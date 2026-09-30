// THE SINGLE-CALL INVARIANT, PROVED BY RUNNING IT.
//
// `tts.rs` keeps one cancel flag and one engine mutex, so the frontend must never have two synthesis
// calls open at once. That used to be readable off the call graph (one caller, one scheduler) and a test
// counted the call sites. Cross-chapter preparation adds a second legitimate caller, so the property is
// enforced by the turnstile every caller passes through — and asserted here as behaviour: concurrency,
// ordering, release on every exit path, and a pre-emption that asks rather than races.
import { describe, expect, it } from "vitest";
import { EngineTurnstile } from "../../src/lib/engineTurnstile";

const tick = () => new Promise((r) => setTimeout(r, 0));
/** A body whose settling this test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("EngineTurnstile — at most one synthesis at a time", () => {
  it("never runs two bodies at once, however many ask", async () => {
    const t = new EngineTurnstile();
    let running = 0;
    let peak = 0;
    const body = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return running;
    };
    await Promise.all(Array.from({ length: 12 }, () => t.run(body)));
    expect(peak).toBe(1);
    expect(t.maxConcurrent).toBe(1);
    expect(t.inFlight).toBe(0);
  });

  it("holds a waiter until the call in flight settles", async () => {
    const t = new EngineTurnstile();
    const first = deferred();
    let secondStarted = false;
    const a = t.run(() => first.promise);
    const b = t.run(async () => { secondStarted = true; });
    await tick();
    expect(t.inFlight).toBe(1);
    expect(secondStarted).toBe(false); // the second call has NOT reached the engine
    expect(t.queued).toBe(1);
    first.resolve();
    await a; await b;
    expect(secondStarted).toBe(true);
    expect(t.maxConcurrent).toBe(1);
  });

  it("serves waiters in the order they arrived", async () => {
    const t = new EngineTurnstile();
    const order: number[] = [];
    const gate = deferred();
    const held = t.run(() => gate.promise);
    const rest = [1, 2, 3, 4].map((n) => t.run(async () => { order.push(n); }));
    gate.resolve();
    await held; await Promise.all(rest);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("releases the turn when a body throws, and when it rejects", async () => {
    const t = new EngineTurnstile();
    await expect(t.run(async () => { throw new Error("edge synth cancelled"); })).rejects.toThrow("cancelled");
    await expect(t.run(() => Promise.reject(new Error("10054")))).rejects.toThrow("10054");
    // the gate is not stranded: the next call still runs
    await expect(t.run(async () => "audio")).resolves.toBe("audio");
    expect(t.inFlight).toBe(0);
    expect(t.maxConcurrent).toBe(1);
  });

  it("asks a yieldable holder to abandon, and still does not overlap with it", async () => {
    const t = new EngineTurnstile();
    const background = deferred();
    let abandoned = false;
    let foregroundStarted = false;
    const prep = t.run(async () => {
      t.setYielder(() => { abandoned = true; background.reject(new Error("edge synth cancelled")); });
      try { return await background.promise; } finally { t.setYielder(null); }
    }).catch(() => "cancelled");
    await tick();
    expect(t.hasYielder).toBe(true);
    const fore = t.run(async () => { foregroundStarted = true; return "audio"; }, { preempt: true });
    await tick();
    expect(abandoned).toBe(true);                 // the holder was asked at once…
    expect(await prep).toBe("cancelled");
    expect(await fore).toBe("audio");
    expect(foregroundStarted).toBe(true);         // …and the waiter ran only after it let go
    expect(t.maxConcurrent).toBe(1);
    expect(t.preempted).toBe(1);
    expect(t.hasYielder).toBe(false);             // cleared on the way out, so nothing stale can be asked
  });

  it("a caller that installs no yielder is never asked to abandon", async () => {
    const t = new EngineTurnstile();
    const held = deferred<string>();
    const first = t.run(() => held.promise);      // a listener-facing call: no yielder
    await tick();
    const second = t.run(async () => "second", { preempt: true });
    await tick();
    expect(t.preempted).toBe(0);                  // nothing to ask
    expect(t.inFlight).toBe(1);
    held.resolve("first");
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(t.maxConcurrent).toBe(1);
  });

  it("pre-empting an empty gate is harmless, and is how a stop drops a preparation", async () => {
    const t = new EngineTurnstile();
    let abandoned = 0;
    const held = deferred();
    const prep = t.run(async () => {
      t.setYielder(() => { abandoned++; held.resolve(); });
      try { await held.promise; } finally { t.setYielder(null); }
    });
    await tick();
    await t.run(async () => undefined, { preempt: true }); // what discardPrepared() does
    await prep;
    expect(abandoned).toBe(1);
    await t.run(async () => undefined, { preempt: true }); // nothing in the gate: no throw, no effect
    expect(abandoned).toBe(1);
    expect(t.maxConcurrent).toBe(1);
  });

  it("counts a pre-emption once, even if the same holder is asked twice", async () => {
    const t = new EngineTurnstile();
    let asked = 0;
    const held = deferred();
    const prep = t.run(async () => {
      t.setYielder(() => { asked++; held.resolve(); });
      try { await held.promise; } finally { t.setYielder(null); }
    });
    await tick();
    const a = t.run(async () => 1, { preempt: true });
    const b = t.run(async () => 2, { preempt: true });
    await prep; await a; await b;
    expect(asked).toBe(1);        // a holder yields once; the second request finds no yielder
    expect(t.preempted).toBe(1);
    expect(t.maxConcurrent).toBe(1);
  });

  it("keeps the invariant under a long mixed run of foreground and background callers", async () => {
    const t = new EngineTurnstile();
    let running = 0;
    let peak = 0;
    const work = async (fail: boolean) => {
      running++; peak = Math.max(peak, running);
      await tick();
      running--;
      if (fail) throw new Error("edge synth: 10054");
      return 1;
    };
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const background = i % 3 === 0;
      jobs.push(
        t.run(async () => {
          if (background) t.setYielder(() => {});
          try { return await work(i % 7 === 0); } finally { if (background) t.setYielder(null); }
        }, { preempt: !background }).catch(() => "failed"),
      );
    }
    await Promise.all(jobs);
    expect(peak).toBe(1);
    expect(t.maxConcurrent).toBe(1);
    expect(t.inFlight).toBe(0);
    expect(t.queued).toBe(0);
    expect(t.hasYielder).toBe(false); // no orphaned yielder after everything has settled
  });
});
