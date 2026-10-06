// ONE SYNTHESIS REQUEST AT A TIME, ENFORCED AT THE FRONTEND.
//
// WHY THIS EXISTS. The native side keeps ONE cancel flag ("the call currently installed") and serialises
// synthesis on one engine mutex, so both assume the frontend never has two `tts_synthesize` calls open at
// once. Until now that held by construction: every call went through one function, called from one place,
// reached only through the single-flight scheduler — a shape `tests/unit/ttsLadder.test.ts` pinned by
// counting call sites. Cross-chapter preparation adds a SECOND caller that is not the scheduler, so the
// property can no longer be read off the call graph. It is enforced here instead, and asserted as the
// behaviour it actually is: at most one body running, whoever asks.
//
// WHAT IT GUARANTEES.
//   1. SERIALISED. A `run()` body does not begin until the previous one has settled. `maxConcurrent`
//      therefore cannot exceed 1, and the counter here proves it rather than describing it.
//   2. ORDERED. Waiters are served in the order they arrived (one promise chain, no queue to reorder).
//   3. RELEASED ON EVERY EXIT. The turn is handed on in a `finally`, so a throw, a rejection or a cancel
//      cannot strand it — the defect that would otherwise freeze read-aloud permanently.
//   4. PRE-EMPTIBLE. A caller that must not wait (the listener's own synthesis) passes `preempt`, which
//      asks the yieldable holder — the background preparation — to abandon its call. The request is
//      COOPERATIVE: it makes the holder finish sooner, it never runs two calls at once.
//
// It knows nothing about read-aloud, the engine or WebAudio, so it is testable on its own.

/** The single-flight gate in front of the synthesis IPC. One instance per engine (there is one). */
export class EngineTurnstile {
  /** The tail of the chain: resolves when the current holder has released. */
  private tail: Promise<void> = Promise.resolve();
  /** How a yieldable holder is asked to abandon its call, installed by that holder for its own duration. */
  private yielder: (() => void) | null = null;
  private active = 0;
  private peak = 0;
  private waiting = 0;
  private preemptions = 0;

  /**
   * Take the turn, run `fn`, release. `preempt` first asks a yieldable holder to abandon (see rule 4);
   * it never skips the queue, so the single-call invariant holds even while a pre-emption is in flight.
   */
  async run<T>(fn: () => Promise<T>, opts: { preempt?: boolean } = {}): Promise<T> {
    if (opts.preempt && this.yielder) {
      this.preemptions++;
      const y = this.yielder;
      this.yielder = null; // a holder yields once; its own `finally` clears nothing twice
      y();
    }
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    this.waiting++;
    try {
      await prev;
    } finally {
      this.waiting--;
    }
    this.active++;
    if (this.active > this.peak) this.peak = this.active;
    try {
      return await fn();
    } finally {
      this.active--;
      release();
    }
  }

  /**
   * Install (or clear) how the CURRENT holder abandons its call. Only a holder that can safely be
   * abandoned installs one; the listener's own synthesis never does, so it is never pre-empted.
   */
  setYielder(fn: (() => void) | null): void {
    this.yielder = fn;
  }

  /** Bodies running right now. The invariant is that this is never above 1. */
  get inFlight(): number { return this.active; }
  /** The highest `inFlight` ever seen — what a test asserts against. */
  get maxConcurrent(): number { return this.peak; }
  /** Callers currently waiting for the turn. */
  get queued(): number { return this.waiting; }
  /** How many times a waiter asked the holder to yield. */
  get preempted(): number { return this.preemptions; }
  /** Whether a yieldable holder is in the gate right now. */
  get hasYielder(): boolean { return this.yielder !== null; }

  /** Per-session counters only; the chain itself is never reset (a turn in flight still owns it). */
  resetCounters(): void {
    this.peak = this.active;
    this.preemptions = 0;
  }
}
