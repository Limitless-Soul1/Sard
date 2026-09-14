// THE WINDOW CLOSE — the one part of shutdown that can strand a user in an application they cannot quit.
//
// THE DEFECT THIS FILE EXISTS FOR, reproduced in the running application before it was fixed. The
// handler prevents the native close so it can flush, then destroys the window itself. A `closing` latch
// stopped a second ✕ from starting a second flush — and was never released. When `destroy()` failed,
// the handler returned with the close still prevented, the window still on screen, and the latch still
// set; every later ✕ hit the latch and did nothing. Measured trace from the real handler with one
// destroy failure injected and then repaired:
//
//     handler FIRED / body entered / flush ran / reached destroy / destroy threw
//     ...destroy healthy again...
//     handler FIRED / IGNORED: closing latch already set      <- and nothing, ever again
//
// The window stayed visible, enabled, responsive and modal-free. Only `Stop-Process` ended it.
//
// WHAT THESE TESTS CAN AND CANNOT PROVE. They exercise the real decision-making — the same function the
// application registers — so the latch, the ordering, and the recovery are covered exactly as they ship.
// What they cannot cover is the OS half: that Windows delivers WM_CLOSE, that Tauri prevents the close
// while a JS listener exists, and that `destroy()` tears the window down. That half is checked by the
// private harness, which closes a real application and fails the run if the process does not exit.
import { describe, expect, it, vi } from "vitest";
import { createCloseHandler } from "../../src/lib/closeFlush";

const evt = () => {
  const e = { prevented: 0, preventDefault: () => { e.prevented++; } };
  return e;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the close handler", () => {
  it("holds the native close, flushes, then destroys", async () => {
    const order: string[] = [];
    const handle = createCloseHandler({
      flush: async () => { order.push("flush"); },
      destroy: async () => { order.push("destroy"); },
    });
    const e = evt();
    await handle(e);
    expect(e.prevented).toBe(1); // the close must be held, or the flush would race the teardown
    expect(order).toEqual(["flush", "destroy"]);
  });

  it("destroys even when the flush fails", async () => {
    // The window must close whether or not the save worked; a failed flush costs a position, a failed
    // close costs the whole session.
    const destroy = vi.fn(async () => {});
    const handle = createCloseHandler({ flush: async () => { throw new Error("disk"); }, destroy });
    await handle(evt()).catch(() => {});
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("runs one flush when a second close arrives mid-flush", async () => {
    let release!: () => void;
    const flush = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const destroy = vi.fn(async () => {});
    const handle = createCloseHandler({ flush, destroy });
    const first = handle(evt());
    const second = handle(evt()); // the impatient second ✕
    await second; // returns at once — it is left to the first
    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    release();
    await first;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("still prevents the native close on the second request", async () => {
    // Returning early must not mean falling through to a native close mid-flush.
    let release!: () => void;
    const handle = createCloseHandler({
      flush: () => new Promise<void>((r) => { release = r; }),
      destroy: async () => {},
    });
    const e1 = evt(); const e2 = evt();
    const first = handle(e1);
    await handle(e2);
    expect(e2.prevented).toBe(1);
    release();
    await first;
  });

  // ── THE REGRESSION ────────────────────────────────────────────────────────────────────────────
  it("RECOVERS: a failed destroy does not make the window permanently unclosable", async () => {
    let fail = true;
    const destroy = vi.fn(async () => {
      if (fail) { fail = false; throw new Error("injected destroy failure"); }
    });
    const flush = vi.fn(async () => {});
    const handle = createCloseHandler({ flush, destroy });

    await handle(evt());                    // first ✕ — destroy fails, window is still here
    expect(destroy).toHaveBeenCalledTimes(1);

    await handle(evt());                    // second ✕ — MUST try again
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("recovers from repeated failures, not merely the first", async () => {
    let failures = 3;
    const destroy = vi.fn(async () => { if (failures-- > 0) throw new Error("still failing"); });
    const handle = createCloseHandler({ flush: async () => {}, destroy });
    for (let i = 0; i < 4; i++) await handle(evt());
    expect(destroy).toHaveBeenCalledTimes(4); // every gesture got a real attempt
  });

  it("a destroy that never settles does not spin or fire twice", async () => {
    // A HUNG destroy is deliberately NOT recovered from: a second destroy would hang the same way, and
    // a timeout would hide it rather than fix it. What must not happen is the handler looping or
    // starting a second flush behind the first.
    const flush = vi.fn(async () => {});
    const destroy = vi.fn(() => new Promise<void>(() => {})); // never settles
    const handle = createCloseHandler({ flush, destroy });
    void handle(evt());
    await tick();
    await handle(evt());
    await tick();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("reports a failed destroy instead of swallowing it", async () => {
    // The original code lost the error in a bare `catch {}`, so the one event worth knowing about left
    // no trace at all. A recurrence in the field must arrive with its reason attached.
    const seen: unknown[] = [];
    const handle = createCloseHandler({
      flush: async () => {},
      destroy: async () => { throw new Error("boom"); },
      onDestroyFailed: (e) => seen.push(e),
    });
    await handle(evt());
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("boom");
  });

  it("a reporter that throws does not take the retry down with it", async () => {
    let fail = true;
    const destroy = vi.fn(async () => { if (fail) { fail = false; throw new Error("x"); } });
    const handle = createCloseHandler({
      flush: async () => {},
      destroy,
      onDestroyFailed: () => { throw new Error("the reporter itself is broken"); },
    });
    await handle(evt());
    await handle(evt());
    expect(destroy).toHaveBeenCalledTimes(2); // recovery survived a broken reporter
  });

  it("passes the flush ceiling through, and defaults it", async () => {
    const seen: (number | undefined)[] = [];
    const mk = (flushMs?: number) =>
      createCloseHandler({ flush: async (ms) => { seen.push(ms); }, destroy: async () => {}, flushMs });
    await mk()(evt());
    await mk(4000)(evt());
    expect(seen).toEqual([1500, 4000]);
  });
});
