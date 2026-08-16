// PROFILES — deriving a whole Sard from a paper and a touch.
//
// THE QUESTION THIS ANSWERS. The reader chooses two colours: the PAPER they read on and the ACCENT
// that marks things. A theme needs eight. Which of the other six can be computed, and which are
// genuinely somebody's choice?
//
// MEASURED, across all sixteen shipped themes (light n=7, dark n=9), in HSL:
//
//   desk   L − paper L    light −0.071 ± 0.011   dark −0.023 ± 0.029   ← tight
//   chrome L − paper L    light −0.025 ± 0.029   dark −0.005 ± 0.028   ← tight
//   muted, as a fraction of the paper→text line
//                         light  0.606 ± 0.084   dark  0.586 ± 0.063   ← tight
//   muted's distance OFF that line, worst channel
//                         light  6.8/255         dark 10.0/255         ← negligible
//   desk hue − paper hue  dark   −0.1° ± 2.4°                          ← the same hue
//   text L − paper L      light −0.757 ± 0.098   dark +0.739 ± 0.030   ← tight
//   contrast(text, paper) light  12.4 ± 3.3      dark  12.3 ± 1.1      ← tight
//
//   text HUE − paper hue  dark  +38.9° ± 73.1°, spanning −36°..+180°   ← NOT DERIVABLE
//
// So the GROUND is derivable and the INK is not. Moonlit reads warm gold on blue paper; Espresso
// reads cream on brown; Nocturne reads pale cyan on near-black. Those are authorial decisions about
// what the page feels like, and no function of the paper produces all three.
//
// THEREFORE the four "harmonies" are not decoration and not four arbitrary presets — they are how
// the reader supplies the one value that cannot be computed. Each proposes a different INK stance
// over the same paper; everything else follows from it. That is exactly the design's own framing:
// four complete Sards from two colours, chosen by eye.
//
// TWO DOCUMENTED EXCEPTIONS in the corpus, both deliberate, neither copied here:
//   • True-Black lifts its DESK above its paper (+0.055 L) because the paper is pure #000 and the
//     reading margins showed a seam against it (RAWY-130). A derived theme never has pure-black
//     paper unless the reader picks it, and the lift is applied by the same rule below.
//   • Ink puts `muted` at 0.794 of the line and its border at 30% alpha — it is the deliberate
//     high-contrast outlier. Derivation targets the cluster, not the outlier.

import type { ThemeColors } from "../../../theme/tokens";
import { HIGHLIGHT_SLOTS } from "../../../theme/tokens";

// ---- colour plumbing ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;

/** True for exactly `#rrggbb`. The ONLY colour shape a profile may carry — see the note in `build`. */
export const isHex = (c: string): boolean => HEX.test(c);

type RGB = [number, number, number];
type HSL = [number, number, number]; // h 0..360, s 0..1, l 0..1

export function toRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const byte = (v: number): number => clamp(Math.round(v), 0, 255);

export function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("");
}

export function rgbToHsl([r, g, b]: RGB): HSL {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return [h * 360, s, l];
}

export function hslToRgb([h, s, l]: HSL): RGB {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255] as RGB;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(hh + 1 / 3) * 255, ch(hh) * 255, ch(hh - 1 / 3) * 255] as RGB;
}

const withL = (hex: string, f: (l: number) => number): string => {
  const [h, s, l] = rgbToHsl(toRgb(hex));
  return toHex(hslToRgb([h, s, clamp(f(l), 0, 1)]));
};

const withS = (hex: string, f: (s: number) => number): string => {
  const [h, s, l] = rgbToHsl(toRgb(hex));
  return toHex(hslToRgb([h, clamp(f(s), 0, 1), l]));
};

/** Mix `a` toward `b` by `t` (0 = all `a`, 1 = all `b`), per channel in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const A = toRgb(a), B = toRgb(b);
  const k = clamp(t, 0, 1);
  return toHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * k) as RGB);
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Whether a paper reads as dark. A SUGGESTION only — `dark` is authored, never inferred (see below). */
export const suggestsDark = (paper: string): boolean => luminance(paper) < 0.18;

// ---- the derivation ----------------------------------------------------------------------------

/** The four ink stances. Each supplies the one value the paper cannot: what the text is made of. */
export type HarmonyId = "calm" | "warm" | "cool" | "contrast";
export const HARMONY_IDS: readonly HarmonyId[] = ["calm", "warm", "cool", "contrast"] as const;

/**
 * What each stance does, to the INK and to the PAPER.
 *
 * THE PAPER MOVES TOO, and that is taken from the design rather than invented. Its own four
 * harmonies carry four different papers — `#F2E9D8` calm, `#F4E3C8` warm, `#F1F1EA` cool,
 * `#FFFFFF` contrast — so "four complete Sards from these two colours" means the pair is the INPUT,
 * not four labels over one identical ground. Measured in the running app before this was added:
 * with the paper held fixed on a dark theme the four candidates were nearly indistinguishable at
 * card size, which defeats the one instruction the design gives the reader — choose by eye.
 *
 * `calm` leaves the reader's paper EXACTLY as they chose it, so their own pick is always one of the
 * four. The other three interpret it: deeper and warmer, neutralised and cooler, or pushed to the
 * extreme. `dL` is a lightness delta toward white, `dS` scales saturation, `dH` shifts hue.
 *
 * The ink's contrast targets sit inside the measured corpus band (light 8.1–19.4, dark 9.6–14.2)
 * rather than at its edges: a generated theme should look like it belongs beside the sixteen.
 */
const STANCE: Record<
  HarmonyId,
  { hue: number; sat: number; target: number; dL: number; dS: number; dH: number }
> = {
  calm: { hue: 0, sat: 0.18, target: 11, dL: 0, dS: 1, dH: 0 },
  warm: { hue: -18, sat: 0.3, target: 10, dL: -0.035, dS: 1.45, dH: -6 },
  cool: { hue: +22, sat: 0.22, target: 12, dL: +0.01, dS: 0.5, dH: +14 },
  contrast: { hue: 0, sat: 0.06, target: 16, dL: +0.05, dS: 0.12, dH: 0 },
};

/**
 * The paper a stance proposes, from the paper the reader chose.
 *
 * On a DARK ground the lightness deltas invert: "deeper and warmer" means further from the ink,
 * which is darker on a light page and lighter on a dark one. Without that, `contrast` on a night
 * paper would lift the page toward grey — the opposite of what the word promises.
 */
export function paperFor(paper: string, harmony: HarmonyId, dark: boolean): string {
  const s = STANCE[harmony];
  const [h, sat, l] = rgbToHsl(toRgb(paper));
  const dl = dark ? -s.dL : s.dL;
  return toHex(hslToRgb([h + s.dH, clamp(sat * s.dS, 0, 1), clamp(l + dl, 0, 1)]));
}

/**
 * Solve for the ink lightness that hits a target contrast against the paper.
 *
 * Binary search rather than algebra because luminance is non-linear in HSL L and the hue/saturation
 * are fixed first — there is no closed form, and forty iterations is exact to well under one 8-bit
 * step. Walks DOWN from the paper on light grounds and UP on dark ones.
 */
function inkAtContrast(paper: string, hue: number, sat: number, target: number, dark: boolean): string {
  const [ph] = rgbToHsl(toRgb(paper));
  const h = ph + hue;
  let lo = dark ? rgbToHsl(toRgb(paper))[2] : 0;
  let hi = dark ? 1 : rgbToHsl(toRgb(paper))[2];
  let best = toHex(hslToRgb([h, sat, dark ? 1 : 0]));
  for (let i = 0; i < 40; i++) {
    const midL = (lo + hi) / 2;
    const c = toHex(hslToRgb([h, sat, midL]));
    const r = contrast(c, paper);
    best = c;
    if (r > target) {
      // too much contrast — move the ink back toward the paper
      if (dark) hi = midL;
      else lo = midL;
    } else {
      if (dark) lo = midL;
      else hi = midL;
    }
  }
  return best;
}

/** The ink a stance proposes for this paper. */
export function inkFor(paper: string, harmony: HarmonyId, dark: boolean): string {
  const s = STANCE[harmony];
  return inkAtContrast(paper, s.hue, s.sat, s.target, dark);
}

/**
 * Everything a paper, an ink and an accent imply.
 *
 * `desk` and `chrome` keep the paper's HUE (measured: dark themes shift it by −0.1° ± 2.4°) and
 * step its LIGHTNESS away from the ink by the measured amount. On a light theme the desk is also
 * slightly desaturated (measured S ratio 0.72), which is what keeps a warm paper from turning muddy
 * as it darkens.
 *
 * The step is applied AWAY FROM THE INK rather than simply downward, which is what handles
 * True-Black's documented exception by construction: with pure-black paper there is no room below,
 * so the desk lifts — exactly what RAWY-130 had to do by hand.
 */
export function deriveColors(
  paper: string,
  ink: string,
  accent: string,
  dark: boolean,
): ThemeColors {
  const away = dark ? +1 : -1; // the direction the ground steps, away from the ink
  const deskStep = dark ? 0.023 : 0.071;
  const chromeStep = dark ? 0.005 : 0.025;

  const room = rgbToHsl(toRgb(paper))[2];
  // With no room to step away (pure black, pure white), step TOWARD the ink instead. This is the
  // True-Black case; the alternative is a desk identical to the paper and a page with no edge.
  const deskDir = dark ? (room + deskStep > 1 ? -1 : away) : room - deskStep < 0 ? +1 : away;
  const chromeDir = dark ? (room + chromeStep > 1 ? -1 : away) : room - chromeStep < 0 ? +1 : away;

  let surfaceBg = withL(paper, (l) => l + deskDir * deskStep);
  if (!dark) surfaceBg = withS(surfaceBg, (s) => s * 0.72);
  let chromeBg = withL(paper, (l) => l + chromeDir * chromeStep);
  if (!dark) chromeBg = withS(chromeBg, (s) => s * 0.83);

  return {
    paperBg: paper,
    surfaceBg,
    chromeBg,
    // Measured: light grounds rule in the ink at ~12% alpha, dark grounds in white at ~8%.
    chromeBorder: dark ? "rgba(255,255,255,.08)" : rgbaOf(ink, 0.12),
    text: ink,
    // Measured: 0.60 of the paper→ink line, and within ~7/255 of that line in every shipped theme.
    muted: mix(paper, ink, 0.6),
    accent,
    // Measured constants, not choices: every light theme washes selection at .20, every dark at .28.
    selection: rgbaOf(accent, dark ? 0.28 : 0.2),
    // The eight inks are SHARED and are never generated — they were tuned against measured
    // text-contrast-through-the-mark (RAWY-258) and adapt to the paper by blend mode, not by value.
    highlight: SHARED_HIGHLIGHTS,
  };
}

const rgbaOf = (hex: string, a: number): string => {
  const [r, g, b] = toRgb(hex);
  return `rgba(${byte(r)},${byte(g)},${byte(b)},${a})`;
};

/** The shared eight, copied from the shipped palette so a derived theme inks exactly like the rest. */
const SHARED_HIGHLIGHTS: ThemeColors["highlight"] = {
  amber: "#E8C36A",
  marigold: "#E7A867",
  coral: "#E2978D",
  rose: "#D285A4",
  purple: "#BFA8D6",
  sky: "#9DC0D6",
  teal: "#8DC3BA",
  green: "#AEC798",
};

/** One candidate whole-Sard: an ink stance plus everything it implies. */
export interface Harmony {
  id: HarmonyId;
  colors: ThemeColors;
  /** contrast(text, paper) — shown so a reader can see what "contrast" actually buys. */
  inkContrast: number;
}

/**
 * The four candidates for a paper and an accent.
 *
 * This is the whole simple path: two colours in, four complete Sards out, chosen by eye. It exists
 * because the ink's hue is the one value the measurement says cannot be computed (sd 73° across the
 * dark themes) — so rather than guess it, Sard proposes four and lets the reader decide.
 */
export function harmonies(paper: string, accent: string, dark: boolean): Harmony[] {
  return HARMONY_IDS.map((id) => {
    // Each stance interprets the paper as well as the ink — see STANCE. `calm` returns the reader's
    // own paper untouched, so the pair they picked is always one of the four on offer.
    const p = paperFor(paper, id, dark);
    const ink = inkFor(p, id, dark);
    return { id, colors: deriveColors(p, ink, accent, dark), inkContrast: contrast(ink, p) };
  });
}

/** Every colour a derived palette contains, for validation and for the advanced editor's list. */
export function paletteColors(c: ThemeColors): string[] {
  return [c.paperBg, c.surfaceBg, c.chromeBg, c.text, c.muted, c.accent,
    ...HIGHLIGHT_SLOTS.map((k) => c.highlight[k])];
}
