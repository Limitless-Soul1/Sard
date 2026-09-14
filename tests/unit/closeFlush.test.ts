// The close must never depend on the flush succeeding.
//
// RAWY-174 already paid once for a close that could be blocked by JavaScript, so the contract here
// is deliberately blunt: `runCloseFlush` resolves, always, within its ceiling, whatever the
// registered function does — and the registry must not be corruptible by an unmount that arrives
// after a remount.
import { afterEach, describe, expect, it, vi } from "vitest";

import { hasCloseFlush, runCloseFlush, setCloseFlush } from "../../src/lib/closeFlush";

// Leave the module clean for the next test, whatever a case registered.
afterEach(() => {
  const dispose = setCloseFlush(async () => {});
  dispose();
});

describe("closeFlush", () => {
  it("reports nothing to flush when no view has registered", () => {
    expect(hasCloseFlush()).toBe(false);
  });

  it("runs the registered flush and reports it", async () => {
    const seen: string[] = [];
    setCloseFlush(async () => { seen.push("flushed"); });
    expect(hasCloseFlush()).toBe(true);
    await expect(runCloseFlush(500)).resolves.toBe("flushed");
    expect(seen).toEqual(["flushed"]);
  });

  it("resolves 'none' when nothing is registered — the close still proceeds", async () => {
    await expect(runCloseFlush(500)).resolves.toBe("none");
  });

  it("never throws when the flush rejects", async () => {
    setCloseFlush(async () => { throw new Error("disk went away"); });
    await expect(runCloseFlush(500)).resolves.toBe("failed");
  });

  it("gives up on a flush that never settles, instead of holding the window open", async () => {
    vi.useFakeTimers();
    setCloseFlush(() => new Promise<void>(() => { /* never resolves */ }));
    const p = runCloseFlush(1500);
    await vi.advanceTimersByTimeAsync(1600);
    await expect(p).resolves.toBe("timeout");
    vi.useRealTimers();
  });

  it("the disposer clears only its OWN registration", async () => {
    const first = async () => { /* the old view */ };
    const disposeFirst = setCloseFlush(first);
    const seen: string[] = [];
    setCloseFlush(async () => { seen.push("second"); }); // a new view took over
    disposeFirst(); // the old view unmounts LATER, as React orders it
    expect(hasCloseFlush()).toBe(true);
    await runCloseFlush(500);
    expect(seen).toEqual(["second"]);
  });

  it("its own disposer clears it when it is still the current one", () => {
    const dispose = setCloseFlush(async () => {});
    expect(hasCloseFlush()).toBe(true);
    dispose();
    expect(hasCloseFlush()).toBe(false);
  });
});
