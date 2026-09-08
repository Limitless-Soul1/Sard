// THE CARD DOCUMENT IS A PROMISE ABOUT USER DATA, so the promise is held to.
//
// A card that cannot be written down and read back identically is the defect this model exists to
// remove: before it, reopening a card silently rebuilt it as a Minimal auto-fit card and saving
// overwrote the good PNG. These tests hold the three properties that make that impossible to
// reintroduce — a document survives a round-trip, a card with NO document still opens as exactly what
// it always was, and a document from a newer version is never quietly stripped on its way through.
import { describe, it, expect } from "vitest";
import {
  COMPOSITION_VERSION, DEFAULT_PRESET, compositionFromLegacy, newId, parseComposition,
  referencedAssets, serializeComposition,
  type Composition, type ImageElement, type TextElement,
} from "../../src/features/photo/composition";
import { DEFAULT_META } from "../../src/features/photo/photo";

const text = (over: Partial<TextElement> = {}): TextElement => ({
  id: "t1",
  kind: "quote",
  placement: { rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.4 } },
  style: { size: 0.06, lineHeight: 1.8, align: "start", color: null, opacity: 1 },
  text: "لم يكن في الأمر ما يدعو إلى العجب.",
  ...over,
});
const image = (over: Partial<ImageElement> = {}): ImageElement => ({
  id: "i1",
  kind: "image",
  placement: { rect: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, rotate: 12 },
  assetId: "asset-a",
  fit: "cover",
  ...over,
});
/** Narrow away the forward-compatibility case: these assertions are about elements we DO know. */
const placed = (el: Composition["elements"][number]) => {
  if (el.kind === "unknown") throw new Error("expected a known element, got an unknown one");
  return el.placement;
};

const base = (over: Partial<Composition> = {}): Composition => ({
  v: COMPOSITION_VERSION,
  canvas: { format: "portrait", w: 1080, h: 1350 },
  ground: { kind: "theme", themeId: "ivory" },
  preset: { ...DEFAULT_PRESET, meta: { ...DEFAULT_META } },
  elements: [],
  ...over,
});

describe("the card document round-trips", () => {
  it("survives serialise → parse → serialise unchanged", () => {
    const comp = base({ elements: [text(), image()], custom: true });
    const once = serializeComposition(comp);
    const back = parseComposition(once);
    expect(back).not.toBeNull();
    expect(serializeComposition(back!)).toBe(once);
  });

  it("keeps every authored value, not just the shape", () => {
    const comp = base({
      elements: [text({ style: { size: 0.081, lineHeight: 2.05, letterSpacing: 0.012, weight: 700, align: "center", color: "#B8825C", opacity: 0.9, dir: "rtl" } })],
    });
    const back = parseComposition(serializeComposition(comp))!;
    const el = back.elements[0] as TextElement;
    expect(el.style.size).toBe(0.081);
    expect(el.style.lineHeight).toBe(2.05);
    expect(el.style.letterSpacing).toBe(0.012);
    expect(el.style.weight).toBe(700);
    expect(el.style.align).toBe("center");
    expect(el.style.color).toBe("#B8825C");
    expect(el.style.opacity).toBe(0.9);
    expect(el.style.dir).toBe("rtl");
  });

  it("keeps a font size that is not one of the presets", () => {
    // The presets are shortcuts, not limits — an arbitrary size must survive storage.
    const odd = 0.0733;
    const back = parseComposition(serializeComposition(base({ elements: [text({ style: { size: odd } })] })))!;
    expect((back.elements[0] as TextElement).style.size).toBe(odd);
  });

  it("keeps an explicitly automatic size distinct from an absent one", () => {
    // `null` means "measure it"; that is a decision the user made and must not decay to a default.
    const back = parseComposition(serializeComposition(base({ elements: [text({ style: { size: null } })] })))!;
    expect((back.elements[0] as TextElement).style.size).toBeNull();
  });

  it("preserves element order, which is the stacking order", () => {
    const ids = ["a", "b", "c", "d"];
    const comp = base({ elements: ids.map((id) => text({ id })) });
    const back = parseComposition(serializeComposition(comp))!;
    expect(back.elements.map((e) => e.id)).toEqual(ids);
  });

  it("keeps rotation and the physical-placement escape hatch", () => {
    const comp = base({ elements: [image({ placement: { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, rotate: -30, mirror: false } })] });
    const back = parseComposition(serializeComposition(comp))!;
    expect(placed(back.elements[0]).rotate).toBe(-30);
    expect(placed(back.elements[0]).mirror).toBe(false);
  });

  it("treats logical placement as the default, so the common case stores no flag", () => {
    const back = parseComposition(serializeComposition(base({ elements: [text()] })))!;
    expect(placed(back.elements[0]).mirror).toBeUndefined();
  });
});

describe("a card with no document still opens as what it always was", () => {
  it("rebuilds the shipped defaults, with no free elements", () => {
    const comp = compositionFromLegacy({ format: "square", theme_id: "slate", quote_font: null });
    expect(comp.elements).toEqual([]);
    expect(comp.preset.style).toBe("minimal");
    expect(comp.preset.textSize).toBe("auto");
    expect(comp.preset.meta).toEqual(DEFAULT_META);
    expect(comp.ground).toEqual({ kind: "theme", themeId: "slate" });
    expect(comp.canvas).toEqual({ format: "square", w: 1080, h: 1080 });
  });

  it("is deterministic — the same row always gives the same document", () => {
    const row = { format: "story", theme_id: "nocturne", quote_font: "Amiri" };
    expect(serializeComposition(compositionFromLegacy(row)))
      .toBe(serializeComposition(compositionFromLegacy(row)));
  });

  it("carries the stored quote font through, since that column does exist", () => {
    expect(compositionFromLegacy({ format: "portrait", theme_id: "ivory", quote_font: "ArefRuqaa" }).preset.quoteFont)
      .toBe("ArefRuqaa");
  });

  it("falls back rather than inventing when the row is unusable", () => {
    const comp = compositionFromLegacy({ format: "not-a-format", theme_id: null, quote_font: null });
    expect(comp.canvas.format).toBe("portrait");
    expect(comp.ground).toEqual({ kind: "theme", themeId: "ivory" });
  });
});

describe("a document from a newer version is not quietly stripped", () => {
  it("keeps an element whose kind this version does not know", () => {
    const future = JSON.stringify({
      v: 99,
      canvas: { format: "portrait", w: 1080, h: 1350 },
      ground: { kind: "theme", themeId: "ivory" },
      preset: DEFAULT_PRESET,
      elements: [
        { id: "s1", kind: "shape", shape: "circle", fill: "#123456", placement: { rect: { x: 0, y: 0, w: 0.2, h: 0.2 } } },
        { id: "t1", kind: "quote", text: "known", placement: { rect: { x: 0, y: 0, w: 1, h: 1 } }, style: {} },
      ],
    });
    const back = parseComposition(future)!;
    expect(back.elements).toHaveLength(2);
    expect(back.elements[0].kind).toBe("unknown");
    const out = JSON.parse(serializeComposition(back));
    expect(out.elements[0]).toEqual({
      id: "s1", kind: "shape", shape: "circle", fill: "#123456",
      placement: { rect: { x: 0, y: 0, w: 0.2, h: 0.2 } },
    });
  });

  it("keeps top-level keys it does not recognise", () => {
    const future = JSON.stringify({
      v: 99, canvas: { format: "square", w: 1080, h: 1080 },
      ground: { kind: "theme", themeId: "ivory" }, preset: DEFAULT_PRESET, elements: [],
      animation: { kind: "fade", ms: 400 },
    });
    const out = JSON.parse(serializeComposition(parseComposition(future)!));
    expect(out.animation).toEqual({ kind: "fade", ms: 400 });
  });
});

describe("a malformed document degrades to the legacy path instead of corrupting a card", () => {
  it.each([
    ["not json at all", "{ this is not json"],
    ["a truncated blob", '{"v":1,"canvas":{"format":"portrait"'],
    ["an array", "[1,2,3]"],
    ["a bare string", '"hello"'],
    ["null", "null"],
    ["empty", ""],
  ])("returns null for %s", (_label, json) => {
    expect(parseComposition(json)).toBeNull();
  });

  it("drops an image element with no asset rather than rendering a broken box", () => {
    const bad = JSON.stringify({
      v: 1, canvas: { format: "portrait", w: 1080, h: 1350 },
      ground: { kind: "theme", themeId: "ivory" }, preset: DEFAULT_PRESET,
      elements: [{ id: "x", kind: "image", assetId: "", placement: { rect: { x: 0, y: 0, w: 1, h: 1 } } }],
    });
    expect(parseComposition(bad)!.elements).toEqual([]);
  });

  it("clamps a value that would place an element off any conceivable canvas", () => {
    const wild = JSON.stringify({
      v: 1, canvas: { format: "portrait", w: 1080, h: 1350 },
      ground: { kind: "theme", themeId: "ivory" }, preset: DEFAULT_PRESET,
      elements: [{ id: "x", kind: "text", text: "t", style: { opacity: 12, lineHeight: -4 }, placement: { rect: { x: 999, y: -999, w: 0, h: 1e9 } } }],
    });
    const el = parseComposition(wild)!.elements[0] as TextElement;
    expect(el.placement.rect.x).toBeLessThanOrEqual(3);
    expect(el.placement.rect.y).toBeGreaterThanOrEqual(-2);
    expect(el.placement.rect.w).toBeGreaterThan(0);
    expect(el.style.opacity).toBe(1);
    expect(el.style.lineHeight).toBe(0.6);
  });
});

describe("the collector can be told exactly which images a card holds", () => {
  it("names the ground and every element image", () => {
    const comp = base({
      ground: { kind: "image", assetId: "bg-1", themeId: "ivory" },
      elements: [image({ id: "a", assetId: "st-1" }), image({ id: "b", assetId: "st-2" }), text()],
    });
    expect(referencedAssets(comp).sort()).toEqual(["bg-1", "st-1", "st-2"]);
  });

  it("reports a shared image once", () => {
    const comp = base({
      ground: { kind: "image", assetId: "same", themeId: "ivory" },
      elements: [image({ id: "a", assetId: "same" })],
    });
    expect(referencedAssets(comp)).toEqual(["same"]);
  });

  it("names nothing for a card that holds no image", () => {
    expect(referencedAssets(base({ elements: [text()] }))).toEqual([]);
  });

  it("still names images that survived a round-trip through storage", () => {
    const comp = base({
      ground: { kind: "image", assetId: "bg-1", themeId: "ivory" },
      elements: [image({ assetId: "st-9" })],
    });
    const back = parseComposition(serializeComposition(comp))!;
    expect(referencedAssets(back).sort()).toEqual(["bg-1", "st-9"]);
  });

  it("keeps a hidden element's image referenced — hidden is not deleted", () => {
    const comp = base({ elements: [image({ assetId: "st-h", hidden: true })] });
    expect(referencedAssets(comp)).toEqual(["st-h"]);
  });
});

describe("a custom card does not pretend to come from a book", () => {
  it("records that it is custom, and survives storage", () => {
    const back = parseComposition(serializeComposition(base({ custom: true })))!;
    expect(back.custom).toBe(true);
  });

  it("a book card carries no custom flag at all", () => {
    const out = JSON.parse(serializeComposition(base()));
    expect("custom" in out).toBe(false);
  });
});

describe("identity", () => {
  it("mints ids that do not collide", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });
});
