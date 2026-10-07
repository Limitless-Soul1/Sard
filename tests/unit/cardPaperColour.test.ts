// A PHOTO CARD LEAVES SARD IN THE PAPER THE USER CHOSE.
//
// The defect: the card on screen drew the user's own paper colour, but saving, exporting and copying
// produced the THEME's paper. All three rasterise through one function, which handed html-to-image the
// theme's paper as `backgroundColor`; html-to-image writes that over the cloned card's background and
// fills the canvas with it. The fix gives the card and the rasteriser one answer, `paperColour`.
//
// What is tested here, from the bottom up: the answer itself; that the answer survives a save and a
// reload byte for byte; that html-to-image really does paint the cloned card with whatever it is given
// (so passing the card's paper is what makes the exported pixels the card's paper); and that every way
// out of the composer goes through that one rasteriser, reading the paper at the moment it runs.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  newCustomComposition, paperColour, parseComposition, serializeComposition, type Composition,
} from "../../src/features/photo/composition";
import { resolveTheme } from "../../src/theme";
import { applyStyle } from "html-to-image/lib/apply-style.js";

const R = join(import.meta.dirname, "..", "..");
const COMPOSER = readFileSync(join(R, "src/features/photo/PhotoComposer.tsx"), "utf8");

const UNUSUAL = "#123456";
const THEME = "moonlit";
const themePaper = resolveTheme(THEME).colors.paperBg;

const withPaper = (paper: string | undefined): Composition => {
  const c = newCustomComposition(THEME, "portrait", "A line");
  return { ...c, ground: { kind: "theme", themeId: THEME, ...(paper ? { paper } : {}) } };
};

describe("the card's paper colour", () => {
  it("is the user's own colour when one is chosen — exactly, not the theme's or a nearby one", () => {
    expect(paperColour(withPaper(UNUSUAL).ground, themePaper)).toBe(UNUSUAL);
    expect(UNUSUAL).not.toBe(themePaper);
  });

  it("is the theme's paper when none is chosen — preset papers behave exactly as before", () => {
    expect(paperColour(withPaper(undefined).ground, themePaper)).toBe(themePaper);
  });

  it("is the theme's paper under a photograph, whose colour the card never offered to change", () => {
    expect(paperColour({ kind: "image", assetId: "a", themeId: THEME }, themePaper)).toBe(themePaper);
  });
});

describe("saved and reloaded", () => {
  it("keeps the exact custom colour through the stored document", () => {
    const back = parseComposition(serializeComposition(withPaper(UNUSUAL)));
    expect(back?.ground.kind).toBe("theme");
    expect(back && paperColour(back.ground, themePaper)).toBe(UNUSUAL);
  });

  it("keeps a lower-case colour as the same colour (the picker stores #RRGGBB upper-case)", () => {
    const back = parseComposition(serializeComposition(withPaper("#a1b2c3")));
    expect(back && paperColour(back.ground, themePaper)).toBe("#A1B2C3");
  });

  it("reloads a card with no custom colour as a preset card", () => {
    const back = parseComposition(serializeComposition(withPaper(undefined)));
    expect(back && paperColour(back.ground, themePaper)).toBe(themePaper);
  });
});

describe("the rasteriser — the one path Save, Copy and Save in app share", () => {
  it("html-to-image paints the cloned card with exactly the backgroundColor it is given", () => {
    // The library's own code, not a model of it: this is what overwrote the user's colour.
    // A stand-in for the cloned card: applyStyle only touches `style`.
    const clone = { style: { background: UNUSUAL, backgroundColor: UNUSUAL } as Record<string, string> };
    const asNode = clone as unknown as HTMLElement;
    applyStyle(asNode, { backgroundColor: themePaper });
    expect(clone.style.backgroundColor).toBe(themePaper); // the old call: the user's colour is gone
    applyStyle(asNode, { backgroundColor: UNUSUAL });
    expect(clone.style.backgroundColor).toBe(UNUSUAL); // the fixed call: the card keeps its paper
  });

  const RASTER = COMPOSER.slice(COMPOSER.indexOf("const rasterize = async"), COMPOSER.indexOf("const onSave = async"));

  it("hands html-to-image the card's own paper, not the theme's", () => {
    expect(RASTER).toContain("backgroundColor: paperColour(compRef.current.ground, resolveTheme(themeId).colors.paperBg)");
    expect(RASTER).not.toMatch(/backgroundColor:\s*resolveTheme\(themeId\)\.colors\.paperBg/);
  });

  it("reads the paper when it runs, so a colour changed after the last export is the one exported", () => {
    // `compRef.current` is reassigned on every render to the live composition; a value captured
    // when the editor opened would export a stale colour.
    expect(COMPOSER).toMatch(/compRef\.current = composition;/);
    expect(RASTER).toContain("compRef.current.ground");
  });

  it("Save, Copy and Save in app all rasterise through it — export and copy cannot drift apart", () => {
    for (const handler of ["const onSave = async", "const onCopy = async", "const onSaveInApp = async"]) {
      const at = COMPOSER.indexOf(handler);
      expect(at, handler).toBeGreaterThan(-1);
      expect(COMPOSER.slice(at, at + 600), handler).toContain("await rasterize()");
    }
  });

  it("the card on screen asks the same question", () => {
    expect(COMPOSER).toContain("const paperBg = paperColour(composition.ground, c.paperBg);");
  });
});
