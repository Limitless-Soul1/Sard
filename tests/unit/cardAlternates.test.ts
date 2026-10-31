// «حروف مرسلة» — A TEXT ELEMENT MAY ASK ITS TYPEFACE FOR ITS ALTERNATE LETTERFORMS (OpenType `salt`).
//
// The setting is per element and optional: absent means the face's default forms, which is what every
// card saved before it carries. These pin the document side (it is stored, restored, owned and
// validated per element) and the drawing side (what the card's text node asks the font for, which is
// what the export rasterises — the export is the same DOM).
//
// What these cannot show is a font's actual letterforms: that is the engine's work. It was measured
// against the real engine, the real export library and a real face when the feature was built.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ElementsLayer } from "../../src/features/photo/CardLayers";
import { applyComposition } from "../../src/features/photo/compositions";
import { addElement, makeText, updateStyle } from "../../src/features/photo/elements";
import {
  fontFeatures, newCustomComposition, parseComposition, serializeComposition,
  type Composition, type TextElement,
} from "../../src/features/photo/composition";

const SALT = 'font-feature-settings:&quot;salt&quot; 1';

/** A card with two text layers: the quote, and a second line the reader added. */
function twoLayers(): { comp: Composition; quote: TextElement; line: TextElement } {
  let comp = newCustomComposition("ivory", "portrait", "كتاب رفيق إنسان يمشي في درب الحق");
  const line = makeText(comp, "text", "ونفسٌ تسعى");
  comp = addElement(comp, line);
  const quote = comp.elements.find((e): e is TextElement => e.kind === "quote")!;
  return { comp, quote, line };
}
const textOf = (c: Composition, id: string): TextElement => c.elements.find((e) => e.id === id) as TextElement;
const render = (comp: Composition) =>
  renderToStaticMarkup(createElement(ElementsLayer, { comp, cardW: 540, ink: "#222", paper: "#fbf7ef", assetUrl: () => null }));
/** The markup of ONE element's layer (each layer carries its id). */
const layerOf = (html: string, id: string) => {
  const at = html.indexOf(`data-el="${id}"`);
  const next = html.indexOf("data-el=", at + 1);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("the setting, per text element", () => {
  it("is stored with the element that has it and restored with it — and only that one", () => {
    const { comp, quote, line } = twoLayers();
    const on = updateStyle(comp, quote.id, { alternates: true });
    const back = parseComposition(serializeComposition(on))!;
    expect(textOf(back, quote.id).style.alternates).toBe(true);
    expect(textOf(back, line.id).style.alternates).toBeUndefined();
  });

  it("is the reader's once set: it is owned, so choosing another composition keeps it", () => {
    const { comp, quote } = twoLayers();
    const on = updateStyle(comp, quote.id, { alternates: true });
    expect(textOf(on, quote.id).own).toContain("alternates");
    const restored = parseComposition(serializeComposition(on))!;
    expect(textOf(restored, quote.id).own).toContain("alternates"); // the ownership survives storage too
    const rearranged = applyComposition(restored, "gilded");
    expect(textOf(rearranged, quote.id).style.alternates).toBe(true);
  });

  it("can be turned off again, and off asks the font for nothing", () => {
    const { comp, quote } = twoLayers();
    const off = updateStyle(updateStyle(comp, quote.id, { alternates: true }), quote.id, { alternates: false });
    const back = parseComposition(serializeComposition(off))!;
    expect(textOf(back, quote.id).style.alternates).toBe(false);
    expect(fontFeatures(textOf(back, quote.id).style)).toBeUndefined();
    expect(layerOf(render(back), quote.id)).not.toContain("font-feature-settings");
  });
});

describe("cards saved before the setting existed", () => {
  it("open without it, and their text asks the font for nothing — exactly as it drew before", () => {
    const { comp, quote, line } = twoLayers();
    const saved = serializeComposition(comp);
    expect(saved).not.toContain("alternates");
    const back = parseComposition(saved)!;
    for (const id of [quote.id, line.id]) expect("alternates" in textOf(back, id).style).toBe(false);
    expect(render(back)).not.toContain("font-feature-settings");
  });

  it("a value this version does not understand is dropped, not honoured", () => {
    const { comp, quote } = twoLayers();
    const doc = JSON.parse(serializeComposition(comp));
    for (const bogus of ["yes", 1, null, { salt: 1 }]) {
      doc.elements.find((e: { id: string }) => e.id === quote.id).style.alternates = bogus;
      const back = parseComposition(JSON.stringify(doc))!;
      expect(textOf(back, quote.id).style.alternates).toBeUndefined();
      expect(render(back)).not.toContain("font-feature-settings");
    }
  });
});

describe("what the card's text asks its font for", () => {
  it("is `salt` alone, on that element's text alone", () => {
    const { comp, quote, line } = twoLayers();
    const html = render(updateStyle(comp, quote.id, { alternates: true }));
    expect(layerOf(html, quote.id)).toContain(SALT);
    expect(layerOf(html, line.id)).not.toContain("font-feature-settings");
    // No other feature is requested: not the font's stylistic sets, not swashes.
    expect(html).not.toMatch(/ss0\d|swsh/);
  });

  it("is a request a face without the feature simply ignores — nothing else about the text changes", () => {
    // Whether a face HAS `salt` is the engine's business: the property is the same for every face, and
    // the rest of the text's style is identical with or without it.
    const { comp, quote } = twoLayers();
    const plain = layerOf(render(comp), quote.id);
    const asked = layerOf(render(updateStyle(comp, quote.id, { alternates: true })), quote.id);
    expect(asked.replace(SALT + ";", "")).toBe(plain);
  });

  it("re-runs the fit when it changes, because the alternates have other widths", () => {
    // A layout effect does not run in a static render, so the dependency is pinned in the source.
    const src = readFileSync(resolve(__dirname, "../../src/features/photo/CardLayers.tsx"), "utf8");
    const deps = src.slice(src.indexOf("el.style.fontSize = `${lo}px`;"), src.indexOf("return (", src.indexOf("el.style.fontSize = `${lo}px`;")));
    expect(deps).toContain("style.alternates");
    // ...and the text being typed asks for the same letterforms as the card it will land on.
    const overlay = readFileSync(resolve(__dirname, "../../src/features/photo/CardOverlay.tsx"), "utf8");
    expect(overlay.match(/fontFeatureSettings: fontFeatures\(el\.style\)/g)?.length).toBe(2);
  });
});
