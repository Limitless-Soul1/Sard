// THE BLANK TEMPLATE — nothing pre-designed, and the four designed ones exactly as they were.
//
// The pure parts are exercised directly: the flavour, the composition list, the style list and what
// applying Blank does to a card's words. The Composer's skin is JSX, so that part is read as a FILE,
// the way this repo's other structural guards are — what is guarded is that the blank skin draws no
// frame, no quotation mark, no rule and no mark, and that the existing skins were not edited.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { autoLayout } from "../../src/features/photo/autoLayout";
import { applyComposition, COMPOSITIONS, seedComposition } from "../../src/features/photo/compositions";
import { CARD_STYLES } from "../../src/features/photo/photo";
import { newCustomComposition, parseComposition, serializeComposition } from "../../src/features/photo/composition";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const COMPOSER = read("src/features/photo/PhotoComposer.tsx");
const CANVAS = { format: "portrait" as const, w: 1080, h: 1350 };
const BOOK = { quote: "A passage worth keeping.", title: "A Book", author: "Someone", chapter: "One" };

describe("the picker", () => {
  it("offers the four designed templates exactly as before, and Blank after them", () => {
    expect(COMPOSITIONS.slice(0, 4)).toEqual([
      { id: "calm", label: "photo.comp.calm" },
      { id: "manuscript", label: "photo.comp.manuscript" },
      { id: "gilded", label: "photo.comp.gilded" },
      { id: "night", label: "photo.comp.night" },
    ]);
    expect(COMPOSITIONS[4]).toEqual({ id: "blank", label: "photo.comp.blank" });
    expect(COMPOSITIONS).toHaveLength(5);
  });

  it("names it with a word Sard already uses for an empty thing, in both languages", () => {
    expect(ar["photo.comp.blank"]).toBe("فارغ");
    expect(en["photo.comp.blank"]).toBe("Blank");
    expect(ar["photo.style.blank"]).toBe("فارغ");
    expect(en["photo.style.blank"]).toBe("Blank");
    // The four existing names are untouched.
    expect([ar["photo.comp.calm"], ar["photo.comp.manuscript"], ar["photo.comp.gilded"], ar["photo.comp.night"]]).toEqual(["هادئ", "مخطوط", "مذهّب", "ليلي"]);
  });

  it("draws its thumbnail with no bars and gives it the whole last row — the only picker change", () => {
    const css = read("src/styles/global.css");
    expect(css).toContain(".pcx-comp-thumb.blank i { display: none; }");
    expect(css).toContain(".pcx-comp:has(.pcx-comp-thumb.blank) { grid-column: 1 / -1; }");
    // The grid the four sit in is as it was.
    expect(css).toContain(".pcx-comps { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }");
  });
});

describe("what Blank does to a card", () => {
  it("keeps every word — it removes decoration, not content", () => {
    const seeded = seedComposition("calm", BOOK, CANVAS);
    const card = { ...newCustomComposition("ivory", "portrait", "x"), custom: undefined, elements: seeded };
    const out = applyComposition(card, "blank", CANVAS);
    const words = out.elements.filter((e) => e.kind !== "image" && e.kind !== "unknown").map((e) => [e.origin, e.text]);
    expect(words).toEqual(seeded.map((e) => [e.origin, e.text]));
  });

  it("lays the words out at the baseline, flush to the reading edge — no geometry of its own", () => {
    const blank = autoLayout({ ...CANVAS, text: BOOK, flavour: "blank" });
    expect(blank.elements[0].style.align).toBe("start");
    // The baseline figures exactly (margin 1, air 1) — which is why its rectangles are the ones the
    // pass produces before any flavour tilts them. Calm shares those figures and adds centring and a
    // quotation mark; Blank adds nothing. The other three tilt margins or air and differ.
    const rects = (f: "calm" | "manuscript" | "gilded" | "night" | "blank") =>
      JSON.stringify(autoLayout({ ...CANVAS, text: BOOK, flavour: f }).elements.map((e) => e.placement.rect));
    expect(rects("blank")).toBe(rects("calm"));
    expect(autoLayout({ ...CANVAS, text: BOOK, flavour: "calm" }).elements[0].style.align).toBe("center");
    for (const f of ["manuscript", "gilded", "night"] as const) expect(rects(f)).not.toBe(rects("blank"));
  });

  it("is a skin the card can be saved with and read back as", () => {
    expect(CARD_STYLES).toContain("blank");
    expect(CARD_STYLES.slice(0, 5)).toEqual(["minimal", "moonlit", "gilded", "manuscript", "editorial"]);
    const card = newCustomComposition("ivory", "portrait", "words");
    card.preset.style = "blank";
    card.preset.meta.brand = false;
    const back = parseComposition(serializeComposition(card));
    expect(back?.preset.style).toBe("blank");
    expect(back?.preset.meta.brand).toBe(false);
  });
});

describe("the blank skin, in the Composer", () => {
  it("is the fifth entry of the composition→skin map, and the four existing entries are unchanged", () => {
    expect(COMPOSER).toContain('  calm: "minimal",\n  manuscript: "manuscript",\n  gilded: "gilded",\n  night: "moonlit",\n  blank: "blank",\n'.replace(/\n/g, COMPOSER.includes("\r\n") ? "\r\n" : "\n"));
  });

  it("draws no frame, no quotation mark, no rule and nothing decorative", () => {
    // The ornament chain names every style that has one; blank is not in it.
    const frameChain = COMPOSER.slice(COMPOSER.indexOf("const frame: React.ReactNode ="), COMPOSER.indexOf("// ---- per-style inner content"));
    expect(frameChain).not.toContain('"blank"');
    // The calm quotation mark is minimal's alone.
    expect(COMPOSER).toContain('composition.custom && style === "minimal"');
    // Blank's own content block carries the words and nothing else.
    const at = COMPOSER.indexOf('} else if (style === "blank") {');
    expect(at).toBeGreaterThan(0);
    const block = COMPOSER.slice(at, COMPOSER.indexOf("} else if", at + 10));
    expect(block).toContain("renderQuote(");
    expect(block).not.toContain("pc-quotemark");
    expect(block).not.toContain("pc-rule");
    expect(block).not.toContain("pc-sep");
    expect(block).not.toContain("<svg");
  });

  it("switches the Sard mark off when applied — and only then", () => {
    const at = COMPOSER.indexOf("applyComposition: (id: CompositionId) => {");
    const fn = COMPOSER.slice(at, COMPOSER.indexOf("},", at));
    expect(fn).toContain('const plain = id === "blank";');
    expect(fn).toContain("if (plain) setMeta((m) => ({ ...m, brand: false }));");
    // The other four still hand the card through untouched.
    expect(fn).toContain(": compRef.current;");
  });

  it("does not turn the mark back on when a designed template is chosen afterwards", () => {
    const at = COMPOSER.indexOf("applyComposition: (id: CompositionId) => {");
    const fn = COMPOSER.slice(at, COMPOSER.indexOf("},", at));
    expect(fn).not.toMatch(/brand:\s*true/);
  });
});
