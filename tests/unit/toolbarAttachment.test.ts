// RAWY-FM3 — THE TOOLBAR IS UI ATTACHED TO THE SELECTION, not to the viewport.
//
// THE MODEL, in the owner's words: the toolbar belongs to the selected text. Scroll the text and the
// toolbar moves with it; scroll the text off the screen and the toolbar goes off with it; scroll it
// back and the toolbar comes back. Nothing about the viewport enters into where it is.
//
// WHAT THIS REPLACES. Two earlier rules both defined the position in VIEWPORT space — a clamp between
// `POP_EDGE` and `vh − POP_EDGE`, then a held `{left, top}` in those coordinates — and both therefore
// ended with the toolbar parked at the top of the window while the selected words were long gone. A
// viewport coordinate is independent of the text by construction; that was the whole defect.
//
// THE RULE NOW. `anchorPlacement` still chooses the side and keeps a freshly RAISED toolbar on screen —
// that is the moment the reader is looking at it. The difference between that placement and the bare
// anchor is captured once as an attachment (`dx`, `dy`, side), and every later position is simply
// anchor + attachment. No clamp is applied again.
//
// NOT TESTED HERE: that the engine drops a selection whose document has gone. That is DOM and engine
// state; it is pinned at the source level below and verified against the real renderer at runtime.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  anchorPlacement, attachedPosition, attachment, fitsBelow, POP_EDGE,
} from "../../src/features/reader/AnnotationLayer";

const VW = 1000, VH = 800;
const BOX = { w: 300, h: 120 };
const GAP = 10;
/** A selection 24 px tall, 300 px wide, at a given top — the shape a line of prose has. */
const at = (top: number, left = 350) => ({ top, bottom: top + 24, left, width: 300, height: 24 });

/** Raise the toolbar on a selection the way the component does on its first measured render. */
function raise(rect: ReturnType<typeof at>) {
  const below = fitsBelow(rect, BOX.h, VH);
  const placed = anchorPlacement(rect, below, BOX, VW, VH);
  return { placed, a: attachment(placed, below) };
}

/** Then scroll: the selection moves, the attachment does not. */
const follow = (a: ReturnType<typeof attachment>, tops: number[]) =>
  tops.map((t) => attachedPosition(at(t), a));

describe("raised with room around it, the toolbar rides the text one-for-one", () => {
  const { placed, a } = raise(at(400));

  it("is attached with a zero offset", () => {
    expect(a).toEqual({ below: false, dx: 0, dy: 0 });
    expect(placed.top).toBe(400 - GAP);
  });

  it("moves exactly as far as the text, in either direction", () => {
    const ys = follow(a, [400, 340, 280, 220, 280, 340, 400]).map((s) => s.top);
    expect(ys).toEqual([390, 330, 270, 210, 270, 330, 390]);
  });
});

describe("scrolling the selection off the top takes the toolbar off with it", () => {
  const { a } = raise(at(400));
  const walk = [400, 200, 100, 20, 0, -40, -200, -1000];
  const seen = walk.map((t) => attachedPosition(at(t), a).top);

  it("never stops at the edge — it keeps going, one-for-one, past zero", () => {
    expect(seen).toEqual(walk.map((t) => t - GAP));
    expect(seen[seen.length - 1]).toBeLessThan(0);
  });

  it("is off the screen exactly when the words are off the screen", () => {
    // The toolbar's BOTTOM sits at `top` (it is drawn upward from there), so it has left the window
    // once `top` is below zero — which happens when the selection's own top has.
    for (let i = 0; i < walk.length; i++) expect(seen[i] < 0).toBe(walk[i] - GAP < 0);
  });

  it("never holds one value across steps that moved the text", () => {
    expect(new Set(seen).size).toBe(walk.length);
  });
});

describe("scrolling the selection off the bottom takes the toolbar off with it", () => {
  const { a } = raise(at(300));
  const walk = [300, 500, 700, 790, 900, 1500];
  const seen = walk.map((t) => attachedPosition(at(t), a).top);

  it("keeps going past the bottom edge, one-for-one", () => {
    expect(seen).toEqual(walk.map((t) => t - GAP));
    expect(seen[seen.length - 1]).toBeGreaterThan(VH);
  });
});

describe("scrolling back brings it back to exactly where it was", () => {
  const { a } = raise(at(400));
  it("retraces the same values in reverse", () => {
    const out = [400, 200, 0, -300];
    const back = [-300, 0, 200, 400];
    const o = out.map((t) => attachedPosition(at(t), a).top);
    const b = back.map((t) => attachedPosition(at(t), a).top);
    expect(b).toEqual([...o].reverse());
  });
});

describe("the side is part of the attachment, and never changes while scrolling", () => {
  it("stays above however far the text travels", () => {
    const { a } = raise(at(400));
    expect(a.below).toBe(false);
    // The rule has no path that flips a side: the attachment is immutable, and every position comes
    // from it. Stated as the values it yields at the far ends of a long scroll.
    expect(attachedPosition(at(-2000), a).top).toBe(-2010);
    expect(attachedPosition(at(3000), a).top).toBe(2990);
  });

  it("a selection raised with no room above is placed below, and stays below", () => {
    const { a } = raise(at(30));
    expect(a.below).toBe(true);
    expect(attachedPosition(at(30), a).top).toBe(54 + GAP);
    expect(attachedPosition(at(600), a).top).toBe(624 + GAP); // still below, far away
  });
});

describe("raised against a window edge, the small shift it was given rides along", () => {
  it("keeps a horizontal shift so a toolbar raised near the left edge is not cut off — then moves with the text", () => {
    const { placed, a } = raise(at(400, -100)); // selection centre at 50: the toolbar would hang off the left
    expect(placed.left).toBe(BOX.w / 2 + POP_EDGE); // kept on screen when raised
    expect(a.dx).toBe(placed.left - 50);
    // Scrolling vertically moves top only; the same horizontal shift is carried, not recomputed.
    const p = attachedPosition(at(100, -100), a);
    expect(p.left).toBe(placed.left);
    expect(p.top).toBe(90);
  });

  it("carries no shift at all when none was needed", () => {
    const { a } = raise(at(400, 350));
    expect(a.dx).toBe(0);
    expect(a.dy).toBe(0);
  });
});

describe("direction does not enter into the vertical rule", () => {
  it("gives the same vertical placement for text on either side of the page", () => {
    const l = raise(at(400, 40)), r = raise(at(400, 660));
    expect(attachedPosition(at(250, 40), l.a).top).toBe(attachedPosition(at(250, 660), r.a).top);
  });

  it("centres on the selection in both, then follows it in both", () => {
    const l = raise(at(400, 300)), r = raise(at(400, 400));
    expect(attachedPosition(at(400, 300), l.a).left).toBe(450);
    expect(attachedPosition(at(400, 400), r.a).left).toBe(550);
  });
});

describe("a new selection is placed afresh", () => {
  it("does not inherit the previous attachment", () => {
    const first = raise(at(30)); // below
    const second = raise(at(500)); // room above → above
    expect(first.a.below).toBe(true);
    expect(second.a.below).toBe(false);
  });
});

describe("no viewport coordinate enters into a tracked position", () => {
  const LAYER = readFileSync("src/features/reader/AnnotationLayer.tsx", "utf8");
  const ENGINE = readFileSync("src/reader-engine/FoliateController.ts", "utf8");

  it("the tracked position has no clamp in it", () => {
    const body = LAYER.slice(LAYER.indexOf("export function attachedPosition("));
    const fn = body.slice(0, body.indexOf("\n}") + 2);
    expect(fn).toContain("wantX + a.dx");
    expect(fn).toContain("wantY + a.dy");
    expect(fn).not.toMatch(/Math\.(min|max)|innerHeight|innerWidth|POP_EDGE/);
  });

  it("the freeze is gone", () => {
    expect(LAYER).not.toContain("heldPlacement");
    expect(LAYER).not.toContain("selectionOffscreen");
    expect(LAYER).toContain("attachedPosition(sel.rect, attached.current.a)");
  });

  it("a new selection is placed afresh IN THE COMPONENT, not only in the pure helpers", () => {
    // `raise()` twice in a test proves the helpers; this proves the component throws the old record
    // away when the selection changes. Without this line a new selection would inherit the previous
    // one's side and shift for as long as the component stayed mounted.
    expect(LAYER).toContain("if (attached.current && attached.current.key !== key) attached.current = null;");
    // …and the record is only ever written from a MEASURED placement.
    expect(LAYER).toContain("if (popBox) attached.current = { key, a: attachment(raised, below) };");
  });

  it("the component never hides the toolbar because of where the selection is", () => {
    // The stand-down was removed by name above; this forbids it coming back under any name. Between
    // deciding the position and rendering it, the component must not bail out — the toolbar goes
    // where the text goes, and off the screen is a place, not a reason to vanish.
    const from = LAYER.indexOf('const key = sel.cfi + "\\u0000" + sel.text;');
    const to = LAYER.indexOf("className={`hl-pop${below", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const between = LAYER.slice(from, to);
    expect(between).not.toContain("return null");
    expect(between).not.toMatch(/innerHeight|innerWidth|offscreen|Offscreen/);
  });

  it("the document change still dismisses, in the engine", () => {
    const body = ENGINE.slice(ENGINE.indexOf("private refreshSelectionRect()")).slice(0, 1800);
    expect(body).toContain("c?.doc === doc");
    expect(body).toContain("this.emitSelection(null)");
  });

  // A DISMISSED SELECTION CANNOT BE BROUGHT BACK BY WORK THAT OUTLIVED IT.
  //
  // `refreshSelectionRect` runs on every renderer scroll and every relocate, and re-emits from
  // `liveSelection`. Dropping the browser's ranges without retiring that field left the toolbar
  // reachable by anything that ran afterwards: measured in the reader, it returned at the old words
  // after a dismissal and a wait, after a dismissal and a scroll, and while read-aloud moved the
  // text underneath it.
  //
  // Retiring the field is what makes every later callback harmless rather than racing it — they all
  // read the same field, and an empty field has nothing to resurrect. No timer is involved, so
  // nothing here depends on how long "later" turns out to be.
  it("clearing the selection retires it in the engine, not just in the browser", () => {
    const body = ENGINE.slice(ENGINE.indexOf("  clearSelection(): void {"));
    const fn = body.slice(0, body.indexOf(String.fromCharCode(10) + "  }") + 4);
    expect(fn).toContain("this.emitSelection(null)");
    // Before anything else: the ranges may be dropped either way round, but the record must go.
    expect(fn.indexOf("this.emitSelection(null)")).toBeLessThan(fn.indexOf("removeAllRanges"));
  });

  it("the one field the toolbar can be resurrected from is written in exactly two places", () => {
    // `emitSelection` sets it and `refreshSelectionRect` reads it. A third writer would be a second
    // authority over the same question, which is how the two could disagree again.
    const writes = [...ENGINE.matchAll(/this\.liveSelection\s*=/g)].length;
    expect(writes).toBe(1);
    expect(ENGINE).toContain("private liveSelection: SelectionInfo | null = null;");
  });

  it("no dismissal path drops the ranges without retiring the record", () => {
    // Every caller reaches the engine through `clearSelection`, so the pairing lives in one place
    // and a new caller cannot forget it.
    const layer = readFileSync("src/features/reader/AnnotationLayer.tsx", "utf8");
    expect(layer).toContain("clearSelection()");
    expect(layer).not.toMatch(/removeAllRanges/);
  });
});
