// TWO THINGS A CARD CAN NOW DO, and the rules both are held to.
//
// THE STROKE — a line around the letters. It is the fourth readability device and the only one that
// is not a mode, because it composes with the other three rather than replacing one: a halo carries
// the words off a busy ground and a hairline stroke stops the glyph edges dissolving into it.
//
// It is held to the same rule as the treatments, and the rule is the whole reason `legibility.ts`
// exists: NOTHING MAY CHANGE WHERE A LINE BREAKS. A padding, a margin, a border — anything that takes
// part in layout — would re-wrap the text and move the auto-fitted size with it, which is a visual
// control quietly re-typesetting the card. `-webkit-text-stroke` and `paint-order` are paint.
//
// THE FLIP — mirrored in the drawing, never in the file. A negative scale on the same element, so the
// stored picture is untouched, the flip costs nothing, and it survives the export because the export
// rasterises this very DOM.
import { describe, expect, it } from "vitest";

import { STROKE_MAX_EM, backingColor, strokeColor, strokeStyle } from "../../src/features/photo/legibility";
import {
  parseComposition,
  serializeComposition,
  newCustomComposition,
  type TextStyle,
} from "../../src/features/photo/composition";

const INK = "#241a10";
const PAPER = "#f6efe2";

describe("the stroke", () => {
  it("is nothing at all at zero, and at no width", () => {
    expect(strokeStyle({ width: 0, textColor: INK, paper: PAPER })).toEqual({});
    expect(strokeStyle({ textColor: INK, paper: PAPER })).toEqual({});
  });

  it("draws behind the fill, so the letterform is the one the typeface drew", () => {
    // Without `paint-order` half the stroke sits ON the glyph: at any usable weight Arabic counters
    // close up and the face thickens. This is the property that makes a stroke usable at all.
    const s = strokeStyle({ width: 0.04, textColor: INK, paper: PAPER });
    expect(s.paintOrder).toBe("stroke fill");
  });

  it("asks for twice the width, because half of it is hidden under the fill", () => {
    // The number the reader sets is the line they SEE — the only definition that is any use to them.
    const s = strokeStyle({ width: 0.05, textColor: INK, paper: PAPER });
    expect(s.WebkitTextStroke).toMatch(/^0\.1000em /);
  });

  it("is measured in em, so it scales with the type and survives a change of format", () => {
    const s = strokeStyle({ width: 0.03, textColor: INK, paper: PAPER });
    expect(s.WebkitTextStroke).toContain("em");
    expect(s.WebkitTextStroke).not.toContain("px");
  });

  it("takes the reader's colour when they name one", () => {
    const s = strokeStyle({ width: 0.04, color: "#FFEFD5", textColor: INK, paper: PAPER });
    expect(s.WebkitTextStroke).toContain("#FFEFD5");
  });

  it("and derives the same answer a treatment derives, so the two read as one decision", () => {
    expect(strokeColor(INK, PAPER)).toBe(backingColor(INK, PAPER));
    const s = strokeStyle({ width: 0.04, color: null, textColor: INK, paper: PAPER });
    expect(s.WebkitTextStroke).toContain(backingColor(INK, PAPER));
  });

  it("cannot be dialled past the point where the counters close", () => {
    const s = strokeStyle({ width: 5, textColor: INK, paper: PAPER });
    expect(s.WebkitTextStroke).toBe(`${(STROKE_MAX_EM * 2).toFixed(4)}em ${backingColor(INK, PAPER)}`);
  });

  it("TOUCHES NOTHING THAT TAKES PART IN LAYOUT — the rule the treatments are held to", () => {
    const s = strokeStyle({ width: 0.08, textColor: INK, paper: PAPER }) as Record<string, unknown>;
    for (const k of Object.keys(s)) {
      expect(k, k + " participates in layout").toMatch(/^(WebkitTextStroke|paintOrder)$/);
    }
  });

  it("is byte-identical at every width — nothing about the box changes with it", () => {
    // The layout-neutrality claim, made measurable: the properties the stroke returns are the same
    // two at 1% as at 24%, so no width can reach anything that decides where a line breaks.
    const keys = (w: number) => Object.keys(strokeStyle({ width: w, textColor: INK, paper: PAPER })).sort();
    for (let w = 0.01; w <= STROKE_MAX_EM; w += 0.01) {
      expect(keys(w)).toEqual(["WebkitTextStroke", "paintOrder"]);
    }
  });
});

describe("the stroke, in a saved document", () => {
  /**
   * A real blank card, carried out to a document and back, with the keys under test written into its
   * first element the way a saved file carries them — including values only a newer version could
   * have written.
   *
   * The keys go in at the DOCUMENT layer rather than into the typed card, and that is deliberate
   * twice over. It is the parser's job to decide what survives, so handing it text is what the test
   * is actually about; and a typed card cannot hold `strokeWidth: 9` in the first place, so writing
   * it there meant forcing the value past the compiler and then asking the parser about a value the
   * product could never have produced. `serializeComposition` writes a text element out verbatim, so
   * the two orderings are the same document.
   */
  const roundTrip = (style: Record<string, unknown>): TextStyle => {
    const written = serializeComposition(newCustomComposition("ivory", "portrait", "نصّ"));
    const doc = JSON.parse(written) as { elements: { style?: Record<string, unknown> }[] };
    doc.elements[0].style = { ...doc.elements[0].style, ...style };
    const back = parseComposition(JSON.stringify(doc));
    if (!back) throw new Error("the round-tripped card did not parse");
    const el = back.elements[0];
    if (!("style" in el)) throw new Error(`expected a text element, found ${el.kind}`);
    return el.style;
  };

  it("persists, and survives being read back", () => {
    const s = roundTrip({ strokeWidth: 0.037, strokeColor: "#102030" });
    expect(s.strokeWidth).toBe(0.037);
    expect(s.strokeColor).toBe("#102030");
  });

  it("a derived colour round-trips as derived rather than as absent", () => {
    expect(roundTrip({ strokeWidth: 0.02, strokeColor: null }).strokeColor).toBeNull();
  });

  it("a width from a newer version is brought inside the range rather than trusted", () => {
    expect(roundTrip({ strokeWidth: 9 }).strokeWidth).toBe(0.24);
    expect(roundTrip({ strokeWidth: -3 }).strokeWidth).toBe(0);
  });

  it("a card with no stroke stays a card with no stroke", () => {
    const s = roundTrip({});
    expect(s.strokeWidth).toBeUndefined();
    expect(s.strokeColor).toBeUndefined();
  });
});

describe("the flip", () => {
  const groundDoc = (extra: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      canvas: { format: "portrait", w: 1080, h: 1350 },
      ground: { kind: "image", assetId: "abc", themeId: "ivory", ...extra },
      preset: {},
      elements: [],
    });

  const imageDoc = (extra: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      canvas: { format: "portrait", w: 1080, h: 1350 },
      ground: { kind: "theme", themeId: "ivory" },
      preset: {},
      elements: [{ id: "e1", kind: "image", assetId: "xyz", placement: { rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, ...extra }],
    });

  it("persists on the ground", () => {
    const g = parseComposition(groundDoc({ flipX: true }))!.ground as { flipX?: boolean; flipY?: boolean };
    expect(g.flipX).toBe(true);
    expect(g.flipY).toBeUndefined();
  });

  it("persists on a picture element", () => {
    const el = parseComposition(imageDoc({ flipY: true }))!.elements[0] as { flipX?: boolean; flipY?: boolean };
    expect(el.flipY).toBe(true);
    expect(el.flipX).toBeUndefined();
  });

  it("survives a full round trip through the document", () => {
    const once = parseComposition(groundDoc({ flipX: true, flipY: true }))!;
    const twice = parseComposition(serializeComposition(once))!;
    expect(twice.ground).toMatchObject({ flipX: true, flipY: true });
  });

  it("the ground's flip and an element's flip are separate properties of separate objects", () => {
    // The requirement in as many words: flipping the background must not reach a foreground picture,
    // and flipping a picture must not reach the background. They cannot, because neither is stored
    // anywhere the other can read.
    const doc = JSON.parse(imageDoc({ flipX: true }));
    doc.ground = { kind: "image", assetId: "bg", themeId: "ivory" };
    const c = parseComposition(JSON.stringify(doc))!;
    expect((c.elements[0] as { flipX?: boolean }).flipX).toBe(true);
    expect((c.ground as { flipX?: boolean }).flipX).toBeUndefined();
  });

  it("is a boolean or it is nothing — a truthy value from elsewhere does not turn it on", () => {
    const g = parseComposition(groundDoc({ flipX: "yes" }))!.ground as { flipX?: boolean };
    expect(g.flipX).toBeUndefined();
  });

  it("never touches the picture it mirrors", () => {
    // The asset id is the file. A flip that rewrote the source would change it — and would also make
    // the flip permanent, shared with every other card using the same picture, and impossible to undo.
    const before = parseComposition(imageDoc({}))!.elements[0] as { assetId: string };
    const after = parseComposition(imageDoc({ flipX: true, flipY: true }))!.elements[0] as { assetId: string };
    expect(after.assetId).toBe(before.assetId);
  });
});

describe("the renderer draws what the document says", () => {
  // A source guard rather than a DOM test: these unit tests run in plain node with no layout, and
  // the property that matters is that ONE place turns the document's flags into a transform.
  it("both pictures are mirrored by a scale, and nothing else is", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/features/photo/CardLayers.tsx"), "utf8");
    expect(src).toContain("el.flipX ? -1 : 1");
    expect(src).toContain("ground.flipX ? -scale : scale");
    // No canvas, no re-encoding, no second copy of the asset anywhere in the drawing path.
    expect(src).not.toMatch(/createImageBitmap|toDataURL|putImageData/);
  });

  it("the stroke is applied where the treatment is, after everything that could be layout", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/features/photo/CardLayers.tsx"), "utf8");
    expect(src).toContain("strokeStyle({");
    expect(src).toContain("...(stroke ?? null),");
  });
});
