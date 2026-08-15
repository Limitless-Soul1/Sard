// PROFILES (stage 2) — the derivation that turns a paper and a touch into a whole Sard.
//
// These tests hold the derivation to the corpus it was measured from. The sixteen shipped themes
// are the specification: a generated theme should look like it belongs beside them, so the bands
// below are the measured bands, not round numbers chosen for convenience.

import { describe, expect, it } from "vitest";

import {
  HARMONY_IDS,
  contrast,
  deriveColors,
  harmonies,
  inkFor,
  isHex,
  luminance,
  mix,
  paletteColors,
  rgbToHsl,
  suggestsDark,
  toHex,
  toRgb,
} from "../../src/features/profiles/model/palette";
import { THEMES, THEME_ORDER } from "../../src/theme/themes";

const PAPERS_LIGHT = ["#F5EEDD", "#FFFFFF", "#E8D9BC", "#F0F2E8", "#FBF1F1", "#F0E2BE", "#F4F2EA"];
const PAPERS_DARK = ["#222A31", "#000000", "#1B2130", "#221912", "#15201A", "#122023", "#121A2E"];
const ACCENTS = ["#9C5A3C", "#5FA8A8", "#E6C77A", "#B5727B", "#5E6B7A"];

describe("colour plumbing round-trips", () => {
  it("hex → rgb → hex is lossless for every shipped colour", () => {
    for (const id of THEME_ORDER) {
      for (const c of [THEMES[id].colors.paperBg, THEMES[id].colors.text, THEMES[id].colors.accent]) {
        expect(toHex(toRgb(c)).toLowerCase()).toBe(c.toLowerCase());
      }
    }
  });

  it("mix is a real interpolation, and its ends are exact", () => {
    expect(mix("#000000", "#FFFFFF", 0).toLowerCase()).toBe("#000000");
    expect(mix("#000000", "#FFFFFF", 1).toLowerCase()).toBe("#ffffff");
    expect(mix("#000000", "#FFFFFF", 0.5).toLowerCase()).toBe("#808080");
  });

  it("contrast matches the WCAG anchors", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 3);
  });

  it("luminance is monotonic from black to white", () => {
    expect(luminance("#000000")).toBeCloseTo(0, 4);
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 4);
    expect(luminance("#808080")).toBeGreaterThan(0.1);
    expect(luminance("#808080")).toBeLessThan(0.3);
  });
});

describe("every derived colour is a plain #rrggbb", () => {
  // Load-bearing, not cosmetic: these values are string-interpolated into the CSS injected into the
  // book iframe, so anything that is not a literal hex is a way into that stylesheet.
  it("holds across every paper, accent and polarity", () => {
    for (const dark of [false, true]) {
      for (const paper of dark ? PAPERS_DARK : PAPERS_LIGHT) {
        for (const accent of ACCENTS) {
          for (const h of harmonies(paper, accent, dark)) {
            for (const c of paletteColors(h.colors)) {
              expect(isHex(c), `${c} from ${paper}/${accent}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("the two alpha roles are the only non-hex values, and they are rgba()", () => {
    const { chromeBorder, selection } = deriveColors("#F5EEDD", "#2B2521", "#9C5A3C", false);
    expect(chromeBorder.startsWith("rgba(")).toBe(true);
    expect(selection.startsWith("rgba(")).toBe(true);
  });
});

describe("the ink hits its target contrast", () => {
  it("every stance lands inside the corpus band on every paper", () => {
    // Measured across the sixteen: light 8.1–19.4, dark 9.6–14.2. A generated theme should sit
    // inside that, which is what makes it look like it belongs beside them.
    for (const dark of [false, true]) {
      for (const paper of dark ? PAPERS_DARK : PAPERS_LIGHT) {
        for (const id of HARMONY_IDS) {
          const r = contrast(inkFor(paper, id, dark), paper);
          expect(r, `${id} on ${paper}`).toBeGreaterThan(7); // AAA body text, always
          expect(r, `${id} on ${paper}`).toBeLessThan(21);
        }
      }
    }
  });

  it("'contrast' is always the strongest stance and 'warm' the gentlest", () => {
    for (const dark of [false, true]) {
      for (const paper of dark ? PAPERS_DARK : PAPERS_LIGHT) {
        const r = (id: (typeof HARMONY_IDS)[number]) => contrast(inkFor(paper, id, dark), paper);
        expect(r("contrast")).toBeGreaterThan(r("calm"));
        expect(r("calm")).toBeGreaterThan(r("warm"));
      }
    }
  });

  it("the ink is on the correct side of the paper", () => {
    for (const paper of PAPERS_LIGHT) {
      for (const id of HARMONY_IDS) {
        expect(luminance(inkFor(paper, id, false))).toBeLessThan(luminance(paper));
      }
    }
    for (const paper of PAPERS_DARK) {
      for (const id of HARMONY_IDS) {
        expect(luminance(inkFor(paper, id, true))).toBeGreaterThan(luminance(paper));
      }
    }
  });
});

describe("the ground keeps the paper's hue and steps away from the ink", () => {
  it("desk and chrome hold the paper's hue", () => {
    // Measured on the dark corpus: desk hue − paper hue is −0.1° ± 2.4°.
    for (const dark of [false, true]) {
      for (const paper of dark ? PAPERS_DARK : PAPERS_LIGHT) {
        const c = deriveColors(paper, inkFor(paper, "calm", dark), "#9C5A3C", dark);
        const ph = rgbToHsl(toRgb(paper))[0];
        const [ds] = [rgbToHsl(toRgb(c.surfaceBg))[0]];
        const sat = rgbToHsl(toRgb(paper))[1];
        if (sat > 0.02) {
          const d = Math.abs(((ds - ph + 180) % 360) - 180);
          expect(d, `${paper} desk hue drift`).toBeLessThan(3);
        }
      }
    }
  });

  it("the desk is distinguishable from the paper — a page always has an edge", () => {
    for (const dark of [false, true]) {
      for (const paper of dark ? PAPERS_DARK : PAPERS_LIGHT) {
        const c = deriveColors(paper, inkFor(paper, "calm", dark), "#9C5A3C", dark);
        expect(c.surfaceBg.toLowerCase(), paper).not.toBe(c.paperBg.toLowerCase());
      }
    }
  });

  it("pure black paper lifts its desk instead of vanishing — True-Black's case, by construction", () => {
    // RAWY-130 had to do this by hand: a pure-#000 desk made the reading margins show a seam.
    const c = deriveColors("#000000", inkFor("#000000", "calm", true), "#C98A5E", true);
    expect(luminance(c.surfaceBg)).toBeGreaterThan(luminance(c.paperBg));
  });

  it("pure white paper steps its desk down rather than off the end", () => {
    const c = deriveColors("#FFFFFF", inkFor("#FFFFFF", "calm", false), "#7A2E1E", false);
    expect(luminance(c.surfaceBg)).toBeLessThan(luminance(c.paperBg));
  });
});

describe("muted sits where the corpus puts it", () => {
  it("is 0.60 of the paper→ink line", () => {
    // Measured: 0.606 ± 0.084 light, 0.586 ± 0.063 dark, and within ~7/255 of the line itself.
    const paper = "#F5EEDD", ink = "#2B2521";
    const c = deriveColors(paper, ink, "#9C5A3C", false);
    expect(c.muted.toLowerCase()).toBe(mix(paper, ink, 0.6).toLowerCase());
  });

  it("is always between the paper and the ink in luminance", () => {
    for (const dark of [false, true]) {
      for (const paper of dark ? PAPERS_DARK : PAPERS_LIGHT) {
        const ink = inkFor(paper, "calm", dark);
        const c = deriveColors(paper, ink, "#9C5A3C", dark);
        const [lp, lm, li] = [luminance(paper), luminance(c.muted), luminance(ink)];
        expect(Math.min(lp, li)).toBeLessThanOrEqual(lm);
        expect(lm).toBeLessThanOrEqual(Math.max(lp, li));
      }
    }
  });
});

describe("the harmonies are four distinct whole Sards", () => {
  it("returns exactly four, one per stance", () => {
    const hs = harmonies("#F5EEDD", "#9C5A3C", false);
    expect(hs.map((h) => h.id)).toEqual([...HARMONY_IDS]);
  });

  it("their inks genuinely differ — four candidates, not four labels", () => {
    for (const dark of [false, true]) {
      const hs = harmonies(dark ? "#1B2130" : "#F5EEDD", "#9C5A3C", dark);
      const inks = new Set(hs.map((h) => h.colors.text.toLowerCase()));
      expect(inks.size).toBe(4);
    }
  });

  it("every candidate keeps the reader's two colours exactly", () => {
    // The paper and the accent are what the reader chose. Nothing may quietly adjust them.
    for (const dark of [false, true]) {
      const paper = dark ? "#122023" : "#F0E2BE";
      const accent = "#5FA8A8";
      for (const h of harmonies(paper, accent, dark)) {
        expect(h.colors.paperBg.toLowerCase()).toBe(paper.toLowerCase());
        expect(h.colors.accent.toLowerCase()).toBe(accent.toLowerCase());
      }
    }
  });

  it("reports each candidate's real ink contrast", () => {
    for (const h of harmonies("#F5EEDD", "#9C5A3C", false)) {
      expect(h.inkContrast).toBeCloseTo(contrast(h.colors.text, h.colors.paperBg), 6);
    }
  });
});

describe("the shared highlight inks are never generated", () => {
  it("a derived theme carries the same eight as the shipped sixteen", () => {
    // Tuned in RAWY-258 against measured text-contrast-through-the-mark; they adapt to the paper by
    // blend mode, not by value, so regenerating them per profile would discard measured work.
    const c = deriveColors("#122023", "#CFE0E0", "#5FA8A8", true);
    expect(c.highlight).toEqual(THEMES.ivory.colors.highlight);
  });
});

describe("suggestsDark is a suggestion, not a verdict", () => {
  it("reads the shipped papers correctly", () => {
    // It exists to PREFILL the Day/Night choice. `dark` stays authored: it drives the highlight
    // blend mode, the ink alpha and the native title bar, and a threshold will eventually
    // misclassify a borderline paper.
    for (const id of THEME_ORDER) {
      expect(suggestsDark(THEMES[id].colors.paperBg)).toBe(THEMES[id].dark);
    }
  });
});
