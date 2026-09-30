// LAST TOUCHED, ON TOP — the inserted picture and the words are two layers, and the one you
// touched last is the one in front.
//
// ## What was actually wrong
//
// Nothing about the model. `elements` order IS the paint order (see `elements.ts`), every element
// carries an absolute rect in canvas fractions so nothing is in document flow, and `bringToFront`
// has existed all along. The single missing wire was that NOTHING CALLED IT except the explicit
// "bring to front" button: selecting a thing on the card set `selectedId` and left the order alone.
// So a picture added to a card sat over the words permanently, and the only way back to them was to
// find an order control — which reads as the picture "pushing against" the text.
//
// ## The background is not one of the layers
//
// `ground` is a sibling of `elements`, not a member of it, and `CardLayers` draws `GroundLayer`
// before `ElementsLayer`. No amount of reordering can put an element behind the ground or bring the
// ground forward, and the tests below assert that rather than trusting it.
//
// ## What these can and cannot prove
//
// The repository has no DOM-render harness — no testing-library, no jsdom — so "clicking the image"
// cannot be simulated here. The split is deliberate and stated: the ORDERING SEMANTICS are proved
// against the real pure operations, and the WIRING (that the canvas's selection is the raising one,
// and that the rail's is not) is proved against the editor's source. The gesture itself was
// verified by driving the real editor; that evidence lives in the task report, not here.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPOSITION_VERSION, type Composition, type ImageElement, type TextElement,
} from "../../src/features/photo/composition";
import { addElement, bringToFront, isImage, isText, makeImage, makeText } from "../../src/features/photo/elements";
import { DEFAULT_META } from "../../src/features/photo/photo";
import { DEFAULT_PRESET } from "../../src/features/photo/composition";

const COMPOSER = readFileSync(join(process.cwd(), "src/features/photo/PhotoComposer.tsx"), "utf8");
const LAYERS = readFileSync(join(process.cwd(), "src/features/photo/CardLayers.tsx"), "utf8");
/** Source with comment lines stripped — the prose names the old wiring on purpose. */
const code = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const PAPER = "#F5EEDD";
const empty = (): Composition => ({
  v: COMPOSITION_VERSION,
  canvas: { format: "portrait", w: 1080, h: 1350 },
  ground: { kind: "theme", themeId: "ivory", paper: PAPER },
  preset: { ...DEFAULT_PRESET, meta: { ...DEFAULT_META } },
  elements: [],
});

/** A picture and a line of text, deliberately overlapping, the picture added first. */
function overlapping() {
  let c = empty();
  const img = { ...makeImage(c, "asset-1"), placement: { rect: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } } } as ImageElement;
  c = addElement(c, img);
  const txt = { ...makeText(c, "text", "over the picture"), placement: { rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.2 } } } as TextElement;
  c = addElement(c, txt);
  return { comp: c, imgId: img.id, txtId: txt.id };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const order = (c: Composition) => c.elements.map((e) => e.id);
const rectOf = (c: Composition, id: string) => {
  const el = c.elements.find((e) => e.id === id)!;
  if (el.kind === "unknown") throw new Error("no rect");
  return el.placement.rect;
};

describe("A · the inserted image is an object, not the background", () => {
  it("lives in `elements`, while the ground is a sibling of them", () => {
    const { comp, imgId } = overlapping();
    expect(comp.elements.some((e) => e.id === imgId && isImage(e))).toBe(true);
    // The ground is not reachable as an element, so nothing can select or reorder it as one.
    expect(comp.elements.some((e) => e.id === (comp.ground as { assetId?: string }).assetId)).toBe(false);
    expect(comp.ground.kind).toBe("theme");
  });

  it("carries its own rect, so it never joins the document flow", () => {
    const { comp, imgId } = overlapping();
    const r = rectOf(comp, imgId);
    for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v)).toBe(true);
    // The renderer places every element absolutely from that rect — one path for text and picture.
    expect(code(LAYERS)).toContain('position: "absolute"');
    expect(code(LAYERS)).toContain("comp.elements.map((el) => {");
  });
});

describe("B and C · they overlap, and the text starts above", () => {
  it("the two rects really do overlap, or nothing below means anything", () => {
    const { comp, imgId, txtId } = overlapping();
    expect(overlaps(rectOf(comp, imgId), rectOf(comp, txtId))).toBe(true);
  });

  it("text placed after the picture paints over it", () => {
    const { comp, imgId, txtId } = overlapping();
    expect(order(comp)).toEqual([imgId, txtId]);
  });
});

describe("D and E · the last one touched is the one in front", () => {
  it("touching the picture puts the picture in front", () => {
    const { comp, imgId, txtId } = overlapping();
    expect(order(bringToFront(comp, imgId))).toEqual([txtId, imgId]);
  });

  it("touching the text afterwards puts the text back in front", () => {
    const { comp, imgId, txtId } = overlapping();
    const afterImage = bringToFront(comp, imgId);
    expect(order(bringToFront(afterImage, txtId))).toEqual([imgId, txtId]);
  });

  it("and it goes on alternating, because the rule is about the last touch and nothing else", () => {
    const { comp, imgId, txtId } = overlapping();
    let c = comp;
    for (const id of [imgId, txtId, imgId, imgId, txtId]) c = bringToFront(c, id);
    expect(order(c)[order(c).length - 1]).toBe(txtId);
  });

  it("raising changes only the order — never the element itself", () => {
    const { comp, imgId } = overlapping();
    const before = comp.elements.find((e) => e.id === imgId)!;
    const after = bringToFront(comp, imgId).elements.find((e) => e.id === imgId)!;
    expect(after).toEqual(before);
  });
});

describe("F and G · the background stays the background", () => {
  it("no reordering can bring the ground forward or push an element behind it", () => {
    const { comp, imgId, txtId } = overlapping();
    for (const id of [imgId, txtId]) {
      const c = bringToFront(comp, id);
      expect(c.ground).toBe(comp.ground);          // same object, not merely equal
      expect(c.elements.length).toBe(comp.elements.length);
    }
    // The ground is painted before the elements, so "behind both" is structural, not a z-index.
    expect(code(LAYERS)).toMatch(/GroundLayer[\s\S]*ElementsLayer/);
  });

  it("the ground's own colour is untouched by a change of order", () => {
    const { comp, imgId } = overlapping();
    const after = bringToFront(comp, imgId);
    expect((after.ground as { paper?: string }).paper).toBe(PAPER);
    expect(after.ground).toEqual(comp.ground);
  });
});

describe("H · a card with nothing overlapping behaves exactly as it did", () => {
  it("raising the element that is already in front changes nothing at all", () => {
    const { comp, txtId } = overlapping();
    expect(bringToFront(comp, txtId)).toEqual(comp);
    expect(order(bringToFront(comp, txtId))).toEqual(order(comp));
  });

  it("a card with one element, or none, is returned untouched", () => {
    const one = addElement(empty(), makeText(empty(), "text", "only"));
    expect(bringToFront(one, one.elements[0].id)).toEqual(one);
    const none = empty();
    expect(bringToFront(none, "nobody")).toEqual(none);
  });

  it("an id that is not on the card is a no-op rather than a throw", () => {
    const { comp } = overlapping();
    expect(bringToFront(comp, "missing")).toEqual(comp);
  });
});

describe("the wiring in the editor", () => {
  it("the canvas hands selection to the raising handler", () => {
    expect(code(COMPOSER)).toContain("const selectOnCanvas = useCallback((id: string | null) => {");
    expect(code(COMPOSER)).toContain("return bringToFront({ ...compRef.current, elements: prev }, id).elements;");
    expect(code(COMPOSER)).toContain("onSelect={selectOnCanvas}");
    // Beginning to type in a text element is an interaction with it, so it raises too.
    expect(code(COMPOSER)).toContain("onBeginEdit={(id) => { selectOnCanvas(id); setEditingId(id); }}");
  });

  it("the strip of objects raises too, because it is the only way to reach a covered element", () => {
    // THIS ASSERTION USED TO SAY THE OPPOSITE, and the opposite was wrong.
    //
    // The first version of this fix left the strip on plain selection, reasoning that a list should
    // not reorder under the finger pointing at it. MEASURED afterwards in the running editor, with a
    // picture whose rect CONTAINS the text's: every hit box in `CardOverlay` is a full rectangle in
    // paint order, so once the picture is in front a press where the words are resolves to the
    // PICTURE's box. It raises the picture that is already in front and nothing appears to happen.
    // The words could not be brought back at all by touching the card.
    //
    // The strip is the one control that can name an element the canvas cannot reach, so it has to
    // carry the same rule. The explicit order controls ("To front" and the rest) are untouched and
    // still work; this only means the reader no longer has to find them.
    const src = code(COMPOSER);
    const strip = src.slice(src.indexOf("<ObjectsStrip"), src.indexOf("<ObjectsStrip") + 300);
    expect(strip).toContain("onSelect={selectOnCanvas}");
    // One handler for both, so the canvas and the strip cannot drift apart on what "touched" means.
    expect(src.match(/onSelect=\{selectOnCanvas\}/g)?.length).toBe(2);
  });

  it("raising is skipped when the element is already on top, so a click is not an edit", () => {
    // The editor's dirty flag is "different from what we opened with"; returning `prev` unchanged is
    // what keeps a plain click off that comparison.
    expect(code(COMPOSER)).toContain("if (i < 0 || i === prev.length - 1) return prev;");
  });

  it("the explicit order controls are still there — this adds to them, it replaces nothing", () => {
    for (const fn of ["bringToFront", "bringForward", "sendBackward", "sendToBack"]) {
      expect(code(COMPOSER)).toContain(fn);
    }
  });
});

describe("what must NOT have changed", () => {
  it("the stacking model is still the array, with no z-index anywhere in the card", () => {
    expect(code(LAYERS)).not.toMatch(/zIndex/);
    expect(isText).toBeTypeOf("function");
    expect(isImage).toBeTypeOf("function");
  });
});
