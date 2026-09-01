// RAWY-200: the pure resolution of the TTS text-tracking look (sentence SPOTLIGHT + word KARAOKE pill)
// from a ReadingStyle over the built-in per-theme base. Kept in its own tiny module so the settings UI
// can import the resolvers WITHOUT dragging in the whole FoliateController (which loads foliate-js).
//
// The `fill` values stay the EXACT `rgb(...)` strings the pre-RAWY-200 build drew, so an untouched
// (null colour/opacity) effect resolves byte-identical, in BOTH themes — the null sentinel is what
// makes that true: it stores no number, so the per-theme constant is used verbatim.

import type { ReadingStyle } from "./injectedCss";

// The sentence spotlight: a soft band + a thin baseline rule. The rule opacity is a per-theme RATIO of
// the band (light ×3, dark ×2.75), so ONE user opacity slider (the band) scales both while the default
// keeps each exact.
export const READING_SPOTLIGHT = {
  light: { fill: "rgb(156,90,60)", band: 0.1, rule: 0.3 }, // #9C5A3C — the brand terracotta
  dark: { fill: "rgb(201,138,94)", band: 0.16, rule: 0.44 }, // #C98A5E — a lighter warm for dark paper
};

// The word karaoke pill: a solid token. `blend` (multiply on paper / screen on dark) keeps the glyphs
// legible through the token and is NOT user-exposed — a user colour rides the same blend.
export const READING_PILL = {
  light: { fill: "rgb(156,90,60)", op: 0.9, blend: "multiply" },
  dark: { fill: "rgb(201,138,94)", op: 0.9, blend: "screen" },
};

/**
 * THE SHAPES THE TWO MARKS ARE DRAWN IN, as proportions of one line's height.
 *
 * Stated here rather than inside the draw functions because they are no longer read in one place: the
 * overlay draws them as SVG rectangles over a book, and the profile editor's preview draws the same
 * two marks as CSS on a specimen page. Two renderings of one design — which is exactly the shape
 * that drifts, and has before (see `highlightInk.ts`). One set of numbers, two readers.
 *
 * The caps are in the reader's own pixels: at book sizes the proportion governs, and at very large
 * type the cap stops a rounded end from becoming a lozenge.
 */
export const TRACK_SHAPE = {
  /** The band's rounded ends: the design's ~.3em, per line fragment. */
  spotRadius: 0.2,
  spotRadiusMax: 6,
  /** The baseline rule under the band: the design's ~.12em. */
  ruleHeight: 0.08,
  ruleHeightMin: 1.5,
  /** The pill's horizontal breathing room, so the token reads as a pill and not a tight box. */
  pillPad: 0.12,
  pillPadMax: 3,
  /** The pill's rounded ends: the design's ~.28em token. */
  pillRadius: 0.22,
  pillRadiusMax: 6,
};

export interface SpotlightDraw { fill: string; band: number; rule: number }
export interface PillDraw { fill: string; op: number; blend: string }

// Resolve the spotlight: null colour/opacity → the base value verbatim (byte-identical default); a set
// opacity scales the baseline rule by the base's own rule/band ratio. Callers gate `on:false` (they
// skip the overlay draw entirely — no DOM), so this only runs for an enabled effect.
export function resolveSpotlight(style: ReadingStyle | undefined, dark: boolean): SpotlightDraw {
  const base = dark ? READING_SPOTLIGHT.dark : READING_SPOTLIGHT.light;
  const fill = style?.ttsSpotlightColor ?? base.fill;
  const band = style?.ttsSpotlightOpacity ?? base.band;
  const ratio = base.rule / base.band; // 3 (light) / 2.75 (dark)
  const rule = style?.ttsSpotlightOpacity == null ? base.rule : Math.min(1, band * ratio);
  return { fill, band, rule };
}

// Resolve the pill: null colour/opacity → the built-in per-theme value verbatim (byte-identical default).
export function resolvePill(style: ReadingStyle | undefined, dark: boolean): PillDraw {
  const base = dark ? READING_PILL.dark : READING_PILL.light;
  return {
    fill: style?.ttsKaraokeColor ?? base.fill,
    op: style?.ttsKaraokeOpacity ?? base.op,
    blend: base.blend,
  };
}
