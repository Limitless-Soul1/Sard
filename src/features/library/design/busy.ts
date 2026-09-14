import { useEffect, useState } from "react";

/**
 * WHETHER AN OPERATION HAS RUN LONG ENOUGH TO BE WORTH SAYING SO.
 *
 * A dialog that dims while it writes is telling the reader "wait". Against a local SQLite file there
 * is nothing to wait for: measured on a real shelf change from Book Details, the dialog dropped to
 * 0.75 opacity at t=15ms and was back at 1 by t=26ms — eleven milliseconds, no transition, an
 * instantaneous 25% step down and up. That is not feedback. It is a flash, and it was the whole of
 * the flicker the reader saw when moving a book between shelves.
 *
 * The fix is not to remove the affordance — a slow write, a large library, a cold disk, all still
 * deserve it — but to withhold it until waiting is actually happening. Below the threshold the
 * operation simply completes and nothing moves on screen.
 *
 * ── WHY THE TWO EDGES ARE NOT SYMMETRIC ─────────────────────────────────────────────────────
 *
 * Turning ON is delayed; turning OFF is immediate. Delaying the off-edge as well would hold a dim
 * over a dialog that is already finished, which is the same fault in the other direction. And the
 * timer is cleared on the way out, so a component that unmounts mid-write leaves nothing behind.
 *
 * 160ms is chosen as the point either side of which the answer is unambiguous: shorter and the
 * change reads as a flicker rather than as progress, longer and a genuinely slow write feels
 * unacknowledged. It is stated once, here, rather than at each call site.
 */
export const BUSY_VISIBLE_AFTER_MS = 160;

export function useSettledBusy(busy: boolean, afterMs: number = BUSY_VISIBLE_AFTER_MS): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShow(false);
      return;
    }
    const id = window.setTimeout(() => setShow(true), afterMs);
    return () => window.clearTimeout(id);
  }, [busy, afterMs]);
  return show;
}
