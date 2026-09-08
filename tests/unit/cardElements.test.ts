// COMPOSING — the operations behind every gesture in the editor.
//
// These are the pure half of dragging, resizing and stacking. Holding them here means a failure in
// the editor can be attributed: if these pass and the card does not move, the fault is in the
// gesture plumbing, not in the arithmetic — which is exactly the question a broken resize raises.
import { describe, it, expect } from "vitest";
import {
  MIN_SIZE, addElement, bringForward, bringToFront, clampRect, liftAttribution, liftQuote, makeImage,
  makeText, moveBy, nextRect, removeElement, resizeBy, sendBackward, sendToBack, setPlacement,
  updateImage, updateStyle, updateText,
} from "../../src/features/photo/elements";
import { DEFAULT_PRESET, COMPOSITION_VERSION, type Composition, type ImageElement, type TextElement } from "../../src/features/photo/composition";
import { DEFAULT_META } from "../../src/features/photo/photo";

const empty = (): Composition => ({
  v: COMPOSITION_VERSION,
  canvas: { format: "portrait", w: 1080, h: 1350 },
  ground: { kind: "theme", themeId: "ivory" },
  preset: { ...DEFAULT_PRESET, meta: { ...DEFAULT_META } },
  elements: [],
});

const withQuote = () => {
  const c = empty();
  const q = liftQuote("a passage");
  return { comp: addElement(c, q), id: q.id };
};

describe("moving", () => {
  it("adds the delta to the inline-start and block-start edges", () => {
    const { comp, id } = withQuote();
    const before = (comp.elements[0] as TextElement).placement.rect;
    const after = (moveBy(comp, id, 0.1, -0.05).elements[0] as TextElement).placement.rect;
    expect(after.x).toBeCloseTo(before.x + 0.1, 6);
    expect(after.y).toBeCloseTo(before.y - 0.05, 6);
  });

  it("does not change the element's size", () => {
    const { comp, id } = withQuote();
    const b = (comp.elements[0] as TextElement).placement.rect;
    const a = (moveBy(comp, id, 0.3, 0.3).elements[0] as TextElement).placement.rect;
    expect([a.w, a.h]).toEqual([b.w, b.h]);
  });

  it("lets an element hang off the edge, but never out of reach", () => {
    const { comp, id } = withQuote();
    const a = (moveBy(comp, id, -99, -99).elements[0] as TextElement).placement.rect;
    expect(a.x).toBeGreaterThanOrEqual(-0.9);
    expect(a.y).toBeGreaterThanOrEqual(-0.9);
  });

  it("ignores an id that is not there", () => {
    const { comp } = withQuote();
    expect(moveBy(comp, "nope", 0.2, 0.2)).toEqual(comp);
  });
});

describe("resizing", () => {
  // Each grip pulls its own edge and leaves the opposite one where it was. That is what makes a
  // resize feel like it pivots on the side you are NOT holding.
  it("grows the inline size from the end grip, leaving the start edge alone", () => {
    const { comp, id } = withQuote();
    const b = (comp.elements[0] as TextElement).placement.rect;
    const a = (resizeBy(comp, id, "ie", 0.1, 0).elements[0] as TextElement).placement.rect;
    expect(a.w).toBeCloseTo(b.w + 0.1, 6);
    expect(a.x).toBeCloseTo(b.x, 6);
  });

  it("grows from the start grip by moving the start edge instead", () => {
    const { comp, id } = withQuote();
    const b = (comp.elements[0] as TextElement).placement.rect;
    const a = (resizeBy(comp, id, "is", -0.1, 0).elements[0] as TextElement).placement.rect;
    expect(a.w).toBeCloseTo(b.w + 0.1, 6);
    expect(a.x).toBeCloseTo(b.x - 0.1, 6);
  });

  it("grows the block size from the block-end grip", () => {
    const { comp, id } = withQuote();
    const b = (comp.elements[0] as TextElement).placement.rect;
    const a = (resizeBy(comp, id, "be", 0, 0.12).elements[0] as TextElement).placement.rect;
    expect(a.h).toBeCloseTo(b.h + 0.12, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });

  it("moves both edges from a corner grip", () => {
    const { comp, id } = withQuote();
    const b = (comp.elements[0] as TextElement).placement.rect;
    const a = (resizeBy(comp, id, "ie-be", 0.08, 0.06).elements[0] as TextElement).placement.rect;
    expect(a.w).toBeCloseTo(b.w + 0.08, 6);
    expect(a.h).toBeCloseTo(b.h + 0.06, 6);
  });

  it("never shrinks an element past the point where its own handles cover it", () => {
    const { comp, id } = withQuote();
    const a = (resizeBy(comp, id, "ie-be", -99, -99).elements[0] as TextElement).placement.rect;
    expect(a.w).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(a.h).toBeGreaterThanOrEqual(MIN_SIZE);
  });

  it("treats a grip name as its two logical edges and nothing else", () => {
    // "ie-bs" must not be read as containing "is" — a substring test that got this wrong would move
    // the wrong edge, and the element would drift while being resized.
    const { comp, id } = withQuote();
    const b = (comp.elements[0] as TextElement).placement.rect;
    const a = (resizeBy(comp, id, "ie-bs", 0.05, -0.05).elements[0] as TextElement).placement.rect;
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.w).toBeCloseTo(b.w + 0.05, 6);
    expect(a.h).toBeCloseTo(b.h + 0.05, 6);
  });
});

describe("stacking is the array order, and nothing else", () => {
  const three = () => {
    let c = empty();
    const a = makeText(c, "text", "a"); c = addElement(c, a);
    const b = makeText(c, "text", "b"); c = addElement(c, b);
    const d = makeText(c, "text", "c"); c = addElement(c, d);
    return { c, ids: [a.id, b.id, d.id] };
  };

  it("brings one element forward by exactly one place", () => {
    const { c, ids } = three();
    expect(bringForward(c, ids[0]).elements.map((e) => e.id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it("sends one back by exactly one place", () => {
    const { c, ids } = three();
    expect(sendBackward(c, ids[2]).elements.map((e) => e.id)).toEqual([ids[0], ids[2], ids[1]]);
  });

  it("jumps to the front and to the back", () => {
    const { c, ids } = three();
    expect(bringToFront(c, ids[0]).elements.map((e) => e.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(sendToBack(c, ids[2]).elements.map((e) => e.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it("does nothing at the ends rather than wrapping around", () => {
    const { c, ids } = three();
    expect(bringForward(c, ids[2])).toEqual(c);
    expect(sendBackward(c, ids[0])).toEqual(c);
  });
});

describe("adding and removing", () => {
  it("fans new elements instead of stacking them all dead centre", () => {
    const c = empty();
    const a = nextRect(c, 0.3, 0.3);
    const b = nextRect(addElement(c, makeText(c, "text", "x")), 0.3, 0.3);
    expect(a).not.toEqual(b);
  });

  it("keeps a new element on the canvas", () => {
    let c = empty();
    for (let i = 0; i < 8; i++) c = addElement(c, makeText(c, "text", "t" + i));
    for (const el of c.elements) {
      const r = (el as TextElement).placement.rect;
      expect(r.x).toBeGreaterThan(-0.5);
      expect(r.x).toBeLessThan(1.5);
    }
  });

  it("removes only the element asked for", () => {
    const { comp, id } = withQuote();
    const c2 = addElement(comp, makeText(comp, "text", "keep"));
    const after = removeElement(c2, id);
    expect(after.elements).toHaveLength(1);
    expect((after.elements[0] as TextElement).text).toBe("keep");
  });

  it("a lifted quote arrives where the preset had it, not in the middle", () => {
    // Otherwise the card jumps under the cursor the moment the user frees it.
    const r = liftQuote("x").placement.rect;
    expect(r.y).toBeLessThan(0.3);
    expect(r.w).toBeGreaterThan(0.6);
  });

  it("a lifted quote measures its own size by default", () => {
    expect(liftQuote("x").style.size).toBeNull();
  });

  it("lifted attribution sits below the quote", () => {
    expect(liftAttribution("x").placement.rect.y).toBeGreaterThan(liftQuote("x").placement.rect.y);
  });
});

describe("editing content and style", () => {
  it("replaces the words, including with nothing at all", () => {
    const { comp, id } = withQuote();
    expect((updateText(comp, id, "").elements[0] as TextElement).text).toBe("");
    expect((updateText(comp, id, "new").elements[0] as TextElement).text).toBe("new");
  });

  it("merges a style patch rather than replacing the style", () => {
    const { comp, id } = withQuote();
    const a = updateStyle(comp, id, { size: 0.09 });
    const b = updateStyle(a, id, { lineHeight: 2.1 });
    const st = (b.elements[0] as TextElement).style;
    expect(st.size).toBe(0.09);
    expect(st.lineHeight).toBe(2.1);
  });

  it("accepts a size no preset offers", () => {
    const { comp, id } = withQuote();
    expect((updateStyle(comp, id, { size: 0.0731 }).elements[0] as TextElement).style.size).toBe(0.0731);
  });

  it("keeps an image's identity while patching it", () => {
    let c = empty();
    const img = makeImage(c, "asset-9");
    c = addElement(c, img);
    const after = updateImage(c, img.id, { opacity: 0.4, fit: "cover" }).elements[0] as ImageElement;
    expect(after.assetId).toBe("asset-9");
    expect(after.kind).toBe("image");
    expect(after.opacity).toBe(0.4);
    expect(after.fit).toBe("cover");
  });

  it("clamps a rect written straight into placement", () => {
    const { comp, id } = withQuote();
    const r = (setPlacement(comp, id, { rect: { x: 0.2, y: 0.2, w: 0, h: 0 } }).elements[0] as TextElement).placement.rect;
    expect(r.w).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(r.h).toBeGreaterThanOrEqual(MIN_SIZE);
  });

  it("clampRect leaves a sane rect alone", () => {
    const r = { x: 0.2, y: 0.3, w: 0.5, h: 0.4 };
    expect(clampRect(r)).toEqual(r);
  });
});
