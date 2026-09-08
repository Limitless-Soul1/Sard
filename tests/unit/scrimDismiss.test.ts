// A SHEET MUST NOT VANISH BECAUSE A TOUCH GRAZED ITS EDGE.
//
// THE DEFECT THIS PINS, and it was one defect shared by every sheet rather than several. The pattern
// was `onClick={onClose}` on the scrim with `stopPropagation` on the panel, which is not the same
// thing as "the reader clicked outside":
//
//   · A `click` is dispatched at the nearest COMMON ANCESTOR of the press and the release. Select a
//     book's title, drag a few pixels past the field, let go — press inside, release outside, so the
//     click lands on the SCRIM and the sheet closes mid-edit. `stopPropagation` on the panel cannot
//     prevent it, because the event never targets the panel.
//   · The panel's border box was the whole boundary, so a press one pixel outside it counted exactly
//     like a press across the room. On a control near the edge that is a coin toss.
//   · The note sheet dismissed on `pointerdown`, removing even the chance of a drag being a drag.
//
// Two rules answer all three, and this file pins the measurable one: a point counts as the backdrop
// only when it is clear of the panel by a margin. (The other — that the gesture must also have BEGUN
// on the backdrop — lives in the hook, which holds the press state.)
import { describe, expect, it } from "vitest";

import { isOnBackdrop } from "../../src/components/useDialog";

/** A sheet in the middle of the window. */
const PANEL = { left: 400, right: 900, top: 200, bottom: 700 };
const GUARD = 12;

describe("what counts as the backdrop", () => {
  it("a press well away from the sheet is the backdrop", () => {
    expect(isOnBackdrop(50, 50, PANEL, GUARD)).toBe(true);
    expect(isOnBackdrop(1200, 400, PANEL, GUARD)).toBe(true);
    expect(isOnBackdrop(650, 900, PANEL, GUARD)).toBe(true);
  });

  it("a press inside the sheet is never the backdrop", () => {
    expect(isOnBackdrop(650, 450, PANEL, GUARD)).toBe(false);
    expect(isOnBackdrop(401, 201, PANEL, GUARD)).toBe(false);
  });

  it("a press that GRAZES the edge is a miss, not an instruction", () => {
    // the reported case: reaching for a field near the boundary and landing a few pixels outside
    for (const [x, y] of [[396, 450], [904, 450], [650, 196], [650, 704]] as const) {
      expect(isOnBackdrop(x, y, PANEL, GUARD), `${x},${y}`).toBe(false);
    }
  });

  it("the guard is a margin, not a doubling — just past it IS the backdrop", () => {
    expect(isOnBackdrop(PANEL.left - GUARD - 1, 450, PANEL, GUARD)).toBe(true);
    expect(isOnBackdrop(PANEL.right + GUARD + 1, 450, PANEL, GUARD)).toBe(true);
    expect(isOnBackdrop(650, PANEL.top - GUARD - 1, PANEL, GUARD)).toBe(true);
    expect(isOnBackdrop(650, PANEL.bottom + GUARD + 1, PANEL, GUARD)).toBe(true);
  });

  it("exactly on the guard line still belongs to the sheet", () => {
    expect(isOnBackdrop(PANEL.left - GUARD, 450, PANEL, GUARD)).toBe(false);
    expect(isOnBackdrop(PANEL.right + GUARD, 450, PANEL, GUARD)).toBe(false);
  });

  it("a guard of zero restores a plain boundary, for a surface where the backdrop IS the target", () => {
    // A lightbox, say: tapping beside the picture is how you leave it, and there is nothing near the
    // edge to reach for. The rule stays available rather than being hard-coded away.
    expect(isOnBackdrop(PANEL.left - 1, 450, PANEL, 0)).toBe(true);
    expect(isOnBackdrop(PANEL.left + 1, 450, PANEL, 0)).toBe(false);
  });

  it("an unmeasured panel means the whole scrim is backdrop", () => {
    // Before the first layout there is nothing to be near. A scrim with nothing in it is all backdrop.
    expect(isOnBackdrop(650, 450, null, GUARD)).toBe(true);
  });

  it("the corners are guarded too, not only the four sides", () => {
    expect(isOnBackdrop(PANEL.left - 6, PANEL.top - 6, PANEL, GUARD)).toBe(false);
    expect(isOnBackdrop(PANEL.right + 6, PANEL.bottom + 6, PANEL, GUARD)).toBe(false);
  });
});

describe("every interactive sheet dismisses through the shared rule", () => {
  // The guard that prevents the regression: a sheet wired straight to `onClick={onClose}` brings the
  // whole class of bug back, silently, and only on a real pointer.
  const SHEETS = [
    "src/features/library/design/BookDetails.tsx",   // تحرير بيانات الكتاب
    "src/features/deposit/DepositSheet.tsx",          // إهداء نسخة القراءة
    "src/features/deposit/DepositReceive.tsx",
    "src/features/library/archive/SlipSheet.tsx",
    "src/features/reader/NoteSheet.tsx",
    "src/features/profiles/ImportSheet.tsx",
    "src/features/profiles/CustomPaper.tsx",
    "src/features/profiles/ProfilesSection.tsx",
  ];

  for (const file of SHEETS) {
    it(file.split("/").pop() + " uses useScrimDismiss", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const src = readFileSync(resolve(__dirname, "../../", file), "utf8");
      expect(src, file + " does not use the shared rule").toContain("useScrimDismiss");
      expect(src, file + " still spreads the scrim props").toContain("scrim.scrimProps");
      // and no bare backdrop dismissal is left behind
      expect(src).not.toMatch(/scrim"\s+onClick=\{on(Close|Cancel)\}/);
      expect(src).not.toMatch(/scrim"\s+onPointerDown=\{on(Close|Cancel)\}/);
    });
  }
});
