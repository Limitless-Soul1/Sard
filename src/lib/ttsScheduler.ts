// RAWY-231: the read-aloud synthesis SCHEDULER — the structural home of three of the five stall-fix
// invariants (DECISIONS D60). The read-aloud engine is SERIALIZED and SINGLE-SOCKET (one warm Edge
// WebSocket behind a mutex); the RAWY-191 connection pool stays REVERTED. This
// class does NOT add parallelism — it ORDERS the work on that one queue so the sentence the user is waiting
// for is never stuck behind speculative look-ahead:
//
//   • SINGLE-FLIGHT — at most ONE synth is dispatched to the engine at a time (mirrors the Rust mutex, and
//     lets us choose WHICH sentence goes next instead of racing four `invoke`s that the OS mutex serves in
//     arbitrary order — the STEP-1 root of the "second sentence" stall).
//   • PRIORITY (invariant B) — the next dispatch is always the highest-priority WANTED sentence:
//     current > next(the one-ahead lead) > look-ahead. Look-ahead never occupies the engine while the
//     current or next sentence is still pending.
//   • DROP-ON-MOVE (invariant C) — when the cursor moves (`reprioritize`), un-started look-ahead for the old
//     position is dropped, so the new landing sentence is the very next thing dispatched. It waits behind at
//     most the ONE synth already in flight, never a backlog of abandoned work. True cancellation of the
//     in-flight Edge synth is deliberately NOT done here — it would mean touching the socket lifecycle the
//     ENGINE CAUTION forbids; single-flight bounds the residual to one request, which is what invariant C's
//     fallback clause asks for.
//
// The class is PURE — no Tauri, WebAudio, or DOM — so the invariants can be exercised headless with
// injected latencies (RAWY-231 STEP 2 did so before wiring): a structural property, not a timing accident.

export interface SchedulerConfig<T = unknown> {
  /** Keep this many already-played sentences resolvable (a one-step skip-back stays instant). */
  behind: number;
  /** Look-ahead depth beyond the current sentence (includes the one-ahead lead).
   *  RAWY-257 4B (A2): with `targetSeconds` set this is no longer the policy — it is the HARD UNIT CAP that
   *  keeps the window O(1) when units are pathologically short. SECONDS govern; this only stops them from
   *  buying an unbounded NUMBER of entries. */
  ahead: number;
  /** RAWY-257 4B (A2): seconds of DECODED audio to keep ahead of the cursor. Unset / 0 keeps the pre-4B
   *  pure-unit behaviour exactly, which is what the headless A/B compares against. */
  targetSeconds?: number;
  /** RAWY-257 4B: the level below which the lead is considered at risk. REPORTED ONLY — deliberately NOT a
   *  refill gate; see `wantedAhead()` for why a hysteresis trigger would make cover WORSE here. */
  lowWaterSeconds?: number;
  /** RAWY-257 4B (A2): how to read a decoded entry's duration in seconds. INJECTED so the class stays PURE —
   *  it must not learn what an `AudioBuffer` is, because being WebAudio-free is what makes it gateable
   *  headless with injected latencies. */
  durationOf?: (v: T) => number;
  /** RAWY-257 4B (A2): a dispatch settled, so the DECODED lead just changed and the owner may now be able to
   *  justify exactly ONE more index. The scheduler cannot request it itself — it does not know how long the
   *  chapter is. Fired before the pump so the new want can be dispatched in the same release. */
  onSettled?: () => void;
  /** RAWY-231 (E): called when an in-flight synth's result is discarded (cursor moved away OR epoch changed). */
  onAbandon?: () => void;
}

// ---- RAWY-257 Phase 1: latency instrumentation ----
// A bounded numeric series. Phase 1 needs TWO of these kept SEPARATE (roadmap §6 Phase 1, work item 3):
//   • DISPATCH→SETTLE — how long the engine actually took (the real network cost). Owned by the scheduler,
//     the only thing that knows when a synth was handed to the engine.
//   • AWAIT→SETTLE — how long PLAYBACK waited for that sentence. Owned by tts.ts `playFrom`.
// Their DIFFERENCE is QUEUE WAIT, and that difference is the empirical proof of C2: `playFrom`'s timeout is
// applied to the AWAIT series, so it can fire for time the engine never spent working. One merged series
// would hide exactly the quantity this phase exists to measure.
// The ring is bounded (SERIES_KEEP) so it cannot grow — RAWY-172's memory invariant applies here too.
const SERIES_KEEP = 100;
export interface LatencySeries { n: number; sum: number; min: number; max: number; last: number; samples: number[] }
export const newSeries = (): LatencySeries => ({ n: 0, sum: 0, min: Infinity, max: 0, last: 0, samples: [] });
export function recordSeries(s: LatencySeries, ms: number): void {
  s.n++;
  s.sum += ms;
  s.last = ms;
  if (ms < s.min) s.min = ms;
  if (ms > s.max) s.max = ms;
  s.samples.push(Math.round(ms));
  if (s.samples.length > SERIES_KEEP) s.samples.shift();
}
export function resetSeries(s: LatencySeries): void {
  s.n = 0;
  s.sum = 0;
  s.min = Infinity;
  s.max = 0;
  s.last = 0;
  s.samples.length = 0;
}
/** Readable summary incl. percentiles over the retained ring — this is the "measured distribution" D70
 *  requires before the 8 s / 9 s ceiling may stop being PROVISIONAL. `null` when nothing was sampled. */
export function seriesSummary(s: LatencySeries): { n: number; avg: number; min: number; max: number; last: number; p50: number; p95: number } | null {
  if (s.n === 0) return null;
  const sorted = [...s.samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return { n: s.n, avg: Math.round(s.sum / s.n), min: Math.round(s.min), max: Math.round(s.max), last: Math.round(s.last), p50: at(0.5), p95: at(0.95) };
}

// ---- The scheduler ----------------------------------------------------------------------------------
//
// FAILURE ISOLATION. Before this, a look-ahead sentence whose synthesis failed was kept as a rejected
// entry: nothing after it was requested (`wantedAhead` stopped at the first not-ready index), it was never
// re-attempted, and when playback reached it the rejected promise stopped the session with the
// "Edge unavailable" pause — even when the service had recovered minutes earlier. Measured on the real
// application: a unit that failed as look-ahead ended the session the instant playback reached it, with
// no new attempt made. Two rules replace that:
//
//   RULE 1 — a required sentence that failed while it is still AHEAD of playback is never abandoned and
//   never skipped. It is re-attempted with growing backoff (no count limit; the attempt RATE is bounded
//   by time), timed so the last chance comes before playback arrives, and sentences beyond it are still
//   prepared within a bounded work window — as future work, never as a replacement.
//
//   RULE 2 — when playback reaches a sentence that is not ready, it gets ONE recovery round: a total
//   user-facing budget (`budgetMs`, 12 s) holding up to `maxRecoveryAttempts` fresh attempts, each with
//   the budget's remainder as its deadline. If the round fails, the failure is surfaced and playback
//   stays on that exact sentence; background attempts continue (RULE 1) so a Retry is instant once the
//   service is back. Nothing ever advances past it automatically.
//
//   RULE 2a — THE FIRST ATTEMPT OF A ROUND MAY NOT SPEND MORE THAN HALF THE BUDGET IN SILENCE. The
//   engine's own first-audio window floors at 12 s, the whole budget, so a connection that opened and
//   then sent nothing used to be declared stalled only when the budget itself ran out — measured in real
//   listening on a poor link: "recovery failed (budget) after 1 attempt(s)", a 12,002 ms gap, and the
//   listener pressing Retry. The round's promised attempts never happened. So the first fresh attempt
//   carries `firstAudioMs = budget / 2`, and a call that was already in flight when the round began (it
//   counts as the first attempt) is asked to yield at the same point if it has not answered. Either way
//   the second attempt starts with at least half the budget, on a fresh connection. The invariant this
//   keeps: a round that can make a second attempt always does; the total budget is never exceeded
//   (the hard timer is untouched); a call that is producing audio is never cut for this — the cap bounds
//   silence, not streaming — and the single-flight rule holds, since the yield is cooperative and the
//   next attempt only starts once the engine has settled.
//
// Playback order is structural: `recover(i)` waits on sentence i and nothing else, so a ready i+1 can
// never be played before i. The engine stays SINGLE-FLIGHT (D60): one dispatch at a time, chosen by
// how soon playback needs it. A cancel is COOPERATIVE: the scheduler only asks (`onCancel`) when a
// session ends or the sentence the listener is waiting on needs an engine another sentence is holding;
// the engine drops the connection at its next message.
//
// Two measures are kept apart on purpose: `bufferedSecondsAhead` is CONTIGUOUS ready audio (how long
// until silence), and `workSet` is how far the scheduler may synthesize, which can reach past a
// waiting sentence. A failed N+4 must not make those two indistinguishable.

/** Why a dispatch is being made — the engine's bounds depend on it (a recovery attempt carries the
 *  listener's remaining budget; background work is bounded on progress instead). */
export interface DispatchContext {
  role: "current" | "lead" | "look-ahead" | "retry" | "probe" | "recovery";
  /** Present only for a recovery attempt: what is left of the user-facing budget, in ms. */
  budgetMs?: number;
  /**
   * Present only for the FIRST fresh attempt of a recovery round: how long that attempt may go without a
   * first audio byte before the engine declares it stalled — half the round's budget. See RULE 2a.
   */
  firstAudioMs?: number;
  attempt: number;
}

/** Injected so every timing rule can be exercised on a virtual clock. */
export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface SchedulerConfig<T = unknown> {
  behind: number;
  /** The O(1) safety cap on look-ahead, in sentences (RAWY-257 4B). */
  ahead: number;
  /** The lead target in seconds of REAL listening time; multiplied by `speed` to get audio seconds. */
  targetSeconds?: number;
  lowWaterSeconds?: number;
  durationOf?: (v: T) => number;
  /** Seconds of audio a not-yet-ready sentence is estimated to hold (from its text). */
  estimateOf?: (idx: number) => number;
  onSettled?: () => void;
  onAbandon?: () => void;
  /** Ask the engine to abandon the call in flight (it returns as cancelled). `why` names the cause. */
  onCancel?: (why: "session" | "recovery" | "preempt", inflight: number) => void;
  /**
   * RULE 2a: whether the call in flight has already produced audio. Consulted before an adopted call is
   * asked to yield at the round's half-way point — a silent call is dropped for a fresh attempt, a call
   * that is streaming is left to finish. Absent, the yield is unconditional.
   */
  isStreaming?: () => Promise<boolean> | boolean;
  isPermanent?: (err: unknown) => boolean;
  isCancelled?: (err: unknown) => boolean;
  isFastReset?: (err: unknown, ms: number) => boolean;
  clock?: SchedulerClock;
  random?: () => number;
  policy?: Partial<SchedulerPolicy>;
}

export interface SchedulerPolicy {
  /** Sentences the work window may reach PAST the first waiting one. */
  pastGap: number;
  /** Extra seconds of audio the work window may hold beyond the lead target when it reaches past a gap. */
  extraSeconds: number;
  /** RULE 2: the total user-facing budget for one recovery round. */
  budgetMs: number;
  /** No recovery attempt starts with less than this left (a cold connect alone takes ~2.7 s). */
  minAttemptMs: number;
  /** Spacing before recovery attempts 1, 2, 3 … */
  recoverySpacing: number[];
  maxRecoveryAttempts: number;
  /** RULE 1 backoff: 2 s doubling to this cap. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A background attempt is scheduled at least this long before playback would need the sentence. */
  leadMarginMs: number;
  /** After a failed recovery round (or while paused) background attempts continue this long. */
  backgroundLimitMs: number;
  /** Outage breaker: consecutive failed calls across ≥2 sentences → degraded; this many → open. */
  degradedAfter: number;
  openAfter: number;
  /** Minimum backoff while degraded. */
  degradedFloorMs: number;
  /** While open: one probe at most this often. */
  probeMs: number;
  /** No speculative work past a waiting sentence that is due within this — a look-ahead call would only
   *  delay an attempt that is about to start anyway. Small: a healthy call takes ~0.5–2 s. */
  reserveMs: number;
  /** A due retry PREEMPTS a look-ahead call (cooperative cancel) when its sentence is needed within this. */
  preemptWindowMs: number;
  /** After a failed recovery round the sentence is re-attempted in the background this soon. */
  postRecoveryRetryMs: number;
}

export const DEFAULT_POLICY: SchedulerPolicy = {
  pastGap: 4,
  extraSeconds: 15,
  budgetMs: 12_000,
  minAttemptMs: 1_500,
  recoverySpacing: [0, 250, 750],
  maxRecoveryAttempts: 3,
  backoffBaseMs: 2_000,
  backoffMaxMs: 30_000,
  leadMarginMs: 3_000,
  backgroundLimitMs: 600_000,
  degradedAfter: 2,
  openAfter: 4,
  degradedFloorMs: 5_000,
  probeMs: 30_000,
  reserveMs: 1_500,
  preemptWindowMs: 20_000,
  postRecoveryRetryMs: 2_000,
};

/** The marker a failed recovery round rejects with. It is the frontend's `TTS_EDGE_DOWN`; the two are
 *  pinned equal by test, and this module cannot import it without a cycle. */
export const RECOVERY_FAILED = "edge-unavailable";
/** The marker a cancelled recovery (the listener moved on) rejects with — a scheduling event, never a
 *  synthesis failure, so it must not contain anything `classifyFailure` keys on. */
export const RECOVERY_CANCELLED = "tts.recoveryCancelled";
// RAWY-257 4A (A3): the rejection reason a DROPPED entry carries — an index removed from the cache before
// it was ready. Deliberately NOT exported and deliberately digit-free: a drop is a scheduling event, not a
// synthesis failure.
const DROPPED = "tts.dropped";

export type EntryState = "queued" | "inflight" | "ready" | "waiting" | "dead";
export type Health = "healthy" | "degraded" | "open";

interface Entry<T> {
  idx: number;
  state: EntryState;
  /** Consecutive RULE-1 failures (drives the backoff). */
  failures: number;
  /** When a waiting entry may be attempted again. */
  retryAt: number;
  /** Identifies the attempt whose result may still count; a re-dispatch invalidates the previous one. */
  token: number;
  value?: T;
  lastError?: unknown;
  resetRetried: boolean;
  /** `request()` callers waiting for READY. */
  waiters: { resolve: (v: T) => void; reject: (e: unknown) => void }[];
}

interface Recovery<T> {
  idx: number;
  t0: number;
  attempts: number;
  nextAt: number;
  hardTimer: unknown;
  /** RULE 2a for an adopted in-flight call: the moment it is asked to yield if it has not answered. */
  yieldTimer: unknown;
  lastError: unknown;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

const defaultClock: SchedulerClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class SynthScheduler<T> {
  private cache = new Map<number, Entry<T>>();
  private prio = 0;
  private count = 0;
  private running = false;
  private epoch = 0;
  private inflightIdx = -1;
  private inflightToken = 0;
  private inflightRole: DispatchContext["role"] | null = null;
  private preemptedToken = -1;
  private live = 0; // dispatches actually outstanding right now (survives clearCache — see pump)
  private paused = false;
  private pausedAt = 0;
  private bgUntil = Infinity;
  private speed = 1;
  private rec: Recovery<T> | null = null;
  private wakeTimer: unknown = null;
  private wakeAt = Infinity;
  private health: Health = "healthy";
  private consecutiveFailures = 0;
  private failedUnits = new Set<number>();
  private lastProbeAt = -Infinity;
  private readonly clock: SchedulerClock;
  private readonly random: () => number;
  private readonly policy: SchedulerPolicy;
  abandoned = 0;
  abandonedEpoch = 0;
  maxConcurrent = 0;
  readonly dispatchLatency: LatencySeries = newSeries();
  /** Counters for the diagnostics readout and the listening-outcome recorder. */
  readonly stats = { futureRetries: 0, recoveries: 0, recoverySuccesses: 0, cancelled: 0, probes: 0, resetRetries: 0, breakerTrips: 0 };

  constructor(
    private readonly dispatch: (idx: number, ctx: DispatchContext) => Promise<T>,
    private readonly cfg: SchedulerConfig<T>,
  ) {
    this.clock = cfg.clock ?? defaultClock;
    this.random = cfg.random ?? Math.random;
    this.policy = { ...DEFAULT_POLICY, ...(cfg.policy ?? {}) };
  }

  // ---- readouts -------------------------------------------------------------------------------------
  get priority(): number { return this.prio; }
  get inFlight(): number { return this.inflightIdx; }
  get size(): number { return this.cache.size; }
  get liveDispatches(): number { return this.live; }
  get currentHealth(): Health { return this.health; }
  get inRecovery(): boolean { return this.rec !== null; }
  get failedCount(): number {
    let n = 0;
    for (const [, e] of this.cache) if (e.state === "waiting" || e.state === "dead") n++;
    return n;
  }
  get queueDepth(): number {
    let n = 0;
    for (const [, e] of this.cache) if (e.state === "queued") n++;
    return n;
  }
  stateOf(i: number): EntryState | undefined { return this.cache.get(i)?.state; }
  isReady(i: number): boolean { return this.cache.get(i)?.state === "ready"; }
  /** A `request()`/`recover()` caller still waiting — must be 0 after `reset()`. */
  get pendingWaiters(): number {
    let n = this.rec ? 1 : 0;
    for (const [, e] of this.cache) n += e.waiters.length;
    return n;
  }
  get hasTimers(): boolean { return this.wakeTimer !== null || (this.rec !== null && this.rec.hardTimer !== null); }

  /** The structural invariants, checkable at any instant. Returns the violations (empty = sound). The
   *  tests call it after every event; a development build calls it after every settle. */
  checkInvariants(): string[] {
    const v: string[] = [];
    if (this.live > 1) v.push(`live=${this.live} (single-flight)`);
    let inflight = 0;
    for (const [idx, e] of this.cache) {
      if (e.idx !== idx) v.push(`entry ${idx} carries idx ${e.idx}`);
      if (e.state === "inflight") inflight++;
      if (e.state === "ready" && e.value === undefined) v.push(`ready ${idx} without a value`);
      if (e.state === "ready" && e.waiters.length) v.push(`ready ${idx} still has waiters`);
      if (e.state === "dead" && e.waiters.length) v.push(`dead ${idx} still has waiters`);
      if (idx < this.prio - this.cfg.behind || idx > this.prio + this.cfg.ahead) v.push(`entry ${idx} outside the window around ${this.prio}`);
    }
    if (inflight > 1) v.push(`${inflight} entries in flight`);
    if (inflight > this.live) v.push(`inflight entries (${inflight}) exceed live dispatches (${this.live})`);
    if (this.cache.size > this.cfg.behind + this.cfg.ahead + 1) v.push(`cache ${this.cache.size} over its bound`);
    if (!this.running && this.rec) v.push("recovery round while not running");
    if (!this.running && this.wakeTimer !== null) v.push("wake timer while not running");
    if (this.rec && this.rec.idx !== this.prio) v.push(`recovery for ${this.rec.idx} while the cursor is ${this.prio}`);
    return v;
  }

  // ---- session --------------------------------------------------------------------------------------
  /** A new queue: `count` sentences, playback starting at `cursor`. Nothing is dispatched before this. */
  begin(count: number, cursor: number): void {
    this.clearCache();
    this.count = count;
    this.prio = Math.max(0, cursor);
    this.running = true;
    this.paused = false;
    this.bgUntil = Infinity;
    // A new queue is a user action: an open breaker may probe at once rather than wait out its interval —
    // otherwise a chapter change during an outage that has since ended would sit silent for up to 30 s.
    this.lastProbeAt = -Infinity;
    this.pump();
  }
  setSpeed(speed: number): void {
    this.speed = speed > 0 ? speed : 1;
    this.pump();
  }
  setPaused(paused: boolean): void {
    if (paused && !this.paused) this.pausedAt = this.clock.now();
    this.paused = paused;
    if (!paused) this.bgUntil = Infinity;
    this.pump();
  }
  /** The listener acted (Retry, Play, a skip): the background limit lifts and waiting sentences become
   *  eligible now, so a service that has quietly recovered is found at once. */
  userAction(): void {
    this.bgUntil = Infinity;
    const now = this.clock.now();
    for (const [, e] of this.cache) if (e.state === "waiting") e.retryAt = Math.min(e.retryAt, now);
    if (this.health === "open") this.lastProbeAt = -Infinity;
    this.pump();
  }

  request(i: number): Promise<T> {
    if (!this.running) return Promise.reject(new Error(DROPPED));
    const e = this.entry(i);
    if (e.state === "ready") return Promise.resolve(e.value as T);
    if (e.state === "dead") return Promise.reject(e.lastError ?? new Error("permanent"));
    const p = new Promise<T>((resolve, reject) => e.waiters.push({ resolve, reject }));
    p.catch(() => {}); // an unobserved waiter (prefetch) must never surface as an unhandled rejection
    this.pump();
    return p;
  }

  reprioritize(i: number): void {
    this.prio = i;
    if (this.rec && this.rec.idx !== i) this.cancelRecovery(RECOVERY_CANCELLED);
    this.trim();
    this.pump();
  }

  /** RULE 2. Resolves with the sentence once it is ready; rejects `RECOVERY_FAILED: …` when the round is
   *  exhausted, or `RECOVERY_CANCELLED` if playback moved on. The sentence itself is never skipped here:
   *  the caller decides only between "surface the failure" and "play". */
  recover(i: number, budgetMs = this.policy.budgetMs): Promise<T> {
    // No session (after `reset()`/`hold()`, before `begin()`): nothing may be dispatched, so a stray
    // wait is answered as a scheduling event rather than starting work for a queue that does not exist.
    if (!this.running) return Promise.reject(new Error(RECOVERY_CANCELLED));
    const e = this.entry(i);
    if (e.state === "ready") return Promise.resolve(e.value as T);
    if (e.state === "dead") return Promise.reject(new Error(`${RECOVERY_FAILED}: ${String(e.lastError)}`));
    this.cancelRecovery(RECOVERY_CANCELLED);
    return new Promise<T>((resolve, reject) => {
      const t0 = this.clock.now();
      const rec: Recovery<T> = { idx: i, t0, attempts: 0, nextAt: t0, hardTimer: null, yieldTimer: null, lastError: e.lastError, resolve, reject };
      // The budget is a HARD ceiling on the listener's wait, whatever the engine does.
      rec.hardTimer = this.clock.setTimeout(() => { rec.hardTimer = null; this.failRecovery("budget"); }, budgetMs);
      (rec as Recovery<T> & { budgetMs: number }).budgetMs = budgetMs;
      this.rec = rec;
      this.stats.recoveries++;
      if (e.state === "inflight") {
        // A call already producing this sentence is the most advanced attempt there is: it counts as the
        // first. It was dispatched as background work, so the engine bounds it on progress (a first-audio
        // window of at least the whole budget) — RULE 2a therefore asks it to yield at the half-way point
        // if it has still not answered, so a fresh attempt gets the other half. If it answers first, the
        // timer is cleared with the round.
        rec.attempts = 1;
        const token = e.token;
        rec.yieldTimer = this.clock.setTimeout(() => {
          rec.yieldTimer = null;
          const stillIt = () => this.rec === rec && e.state === "inflight" && e.token === token && this.inflightIdx === i;
          if (!stillIt()) return;
          // The cap bounds SILENCE, never a running stream — on this path too. A call that has begun to
          // stream is left to finish inside the hard timer; only a silent one is dropped for a fresh attempt.
          const yieldIfSilent = (streaming: boolean) => {
            if (streaming || !stillIt()) return;
            this.stats.cancelled++;
            this.cfg.onCancel?.("recovery", i);
          };
          const probe = this.cfg.isStreaming?.();
          if (probe && typeof (probe as Promise<boolean>).then === "function") (probe as Promise<boolean>).then(yieldIfSilent, () => yieldIfSilent(false));
          else yieldIfSilent(!!probe);
        }, Math.round(budgetMs / 2));
      } else if (this.live > 0 && this.inflightIdx !== i) {
        // The engine is busy with another sentence: ask it to yield so this attempt starts now.
        this.stats.cancelled++;
        this.cfg.onCancel?.("recovery", this.inflightIdx);
      }
      if (e.state === "waiting") e.retryAt = t0;
      this.pump();
    });
  }

  /** Between sessions: nothing may be dispatched until `begin()` hands over the next queue. Drops the
   *  cache like `clearCache()` (cancelling a call in flight) but keeps the session counters. */
  hold(): void {
    this.running = false;
    this.clearCache();
  }

  clearCache(): void {
    this.epoch++;
    this.cancelRecovery(RECOVERY_CANCELLED);
    if (this.live > 0) { this.stats.cancelled++; this.cfg.onCancel?.("session", this.inflightIdx); }
    for (const [idx, e] of this.cache) this.drop(idx, e);
    this.cache.clear();
    // The cursor is left where it is: the caller re-points it (begin / reprioritize) before any wait, and
    // a pump in between must not dispatch sentence 0 of a chapter the listener is in the middle of.
    this.inflightIdx = -1;
    this.bgUntil = Infinity;
    this.clearWake();
  }

  reset(): void {
    this.running = false;
    this.clearCache();
    this.abandoned = 0;
    this.abandonedEpoch = 0;
    this.maxConcurrent = 0;
    this.health = "healthy";
    this.consecutiveFailures = 0;
    this.failedUnits.clear();
    this.lastProbeAt = -Infinity;
    resetSeries(this.dispatchLatency);
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
  }

  // ---- windows --------------------------------------------------------------------------------------
  private leadAudioSeconds(): number {
    return (this.cfg.targetSeconds ?? 0) * this.speed;
  }
  private secondsOf(i: number): number {
    const e = this.cache.get(i);
    if (e?.state === "ready" && e.value !== undefined && this.cfg.durationOf) return this.cfg.durationOf(e.value);
    return this.cfg.estimateOf?.(i) ?? 0;
  }
  /** CONTIGUOUS ready audio ahead of the cursor — stops at the first sentence that is not ready. */
  bufferedSecondsAhead(): number {
    if (!this.cfg.durationOf) return 0;
    let secs = 0;
    for (let k = 1; k <= this.cfg.ahead; k++) {
      const e = this.cache.get(this.prio + k);
      if (!e || e.state !== "ready" || e.value === undefined) break;
      secs += this.cfg.durationOf(e.value);
    }
    return secs;
  }
  /** How many sentences ahead the CONTIGUOUS lead wants (the readout kept from RAWY-257 4B). */
  wantedAhead(): number {
    const target = this.leadAudioSeconds();
    if (!this.cfg.durationOf || target <= 0) return this.cfg.ahead;
    let secs = 0;
    for (let k = 1; k <= this.cfg.ahead; k++) {
      const e = this.cache.get(this.prio + k);
      if (!e || e.state !== "ready" || e.value === undefined) return k;
      secs += this.cfg.durationOf(e.value);
      if (secs >= target) return k;
    }
    return this.cfg.ahead;
  }
  /** The sentences the scheduler may synthesize now: the lead, and — while healthy — a bounded stretch
   *  PAST the first sentence that is not ready, so one failure does not idle the engine. */
  workSet(): number[] {
    const target = this.leadAudioSeconds();
    const last = Math.min(this.count - 1, this.prio + this.cfg.ahead);
    const lead: number[] = [];
    let acc = 0;
    for (let k = this.prio + 1; k <= last && (target <= 0 || acc < target); k++) {
      lead.push(k);
      acc += this.secondsOf(k);
    }
    const gap = lead.find((j) => !this.isReady(j));
    if (gap === undefined) return lead;
    if (this.health !== "healthy") return lead.filter((j) => j <= gap || this.isReady(j));
    const out = lead.filter((j) => j <= gap);
    let acc2 = 0;
    for (let k = this.prio + 1; k <= gap; k++) acc2 += this.secondsOf(k);
    for (let j = gap + 1; j <= gap + this.policy.pastGap && j <= last; j++) {
      if (acc2 >= target + this.policy.extraSeconds) break;
      acc2 += this.secondsOf(j);
      out.push(j);
    }
    return out;
  }
  /** When playback would reach sentence j, on the current clock (Infinity while paused). */
  private needAt(j: number): number {
    if (this.paused) return Infinity;
    let secs = 0;
    for (let k = this.prio; k < j; k++) secs += this.secondsOf(k); // conservative: all of the current sentence
    return this.clock.now() + (secs / this.speed) * 1000;
  }

  // ---- entries --------------------------------------------------------------------------------------
  private entry(i: number): Entry<T> {
    let e = this.cache.get(i);
    if (!e) {
      e = { idx: i, state: "queued", failures: 0, retryAt: 0, token: 0, resetRetried: false, waiters: [] };
      this.cache.set(i, e);
    }
    return e;
  }
  private drop(idx: number, e: Entry<T>): void {
    this.cache.delete(idx);
    // RAWY-257 4A: settle-before-drop — never orphan an awaiter. A started entry's result is matched
    // by token and epoch and discarded as abandoned.
    for (const w of e.waiters) w.reject(new Error(DROPPED));
    e.waiters = [];
  }
  private trim(): void {
    for (const [idx, e] of this.cache) {
      if (idx < this.prio - this.cfg.behind || idx > this.prio + this.cfg.ahead) this.drop(idx, e);
      else if (idx < this.prio && e.state !== "ready") this.drop(idx, e); // never re-attempted behind the cursor
    }
  }

  // ---- choosing the next dispatch -------------------------------------------------------------------
  private futureAllowed(): boolean {
    const now = this.clock.now();
    if (now > this.bgUntil) return false;
    if (this.paused && now - this.pausedAt > this.policy.backgroundLimitMs) return false;
    return true;
  }
  private pick(): { idx: number; ctx: DispatchContext } | { wakeAt: number } | null {
    const now = this.clock.now();
    if (this.rec) {
      const r = this.rec;
      const budget = (r as Recovery<T> & { budgetMs: number }).budgetMs;
      if (r.attempts >= this.policy.maxRecoveryAttempts) { this.failRecovery("attempts"); return null; }
      const left = r.t0 + budget - now;
      if (left < this.policy.minAttemptMs) { this.failRecovery("budget"); return null; }
      if (now < r.nextAt) return { wakeAt: r.nextAt };
      const e = this.cache.get(r.idx);
      if (!e || e.state === "inflight" || e.state === "ready" || e.state === "dead") return null;
      // RULE 2a: only the round's first attempt is capped; a later one already has at most half the budget.
      const firstAudioMs = r.attempts === 0 ? Math.round(budget / 2) : undefined;
      return { idx: r.idx, ctx: { role: "recovery", budgetMs: Math.round(left), attempt: r.attempts + 1, ...(firstAudioMs !== undefined ? { firstAudioMs } : {}) } };
    }
    if (!this.running || !this.futureAllowed()) return null;
    const list = this.cache.get(this.prio)?.state === "ready" ? this.workSet() : [this.prio, ...this.workSet()];
    if (this.health === "open") {
      const j = list.find((k) => { const s = this.stateOf(k); return s !== "ready" && s !== "dead" && s !== "inflight"; });
      if (j === undefined) return null;
      const at = Math.max(this.lastProbeAt + this.policy.probeMs, this.cache.get(j)?.retryAt ?? 0);
      if (now < at) return { wakeAt: at };
      return { idx: j, ctx: { role: "probe", attempt: (this.cache.get(j)?.failures ?? 0) + 1 } };
    }
    let firstWaiting: Entry<T> | undefined;
    let wakeAt = Infinity;
    for (const j of list) {
      const e = this.cache.get(j);
      if (e && (e.state === "ready" || e.state === "inflight" || e.state === "dead")) continue;
      if (e && e.state === "waiting") {
        if (!firstWaiting) firstWaiting = e;
        if (now < e.retryAt) { wakeAt = Math.min(wakeAt, e.retryAt); continue; }
        return { idx: j, ctx: { role: "retry", attempt: e.failures + 1 } };
      }
      if (firstWaiting && j > firstWaiting.idx) {
        // Keep the engine free for a waiting sentence that is due soon: a look-ahead call could hold
        // it for its whole bound just as that sentence's last chance comes.
        if (firstWaiting.retryAt <= now + this.policy.reserveMs) continue;
        return { idx: j, ctx: { role: "look-ahead", attempt: 1 } };
      }
      return { idx: j, ctx: { role: j === this.prio ? "current" : j === this.prio + 1 ? "lead" : "look-ahead", attempt: 1 } };
    }
    return Number.isFinite(wakeAt) ? { wakeAt } : null;
  }

  private clearWake(): void {
    if (this.wakeTimer !== null) { this.clock.clearTimeout(this.wakeTimer); this.wakeTimer = null; this.wakeAt = Infinity; }
  }
  private pump(): void {
    // RAWY-257 2C (C4): gate on `live`, the count of dispatches ACTUALLY OUTSTANDING — single-flight
    // stays true across an epoch change, which is the one case it never held.
    if (this.live > 0) { this.whileBusy(); return; }
    const p = this.pick();
    if (!p || !("wakeAt" in p) || p.wakeAt !== this.wakeAt) this.clearWake();
    if (!p) return;
    if ("wakeAt" in p) {
      if (this.wakeTimer === null) {
        this.wakeAt = p.wakeAt;
        this.wakeTimer = this.clock.setTimeout(() => { this.wakeTimer = null; this.wakeAt = Infinity; this.pump(); }, Math.max(0, p.wakeAt - this.clock.now()));
      }
      return;
    }
    this.start(p.idx, p.ctx);
  }

  /** The engine is busy. A waiting sentence that becomes due while a LOOK-AHEAD call holds the engine
   *  preempts it (cooperatively) when playback will need that sentence soon; otherwise a wake is armed
   *  for the moment it becomes due, so the decision is made then rather than when the call ends. */
  private whileBusy(): void {
    if (this.rec || !this.running) return; // a recovery round already owns the engine's next slot
    const now = this.clock.now();
    let due: Entry<T> | undefined;
    let earliest = Infinity;
    for (const j of [this.prio, ...this.workSet()]) {
      const e = this.cache.get(j);
      if (!e || e.state !== "waiting") continue;
      if (e.retryAt <= now) { if (!due || j < due.idx) due = e; }
      else earliest = Math.min(earliest, e.retryAt);
    }
    if (due && (this.inflightRole === "look-ahead" || this.inflightRole === "probe") && due.idx < this.inflightIdx
        && this.inflightToken !== this.preemptedToken && this.needAt(due.idx) - now <= this.policy.preemptWindowMs) {
      this.preemptedToken = this.inflightToken;
      this.stats.cancelled++;
      this.cfg.onCancel?.("preempt", this.inflightIdx);
      return;
    }
    if (Number.isFinite(earliest) && earliest < this.wakeAt) {
      this.clearWake();
      this.wakeAt = earliest;
      this.wakeTimer = this.clock.setTimeout(() => { this.wakeTimer = null; this.wakeAt = Infinity; this.pump(); }, Math.max(0, earliest - now));
    }
  }

  private start(i: number, ctx: DispatchContext): void {
    const e = this.entry(i);
    e.state = "inflight";
    const token = ++e.token;
    const myEpoch = this.epoch;
    this.inflightIdx = i;
    this.inflightToken = token;
    this.inflightRole = ctx.role;
    if (ctx.role === "probe") { this.lastProbeAt = this.clock.now(); this.stats.probes++; }
    if (ctx.role === "retry") this.stats.futureRetries++;
    // A recovery attempt is counted when it STARTS, so the round's count is right while it is in flight
    // (the hard timer reported "after 0 attempt(s)" for a round whose only attempt was still running).
    if (ctx.role === "recovery" && this.rec && this.rec.idx === i) this.rec.attempts = ctx.attempt;
    const t0 = this.clock.now();
    this.live++;
    if (this.live > this.maxConcurrent) this.maxConcurrent = this.live;
    void this.dispatch(i, ctx).then(
      (v) => this.settle(e, token, myEpoch, t0, ctx, null, v),
      (err) => this.settle(e, token, myEpoch, t0, ctx, err ?? new Error("dispatch rejected"), undefined),
    );
  }

  private settle(e: Entry<T>, token: number, myEpoch: number, t0: number, ctx: DispatchContext, err: unknown, v: T | undefined): void {
    const now = this.clock.now();
    recordSeries(this.dispatchLatency, now - t0);
    this.live--;
    if (myEpoch === this.epoch && this.inflightToken === token) { this.inflightIdx = -1; this.inflightRole = null; }
    const stale = myEpoch !== this.epoch || this.cache.get(e.idx) !== e || e.token !== token;
    if (stale) {
      // RAWY-257 (C10): the epoch moved or the entry was dropped under this dispatch; its result is
      // thrown away and counted — an abandoned dispatch still consumed the engine.
      this.abandoned++;
      if (myEpoch !== this.epoch) this.abandonedEpoch++;
      this.cfg.onAbandon?.();
      this.afterSettle();
      return;
    }
    if (err === null) {
      e.state = "ready";
      e.value = v;
      e.lastError = undefined;
      e.resetRetried = false;
      this.recovered();
      for (const w of e.waiters) w.resolve(v as T);
      e.waiters = [];
      if (this.rec && this.rec.idx === e.idx) this.succeedRecovery(v as T);
      this.afterSettle();
      return;
    }
    if (this.cfg.isCancelled?.(err)) {
      // The engine yielded on request: not a failure, the sentence is simply still wanted.
      e.state = "queued";
      if (this.rec && this.rec.idx === e.idx) this.rec.attempts = Math.max(0, this.rec.attempts - (ctx.role === "recovery" ? 1 : 0));
      this.afterSettle();
      return;
    }
    if (this.cfg.isFastReset?.(err, now - t0) && !e.resetRetried) {
      // A warm socket the service closed while idle (measured: 10054 within ~15 ms, before any audio).
      // One immediate reconnect, not counted as a failure — otherwise every idle stretch would add a
      // backoff and could trip the breaker for nothing.
      e.resetRetried = true;
      e.state = "queued";
      this.stats.resetRetries++;
      this.afterSettle();
      return;
    }
    e.resetRetried = false;
    e.lastError = err;
    const permanent = !!this.cfg.isPermanent?.(err);
    if (!permanent) this.noteFailure(e.idx);
    if (this.rec && this.rec.idx === e.idx) {
      const r = this.rec;
      r.lastError = err;
      if (ctx.role === "recovery") r.attempts = ctx.attempt; // counted at start; the in-flight-at-arrival call was attempt 1
      if (permanent) { e.state = "dead"; this.failRecovery("permanent"); return; }
      e.state = "waiting";
      if (r.attempts >= this.policy.maxRecoveryAttempts) { this.failRecovery("attempts"); return; }
      const spacing = this.policy.recoverySpacing[Math.min(r.attempts, this.policy.recoverySpacing.length - 1)] ?? 0;
      e.retryAt = now + spacing;
      r.nextAt = e.retryAt;
      this.afterSettle();
      return;
    }
    if (permanent) {
      e.state = "dead";
      for (const w of e.waiters) w.reject(err);
      e.waiters = [];
      this.afterSettle();
      return;
    }
    // RULE 1: keep it, with backoff — timed so the last chance comes before playback arrives.
    e.state = "waiting";
    e.failures++;
    const p = this.policy;
    let backoff = Math.min(p.backoffMaxMs, p.backoffBaseMs * 2 ** (e.failures - 1));
    backoff *= 0.8 + 0.4 * this.random();
    let at = now + backoff;
    // The cap only ever SHORTENS a wait for a sentence that is still ahead: its last chance is placed
    // before playback arrives. A sentence that is already due (the current one after a failed round, or
    // one playback has caught up with) keeps the plain backoff — capping it to "now" would be a retry
    // loop (measured on the first version of this rule: two attempts a second, 114 a minute).
    const cap = this.needAt(e.idx) - p.leadMarginMs;
    if (cap < at && cap > now + p.backoffBaseMs) at = cap;
    if (this.health !== "healthy") at = Math.max(at, now + p.degradedFloorMs);
    e.retryAt = at;
    this.afterSettle();
  }

  private afterSettle(): void {
    // GUARDED ON PURPOSE: a throw from a listener must never skip the pump below (RAWY-257 2C).
    try { this.cfg.onSettled?.(); } catch { /* a listener must not be able to stall the engine */ }
    this.pump();
  }

  // ---- the outage breaker ---------------------------------------------------------------------------
  private noteFailure(idx: number): void {
    this.consecutiveFailures++;
    this.failedUnits.add(idx);
    const before = this.health;
    // ONE sentence failing repeatedly is that sentence's problem, not an outage: the breaker needs
    // consecutive failures across at least two different sentences before it limits work.
    if (this.failedUnits.size >= 2) {
      if (this.consecutiveFailures >= this.policy.openAfter) this.health = "open";
      else if (this.consecutiveFailures >= this.policy.degradedAfter) this.health = "degraded";
    }
    if (this.health !== before) this.stats.breakerTrips++;
  }
  private recovered(): void {
    this.consecutiveFailures = 0;
    this.failedUnits.clear();
    if (this.health !== "healthy") {
      this.health = "healthy";
      // Any success makes every waiting sentence eligible at once — no sentence is ever abandoned.
      const now = this.clock.now();
      for (const [, e] of this.cache) if (e.state === "waiting") e.retryAt = Math.min(e.retryAt, now);
    }
  }

  // ---- recovery bookkeeping -------------------------------------------------------------------------
  private succeedRecovery(v: T): void {
    const r = this.rec!;
    if (r.hardTimer !== null) this.clock.clearTimeout(r.hardTimer);
    if (r.yieldTimer !== null) this.clock.clearTimeout(r.yieldTimer);
    this.rec = null;
    this.stats.recoverySuccesses++;
    r.resolve(v);
  }
  private failRecovery(why: string): void {
    const r = this.rec;
    if (!r) return;
    if (r.hardTimer !== null) this.clock.clearTimeout(r.hardTimer);
    if (r.yieldTimer !== null) this.clock.clearTimeout(r.yieldTimer);
    this.rec = null;
    const e = this.cache.get(r.idx);
    if (e && e.state !== "dead" && e.state !== "inflight") {
      e.state = "waiting";
      e.retryAt = this.clock.now() + this.policy.postRecoveryRetryMs;
    }
    // Background attempts continue for a bounded time, so a Retry is instant once the service is back.
    this.bgUntil = this.clock.now() + this.policy.backgroundLimitMs;
    r.reject(new Error(`${RECOVERY_FAILED}: recovery failed (${why}) after ${r.attempts} attempt(s): ${String(r.lastError ?? "")}`));
    this.pump();
  }
  private cancelRecovery(reason: string): void {
    const r = this.rec;
    if (!r) return;
    if (r.hardTimer !== null) this.clock.clearTimeout(r.hardTimer);
    if (r.yieldTimer !== null) this.clock.clearTimeout(r.yieldTimer);
    this.rec = null;
    r.reject(new Error(reason));
  }
}
