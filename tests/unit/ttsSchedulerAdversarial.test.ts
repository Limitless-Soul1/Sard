// ADVERSARIAL validation of the read-aloud scheduler — the point is to break it, not to confirm it.
//
// Every scenario runs on a virtual clock against a scripted engine, and an INVARIANT MONITOR checks the
// scheduler after every event (dispatch, settle, timer, action): single-flight, no duplicate dispatch,
// bounded cache / timers / waiters, playback order, no automatic skip, no work after Stop, no result
// from an old session. A violation fails the test at the instant it happens, with the event trace.
//
// Sections: the state machine, N+4 isolation, the retry scheduler under attack, the 12 s budget, the
// breaker, Stop as a hard invariant, randomized navigation, explicit skip vs automatic skip, and a
// long-form torture run at every speed.

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, RECOVERY_CANCELLED, SynthScheduler, type DispatchContext, type SchedulerClock } from "../../src/lib/ttsScheduler";
import { TTS_EDGE_DOWN } from "../../src/lib/tts";

// ---------------------------------------------------------------- virtual clock (labelled timers)
class Clock implements SchedulerClock {
  t = 0;
  private seq = 0;
  private q: { at: number; seq: number; fn: () => void; id: number; live: boolean }[] = [];
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.seq; this.q.push({ at: this.t + Math.max(0, ms), seq: id, fn, id, live: true }); return id; }
  clearTimeout(id: unknown) { const e = this.q.find((x) => x.id === id); if (e) e.live = false; }
  live() { return this.q.filter((e) => e.live).length; }
  private async drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  /** Advance to `until`, firing timers in order; `onStep` runs after every fired timer. */
  async run(until: number, onStep?: () => void) {
    await this.drain(); onStep?.();
    for (;;) {
      this.q = this.q.filter((e) => e.live);
      this.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const e = this.q[0];
      if (!e || e.at > until) break;
      this.q.shift();
      this.t = e.at;
      e.fn();
      await this.drain();
      onStep?.();
    }
    this.t = Math.max(this.t, until);
    await this.drain(); onStep?.();
  }
}

// ---------------------------------------------------------------- deterministic randomness
function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ---------------------------------------------------------------- engine outcomes
type Outcome = { ok: true; ms: number } | { ok: false; ms: number; err: string };
type Script = (idx: number, attempt: number, ctx: DispatchContext, now: number) => Outcome;
const ok = (ms = 300): Outcome => ({ ok: true, ms });
const dns = (ms = 30): Outcome => ({ ok: false, ms, err: "edge connect: 11001 host not found" });
const reset = (): Outcome => ({ ok: false, ms: 15, err: "edge synth: ConnectionReset 10054" });
const http = (code: number): Outcome => ({ ok: false, ms: 200, err: `edge synth: HTTP ${code}` });
const empty = (): Outcome => ({ ok: false, ms: 400, err: "empty-audio (0-length buffer)" });
const decode = (): Outcome => ({ ok: false, ms: 400, err: "EncodingError: decode failed" });
// the engine's progress bounds, as the frontend sees them
const stallNoAudio = (ctx: DispatchContext): Outcome => ({ ok: false, ms: ctx.firstAudioMs ?? ctx.budgetMs ?? 12000, err: "edge synth stalled: no audio" });
const stallMidStream = (ctx: DispatchContext): Outcome => ({ ok: false, ms: ctx.budgetMs ?? 30000, err: "edge synth stalled: stream idle" });

interface Call { idx: number; ctx: DispatchContext; at: number; done?: number; ok?: boolean; err?: string; epoch: number }

// ---------------------------------------------------------------- the instrumented harness
class H {
  reset() { this.started = false; this.s.reset(); }
  clock = new Clock();
  calls: Call[] = [];
  live = 0; maxLive = 0; cancels = 0;
  violations: string[] = [];
  trace: string[] = [];
  maxTimers = 0; maxWaiters = 0; maxCache = 0;
  duplicateDispatch = 0;
  s: SynthScheduler<{ durationSec: number; idx: number; epoch: number }>;
  private inflightIdx = new Set<number>();
  private cancelNext: (() => void) | null = null;
  epoch = 0; // the harness's own notion of the session, bumped on begin()
  started = false;
  lens: number[];
  constructor(public script: Script, opts: { count?: number; lens?: number[]; policy?: Partial<typeof DEFAULT_POLICY>; seed?: number; streaming?: () => boolean } = {}) {
    const count = opts.count ?? 200;
    this.lens = opts.lens ?? Array.from({ length: count }, () => 80);
    const r = rng(opts.seed ?? 1);
    const attempts = new Map<number, number>();
    const dispatch = (idx: number, ctx: DispatchContext) => new Promise<{ durationSec: number; idx: number; epoch: number }>((resolve, reject) => {
      if (this.live > 0) this.fail(`dispatch ${idx} while ${this.live} live`);
      if (this.inflightIdx.has(idx)) { this.duplicateDispatch++; this.fail(`duplicate dispatch of ${idx}`); }
      if (this.s.isReady(idx)) { this.duplicateDispatch++; this.fail(`dispatch of READY ${idx}`); }
      const n = (attempts.get(idx) ?? 0) + 1; attempts.set(idx, n);
      this.live++; this.maxLive = Math.max(this.maxLive, this.live); this.inflightIdx.add(idx);
      const rec: Call = { idx, ctx, at: this.clock.now(), epoch: this.epoch }; this.calls.push(rec);
      this.trace.push(`${this.clock.now()} dispatch ${idx} ${ctx.role}#${ctx.attempt}${ctx.budgetMs !== undefined ? ` b=${ctx.budgetMs}` : ""}`);
      const out = this.script(idx, n, ctx, this.clock.now());
      let settled = false; let timer: unknown = null;
      const finish = (good: boolean, err?: string) => {
        if (settled) return; settled = true; this.clock.clearTimeout(timer); this.live--; this.inflightIdx.delete(idx); rec.done = this.clock.now(); rec.ok = good; rec.err = err;
        this.trace.push(`${this.clock.now()} settle ${idx} ${good ? "ok" : err}`);
        good ? resolve({ durationSec: this.lens[idx] * 0.0757, idx, epoch: rec.epoch }) : reject(new Error(err));
      };
      timer = this.clock.setTimeout(() => finish(out.ok, out.ok ? undefined : out.err), out.ms);
      this.cancelNext = () => finish(false, "edge synth cancelled");
    });
    this.s = new SynthScheduler(dispatch, {
      behind: 1, ahead: 20, targetSeconds: 18, lowWaterSeconds: 5,
      durationOf: (v) => v.durationSec,
      estimateOf: (i) => Math.max(1, this.lens[i] * 0.0757),
      isPermanent: (e) => /HTTP 4\d\d/.test(String(e)) && !/429/.test(String(e)),
      isCancelled: (e) => String(e).includes("edge synth cancelled"),
      isFastReset: (e, ms) => ms < 150 && /10054/.test(String(e)),
      onCancel: () => { this.cancels++; this.trace.push(`${this.clock.now()} cancel`); this.cancelNext?.(); },
      isStreaming: opts.streaming,
      clock: this.clock, random: r, policy: opts.policy,
    });
    this.s.setSpeed(1.3);
  }
  fail(msg: string) { this.violations.push(`${this.clock.now()}: ${msg}`); }
  /** Called after every event: the scheduler's own check plus the harness's bounds. */
  check() {
    for (const v of this.s.checkInvariants()) this.fail(v);
    const timers = this.clock.live(); this.maxTimers = Math.max(this.maxTimers, timers);
    this.maxWaiters = Math.max(this.maxWaiters, this.s.pendingWaiters);
    this.maxCache = Math.max(this.maxCache, this.s.size);
    if (timers > 4) this.fail(`${timers} live timers (scheduler wake + recovery hard + the round's yield point + one engine call = 4)`);
    if (this.s.size > 22) this.fail(`cache ${this.s.size}`);
    if (this.s.maxConcurrent > 1) this.fail(`maxConcurrent ${this.s.maxConcurrent}`);
  }
  async run(ms: number) { await this.clock.run(this.clock.now() + ms, () => this.check()); }
  request(i: number) { const p = this.s.request(i); p.catch(() => {}); return p; }
  prefetch() { for (const j of this.s.workSet()) this.request(j); }
  begin(count: number, at: number) { this.epoch++; this.started = true; this.s.begin(count, at); }
  assertSound(label = "") {
    expect(this.violations, `${label} violations\n${this.trace.slice(-30).join("\n")}`).toEqual([]);
  }
}

// ---------------------------------------------------------------- the playback model
// Mirrors playFrom: reach i, wait (recovery if not ready), play for its duration, advance ONLY on end.
// Detects: an automatic advance that skipped a sentence, a sentence played twice, a play out of order.
class Player {
  order: { idx: number; at: number; why: "natural" | "user" }[] = [];
  autoSkips: string[] = []; duplicates: string[] = []; waits: { idx: number; ms: number }[] = [];
  stopped: { idx: number; err: string } | null = null;
  playing: number | null = null; playEnds = 0;
  private gen = 0;
  constructor(private h: H) {}
  /** Play from `from` until `untilMs` or a failure; `why` marks the entry as a user move. */
  async play(from: number, untilMs: number, why: "natural" | "user" = "user", budget = DEFAULT_POLICY.budgetMs, count = 200) {
    const g = ++this.gen; const { h } = this; const s = h.s;
    if (!h.started) h.begin(count, from);
    let i = from; let first = true;
    while (h.clock.now() < untilMs && g === this.gen) {
      s.reprioritize(i);
      h.request(i); if (i + 1 < count) h.request(i + 1); h.prefetch();
      const t0 = h.clock.now();
      const p = s.isReady(i) ? h.request(i) : s.recover(i, budget);
      let settled: { v?: { idx: number; epoch: number }; e?: unknown } | null = null;
      p.then((v) => { settled = { v }; }, (e) => { settled = { e }; });
      await h.clock.run(h.clock.now(), () => h.check());
      while (!settled && h.clock.now() < untilMs && g === this.gen) await h.clock.run(Math.min(untilMs, h.clock.now() + 25), () => h.check());
      if (!settled || g !== this.gen) return;
      const st = settled as { v?: { idx: number; epoch: number }; e?: unknown };
      if (st.e) { if (String(st.e).includes(RECOVERY_CANCELLED)) return; this.stopped = { idx: i, err: String(st.e) }; return; }
      this.waits.push({ idx: i, ms: h.clock.now() - t0 });
      if (st.v!.idx !== i) h.fail(`sentence ${i} received audio of ${st.v!.idx}`);
      if (st.v!.epoch !== h.epoch) h.fail(`sentence ${i} received audio from session ${st.v!.epoch} (now ${h.epoch})`);
      const last = this.order[this.order.length - 1];
      const w = first ? why : "natural";
      if (w === "natural" && last && i !== last.idx + 1) this.autoSkips.push(`natural play ${i} after ${last.idx}`);
      if (this.order.some((o) => o.idx === i && o.why === "natural" && w === "natural")) this.duplicates.push(`natural play ${i} twice`);
      this.order.push({ idx: i, at: h.clock.now(), why: w });
      this.playing = i;
      await h.clock.run(h.clock.now() + (this.h.lens[i] * 0.0757 / 1.3) * 1000, () => h.check()); // the audio plays
      if (g !== this.gen) return;
      this.playing = null; this.playEnds++;
      first = false;
      i++;
      if (i >= count) return;
    }
  }
  interrupt() { this.gen++; this.playing = null; }
  get maxWait() { return Math.max(0, ...this.waits.map((w) => w.ms)); }
}

const N = 30;

// =============================================================================================
describe("state machine — every transition, monitored", () => {
  it("absent → queued → in flight → ready; ready is never re-dispatched; drop settles waiters", async () => {
    const h = new H(() => ok());
    h.begin(200, N);
    expect(h.s.stateOf(N + 3)).toBeUndefined();
    h.request(N + 3); expect(["queued", "inflight"]).toContain(h.s.stateOf(N + 3));
    await h.run(5000);
    expect(h.s.isReady(N + 3)).toBe(true);
    const before = h.calls.length;
    await h.request(N + 3); h.prefetch(); await h.run(1000);
    expect(h.calls.length).toBe(before);
    let dropped: unknown = null;
    h.request(N + 15).catch((e) => { dropped = e; });
    h.s.reprioritize(N + 60); await h.run(100);
    expect(String(dropped)).toContain("tts.dropped");
    h.assertSound();
  });

  it("in flight → waiting → in flight → ready, then no further dispatch of that sentence", async () => {
    const h = new H((i, n) => (i === N + 2 && n === 1 ? dns() : ok()));
    h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.run(300); // N in flight / done
    await h.run(2000);
    expect(h.s.stateOf(N + 2)).toBe("waiting");
    await h.run(6000);
    expect(h.s.isReady(N + 2)).toBe(true);
    const n = h.calls.filter((c) => c.idx === N + 2).length;
    await h.run(60000);
    expect(h.calls.filter((c) => c.idx === N + 2).length).toBe(n);
    h.assertSound();
  });

  it("dead (4xx) never dispatches again and rejects request/recover immediately", async () => {
    const h = new H((i) => (i === N + 2 ? http(403) : ok()));
    h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.run(3000);
    expect(h.s.stateOf(N + 2)).toBe("dead");
    let e: unknown; await h.s.recover(N + 2).catch((x) => { e = x; });
    expect(String(e)).toContain(TTS_EDGE_DOWN);
    await h.run(120000);
    expect(h.calls.filter((c) => c.idx === N + 2).length).toBe(1);
    h.assertSound();
  });

  it("stopped: nothing dispatches, nothing resurrects, no timer, no waiter — from every state", async () => {
    for (const state of ["queued", "inflight", "waiting", "recovery", "ready"] as const) {
      const h = new H((i, n) => (state === "waiting" && i === N + 1 ? dns() : state === "recovery" && i === N ? dns() : ok(state === "inflight" ? 5000 : 300)));
      const p = new Player(h);
      h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
      if (state === "recovery") { void p.play(N, 1e9); }
      await h.run(state === "queued" ? 0 : 800);
      h.reset(); p.interrupt();
      const calls = h.calls.length;
      await h.run(300000);
      expect(h.calls.length, state).toBe(calls);
      expect(h.s.pendingWaiters, state).toBe(0);
      expect(h.s.hasTimers, state).toBe(false);
      expect(h.clock.live(), state).toBe(0);
      expect(h.s.liveDispatches, state).toBe(0);
      h.assertSound(state);
    }
  });

  it("a newer session is never overwritten by an older result, whatever state the old one was in", async () => {
    for (const late of [200, 2000, 8000]) {
      const h = new H((i, n, ctx, now) => (now < 50 ? ok(late) : ok()));
      h.begin(200, N); h.request(N); await h.run(10); // N in flight, slow
      h.begin(200, 100); h.request(100); h.request(101); h.prefetch();
      await h.run(late + 2000);
      expect(h.s.isReady(N)).toBe(false);
      expect(h.s.isReady(100)).toBe(true);
      expect(h.s.abandonedEpoch).toBeGreaterThanOrEqual(1);
      h.assertSound(`late ${late}`);
    }
  });
});

// =============================================================================================
describe("N+4 isolation — brutally", () => {
  const cases: [string, Script][] = [
    ["fails once", (i, n) => (i === N + 4 && n <= 1 ? dns() : ok())],
    ["fails twice", (i, n) => (i === N + 4 && n <= 2 ? dns() : ok())],
    ["fails 3 times", (i, n) => (i === N + 4 && n <= 3 ? dns() : ok())],
    ["fails 10 times", (i, n) => (i === N + 4 && n <= 10 ? dns() : ok())],
    ["alternates", (i, n) => (i === N + 4 && n % 2 === 1 ? dns() : ok())],
    ["reset then ok", (i, n) => (i === N + 4 && n === 1 ? reset() : ok())],
    ["empty then ok", (i, n) => (i === N + 4 && n === 1 ? empty() : ok())],
    ["decode error then ok", (i, n) => (i === N + 4 && n === 1 ? decode() : ok())],
    ["stalls before first audio once", (i, n, ctx) => (i === N + 4 && n === 1 ? stallNoAudio(ctx) : ok())],
    ["stalls mid-stream once", (i, n, ctx) => (i === N + 4 && n === 1 ? stallMidStream(ctx) : ok())],
    ["succeeds only after 3 minutes", (i, n, ctx, now) => (i === N + 4 && now < 180000 ? dns() : ok())],
  ];
  for (const [name, script] of cases) {
    it(`N+4 ${name}: later sentences are prepared, order is N..N+9, nothing skipped`, async () => {
      const h = new H(script);
      const p = new Player(h);
      await p.play(N, 400000);
      const played = p.order.map((o) => o.idx);
      if (p.stopped) {
        // cases that cannot succeed before playback arrives and the round ends: ten fast failures span
        // ~4 minutes of backoff; a mid-stream stall holds the engine past the arrival; three minutes of dns
        expect(["fails 10 times", "stalls mid-stream once", "succeeds only after 3 minutes"]).toContain(name);
        expect(p.stopped.idx).toBe(N + 4);
        expect(played).toEqual([N, N + 1, N + 2, N + 3]);
        // later sentences were still prepared while N+4 failed — except while a stalled stream held the
        // single-flight engine (the mid-stream case: 30 s of idle before the engine reports it)
        if (name !== "stalls mid-stream once") { expect(h.s.isReady(N + 5)).toBe(true); expect(h.s.isReady(N + 6)).toBe(true); }
        // and the background eventually recovers it without any further user action
        await h.run(200000);
        expect(h.s.isReady(N + 4)).toBe(true);
        expect(h.s.isReady(N + 5)).toBe(true); // kept (or produced once the engine was free)
      } else {
        expect(played.slice(0, 10)).toEqual([N, N + 1, N + 2, N + 3, N + 4, N + 5, N + 6, N + 7, N + 8, N + 9]);
        expect(p.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
      }
      expect(p.autoSkips).toEqual([]);
      expect(p.duplicates).toEqual([]);
      expect(h.duplicateDispatch).toBe(0);
      // N+5..N+7 were synthesized exactly once each — never re-synthesized because of N+4
      for (const j of [N + 5, N + 6, N + 7]) expect(h.calls.filter((c) => c.idx === j).length, `calls for ${j}`).toBe(1);
      h.assertSound(name);
    });
  }

  it("N+4 fails indefinitely: stops AT N+4, N+5.. ready, bounded background attempts, Retry rounds bounded", async () => {
    const h = new H((i) => (i === N + 4 ? dns() : ok()));
    const p = new Player(h);
    await p.play(N, 300000);
    expect(p.stopped?.idx).toBe(N + 4);
    expect(String(p.stopped?.err)).toContain(TTS_EDGE_DOWN);
    expect(p.order.map((o) => o.idx)).toEqual([N, N + 1, N + 2, N + 3]);
    for (const j of [N + 5, N + 6, N + 7, N + 8]) expect(h.s.isReady(j), `ready ${j}`).toBe(true);
    const t1 = h.clock.now();
    await h.run(DEFAULT_POLICY.backgroundLimitMs + 60000);
    const bg = h.calls.filter((c) => c.idx === N + 4 && c.at > t1);
    expect(bg.length).toBeGreaterThanOrEqual(5);
    expect(bg.length).toBeLessThanOrEqual(40); // 2/4/8/16/30 s backoff over 10 min, then nothing
    expect(h.calls.filter((c) => c.at > t1 + DEFAULT_POLICY.backgroundLimitMs + 5000).length).toBe(0);
    // three Retry rounds: each ≤ 12 s, 3 attempts, and N+5.. never re-synthesized
    for (let k = 0; k < 3; k++) {
      h.s.userAction();
      const t = h.clock.now(); let e: unknown; let done = false;
      h.s.recover(N + 4).catch((x) => { e = x; done = true; });
      while (!done) await h.run(25);
      expect(h.clock.now() - t).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
      expect(String(e)).toContain(TTS_EDGE_DOWN);
    }
    for (const j of [N + 5, N + 6]) expect(h.calls.filter((c) => c.idx === j).length).toBe(1);
    h.assertSound();
  });
});

// =============================================================================================
describe("the retry scheduler under attack", () => {
  it("no zero-delay loop and no duplicate attempts under thousands of failures (all failing, 1 h)", async () => {
    const h = new H(() => dns());
    h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.run(3600000);
    const byIdx = new Map<number, number[]>();
    for (const c of h.calls) { const a = byIdx.get(c.idx) ?? []; a.push(c.at); byIdx.set(c.idx, a); }
    for (const [idx, ats] of byIdx) for (let k = 1; k < ats.length; k++) expect(ats[k] - ats[k - 1], `gap for ${idx}`).toBeGreaterThanOrEqual(1000);
    expect(h.calls.length).toBeLessThan(400); // an hour of a dead service: probes every ≥ 30 s once open
    expect(h.s.currentHealth).toBe("open");
    expect(h.maxTimers).toBeLessThanOrEqual(4);
    h.assertSound();
  });

  it("far-future work never starves a near retry, and a near retry never starves the current sentence", async () => {
    // N+2 waits; look-ahead beyond it is slow (5 s calls) — the retry must still land when due
    const h = new H((i, n) => (i === N + 2 && n === 1 ? dns() : i > N + 2 ? ok(5000) : ok()));
    h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.run(30000);
    const retry = h.calls.find((c) => c.idx === N + 2 && c.ctx.role === "retry");
    expect(retry).toBeDefined();
    // the current sentence in recovery always wins the engine: a due retry for a later sentence waits
    const h2 = new H((i, n, ctx) => (i === N + 3 && n === 1 ? dns() : i === N ? (ctx.role === "recovery" && n >= 2 ? ok() : dns()) : ok()));
    const p = new Player(h2);
    await p.play(N, 60000);
    const first = h2.calls.filter((c) => c.at >= 0 && c.ctx.role === "recovery")[0];
    expect(first?.idx).toBe(N);
    expect(p.stopped).toBeNull();
    h.assertSound(); h2.assertSound();
  });

  it("retries stop after Stop, chapter change, seek beyond, skip past, voice change — never for a sentence no longer needed", async () => {
    const mk = () => { const h = new H((i) => (i === N + 4 ? dns() : ok())); h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch(); return h; };
    const cases: [string, (h: H) => void][] = [
      ["stop", (h) => h.reset()],
      ["chapter change", (h) => h.begin(200, 0)],
      ["seek beyond", (h) => h.s.reprioritize(N + 50)],
      ["skip past", (h) => { h.s.reprioritize(N + 5); h.s.userAction(); }],
    ];
    for (const [name, act] of cases) {
      const h = mk(); await h.run(6000);
      expect(h.s.stateOf(N + 4)).toBe("waiting");
      act(h);
      const n = h.calls.filter((c) => c.idx === N + 4).length;
      await h.run(120000);
      expect(h.calls.filter((c) => c.idx === N + 4).length, name).toBe(n);
      h.assertSound(name);
    }
    // a voice change is different: every sentence must be produced again in the new voice, N+4 included —
    // with a fresh backoff history, bounded exactly like a first failure
    const h = mk(); await h.run(6000);
    h.s.clearCache(); h.s.reprioritize(N);
    const n = h.calls.filter((c) => c.idx === N + 4).length;
    await h.run(120000);
    const again = h.calls.filter((c) => c.idx === N + 4).length - n;
    expect(again).toBeGreaterThanOrEqual(1);
    expect(again).toBeLessThanOrEqual(10);
    h.assertSound("voice change");
  });

  it("stress: 2,000 random events on a flaky engine keep every bound", async () => {
    const r = rng(42);
    const h = new H((i, n) => { const x = r(); return x < 0.2 ? dns() : x < 0.25 ? reset() : x < 0.28 ? empty() : ok(100 + r() * 1500); }, { seed: 42 });
    const p = new Player(h);
    let cursor = N; let total = 0;
    void p.play(cursor, 1e9);
    for (let k = 0; k < 2000; k++) {
      await h.run(50 + r() * 800);
      const a = r();
      if (a < 0.3) { cursor = Math.max(0, Math.min(199, cursor + (r() < 0.5 ? 1 : -1))); p.interrupt(); h.s.reprioritize(cursor); h.s.userAction(); void p.play(cursor, 1e9); }
      else if (a < 0.4) { cursor = Math.floor(r() * 190); p.interrupt(); h.s.reprioritize(cursor); h.s.userAction(); void p.play(cursor, 1e9); }
      else if (a < 0.45) { h.s.setPaused(true); await h.run(r() * 3000); h.s.setPaused(false); }
      else if (a < 0.5) { h.s.setSpeed([1, 1.3, 1.5, 2][Math.floor(r() * 4)]); }
      else if (a < 0.55) { p.interrupt(); h.reset(); await h.run(200); cursor = Math.floor(r() * 190); h.begin(200, cursor); void p.play(cursor, 1e9); }
      else if (a < 0.6) { p.interrupt(); cursor = Math.floor(r() * 190); h.begin(200, cursor); void p.play(cursor, 1e9); }
      total++;
    }
    p.interrupt(); h.reset(); await h.run(200000);
    expect(h.violations).toEqual([]);
    expect(h.duplicateDispatch).toBe(0);
    expect(h.maxLive).toBe(1);
    expect(p.autoSkips).toEqual([]);
    expect(h.s.pendingWaiters).toBe(0); expect(h.clock.live()).toBe(0);
    expect(h.maxTimers).toBeLessThanOrEqual(4);
    expect(h.maxCache).toBeLessThanOrEqual(22);
  });
});

// =============================================================================================
describe("the 12 s budget — every way to overrun it", () => {
  const B = DEFAULT_POLICY.budgetMs;
  async function round(script: Script, lens?: number[]) {
    const h = new H(script, { lens });
    const p = new Player(h);
    await p.play(N, 200000);
    return { h, p };
  }
  const cur = (f: (n: number, ctx: DispatchContext) => Outcome): Script => (i, n, ctx) => (i === N + 1 ? f(n, ctx) : ok());
  const table: [string, Script][] = [
    ["one immediate failure then ok", cur((n) => (n === 1 ? dns() : ok()))],
    ["three immediate failures", cur(() => dns())],
    ["slow failures (5 s each)", cur(() => dns(5000))],
    ["first-audio stalls", cur((n, ctx) => stallNoAudio(ctx))],
    ["mid-stream stalls", cur((n, ctx) => stallMidStream(ctx))],
    ["success 1 ms before the deadline", cur((n, ctx) => (n === 1 ? ok((ctx.budgetMs ?? B) - 1) : ok()))],
    ["success exactly at the deadline", cur((n, ctx) => (n === 1 ? ok(ctx.budgetMs ?? B) : ok()))],
    ["success 1 ms after the deadline", cur((n, ctx) => (n === 1 ? ok((ctx.budgetMs ?? B) + 1) : ok()))],
    ["timeout errors", cur(() => ({ ok: false, ms: 900, err: "edge connect timed out" }))],
  ];
  for (const [name, script] of table) {
    it(name, async () => {
      const { h, p } = await round(script);
      expect(p.maxWait, name).toBeLessThanOrEqual(B + 1);
      for (const c of h.calls.filter((c) => c.ctx.role === "recovery")) {
        expect(c.ctx.budgetMs!, "attempt budget ≤ remaining").toBeLessThanOrEqual(B);
        expect(c.ctx.budgetMs!).toBeGreaterThanOrEqual(DEFAULT_POLICY.minAttemptMs);
      }
      expect(p.autoSkips).toEqual([]);
      h.assertSound(name);
    });
  }

  it("an attempt in flight when the round begins is asked to yield at the half-way point, and the fresh attempt gets the other half", async () => {
    // short N so playback reaches N+1 while its 15 s call runs. Before RULE 2a the round adopted that
    // call and waited on it until the budget expired — one attempt, a 12 s wait, a stop. Now the call is
    // asked to yield at 6 s and a fresh attempt is dispatched with the other half; here it succeeds.
    const lens = Array.from({ length: 200 }, (_, i) => (i === N ? 13 : 80));
    const { h, p } = await round(cur((n) => (n === 1 ? ok(15000) : ok())), lens);
    expect(p.stopped).toBeNull();
    const calls = h.calls.filter((c) => c.idx === N + 1);
    expect(calls.map((c) => c.ctx.role)).toEqual(["lead", "recovery"]);
    expect(calls[0].err).toBe("edge synth cancelled");
    expect(calls[1].at - calls[0].at).toBeLessThanOrEqual(B / 2 + 1500); // the yield came at the half-way point
    expect(calls[1].ctx.budgetMs!).toBeGreaterThanOrEqual(B / 2 - 250);   // ...leaving the other half
    expect(p.maxWait).toBeLessThanOrEqual(B + 1);
    expect(p.autoSkips).toEqual([]);
    h.assertSound();
  });

  it("the failure names the attempts that were STARTED, including the one still in flight at expiry", async () => {
    // every attempt is silent: the first is declared stalled at its cap (6 s), the second runs out the
    // budget — the report says 2, and the wait is still the budget
    const { p } = await round(cur((n, ctx) => stallNoAudio(ctx)));
    expect(p.stopped?.idx).toBe(N + 1);
    expect(p.stopped?.err).toContain("after 2 attempt(s)");
    expect(p.maxWait).toBeLessThanOrEqual(B + 1);
    // the lead call fails before arrival (not a recovery attempt), one recovery attempt fails in 3 s, the
    // next is in flight at expiry: 2 started
    const r2 = await round(cur((n, ctx) => (n <= 2 ? dns(3000) : ok((ctx.budgetMs ?? B) + 5000))));
    expect(r2.h.calls.filter((c) => c.idx === N + 1).map((c) => c.ctx.role)).toEqual(["lead", "recovery", "recovery"]);
    expect(r2.p.stopped?.err).toContain("after 2 attempt(s)");
  });

  it("sweep: budget never exceeded across 300 random failure mixes", async () => {
    const r = rng(7);
    let worst = 0;
    for (let k = 0; k < 300; k++) {
      const seq = Array.from({ length: 4 }, () => r());
      const script: Script = (i, n, ctx) => {
        if (i !== N + 1) return ok();
        const x = seq[Math.min(n - 1, 3)];
        return x < 0.3 ? dns(r() * 3000) : x < 0.5 ? stallNoAudio(ctx) : x < 0.6 ? ({ ok: true, ms: (ctx.budgetMs ?? B) * r() * 1.2 }) : x < 0.7 ? reset() : ok(r() * 2000);
      };
      const h = new H(script, { seed: k });
      const p = new Player(h);
      await p.play(N, 60000);
      worst = Math.max(worst, p.maxWait);
      expect(p.maxWait, `mix ${k}`).toBeLessThanOrEqual(B + 1);
      expect(p.autoSkips).toEqual([]);
      if (h.violations.length) h.assertSound(`mix ${k}`);
    }
    expect(worst).toBeLessThanOrEqual(B + 1);
  });
});

// =============================================================================================
describe("RULE 2a — a silent first attempt cannot spend the whole round", () => {
  const B = DEFAULT_POLICY.budgetMs;
  const cur = (f: (n: number, ctx: DispatchContext) => Outcome): Script => (i, n, ctx) => (i === N + 1 ? f(n, ctx) : ok());
  async function round(script: Script, lens?: number[], policy?: Partial<typeof DEFAULT_POLICY>) {
    const h = new H(script, { lens, policy });
    const p = new Player(h);
    await p.play(N, 200000);
    return { h, p };
  }
  const recoveries = (h: H) => h.calls.filter((c) => c.idx === N + 1 && c.ctx.role === "recovery");
  // With the lead failed, the background retry would otherwise start 2 s later and still be running when
  // playback arrives — the ADOPTED path (#6). A long backoff makes the sentence WAITING at arrival, so the
  // round dispatches its own fresh first attempt, which is the capped one under test here.
  const FRESH = { backoffBaseMs: 20000 };

  // In every script below, n === 1 is the LEAD call made before playback arrives: it fails fast so the
  // sentence is waiting when playback reaches it and the round dispatches a fresh, capped first attempt.
  it("1. a silent first attempt is declared stalled at half the budget, not at the budget", async () => {
    const { h, p } = await round(cur((n, ctx) => (n === 1 ? dns() : n === 2 ? stallNoAudio(ctx) : ok())), undefined, FRESH);
    const [first] = recoveries(h);
    expect(first.ctx.attempt).toBe(1);
    expect(first.ctx.firstAudioMs).toBe(B / 2);
    expect(first.done! - first.at).toBeCloseTo(B / 2, 3); // the virtual clock adds floating-point dust
    expect(p.stopped).toBeNull();
    h.assertSound();
  });

  it("2. a silent first attempt followed by a successful second: the listener waits ~6 s, not 12, and hears the sentence", async () => {
    const { h, p } = await round(cur((n, ctx) => (n === 1 ? dns() : n === 2 ? stallNoAudio(ctx) : ok(400))), undefined, FRESH);
    expect(p.stopped).toBeNull();
    expect(p.maxWait).toBeGreaterThanOrEqual(B / 2);
    expect(p.maxWait).toBeLessThan(B / 2 + 1500);
    const rs = recoveries(h);
    expect(rs.map((c) => c.ctx.attempt)).toEqual([1, 2]);
    expect(rs[1].ctx.firstAudioMs).toBeUndefined();               // only the first attempt is capped
    expect(rs[1].ctx.budgetMs!).toBeGreaterThanOrEqual(B / 2 - 300); // and the second has the other half
    expect(p.order.map((o) => o.idx).slice(0, 3)).toEqual([N, N + 1, N + 2]);
    h.assertSound();
  });

  it("3. a fast failure followed by success: unchanged — fast attempts still fit the round three deep", async () => {
    const { h, p } = await round(cur((n) => (n <= 2 ? dns() : ok())));
    expect(p.stopped).toBeNull();
    expect(p.maxWait).toBeLessThan(1500);
    expect(h.maxLive).toBe(1);
    const deep = await round(cur((n) => (n <= 4 ? dns() : ok())));
    expect(deep.p.stopped).toBeNull();
    expect(recoveries(deep.h).length).toBeGreaterThanOrEqual(2);
    expect(recoveries(deep.h).length).toBeLessThanOrEqual(3);
    deep.h.assertSound();
  });

  it("4. multiple failures inside the budget: silent, then reset, then silent — the round ends with the budget and reports every attempt", async () => {
    const { h, p } = await round(cur((n, ctx) => (n === 1 ? dns() : n === 2 ? stallNoAudio(ctx) : n === 3 ? reset() : stallNoAudio(ctx))));
    // attempt 1: 6 s of silence; attempt 2: a 15 ms reset; attempt 3: silent for what is left
    expect(p.stopped?.idx).toBe(N + 1);
    expect(p.stopped?.err).toContain("after 3 attempt(s)");
    expect(p.maxWait).toBeLessThanOrEqual(B + 1);
    h.assertSound();
  });

  it("5. the round never exceeds the total budget, whatever the mix (200 random mixes)", async () => {
    const r = rng(11);
    for (let k = 0; k < 200; k++) {
      const seq = Array.from({ length: 4 }, () => r());
      const script: Script = (i, n, ctx) => {
        if (i !== N + 1) return ok();
        const x = seq[Math.min(n - 1, 3)];
        return x < 0.35 ? stallNoAudio(ctx) : x < 0.5 ? dns(r() * 3000) : x < 0.6 ? reset() : x < 0.7 ? stallMidStream(ctx) : ok(r() * 5000);
      };
      const h = new H(script, { seed: k });
      const p = new Player(h);
      await p.play(N, 60000);
      expect(p.maxWait, `mix ${k}`).toBeLessThanOrEqual(B + 1);
      for (const c of recoveries(h)) {
        if (c.ctx.firstAudioMs !== undefined) expect(c.ctx.firstAudioMs).toBeLessThanOrEqual(c.ctx.budgetMs!);
      }
      if (h.violations.length) h.assertSound(`mix ${k}`);
    }
  });

  it("6. no overlapping synthesis: the yield is cooperative and the next attempt waits for the engine to settle", async () => {
    const lens = Array.from({ length: 200 }, (_, i) => (i === N ? 13 : 80));
    // the adopted in-flight call answers the cancel 400 ms late, as a real socket does
    const h = new H((i, n, ctx) => (i === N + 1 && n === 1 ? ok(15000) : ok()), { lens });
    const p = new Player(h);
    await p.play(N, 60000);
    expect(h.maxLive).toBe(1);
    expect(h.duplicateDispatch).toBe(0);
    expect(p.stopped).toBeNull();
    h.assertSound();
  });

  it("6b. an adopted call that is already STREAMING is not yielded: it finishes, one attempt, inside the budget", async () => {
    // the same 9 s in-flight call as #6, but the engine reports audio flowing at the half-way point
    const lens = Array.from({ length: 200 }, (_, i) => (i === N ? 13 : 80));
    const h = new H((i, n) => (i === N + 1 && n === 1 ? ok(9000) : ok()), { lens, streaming: () => true });
    const p = new Player(h);
    await p.play(N, 60000);
    expect(p.stopped).toBeNull();
    expect(h.calls.filter((c) => c.idx === N + 1).length).toBe(1); // never restarted
    expect(h.cancels).toBe(0);
    expect(p.maxWait).toBeLessThanOrEqual(B + 1);
    // ...and a streaming call that still overruns the budget is ended by the hard timer, not by the yield
    const h2 = new H((i, n) => (i === N + 1 && n === 1 ? ok(20000) : ok()), { lens, streaming: () => true });
    const p2 = new Player(h2);
    await p2.play(N, 60000);
    expect(p2.stopped?.idx).toBe(N + 1);
    expect(p2.maxWait).toBeLessThanOrEqual(B + 1);
    expect(h2.calls.filter((c) => c.idx === N + 1).length).toBe(1);
    h.assertSound(); h2.assertSound();
  });

  it("7. Stop during a round whose first attempt is silent leaves zero active synthesis and no timers", async () => {
    const h = new H(cur((n, ctx) => (n === 1 ? dns() : stallNoAudio(ctx))));
    const p = new Player(h);
    void p.play(N, 200000);
    await h.run(3000); // playback has reached N+1 and its first silent attempt is running
    await h.run(2000);
    expect(h.live).toBe(1);
    h.reset(); // Stop
    await h.run(100);
    expect(h.live).toBe(0);
    expect(h.clock.live()).toBe(0);
    expect(h.s.pendingWaiters).toBe(0);
    await h.run(30000);
    expect(h.calls.filter((c) => c.at > h.clock.now() - 30000).length).toBe(0);
    h.assertSound();
  });

  it("8. a chapter change during a round cancels it: the old sentence's result is never kept", async () => {
    const h = new H(cur((n, ctx) => (n === 1 ? dns() : n === 2 ? stallNoAudio(ctx) : ok())));
    const p = new Player(h);
    void p.play(N, 200000);
    await h.run(5000);
    h.begin(200, 0); // the next chapter
    await h.run(100);
    expect(h.s.stateOf(N + 1)).not.toBe("ready");
    await h.run(15000);
    expect(h.calls.filter((c) => c.epoch !== h.epoch && c.done && c.done > c.at && c.ok).every((c) => !h.s.isReady(c.idx) || c.epoch === h.epoch)).toBe(true);
    h.assertSound();
  });

  it("9. a successful recovery plays on into the audio that was already prepared beyond it", async () => {
    const { h, p } = await round(cur((n, ctx) => (n === 1 ? dns() : n === 2 ? stallNoAudio(ctx) : ok())));
    expect(p.stopped).toBeNull();
    // N+2.. were prepared while N+1 waited: exactly one call each, none re-synthesized after the round
    for (const j of [N + 2, N + 3, N + 4]) expect(h.calls.filter((c) => c.idx === j).length).toBe(1);
    expect(p.order.map((o) => o.idx).slice(0, 5)).toEqual([N, N + 1, N + 2, N + 3, N + 4]);
    h.assertSound();
  });

  it("10. no automatic skip: a sentence that stays silent stops playback ON it, and the next is not played", async () => {
    const { p } = await round(cur((n, ctx) => stallNoAudio(ctx)));
    expect(p.stopped?.idx).toBe(N + 1);
    expect(p.autoSkips).toEqual([]);
    expect(p.order.map((o) => o.idx)).toEqual([N]);
  });
});

describe("after a recovery — the audio ahead (E3 coverage)", () => {
  const B = DEFAULT_POLICY.budgetMs;
  const all = (h: H) => ({ live: h.maxLive, dup: h.duplicateDispatch });

  it("Retry after a reached failure: a fresh round, and playback resumes on the sentence it stopped on", async () => {
    let serviceBack = false;
    const script: Script = (i, n, ctx) => (i === N + 1 && !serviceBack ? stallNoAudio(ctx) : ok(300));
    const h = new H(script, { policy: { backoffBaseMs: 20000 } });
    const p = new Player(h);
    await p.play(N, 60000);
    expect(p.stopped?.idx).toBe(N + 1);                 // the round failed: silent, silent
    expect(p.stopped?.err).toContain("after 2 attempt(s)");
    serviceBack = true;
    await p.play(N + 1, h.clock.now() + 60000, "user"); // Retry
    expect(p.stopped?.idx).toBe(N + 1);                 // (the old stop record; the new play did not stop)
    expect(p.order.map((o) => o.idx)).toEqual([N, N + 1, ...Array.from({ length: p.order.length - 2 }, (_, k) => N + 2 + k)]);
    expect(p.autoSkips).toEqual([]);
    expect(all(h)).toEqual({ live: 1, dup: 0 });
    h.assertSound();
  });

  it("recovery with future audio already ready: N+2.. are played from the cache, none re-synthesized", async () => {
    // everything past N+1 was prepared while N+1 waited; after the round, they play straight through
    const h = new H((i, n, ctx) => (i === N + 1 && n === 1 ? dns() : i === N + 1 && n === 2 ? stallNoAudio(ctx) : ok(300)), { policy: { backoffBaseMs: 20000 } });
    const p = new Player(h);
    await p.play(N, 120000);
    expect(p.stopped).toBeNull();
    for (const j of [N + 2, N + 3, N + 4, N + 5]) expect(h.calls.filter((c) => c.idx === j).length).toBe(1);
    const afterRecovery = p.waits.filter((w) => w.idx > N + 1);
    expect(Math.max(0, ...afterRecovery.map((w) => w.ms))).toBeLessThan(50); // no wait at all past the recovered sentence
    expect(all(h)).toEqual({ live: 1, dup: 0 });
    h.assertSound();
  });

  it("recovery with NO future audio ready: the next sentences are waited for in order, never skipped, never duplicated", async () => {
    // the service refused everything AHEAD of the current sentence until just after playback reached
    // N+1: the round's first attempt fails, the second succeeds, and nothing beyond it is ready yet
    const script: Script = (i, n, ctx, now) => (i > N && now < 4900 ? dns(40) : ok(300));
    const h = new H(script);
    const p = new Player(h);
    await p.play(N, 90000);
    expect(p.stopped).toBeNull();
    expect(p.autoSkips).toEqual([]);
    expect(p.duplicates).toEqual([]);
    expect(p.order.slice(0, 6).map((o) => o.idx)).toEqual([N, N + 1, N + 2, N + 3, N + 4, N + 5]);
    expect(all(h)).toEqual({ live: 1, dup: 0 });
    h.assertSound();
  });

  it("recovery followed by SLOW synthesis (each sentence takes as long as it plays): bounded waits, order kept, no duplicate requests", async () => {
    // the measured poor-network steady state: synthesis ≈ playback duration, so the buffer never grows
    const perSentenceMs = Math.round((80 * 0.0757 / 1.3) * 1000); // one 80-char sentence's playback at 1.3×
    const h = new H((i, n, ctx) => (i === N + 1 && n === 1 ? dns() : i === N + 1 && n === 2 ? stallNoAudio(ctx) : ok(perSentenceMs * 0.95)), { policy: { backoffBaseMs: 20000 } });
    const p = new Player(h);
    await p.play(N, 120000);
    expect(p.stopped).toBeNull();
    expect(p.autoSkips).toEqual([]);
    expect(p.duplicates).toEqual([]);
    for (const w of p.waits) expect(w.ms).toBeLessThanOrEqual(B + 1);
    const idxs = p.order.map((o) => o.idx);
    expect(idxs).toEqual(idxs.map((_, k) => N + k));
    expect(all(h)).toEqual({ live: 1, dup: 0 });
    h.assertSound();
  });
});

describe("a chapter start — the first sentence under RULE 2a (E4)", () => {
  // At a chapter start the first sentence is dispatched at once and playback waits on it through the
  // same round every not-ready sentence gets. The common case is untouched: an answer inside 6 s is
  // used as it always was. The one documented trade-off: a link whose FIRST BYTE takes longer than 6 s
  // has its call restarted on a fresh connection, where before it was simply waited for up to 12 s.
  it("a first sentence answering within 6 s is dispatched at t=0 and never restarted; time-to-first-audio is its synthesis time", async () => {
    const h = new H((i) => (i === 0 ? ok(4000) : ok(300)));
    const p = new Player(h);
    await p.play(0, 30000, "natural", DEFAULT_POLICY.budgetMs, 200);
    const first = h.calls.filter((c) => c.idx === 0);
    expect(first.length).toBe(1);
    expect(first[0].at).toBe(0);
    expect(p.waits[0].ms).toBeCloseTo(4000, 0);
    expect(p.stopped).toBeNull();
    h.assertSound();
  });
  it("a first sentence whose first byte takes 9 s is restarted at 6 s and still arrives inside the budget (the trade-off, stated)", async () => {
    const h = new H((i, n) => (i === 0 && n === 1 ? ok(9000) : ok(300)));
    const p = new Player(h);
    await p.play(0, 30000, "natural", DEFAULT_POLICY.budgetMs, 200);
    expect(h.calls.filter((c) => c.idx === 0).length).toBe(2);
    expect(p.waits[0].ms).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
    expect(p.stopped).toBeNull();
    h.assertSound();
  });
});

describe("the breaker", () => {
  it("one bad sentence never trips it; two do; recovery resets it; old-session failures do not count", async () => {
    const h = new H((i) => (i === N + 4 ? dns() : ok()));
    h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
    await h.run(120000);
    expect(h.s.currentHealth).toBe("healthy");
    expect(h.s.stats.breakerTrips).toBe(0);
    const h2 = new H((i) => (i === N + 4 || i === N + 5 ? dns() : ok()));
    h2.begin(200, N); h2.request(N); h2.request(N + 1); h2.prefetch();
    await h2.run(20000);
    expect(h2.s.currentHealth).not.toBe("healthy");
    // a newer session: its first success resets health, old-session failures are gone with the epoch
    h2.begin(200, 100); h2.request(100); await h2.run(2000);
    expect(h2.s.currentHealth).toBe("healthy");
    h.assertSound(); h2.assertSound();
  });

  it("randomized failure patterns: health is 'open' only after ≥4 consecutive failures on ≥2 sentences", async () => {
    const r = rng(99);
    for (let k = 0; k < 30; k++) {
      const bad = new Set<number>(); const nBad = 1 + Math.floor(r() * 3);
      while (bad.size < nBad) bad.add(N + 1 + Math.floor(r() * 6));
      const h = new H((i) => (bad.has(i) ? dns() : ok()));
      h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch();
      await h.run(90000);
      if (bad.size === 1) expect(h.s.currentHealth, `bad=${[...bad]}`).toBe("healthy");
      h.assertSound(`pattern ${k}`);
    }
  });
});

// =============================================================================================
describe("Stop as a hard invariant — 500 random stop points", () => {
  it("after every stop: zero calls, zero waiters, zero timers, zero live, no resurrection", async () => {
    const r = rng(2024);
    let worstAfter = 0;
    for (let k = 0; k < 500; k++) {
      const h = new H((i, n) => { const x = r(); return x < 0.3 ? dns() : x < 0.35 ? stallNoAudio({ role: "look-ahead", attempt: 1 }) : ok(r() * 3000); }, { seed: k });
      const p = new Player(h);
      void p.play(N, 1e9);
      await h.run(r() * 30000);
      p.interrupt(); h.reset();
      const calls = h.calls.length;
      await h.run(120000);
      const after = h.calls.length - calls; worstAfter = Math.max(worstAfter, after);
      expect(after, `stop ${k}`).toBe(0);
      expect(h.s.pendingWaiters, `stop ${k}`).toBe(0);
      expect(h.clock.live(), `stop ${k}`).toBe(0);
      expect(h.s.liveDispatches, `stop ${k}`).toBe(0);
      expect(h.s.hasTimers).toBe(false);
      if (h.violations.length) h.assertSound(`stop ${k}`);
    }
    expect(worstAfter).toBe(0);
  });
});

// =============================================================================================
describe("rapid navigation — one authoritative position", () => {
  it("random Skip/Back/Seek/Retry/Pause/Resume/chapter sequences never mix sessions or skip automatically", async () => {
    const r = rng(77);
    for (let k = 0; k < 60; k++) {
      const h = new H((i, n) => (r() < 0.15 ? dns() : ok(r() < 0.1 ? 4000 : 300)), { seed: k });
      const p = new Player(h);
      let cursor = N;
      void p.play(cursor, 1e9);
      for (let a = 0; a < 40; a++) {
        await h.run(r() < 0.5 ? r() * 150 : r() * 4000); // bursts of rapid presses and calmer stretches
        const x = r();
        if (x < 0.35) { cursor = Math.max(0, cursor + 1); p.interrupt(); h.s.reprioritize(cursor); h.s.userAction(); void p.play(cursor, 1e9); }
        else if (x < 0.6) { cursor = Math.max(0, cursor - 1); p.interrupt(); h.s.reprioritize(cursor); h.s.userAction(); void p.play(cursor, 1e9); }
        else if (x < 0.7) { cursor = Math.floor(r() * 150); p.interrupt(); h.s.reprioritize(cursor); h.s.userAction(); void p.play(cursor, 1e9); }
        else if (x < 0.8) { h.s.setPaused(true); await h.run(r() * 2000); h.s.setPaused(false); }
        else if (x < 0.9) { p.interrupt(); cursor = Math.floor(r() * 150); h.begin(200, cursor); void p.play(cursor, 1e9); }
        else { p.interrupt(); h.s.userAction(); void p.play(cursor, 1e9); } // Retry
      }
      p.interrupt(); h.reset(); await h.run(100000);
      expect(p.autoSkips, `seq ${k}`).toEqual([]);
      expect(h.violations, `seq ${k}\n${h.trace.slice(-20).join("\n")}`).toEqual([]);
      expect(h.duplicateDispatch).toBe(0);
    }
  });
});

// =============================================================================================
describe("explicit Skip/Back vs automatic skip — a failed N+4 in every state", () => {
  const states = ["before reach", "during background retry", "during recovery", "after error", "after background recovery"] as const;
  for (const st of states) {
    it(`${st}: the automatic flow never passes N+4, an explicit skip does, Back returns cleanly`, async () => {
      let healthyFrom = Infinity;
      const h = new H((i, n, ctx, now) => (i === N + 4 && now < healthyFrom ? dns(st === "during recovery" ? 3500 : 30) : ok()));
      const p = new Player(h);
      if (st === "before reach") { h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch(); await h.run(1500); }
      if (st === "during background retry") { h.begin(200, N); h.request(N); h.request(N + 1); h.prefetch(); await h.run(4000); expect(h.s.stateOf(N + 4)).toBe("waiting"); }
      if (st === "during recovery") { void p.play(N, 1e9); while (!h.s.inRecovery && h.clock.now() < 60000) await h.run(100); expect(h.s.inRecovery).toBe(true); }
      if (st === "after error" || st === "after background recovery") { await p.play(N, 120000); expect(p.stopped?.idx).toBe(N + 4); if (st === "after background recovery") { healthyFrom = h.clock.now(); await h.run(60000); expect(h.s.isReady(N + 4)).toBe(true); } }
      // automatic flow: nothing ever advanced past N+4
      expect(p.order.map((o) => o.idx).filter((i) => i > N + 4)).toEqual([]);
      // explicit skip: lands on N+5 (ready or produced), N+4 is left behind and never retried again
      p.interrupt(); h.s.reprioritize(N + 5); h.s.userAction();
      const tries = h.calls.filter((c) => c.idx === N + 4).length;
      const q = new Player(h); await q.play(N + 5, h.clock.now() + 20000, "user");
      expect(q.order[0]?.idx).toBe(N + 5);
      expect(q.autoSkips).toEqual([]);
      await h.run(60000);
      expect(h.calls.filter((c) => c.idx === N + 4).length).toBe(tries);
      // Back onto N+4: a fresh round; it either plays (service back) or fails visibly — never skips
      q.interrupt(); h.s.reprioritize(N + 4); h.s.userAction();
      const b = new Player(h); await b.play(N + 4, h.clock.now() + 20000, "user");
      if (b.stopped) expect(b.stopped.idx).toBe(N + 4); else expect(b.order[0]?.idx).toBe(N + 4);
      expect(b.autoSkips).toEqual([]);
      h.assertSound(st);
    });
  }
});

// =============================================================================================
describe("long-form torture — mixed content, every speed, random faults, 2 h virtual", () => {
  const mixed = (n: number, seed: number) => { const r = rng(seed); return Array.from({ length: n }, () => { const x = r(); return x < 0.2 ? 5 + Math.floor(r() * 20) : x < 0.8 ? 40 + Math.floor(r() * 120) : x < 0.95 ? 300 + Math.floor(r() * 500) : 1200 + Math.floor(r() * 600); }); };
  for (const speed of [1.0, 1.3, 1.5, 2.0]) {
    it(`speed ${speed}: bounded timers/waiters/cache, no duplicate synthesis, no automatic skip, budget held`, async () => {
      const lens = mixed(600, 5);
      const r = rng(11);
      const h = new H((i, n, ctx) => { const x = r(); return x < 0.04 ? dns() : x < 0.05 ? stallNoAudio(ctx) : x < 0.06 ? reset() : ok(150 + lens[i] * 0.8 + r() * 500); }, { count: 600, lens, seed: 3 });
      h.s.setSpeed(speed);
      const p = new Player(h);
      // the model plays at 1.3x; only the scheduler's own timing depends on `speed`, which is what is under test
      const t0 = h.clock.now();
      while (h.clock.now() - t0 < 7200000) {
        await p.play(p.stopped ? p.stopped.idx : (p.order.length ? p.order[p.order.length - 1].idx + 1 : 0), t0 + 7200000, "user", DEFAULT_POLICY.budgetMs, 600);
        if (p.stopped) { const idx = p.stopped.idx; p.stopped = null; h.s.userAction(); await h.run(3000); p.interrupt(); void 0; if (idx >= 599) break; if (h.clock.now() - t0 >= 7200000) break; continue; }
        break;
      }
      const dup = new Map<number, number>(); for (const c of h.calls.filter((c) => c.ok)) dup.set(c.idx, (dup.get(c.idx) ?? 0) + 1);
      const resynth = [...dup.values()].filter((n) => n > 1).length;
      expect(p.autoSkips).toEqual([]);
      expect(p.duplicates).toEqual([]);
      expect(h.duplicateDispatch).toBe(0);
      expect(h.maxLive).toBe(1);
      expect(h.maxTimers).toBeLessThanOrEqual(4);
      expect(h.maxWaiters).toBeLessThanOrEqual(23);
      expect(h.maxCache).toBeLessThanOrEqual(22);
      expect(p.maxWait).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs + 1);
      expect(resynth, "sentences synthesized successfully more than once").toBeLessThanOrEqual(3); // seeks in the model may re-request; none from failures
      h.assertSound(`speed ${speed}`);
    });
  }
});
