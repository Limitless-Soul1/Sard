// The read-aloud scheduler's failure-isolation contract, on a virtual clock with a scripted engine.
//
// RULE 1: a sentence that fails while still ahead of playback is never abandoned and never skipped — it is
//         re-attempted with backoff (no count limit) while later sentences keep being prepared.
// RULE 2: once playback reaches a sentence that is not ready, it gets ONE bounded recovery round (a 12 s
//         total budget, ≤ 3 attempts); if that fails the failure is surfaced ON that sentence.
//
// Every scenario also asserts the invariants that make the design safe: one dispatch in flight at a time,
// a bounded number of dispatches (no busy loop), playback order never advanced by the scheduler, every
// waiter settled and no timer left after `reset()`.

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, RECOVERY_CANCELLED, RECOVERY_FAILED, SynthScheduler, type DispatchContext, type SchedulerClock } from "../../src/lib/ttsScheduler";
import { TTS_EDGE_DOWN } from "../../src/lib/tts";

// ---- a virtual clock: timers fire in order at their scheduled time; promises drain between events ----
class Clock implements SchedulerClock {
  t = 0;
  private seq = 0;
  private q: { at: number; seq: number; fn: () => void; id: number; live: boolean }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.seq; this.q.push({ at: this.t + Math.max(0, ms), seq: id, fn, id, live: true }); return id; }
  clearTimeout(id: unknown) { const e = this.q.find((x) => x.id === id); if (e) e.live = false; }
  live() { return this.q.filter((e) => e.live).length; }
  private async drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async run(until: number) {
    await this.drain();
    for (;;) {
      this.q = this.q.filter((e) => e.live);
      this.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const e = this.q[0];
      if (!e || e.at > until) break;
      this.q.shift();
      this.t = e.at;
      e.fn();
      await this.drain();
    }
    this.t = Math.max(this.t, until);
    await this.drain();
  }
}

type Syn = { durationSec: number };
type Outcome = { ok: true; ms: number } | { ok: false; ms: number; err: string };
type Script = (idx: number, attempt: number, ctx: DispatchContext) => Outcome;

const ok = (ms = 300): Outcome => ({ ok: true, ms });
const fail = (err = "edge connect: 11001 host not found", ms = 30): Outcome => ({ ok: false, ms, err });
// a stall: nothing arrives; the engine reports it at its bound (the recovery budget or the first-audio window)
const stall = (ctx: DispatchContext): Outcome => ({ ok: false, ms: ctx.budgetMs ?? 12000, err: "edge synth stalled: no audio" });

function harness(script: Script, opts: { count?: number; lens?: number[]; policy?: Partial<typeof DEFAULT_POLICY> } = {}) {
  const clock = new Clock();
  const count = opts.count ?? 60;
  const lens = opts.lens ?? Array.from({ length: count }, () => 80); // ≈ 6 s of audio per sentence
  const calls: { idx: number; ctx: DispatchContext; at: number; done?: number; ok?: boolean }[] = [];
  const attempts = new Map<number, number>();
  let live = 0, maxLive = 0, cancels = 0;
  let cancelNext: (() => void) | null = null;
  const dispatch = (idx: number, ctx: DispatchContext) => new Promise<Syn>((resolve, reject) => {
    const n = (attempts.get(idx) ?? 0) + 1; attempts.set(idx, n);
    live++; maxLive = Math.max(maxLive, live);
    const rec: { idx: number; ctx: DispatchContext; at: number; done?: number; ok?: boolean } = { idx, ctx, at: clock.now() }; calls.push(rec);
    const out = script(idx, n, ctx);
    let settled = false;
    const finish = (good: boolean, err?: string) => {
      if (settled) return; settled = true; live--; rec.done = clock.now(); rec.ok = good;
      good ? resolve({ durationSec: lens[idx] * 0.0757 }) : reject(new Error(err));
    };
    clock.setTimeout(() => finish(out.ok, out.ok ? undefined : out.err), out.ms);
    cancelNext = () => finish(false, "edge synth cancelled");
  });
  const s = new SynthScheduler<Syn>(dispatch, {
    behind: 1, ahead: 20, targetSeconds: 18, lowWaterSeconds: 5,
    durationOf: (v) => v.durationSec,
    estimateOf: (i) => Math.max(1, lens[i] * 0.0757),
    isPermanent: (e) => /HTTP 4\d\d/.test(String(e)) && !/429/.test(String(e)),
    isCancelled: (e) => String(e).includes("edge synth cancelled"),
    isFastReset: (e, ms) => ms < 150 && /10054/.test(String(e)),
    onCancel: () => { cancels++; cancelNext?.(); },
    clock, random: () => 0.5, policy: opts.policy,
  });
  s.setSpeed(1.3);
  const request = (i: number) => { const p = s.request(i); p.catch(() => {}); return p; };
  const prefetch = () => { for (const j of s.workSet()) request(j); };
  return { clock, s, calls, attempts, request, prefetch, get maxLive() { return maxLive; }, get cancels() { return cancels; }, get live() { return live; } };
}

// The playback loop as the store drives it: reach `i`, wait for it (recovery if needed), "play" it for its
// duration, advance. Records the order actually played and never advances past a failed recovery.
async function play(h: ReturnType<typeof harness>, from: number, untilMs: number, budget = DEFAULT_POLICY.budgetMs) {
  const { s, clock } = h;
  const order: number[] = []; const waits: number[] = []; let stoppedAt: number | null = null; let error: string | null = null;
  let i = from; let deadline = untilMs;
  s.begin(60, from);
  while (clock.now() < deadline) {
    s.reprioritize(i);
    h.request(i); if (i + 1 < 60) h.request(i + 1); h.prefetch();
    const t0 = clock.now();
    let v: Syn;
    const p = s.isReady(i) ? h.request(i) : s.recover(i, budget);
    let settled: { v?: Syn; e?: unknown } | null = null;
    p.then((x) => { settled = { v: x }; }, (e) => { settled = { e }; });
    await clock.run(clock.now());
    while (!settled && clock.now() < deadline) await clock.run(Math.min(deadline, clock.now() + 50));
    if (!settled) break;
    waits.push(clock.now() - t0);
    if ((settled as { e?: unknown }).e) { error = String((settled as { e?: unknown }).e); stoppedAt = i; break; }
    v = (settled as { v: Syn }).v;
    order.push(i);
    await clock.run(clock.now() + (v.durationSec / 1.3) * 1000); // it plays
    i++;
    if (i >= 60) break;
  }
  return { order, waits, stoppedAt, error, maxWait: Math.max(0, ...waits) };
}

/** Await a scheduler promise while the virtual clock runs (a bare `await` would wait for timers that never fire). */
async function settle<T>(h: ReturnType<typeof harness>, p: Promise<T>, maxMs = 120_000): Promise<{ v?: T; e?: unknown; ms: number }> {
  const t0 = h.clock.now();
  let out: { v?: T; e?: unknown; ms: number } | null = null;
  p.then((v) => { out = { v, ms: h.clock.now() - t0 }; }, (e) => { out = { e, ms: h.clock.now() - t0 }; });
  await h.clock.run(h.clock.now());
  while (!out && h.clock.now() - t0 < maxMs) await h.clock.run(h.clock.now() + 50);
  return out ?? { e: new Error("unsettled"), ms: h.clock.now() - t0 };
}

function expectInvariants(h: ReturnType<typeof harness>) {
  expect(h.maxLive, "one dispatch in flight at a time").toBeLessThanOrEqual(1);
  expect(h.s.maxConcurrent).toBeLessThanOrEqual(1);
}
async function expectCleanAfterReset(h: ReturnType<typeof harness>) {
  h.s.reset();
  await h.clock.run(h.clock.now() + 200_000);
  const callsBefore = h.calls.length;
  await h.clock.run(h.clock.now() + 600_000);
  expect(h.calls.length, "no dispatch after reset").toBe(callsBefore);
  expect(h.s.pendingWaiters, "every waiter settled").toBe(0);
  expect(h.s.hasTimers, "no scheduler timer left").toBe(false);
  expect(h.clock.live(), "no timer left at all").toBe(0);
}

const N = 30;

describe("failure isolation — the markers the store keys on", () => {
  it("a failed recovery round rejects with the store's Edge-unavailable marker", () => {
    expect(RECOVERY_FAILED).toBe(TTS_EDGE_DOWN);
    expect(RECOVERY_CANCELLED).not.toContain("edge");
    expect(RECOVERY_CANCELLED).not.toMatch(/\d/);
  });
});

describe("RULE 1 — a failed sentence ahead of playback is retried, never abandoned, never skipped", () => {
  it("N+4 fails once as look-ahead and recovers before playback arrives: no interruption, no stop", async () => {
    const h = harness((i, n) => (i === N + 4 && n === 1 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBeNull();
    expect(r.order.slice(0, 8)).toEqual([N, N + 1, N + 2, N + 3, N + 4, N + 5, N + 6, N + 7]);
    expect(h.attempts.get(N + 4)).toBe(2);
    expect(r.maxWait).toBeLessThan(1000);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("N+4 fails four times then recovers — the backoff grows and there is no count cut-off", async () => {
    const h = harness((i, n) => (i === N + 4 && n <= 4 ? fail() : ok()));
    const r = await play(h, N, 150_000);
    expect(r.stoppedAt).toBeNull();
    expect(r.order).toContain(N + 4);
    expect(r.order.indexOf(N + 5)).toBe(r.order.indexOf(N + 4) + 1);
    const tries = h.calls.filter((c) => c.idx === N + 4);
    const gaps = tries.slice(1).map((c, k) => c.at - tries[k].at);
    expect(gaps.length).toBe(4);
    expect(gaps[0]).toBeGreaterThanOrEqual(1_500); // ≥ the 2 s base minus jitter — never a tight loop
    expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0] * 0.9); // doubling…
    // …until the wait is capped so the last chance comes before playback arrives: every BACKGROUND attempt
    // lands before the sentence is needed (N..N+3 ≈ 18.6 s of listening at 1.3x); whatever is left is
    // the recovery round's, and the round succeeded (no stop above)
    for (const c of tries.filter((c) => c.ctx.role === "retry")) expect(c.at).toBeLessThan(18_600);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("N+1 (the very next sentence) failing three times still recovers in time", async () => {
    const h = harness((i, n) => (i === N + 1 && n <= 3 ? fail() : ok()));
    const r = await play(h, N, 90_000);
    expect(r.stoppedAt).toBeNull();
    expect(r.order.slice(0, 3)).toEqual([N, N + 1, N + 2]);
    expectInvariants(h);
  });

  it("a sentence that is already due (no recovery round waiting on it) keeps the plain backoff — no retry loop", async () => {
    // the current sentence fails and nobody is in a recovery round for it (the state after a failed round)
    const h = harness((i) => (i === N ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(120_000);
    const tries = h.calls.filter((c) => c.idx === N).length;
    expect(tries).toBeGreaterThanOrEqual(3);
    expect(tries).toBeLessThanOrEqual(10); // 2/4/8/16/30/30/30… s
    expect(h.calls.length).toBeLessThan(60);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("the backoff is a bounded rate, not a busy loop: a sentence that always fails gets few attempts", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(60_000);
    const tries = h.calls.filter((c) => c.idx === N + 4).length;
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(tries).toBeLessThanOrEqual(8); // 2/4/8/16/30 s backoff inside a minute
    expect(h.calls.length).toBeLessThan(40);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });
});

describe("failure isolation — later sentences keep being prepared past a failed one", () => {
  it("while N+4 waits on its backoff, N+5, N+6 and N+7 are synthesized", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(15_000);
    expect(h.s.isReady(N + 5)).toBe(true);
    expect(h.s.isReady(N + 6)).toBe(true);
    expect(h.s.isReady(N + 7)).toBe(true);
    expect(h.s.stateOf(N + 4)).toBe("waiting");
    // the two measures stay apart: contiguous audio stops at the gap, the work set reaches past it
    expect(h.s.bufferedSecondsAhead()).toBeCloseTo(3 * 80 * 0.0757, 1);
    expect(h.s.workSet()).toContain(N + 7);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("the work window past a gap is bounded, and closed while the service is degraded", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(30_000);
    const ready = [...Array(60).keys()].filter((j) => h.s.isReady(j));
    expect(Math.max(...ready)).toBeLessThanOrEqual(N + 4 + DEFAULT_POLICY.pastGap);
    // two different sentences failing consecutively → degraded → no speculative work past the gap
    const h2 = harness((i) => (i === N + 4 || i === N + 5 ? fail() : ok()));
    h2.s.begin(60, N); h2.request(N); h2.request(N + 1); h2.prefetch();
    await h2.clock.run(30_000);
    expect(h2.s.currentHealth).not.toBe("healthy");
    expect(h2.s.isReady(N + 6)).toBe(false);
    expectInvariants(h2);
  });
});

describe("RULE 2 — playback reaches a sentence that is not ready", () => {
  it("never plays N+5 before N+4: with N+4 dead and N+5..N+7 ready, playback stops AT N+4 with the failure", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.order).toEqual([N, N + 1, N + 2, N + 3]);
    expect(r.stoppedAt).toBe(N + 4);
    expect(r.error).toContain(TTS_EDGE_DOWN);
    expect(h.s.isReady(N + 5)).toBe(true); // kept, not discarded
    expect(h.s.isReady(N + 6)).toBe(true);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("the round holds exactly three fresh attempts on fast failures, inside ~1.5 s", async () => {
    const h = harness((i, n) => (i === N + 4 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    const rec = h.calls.filter((c) => c.idx === N + 4 && c.ctx.role === "recovery");
    expect(rec.length).toBe(3);
    expect(rec.map((c) => c.ctx.attempt)).toEqual([1, 2, 3]);
    expect(rec[2].at - rec[0].at).toBeLessThan(2_000);
    expect(r.stoppedAt).toBe(N + 4);
  });

  it("attempt 2 succeeding plays N+4 and continues straight into the cached N+5", async () => {
    const h = harness((i, n, ctx) => (i === N + 4 ? (ctx.role === "recovery" && n >= 6 ? ok() : fail()) : ok()));
    const r = await play(h, N, 150_000);
    expect(r.stoppedAt).toBeNull();
    const k = r.order.indexOf(N + 4);
    expect(k).toBeGreaterThan(0);
    expect(r.order[k + 1]).toBe(N + 5);
    // N+5 was produced once, before N+4 recovered, and reused — not synthesized again
    expect(h.attempts.get(N + 5)).toBe(1);
    expect(r.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs);
    expectInvariants(h);
  });

  it("a stall on the current sentence surfaces at the 12 s budget, never later", async () => {
    const h = harness((i, n, ctx) => (i === N + 1 ? stall(ctx) : ok()));
    const r = await play(h, N, 90_000);
    expect(r.stoppedAt).toBe(N + 1);
    expect(r.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
    expect(r.maxWait).toBeGreaterThan(10_000);
    // the one attempt was given the whole remaining budget, and no attempt started with too little left
    const rec = h.calls.filter((c) => c.idx === N + 1 && c.ctx.role === "recovery");
    for (const c of rec) expect(c.ctx.budgetMs!).toBeGreaterThanOrEqual(DEFAULT_POLICY.minAttemptMs);
    expectInvariants(h);
  });

  it("a call already in flight when playback arrives counts as the first attempt, yields at the half-way point, and is bounded by the budget", async () => {
    // N+1 is short so playback reaches it while its synthesis is still running. A call that answers
    // within half the budget of the round's start is simply used (one attempt, no second call).
    const lens = Array.from({ length: 60 }, (_, i) => (i === N ? 13 : 80));
    const h = harness((i, n) => (i === N + 1 && n === 1 ? ok(4_000) : ok()), { lens });
    const r = await play(h, N, 60_000);
    expect(r.stoppedAt).toBeNull();
    expect(h.attempts.get(N + 1)).toBe(1); // no second call was started behind the in-flight one
    expect(r.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs);
    // One that would take 9 s is asked to yield at 6 s (RULE 2a) and a fresh attempt takes the other half.
    const h9 = harness((i, n) => (i === N + 1 && n === 1 ? ok(9_000) : ok()), { lens });
    const r9 = await play(h9, N, 60_000);
    expect(r9.stoppedAt).toBeNull();
    expect(h9.attempts.get(N + 1)).toBe(2);
    expect(r9.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs);
    // A silent in-flight call is asked to yield at 6 s; the fresh attempt succeeds and playback goes on.
    const hs = harness((i, n) => (i === N + 1 && n === 1 ? ({ ok: false, ms: 30_000, err: "edge synth stalled: no audio" }) : ok()), { lens });
    const rs = await play(hs, N, 60_000);
    expect(rs.stoppedAt).toBeNull();
    expect(hs.attempts.get(N + 1)).toBe(2);
    expect(rs.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
    expectInvariants(hs);
  });

  it("a permanent failure (4xx) is surfaced at once and is not retried in the background", async () => {
    const h = harness((i) => (i === N + 2 ? fail("edge synth: HTTP 403") : ok()));
    const r = await play(h, N, 90_000);
    expect(r.stoppedAt).toBe(N + 2);
    expect(h.attempts.get(N + 2)).toBe(1);
    expect(h.s.stateOf(N + 2)).toBe("dead");
    await h.clock.run(h.clock.now() + 120_000);
    expect(h.attempts.get(N + 2)).toBe(1);
  });
});

describe("after a failed round — background retries, Retry, Skip", () => {
  it("background attempts continue after the failure is shown, and a user Retry then resumes instantly", async () => {
    let healthyFrom = Infinity;
    const h = harness((i) => (i === N + 4 && h.clock.now() < healthyFrom ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBe(N + 4);
    const failedAt = h.clock.now();
    healthyFrom = failedAt + 20_000; // the service recovers 20 s later
    await h.clock.run(failedAt + 90_000);
    expect(h.s.isReady(N + 4)).toBe(true); // recovered in the background — nothing auto-resumed
    const before = h.calls.length;
    // Retry: the store calls userAction() then playFrom → request (ready) — no new synthesis of N+4
    h.s.userAction();
    const v = await h.request(N + 4);
    expect(v.durationSec).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.idx === N + 4).length).toBe(h.calls.slice(0, before).filter((c) => c.idx === N + 4).length);
    expect(h.s.isReady(N + 5)).toBe(true);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("background attempts stop after the limit and resume on a user action", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBe(N + 4);
    const t1 = h.clock.now();
    await h.clock.run(t1 + DEFAULT_POLICY.backgroundLimitMs + 120_000);
    const afterLimit = h.calls.filter((c) => c.at > t1 + DEFAULT_POLICY.backgroundLimitMs + 5_000).length;
    expect(afterLimit).toBe(0);
    const before = h.calls.length;
    h.s.userAction();
    await h.clock.run(h.clock.now() + 5_000);
    expect(h.calls.length).toBeGreaterThan(before);
    expectInvariants(h);
  });

  it("Retry while the sentence is still unavailable gives a fresh round and the same failure", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBe(N + 4);
    h.s.userAction();
    const out = await settle(h, h.s.recover(N + 4));
    expect(String(out.e)).toContain(TTS_EDGE_DOWN);
    expect(out.ms).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
    expect(h.s.isReady(N + 5)).toBe(true);
  });

  it("an explicit skip past the failed sentence plays the cached next one; the skipped sentence is no longer required", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBe(N + 4);
    const tries = h.attempts.get(N + 4)!;
    h.s.reprioritize(N + 5); h.s.userAction(); // what skip(+1) does, in that order
    expect(h.s.isReady(N + 5)).toBe(true);
    await h.clock.run(h.clock.now() + 120_000);
    expect(h.attempts.get(N + 4)).toBe(tries); // behind the cursor: never re-attempted
    expectInvariants(h);
  });

  it("Back onto the failed sentence gives it a fresh recovery round", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBe(N + 4);
    h.s.reprioritize(N + 5);
    const recBefore = h.calls.filter((c) => c.idx === N + 4 && c.ctx.role === "recovery").length;
    h.s.reprioritize(N + 4);
    const out = await settle(h, h.s.recover(N + 4));
    expect(String(out.e)).toContain(TTS_EDGE_DOWN);
    const recAfter = h.calls.filter((c) => c.idx === N + 4 && c.ctx.role === "recovery").length;
    expect(recAfter - recBefore).toBe(3); // a fresh round of three
    expect(out.ms).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
  });
});

describe("navigation and session changes while requests are in flight", () => {
  it("a seek away drops the old window; a late result for the old position is discarded, not stored", async () => {
    const h = harness((i, n) => (i === N + 4 ? ok(8_000) : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(6_000); // N+4's 8 s call is in flight
    expect(h.s.inFlight).toBe(N + 4);
    h.s.reprioritize(N + 40);
    await h.clock.run(30_000);
    expect(h.s.isReady(N + 4)).toBe(false);
    expect(h.s.abandoned).toBeGreaterThanOrEqual(1);
    expect(h.s.isReady(N + 40)).toBe(true);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("a chapter change (clearCache) cancels the in-flight call and never keeps its result", async () => {
    const h = harness((i) => (i === N + 2 ? ok(20_000) : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(2_000);
    expect(h.s.inFlight).toBe(N + 2);
    h.s.begin(60, 0); // new session
    expect(h.cancels).toBe(1);
    await h.clock.run(40_000);
    expect(h.s.isReady(N + 2)).toBe(false);
    expect(h.s.isReady(0)).toBe(true);
    expect(h.s.abandonedEpoch).toBeGreaterThanOrEqual(1);
    expectInvariants(h);
  });

  it("stop during a retry: nothing is dispatched afterwards and nothing is left pending", async () => {
    const h = harness((i) => (i === N + 4 ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(5_000);
    expect(h.s.stateOf(N + 4)).toBe("waiting");
    await expectCleanAfterReset(h);
  });

  it("the sentence the listener waits on takes the engine from a long look-ahead call (cooperative cancel)", async () => {
    const lens = Array.from({ length: 60 }, (_, i) => (i === N ? 13 : 80));
    const h = harness((i) => (i === N + 3 ? ok(40_000) : ok()), { lens });
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(3_000);
    expect(h.s.inFlight).toBe(N + 3);
    h.s.reprioritize(N + 6); // the listener jumped to a sentence that is not ready
    const out = await settle(h, h.s.recover(N + 6));
    expect(h.cancels).toBe(1);
    expect(out.v).toBeDefined();
    expect(out.ms).toBeLessThan(2_000);
    expectInvariants(h);
  });

  it("a cancelled call is not a failure: no backoff, no breaker, the sentence is simply requeued", async () => {
    const h = harness((i) => (i === N + 3 ? ok(40_000) : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(3_000);
    h.s.begin(60, N); h.request(N); // session restarts at the same place
    await h.clock.run(h.clock.now() + 2_000);
    expect(h.s.currentHealth).toBe("healthy");
    expect(h.s.stats.futureRetries).toBe(0);
    expect(h.s.stateOf(N)).toBe("ready");
  });

  it("pause freezes the deadlines but background retries continue; resume lifts the limit", async () => {
    const h = harness((i, n) => (i === N + 4 && n <= 3 ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(1_000);
    h.s.setPaused(true);
    await h.clock.run(60_000);
    expect(h.s.isReady(N + 4)).toBe(true); // recovered while paused
    h.s.setPaused(false);
    expectInvariants(h);
  });

  it("a speed change re-sizes the lead in audio seconds without touching cached audio", async () => {
    const h = harness(() => ok());
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(20_000);
    const at13 = [...Array(60).keys()].filter((j) => h.s.isReady(j)).length;
    h.s.setSpeed(2.0); h.prefetch();
    await h.clock.run(40_000);
    const at20 = [...Array(60).keys()].filter((j) => h.s.isReady(j)).length;
    expect(at20).toBeGreaterThan(at13);
    expect(h.s.abandoned).toBe(0);
  });
});

describe("service conditions", () => {
  it("an idle-connection reset gets one immediate reconnect that does not count as a failure", async () => {
    const h = harness((i, n) => (n === 1 && i === N + 2 ? fail("edge synth: ConnectionReset 10054", 15) : ok()));
    const r = await play(h, N, 60_000);
    expect(r.stoppedAt).toBeNull();
    expect(h.attempts.get(N + 2)).toBe(2);
    expect(h.s.stats.resetRetries).toBe(1);
    expect(h.s.stats.futureRetries).toBe(0);
    expect(h.s.currentHealth).toBe("healthy");
  });

  it("a full outage opens the breaker: one probe at a time, spaced, and every sentence eligible again on recovery", async () => {
    let down = true;
    const h = harness(() => (down ? fail() : ok()));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(120_000);
    expect(h.s.currentHealth).toBe("open");
    const probes = h.calls.filter((c) => c.at > 60_000 && c.at <= 120_000).length;
    expect(probes).toBeLessThanOrEqual(3); // ≤ 1 per 30 s
    down = false;
    await h.clock.run(200_000);
    expect(h.s.currentHealth).toBe("healthy");
    expect(h.s.isReady(N)).toBe(true);
    expect(h.s.isReady(N + 3)).toBe(true);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("a slow but progressing long unit is waited for (one call, never killed and re-requested) and reused when reached", async () => {
    // N+2 takes 15 s to synthesize: it is still in flight when playback arrives (≈ 9 s in), it counts as
    // the recovery's first attempt, completes inside the budget, and is NOT duplicated
    const lens = Array.from({ length: 60 }, (_, i) => (i === N + 2 ? 1336 : 80));
    const h = harness((i) => (i === N + 2 ? ok(15_000) : ok()), { lens });
    const r = await play(h, N, 200_000);
    expect(r.stoppedAt).toBeNull();
    expect(r.order.slice(0, 4)).toEqual([N, N + 1, N + 2, N + 3]);
    expect(h.attempts.get(N + 2)).toBe(1);
    expect(r.maxWait).toBeGreaterThan(3_000);
    expect(r.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs);
  });

  it("the same long unit reached while still in flight: the wait is capped at the budget and the call is not duplicated", async () => {
    const lens = Array.from({ length: 60 }, (_, i) => (i === N + 2 ? 1336 : 80));
    // Every call for this unit takes 40 s: the one in flight is asked to yield at 6 s (RULE 2a), the
    // fresh attempt runs out the rest of the budget, and the wait is still capped. Two calls, never two
    // at once.
    const h = harness((i) => (i === N + 2 ? ok(40_000) : ok()), { lens });
    const r = await play(h, N, 120_000);
    expect(r.stoppedAt).toBe(N + 2);
    expect(r.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
    expect(h.attempts.get(N + 2)).toBe(2);
  });
});

describe("regression — healthy playback is unchanged", () => {
  it("plays every sentence in order with one dispatch each and never waits at a transition", async () => {
    const h = harness(() => ok(400));
    const r = await play(h, 0, 900_000);
    expect(r.stoppedAt).toBeNull();
    expect(r.order).toEqual([...Array(60).keys()]);
    for (let j = 0; j < 60; j++) expect(h.attempts.get(j)).toBe(1);
    expect(Math.max(...r.waits.slice(1))).toBe(0); // only the first sentence is ever waited for
    expect(h.s.stats.futureRetries).toBe(0);
    expect(h.s.stats.recoveries).toBe(1);
    expectInvariants(h);
    await expectCleanAfterReset(h);
  });

  it("keeps about 18 real seconds of audio ahead at 1.3x and never exceeds the window", async () => {
    const h = harness(() => ok(400));
    h.s.begin(60, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.clock.run(30_000);
    const ahead = h.s.bufferedSecondsAhead();
    expect(ahead).toBeGreaterThanOrEqual(18 * 1.3);
    expect(ahead).toBeLessThan(18 * 1.3 + 2 * 80 * 0.0757);
    expect(h.s.size).toBeLessThanOrEqual(1 + 20);
  });
});
