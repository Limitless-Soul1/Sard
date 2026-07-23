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
  /** RAWY-231 (E): called when an in-flight synth's result is discarded because the cursor moved away. */
  onAbandon?: () => void;
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
  /** RAWY-231 (E): cumulative count of syntheses whose result was discarded because the cursor moved. */
  abandoned = 0;

  constructor(
    private readonly dispatch: (idx: number) => Promise<T>,
    private readonly cfg: SchedulerConfig,
  ) {}

  /** The playback cursor the scheduler prioritizes around. */
  get priority(): number { return this.prio; }
  /** Diagnostics (invariant E / tests). */
  get inFlight(): number { return this.inflight; }
  get size(): number { return this.cache.size; }

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

  /** Full reset — new session (the player closed). Also zeroes the recurrence counters. */
  reset(): void {
    this.clearCache();
    this.abandoned = 0;
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
    void this.dispatch(i).then(
      (v) => {
        if (myEpoch === this.epoch) {
          if (Math.abs(i - this.prio) > this.cfg.ahead) { this.abandoned++; this.cfg.onAbandon?.(); }
          e.settled = true;
        }
        e.resolve(v);
      },
      (err) => {
        if (myEpoch === this.epoch) this.cache.delete(i); // never retain a rejected synth (RAWY-193)
        e.reject(err);
      },
    ).finally(() => {
      if (myEpoch === this.epoch) { this.inflight = -1; this.pump(); }
    });
  }
}
