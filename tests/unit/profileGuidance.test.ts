// PROFILES (stage 2) — guidance that repairs rather than refuses.
//
// The rule these hold: the reader's colour survives when it can, the repair is the SMALLEST one that
// clears, and nothing is ever silently replaced.

import { describe, expect, it } from "vitest";

import {
  AAA_TEXT,
  AA_TEXT,
  NON_TEXT,
  guide,
  judgePalette,
  paletteReads,
} from "../../src/features/profiles/model/guidance";
import { contrast, harmonies, luminance } from "../../src/features/profiles/model/palette";
import { THEMES, THEME_ORDER } from "../../src/theme/themes";

describe("a colour that clears is left completely alone", () => {
  it("offers nothing when the reader's choice already passes", () => {
    const v = guide("#2B2521", "#F5EEDD", AA_TEXT);
    expect(v.passes).toBe(true);
    expect(v.nearest).toBeNull();
  });

  it("reports the real ratio rather than only a verdict", () => {
    const v = guide("#2B2521", "#F5EEDD", AA_TEXT);
    expect(v.ratio).toBeCloseTo(contrast("#2B2521", "#F5EEDD"), 6);
  });

  it("every shipped theme's own ink clears AAA on its own paper", () => {
    for (const id of THEME_ORDER) {
      const { text, paperBg } = THEMES[id].colors;
      expect(guide(text, paperBg, AAA_TEXT).passes, id).toBe(true);
    }
  });
});

describe("a colour that fails comes back repaired, minimally", () => {
  const GROUND = "#F5EEDD";
  const FAINT = "#C8B49E"; // a washed terracotta — clearly too faint on ivory

  it("fails, and offers something", () => {
    const v = guide(FAINT, GROUND, AA_TEXT);
    expect(v.passes).toBe(false);
    expect(v.nearest).not.toBeNull();
  });

  it("the offer actually clears the floor", () => {
    const v = guide(FAINT, GROUND, AA_TEXT);
    expect(contrast(v.nearest!, GROUND)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("the offer is the SMALLEST step that clears — one step back still fails", () => {
    // This is the whole point of stepping: a jump straight to black would also clear, and would
    // throw away the reader's hue for no reason.
    const v = guide(FAINT, GROUND, AA_TEXT);
    const nearest = v.nearest!;
    // Reconstruct the previous 5% step and confirm it does NOT clear.
    const before = mixToward(FAINT, "#000000", stepOf(FAINT, nearest) - 0.05);
    expect(contrast(before, GROUND)).toBeLessThan(AA_TEXT);
  });

  it("keeps the reader's hue rather than turning grey", () => {
    // The repaired terracotta must still be recognisably warm: red above blue.
    const v = guide(FAINT, GROUND, AA_TEXT);
    const [r, , b] = [
      parseInt(v.nearest!.slice(1, 3), 16),
      0,
      parseInt(v.nearest!.slice(5, 7), 16),
    ];
    expect(r).toBeGreaterThan(b);
  });

  it("darkens on a light ground and lightens on a dark one", () => {
    const onLight = guide("#C8B49E", "#F5EEDD", AA_TEXT).nearest!;
    expect(luminance(onLight)).toBeLessThan(luminance("#C8B49E"));

    const onDark = guide("#3A4550", "#1B2130", AA_TEXT).nearest!;
    expect(luminance(onDark)).toBeGreaterThan(luminance("#3A4550"));
  });
});

describe("the floors are the ones Sard already uses", () => {
  it("AA, AAA and the non-text floor are 4.5, 7 and 3", () => {
    expect(AA_TEXT).toBe(4.5);
    expect(AAA_TEXT).toBe(7);
    expect(NON_TEXT).toBe(3);
  });

  it("a colour can clear AA and still fail AAA — the reading page is held higher", () => {
    // Something in the band between the two floors.
    const ground = "#F5EEDD";
    const mid = "#7A6B5E";
    const aa = guide(mid, ground, AA_TEXT);
    const aaa = guide(mid, ground, AAA_TEXT);
    expect(aa.ratio).toBeCloseTo(aaa.ratio, 6);
    if (aa.passes) expect(aaa.passes).toBe(false);
  });
});

describe("a malformed colour is not answered with an invented repair", () => {
  it("reports failure with nothing to offer", () => {
    for (const bad of ["red", "", "#FFF", "rgba(0,0,0,.5)", "#GGGGGG"]) {
      const v = guide(bad, "#F5EEDD", AA_TEXT);
      expect(v.passes, bad).toBe(false);
      expect(v.nearest, bad).toBeNull();
    }
  });

  it("a malformed GROUND is handled the same way", () => {
    expect(guide("#2B2521", "not-a-colour", AA_TEXT).nearest).toBeNull();
  });
});

describe("judging a whole palette", () => {
  it("every shipped theme reads — the gates are the standard Sard itself meets", () => {
    for (const id of THEME_ORDER) {
      const v = judgePalette(THEMES[id].colors);
      expect(v.textOnPaper.passes, `${id} text on paper`).toBe(true);
      expect(v.textOnChrome.passes, `${id} text on chrome`).toBe(true);
      expect(paletteReads(v), id).toBe(true);
    }
  });

  it("muted and accent are READINGS, not gates — most shipped themes would fail them", () => {
    // MEASURED across the sixteen: muted-on-paper is below AA on six of the seven light themes
    // (Sepia 2.98, Linen 3.04, Rose Quartz 3.33, Ivory 3.43, Sage 3.44, Parchment 3.49), and
    // Parchment's accent-on-chrome is 2.79. Sard repairs the MARKS derived from those colours
    // rather than the colours themselves, so gating on them would refuse what Sard ships.
    const soft = ["sepia", "linen", "rosequartz", "ivory", "sage", "parchment"] as const;
    const anyBelowAA = soft.some((id) => judgePalette(THEMES[id].colors).mutedOnPaper.ratio < AA_TEXT);
    expect(anyBelowAA, "the corpus really does sit below AA here").toBe(true);

    // …and yet every one of them still reads.
    for (const id of soft) expect(paletteReads(judgePalette(THEMES[id].colors)), id).toBe(true);

    // Parchment's accent is the documented token-ceiling case.
    expect(judgePalette(THEMES.parchment.colors).accentOnChrome.ratio).toBeLessThan(NON_TEXT);
  });

  it("every DERIVED palette reads on its own page", () => {
    // The derivation targets 10–16:1 for the ink, so this should never be close — but the whole
    // point of generating themes is that nobody hand-checks them.
    for (const dark of [false, true]) {
      for (const paper of dark ? ["#1B2130", "#000000", "#221912"] : ["#F5EEDD", "#FFFFFF", "#F0E2BE"]) {
        for (const h of harmonies(paper, "#9C5A3C", dark)) {
          const v = judgePalette(h.colors);
          expect(v.textOnPaper.passes, `${paper}/${h.id} text on paper`).toBe(true);
        }
      }
    }
  });

  it("paletteReads is false when the body text itself cannot be read", () => {
    const bad = judgePalette({
      paperBg: "#F5EEDD",
      chromeBg: "#EAE0CA",
      text: "#E8DFCE", // ink barely distinct from the paper
      muted: "#E8DFCE",
      accent: "#EFE8D8",
    });
    expect(paletteReads(bad)).toBe(false);
  });
});

// ---- helpers for the "smallest step" assertion --------------------------------------------------

function mixToward(from: string, pole: string, t: number): string {
  const A = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const B = [1, 3, 5].map((i) => parseInt(pole.slice(i, i + 2), 16));
  const k = Math.max(0, Math.min(1, t));
  return (
    "#" +
    A.map((a, i) => Math.round(a + (B[i] - a) * k).toString(16).padStart(2, "0")).join("")
  );
}

/** Recover which 5% step produced `result` from `from` toward black. */
function stepOf(from: string, result: string): number {
  for (let k = 0.05; k <= 1.0001; k += 0.05) {
    if (mixToward(from, "#000000", k).toLowerCase() === result.toLowerCase()) return k;
  }
  return 1;
}
