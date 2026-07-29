// RAWY-231: the read-aloud synthesis SCHEDULER — the structural home of three of the five stall-fix
// invariants (DECISIONS D60). The read-aloud engine is SERIALIZED and SINGLE-SOCKET (Piper = one warm
// process, Edge = one warm WebSocket behind a mutex); the RAWY-191 connection pool stays REVERTED. This
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

export interface SchedulerConfig {
  /** Keep this many already-played sentences resolvable (a one-step skip-back stays instant). */
  behind: number;
  /** Optional look-ahead depth beyond the current sentence (includes the one-ahead lead). */
  ahead: number;
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

interface Entry<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  settled: boolean; // resolved OK (a rejected entry is deleted, so "in cache + settled" == ready)
  started: boolean; // dispatched to the engine (must not be trimmed — its result may be awaited)
}

export class SynthScheduler<T> {
  private cache = new Map<number, Entry<T>>();
  private prio = 0;
  private inflight = -1;
  // A stale in-flight completion (after reset/clearCache) must not touch scheduler state — guard on this.
  private epoch = 0;
  /** RAWY-231 (E): cumulative count of syntheses whose result was DISCARDED — the cursor moved past the
   *  window, OR the epoch changed under it (clearCache: new chapter / new voice / Edge retry).
   *  RAWY-257 (C10): the epoch case was previously UNCOUNTED — the epoch guard short-circuited before the
   *  increment — so the largest source of wasted work (C4's duplicate generation) was invisible to the very
   *  counter built to detect it. Both causes now count; `abandonedEpoch` isolates the C4-attributable share. */
  abandoned = 0;
  /** RAWY-257 (C10): the subset of `abandoned` caused by an epoch change (clearCache) rather than a cursor
   *  move. A NON-ZERO value is direct evidence of C4 — work dispatched, paid for, and thrown away. */
  abandonedEpoch = 0;
  /** RAWY-257 (Phase 1, item 3): DISPATCH→SETTLE latency — the engine's real cost, excluding queue wait. */
  readonly dispatchLatency: LatencySeries = newSeries();
  /** RAWY-257 (Phase 1): peak concurrent dispatches observed. The D60 single-flight invariant says this must
   *  never exceed 1; C4 predicts it CAN, because clearCache() frees the slot while a synth is still live in
   *  Rust. This counter is what turns that prediction into a measurement. */
  maxConcurrent = 0;
  private live = 0; // dispatches actually outstanding right now (NOT the same as `inflight`, which clearCache resets)

  constructor(
    private readonly dispatch: (idx: number) => Promise<T>,
    private readonly cfg: SchedulerConfig,
  ) {}

  /** The playback cursor the scheduler prioritizes around. */
  get priority(): number { return this.prio; }
  /** Diagnostics (invariant E / tests). */
  get inFlight(): number { return this.inflight; }
  get size(): number { return this.cache.size; }
  /** RAWY-257 (Phase 1): dispatches genuinely outstanding right now. Diverges from `inFlight` exactly when
   *  C4 fires — `clearCache()` sets `inflight = -1` while the underlying `tts_synthesize` is still running. */
  get liveDispatches(): number { return this.live; }
  /** RAWY-257 (Phase 1): entries requested but not yet handed to the engine — the queue C2 mis-times as synthesis. */
  get queueDepth(): number {
    let n = 0;
    for (const [, e] of this.cache) if (!e.started) n++;
    return n;
  }

  /** Is sentence `i` already synthesized and ready to play (not merely requested)? A rejected synth is
   *  evicted, so a cache miss reads as "not ready" and a later `request` re-attempts cleanly. */
  isReady(i: number): boolean {
    const e = this.cache.get(i);
    return !!e && e.settled;
  }

  /** The promise playback awaits for sentence `i`. Requesting an index queues it and kicks the pump; it is
   *  dispatched in priority order, so requesting look-ahead never delays the current/next sentence. */
  request(i: number): Promise<T> {
    let e = this.cache.get(i);
    if (!e) { e = this.mkEntry(); this.cache.set(i, e); this.pump(); }
    return e.promise;
  }

  /** Move the priority anchor — playback advanced, or the user seeked/jumped. Drops stale work outside the
   *  window (both far look-ahead AND far-behind decoded buffers, so memory stays bounded to ~behind+ahead+1),
   *  then dispatches the highest-priority want. */
  reprioritize(i: number): void {
    this.prio = i;
    this.trim();
    this.pump();
  }

  /** New chapter / voice — drop the cache but KEEP the session's recurrence counters (invariant E). Bumps
   *  the epoch so a synth still in flight for the old chapter can't clobber the new scheduler state. */
  clearCache(): void {
    this.epoch++;
    this.cache.clear();
    this.prio = 0;
    this.inflight = -1;
  }

  /** Full reset — new session (the player closed). Also zeroes the recurrence counters.
   *  RAWY-257: `live` is deliberately NOT reset — a dispatch still running in Rust is still running, and
   *  zeroing it here would forge the very single-flight evidence Phase 1 exists to collect. It decrements
   *  itself when the real call settles. */
  reset(): void {
    this.clearCache();
    this.abandoned = 0;
    this.abandonedEpoch = 0;
    this.maxConcurrent = 0;
    resetSeries(this.dispatchLatency);
  }

  private mkEntry(): Entry<T> {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject, settled: false, started: false };
  }

  private inWindow(idx: number): boolean {
    const d = idx - this.prio;
    return d >= -this.cfg.behind && d <= this.cfg.ahead;
  }

  private trim(): void {
    for (const [idx] of this.cache) {
      if (idx === this.inflight) continue; // never drop the one in flight (its result is awaited)
      if (!this.inWindow(idx)) this.cache.delete(idx);
    }
  }

  /** Highest-priority index still needing synthesis: current (distance 0) first, then next (1), then
   *  ascending look-ahead; anything behind the cursor is lowest priority. */
  private pick(): number {
    let best = -1;
    let bestRank = Infinity;
    for (const [idx, e] of this.cache) {
      if (e.started || !this.inWindow(idx)) continue;
      const d = idx - this.prio;
      const rank = d < 0 ? 1000 - d : d;
      if (rank < bestRank) { bestRank = rank; best = idx; }
    }
    return best;
  }

  private pump(): void {
    if (this.inflight >= 0) return; // single-flight — the engine is serialized
    const i = this.pick();
    if (i < 0) return;
    const e = this.cache.get(i)!;
    e.started = true;
    this.inflight = i;
    const myEpoch = this.epoch;
    // RAWY-257 (Phase 1): time the DISPATCH, and track how many dispatches are genuinely outstanding.
    // `live` is deliberately NOT `inflight`: clearCache() resets `inflight` while the underlying call is
    // still running, which is precisely the C4 defect — so only `live`/`maxConcurrent` can observe it.
    const t0 = performance.now();
    this.live++;
    if (this.live > this.maxConcurrent) this.maxConcurrent = this.live;
    void this.dispatch(i).then(
      (v) => {
        if (myEpoch === this.epoch) {
          if (Math.abs(i - this.prio) > this.cfg.ahead) { this.abandoned++; this.cfg.onAbandon?.(); }
          e.settled = true;
        } else {
          // RAWY-257 (C10): the epoch moved under this dispatch (clearCache — new chapter / voice / retry),
          // so its result is thrown away. Previously uncounted; it is the C4-attributable waste.
          this.abandoned++;
          this.abandonedEpoch++;
          this.cfg.onAbandon?.();
        }
        e.resolve(v);
      },
      (err) => {
        if (myEpoch === this.epoch) this.cache.delete(i); // never retain a rejected synth (RAWY-193)
        e.reject(err);
      },
    ).finally(() => {
      // RAWY-257 (Phase 1): record the ENGINE's cost and release the live count. Both are unconditional —
      // a dispatch abandoned by an epoch change still consumed the engine, and hiding that is the C10 defect.
      recordSeries(this.dispatchLatency, performance.now() - t0);
      this.live--;
      if (myEpoch === this.epoch) { this.inflight = -1; this.pump(); }
    });
  }
}
