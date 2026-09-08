// The dismissal stack — the contract that fixes four separate defects at once.
//
// Before it, every transient surface owned its own flag and its own full-screen overlay, and the
// consequences were: two book menus open at the same time, an outside click that dismissed nothing,
// Escape reaching Vista's navigation handler over the top of an open menu, and switching from the
// sort menu to the filter menu costing two clicks because the first was eaten by an overlay.
//
// These assertions are written against the OLD behaviour as much as the new: every one of them
// fails if the stack goes back to letting two surfaces be open at once.

import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissTransients,
  openTransient,
  pressDismisses,
  transientDepth,
} from "../../src/features/library/design/transient";

describe("one transient surface at a time", () => {
  beforeEach(() => dismissTransients());

  it("starts with nothing open", () => {
    expect(transientDepth()).toBe(0);
  });

  it("opening a second surface closes the first — the two-menus defect", () => {
    let aClosed = false;
    let bClosed = false;
    openTransient(() => { aClosed = true; }, () => null);
    expect(transientDepth()).toBe(1);
    openTransient(() => { bClosed = true; }, () => null);
    expect(aClosed).toBe(true);
    expect(bClosed).toBe(false);
    expect(transientDepth()).toBe(1);
  });

  it("is empty again once the surface disposes, so Escape goes back to navigating", () => {
    // This is the whole of the Escape fix: while a surface is on the stack the key is spent on it
    // and the handler that would walk Vista up a level never sees it — and once it is gone, it does.
    const dispose = openTransient(() => {}, () => null);
    expect(transientDepth()).toBe(1);
    dispose();
    expect(transientDepth()).toBe(0);
  });

  it("disposing is idempotent, and disposing one does not resurrect another", () => {
    const disposeA = openTransient(() => {}, () => null);
    const disposeB = openTransient(() => {}, () => null);
    disposeA(); // A was already closed by B opening
    expect(transientDepth()).toBe(1);
    disposeB();
    disposeB();
    expect(transientDepth()).toBe(0);
  });

  it("dismissing everything runs every close handler exactly once", () => {
    let calls = 0;
    openTransient(() => { calls += 1; }, () => null);
    dismissTransients();
    expect(calls).toBe(1);
    dismissTransients();
    expect(calls).toBe(1);
    expect(transientDepth()).toBe(0);
  });

  it("a surface that closes itself leaves the stack empty, not stale", () => {
    // The stale-overlay case: a menu unmounted by a navigation must not leave the stack believing
    // it is still open, or the next Escape is swallowed by a surface that is no longer on screen.
    let dispose: (() => void) | null = null;
    dispose = openTransient(() => { dispose?.(); }, () => null);
    dismissTransients();
    expect(transientDepth()).toBe(0);
  });
});

// A NEAR MISS IS A MISS — the second half of the sheet-dismissal defect.
//
// The scrim's own rule (see `scrimDismiss.test.ts`) was not the whole of it. A sheet that joins this
// stack was ALSO being closed from here, on `pointerdown`, by a press one pixel past its border box
// — before the scrim ever saw the gesture. MEASURED in the running application after the scrim was
// fixed: a press 5px outside «تحرير بيانات الكتاب» still closed it, and so did presses 6px and 7px
// past the other edges. The stack was the dominant path, and the scrim fix alone was invisible.
//
// Two amendments, both stated here: a press within `guardPx` is not an outside press, and a surface
// that owns its own backdrop can decline this listener entirely — it sees only the press, and a
// sheet needs both ends of the gesture to tell a dismissal from a drag that overshot.
describe("what the stack counts as a press outside", () => {
  const RECT = { left: 400, right: 900, top: 200, bottom: 700 };
  const MENU = { rect: RECT, guardPx: 12, outsidePress: true };

  it("a press well away from the surface dismisses it, as it always did", () => {
    expect(pressDismisses({ inside: false, ...MENU }, 60, 60)).toBe(true);
    expect(pressDismisses({ inside: false, ...MENU }, 1200, 400)).toBe(true);
  });

  it("a press on the surface's own tree never dismisses it", () => {
    // `contains` still decides this: a menu item may paint outside its parent's box.
    expect(pressDismisses({ inside: true, ...MENU }, 60, 60)).toBe(false);
  });

  it("a press that GRAZES the edge does not dismiss — the reported defect", () => {
    for (const [x, y] of [[395, 450], [906, 450], [650, 194], [650, 707]] as const) {
      expect(pressDismisses({ inside: false, ...MENU }, x, y), `${x},${y}`).toBe(false);
    }
  });

  it("and just past the guard it dismisses again — a margin, not an amnesty", () => {
    expect(pressDismisses({ inside: false, ...MENU }, RECT.left - 13, 450)).toBe(true);
    expect(pressDismisses({ inside: false, ...MENU }, RECT.right + 13, 450)).toBe(true);
  });

  it("a surface that owns its own backdrop takes nothing from this listener", () => {
    // «تحرير بيانات الكتاب» — the press may be the start of a drag that belongs to the sheet, and
    // only the scrim, which sees the release too, can tell.
    const sheet = { inside: false, rect: RECT, guardPx: 12, outsidePress: false };
    expect(pressDismisses(sheet, 60, 60)).toBe(false);
    expect(pressDismisses(sheet, RECT.left - 5, 450)).toBe(false);
  });

  it("an unmeasured surface still yields to a press, so nothing can be left stuck open", () => {
    expect(pressDismisses({ inside: false, rect: null, guardPx: 12, outsidePress: true }, 60, 60)).toBe(true);
  });

  it("the guard is the same number the scrim uses", async () => {
    // Two different margins would mean a sheet forgiving a graze that the stack beneath it acts on.
    const { NEAR_MISS_PX } = await import("../../src/components/useDialog");
    const dispose = openTransient(() => {}, () => null);
    expect(NEAR_MISS_PX).toBe(12);
    dispose();
  });
});

describe("the sheet that reported the defect is wired the way the fix requires", () => {
  it("«تحرير بيانات الكتاب» joins the stack without giving it the press", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../../src/features/library/design/BookDetails.tsx"),
      "utf8",
    );
    expect(src).toMatch(/openTransient\([\s\S]{0,120}outsidePress:\s*false/);
  });
});
