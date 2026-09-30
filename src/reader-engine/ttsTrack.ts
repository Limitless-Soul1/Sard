// RAWY-200: the pure resolution of the TTS text-tracking look (sentence SPOTLIGHT + word KARAOKE pill)
// from a ReadingStyle over the built-in per-theme base. Kept in its own tiny module so the settings UI
// can import the resolvers WITHOUT dragging in the whole FoliateController (which loads foliate-js).
//
// The `fill` values stay the EXACT `rgb(...)` strings the pre-RAWY-200 build drew, so an untouched
// (null colour/opacity) effect resolves byte-identical, in BOTH themes — the null sentinel is what
// makes that true: it stores no number, so the per-theme constant is used verbatim.

import type { ReadingStyle } from "./injectedCss";
import { contrastRatio, luminanceOf, MIN_READABLE_CONTRAST } from "../lib/contrast";

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

/**
 * THE PAINTED BOX IS THE INK, NOT THE FONT'S BOX.
 *
 * MEASURED ROOT. `Range.getClientRects()` returns the font's CONTENT box — ascent + descent, measured
 * at 1.33–1.52 em across five faces — and positions it by the font's declared ASCENT. A reader sees
 * the INK. The difference is the ascent the font reserves for marks that most words do not carry, and
 * it is empty highlight sitting above the word: measured 3.9 px at a 12 px page and 18.0 px (Arabic) /
 * 21.6 px (Latin) at 48 px, i.e. 24–44 % of the mark's own height. Pixel-differencing the rendered
 * frames put the mark's top edge 4–26 px above the first inked row while its bottom edge was flush
 * with the ink — which is exactly "a strip floating above the word".
 *
 * It is NOT the leading. Measured at one size with line-height swept 0.9 → 3.2, the line box moved
 * 11.5 px → 41.0 px and the painted box stayed 17 px throughout. So the correction belongs to the font
 * metrics, and a leading-based or fixed-pixel correction would be wrong at every other size.
 *
 * THE ARITHMETIC IS SCALE-FREE, and deliberately so. Only RATIOS of the font's own metrics are used,
 * multiplied by the fragment's measured height — so the correction needs no absolute font size, no
 * device ratio and no `zoom` chain, and it is automatically right at every size, in both scripts and
 * under any leading. `zoom` is the reader's size control (D6) and would otherwise have to be walked
 * and multiplied back in, as `emPxForRange` must do for the reference rule.
 *
 * THE CLAMP EXISTS BECAUSE INK CAN EXCEED THE FONT BOX. Arabic with tashkīl measured a taller ink box
 * than the content box it is laid out in (gapAbove went negative), so correcting to the ink can make
 * the mark taller than the raw rect. Left alone that would reach into the line above at tight leading,
 * so the box is held inside the LINE box when one is known. Both edges are clamped, so the mark can
 * never trespass on a neighbouring line no matter how the two disagree.
 */
export interface TrackMetrics {
  /** The font's own ascent and descent. Any consistent unit — only their ratio is used. */
  fontAscent: number;
  fontDescent: number;
  /** The ink the marked text actually draws, in the SAME unit as the two above. */
  inkAscent: number;
  inkDescent: number;
  /** The line box, in the same space as the rect handed to `inkBand` (post-zoom px). Optional: without
   *  it the box is corrected but not clamped. */
  lineBoxPx?: number;
}

export function inkBand(top: number, height: number, m: TrackMetrics | null | undefined):
  { top: number; height: number } {
  if (!m) return { top, height };
  const font = m.fontAscent + m.fontDescent;
  // A face that reports nothing usable leaves the mark exactly where it was drawn before. A mark that
  // is merely mispositioned is a blemish; a mark that fails to draw is a reader who cannot follow the
  // voice, so every guard here falls back to the old box rather than to nothing.
  if (!(font > 0) || !(height > 0)) return { top, height };
  const baseline = top + height * (m.fontAscent / font);
  const asc = Math.max(0, m.inkAscent);
  const desc = Math.max(0, m.inkDescent);
  let t = baseline - height * (asc / font);
  let b = baseline + height * (desc / font);
  if (!(b > t)) return { top, height };
  // THE LINE BOX, WHEN IT IS KNOWN. Half the leading sits above the content box and half below, so the
  // line's own bounds follow from the fragment. At leading tighter than the content box the half is
  // negative and this pulls the mark IN, which is the case that would otherwise overlap.
  if (m.lineBoxPx && m.lineBoxPx > 0) {
    const half = (m.lineBoxPx - height) / 2;
    const lineTop = top - half;
    const lineBottom = top + height + half;
    t = Math.max(t, lineTop);
    b = Math.min(b, lineBottom);
    if (!(b > t)) return { top, height };
  }
  return { top: t, height: b - t };
}

/**
 * WHAT THE MARK IS PAINTED OVER — the two colours the blend decision is made against.
 *
 * Read at paint time from the surface actually on screen, never from stored metadata. See
 * `isDarkSurface` in `lib/contrast.ts` for why the هيئة's own `dark` flag cannot be trusted here.
 */
export interface TrackGround { paper: string; text: string }

/** Per-channel separable blends, as the compositing spec defines them. */
function blendChannel(mode: string, backdrop: number, src: number): number {
  switch (mode) {
    case "multiply": return (backdrop * src) / 255;
    case "screen": return 255 - ((255 - backdrop) * (255 - src)) / 255;
    case "darken": return Math.min(backdrop, src);
    case "lighten": return Math.max(backdrop, src);
    default: return src; // normal
  }
}

const parse = (c: string): [number, number, number] | null => {
  const m = c.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  let h = c.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** What a group of `fill` at `op` under `mode` turns `backdrop` into — the colour that reaches the eye. */
export function compositeMark(backdrop: string, fill: string, op: number, mode: string): string {
  const b = parse(backdrop), s = parse(fill);
  if (!b || !s) return backdrop;
  const a = Math.max(0, Math.min(1, op));
  const out = [0, 1, 2].map((i) => b[i] * (1 - a) + blendChannel(mode, b[i], s[i]) * a);
  return `#${hex(out[0])}${hex(out[1])}${hex(out[2])}`;
}

/**
 * THE BLEND MODE IS CHOSEN, NOT FIXED — and the test it is chosen by is "does this mark leave the words
 * alone?", not "is the mark high-contrast?".
 *
 * WHAT WAS WRONG. The mode was a per-polarity constant: `multiply` on light paper, `screen` on dark,
 * unreachable by a هيئة. Both are multiplicative, so both carry the paper's hue into the result and clamp
 * the reachable gamut to one side of it. Measured on real هيئات: one asking for a NEUTRAL grey #585656
 * rendered #655545, a brown; one asking for #965334 on a #101419 page rendered #1F120E, indistinguishable
 * from the page. The asked colour was not dimmed, it was unreachable.
 *
 * WHY THE BLEND CANNOT SIMPLY GO. foliate's overlayer paints ABOVE the glyphs, so `normal` at high
 * opacity buries the words — a real regression once (see `drawHighlight`). The blend is what turns an
 * over-the-text overlay back into something that behaves like pigment beneath it.
 *
 * THE DIRECTIONAL CLAMP DOES BOTH. `darken` (a mark darker than its paper) and `lighten` (lighter) are
 * per-channel min/max: on the paper they reproduce the asked colour, and on a glyph that lies on the far
 * side of the mark they change NOTHING — the words come through at their own exact colour. So the first
 * candidate is whichever direction the mark actually falls on, measured against the paper on screen.
 *
 * ⚠️ WHY THE OBVIOUS GATE IS THE WRONG ONE, AND WAS TRIED. Ranking candidates by the contrast between
 * the composited glyph and the composited mark picks `multiply` for the neutral-grey هيئة — 3.30 against
 * `darken`'s 2.55 — because multiply reaches that ratio by repainting the ink #45382A → #231c15. It
 * "wins" by destroying the text's own colour, which is the opposite of the thing being protected. So a
 * mode that leaves the glyph untouched is accepted on that ground alone, and the ratio is only consulted
 * for modes that do disturb the ink.
 *
 * VISIBILITY IS A HARD REQUIREMENT. A directional clamp against a paper the mark does not actually
 * straddle collapses onto the paper (measured: `darken` on #101419 renders the page itself), so a
 * candidate that cannot be told apart from its own paper is never chosen, however safe it is.
 *
 * MEASURED RESULT, all five real هيئات: every one now resolves to the directional clamp, the asked hue
 * arrives on the paper, and the ink is left at its own value or within a few counts of it.
 */
/** A mark must differ from its own paper by at least this much to count as visible at all. */
const MARK_VISIBLE_CONTRAST = 1.1;
/** Per-channel tolerance for "the ink came through untouched" — a few counts, to absorb rounding. */
const INK_UNTOUCHED = 4;

function channelDistance(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 255;
  return Math.max(...[0, 1, 2].map((i) => Math.abs(x[i] - y[i])));
}

export function pillBlendFor(fill: string, op: number, ground: TrackGround | undefined, dark: boolean): string {
  const fallback = dark ? READING_PILL.dark.blend : READING_PILL.light.blend;
  if (!ground?.paper || !ground?.text) return fallback;
  const lf = luminanceOf(fill), lp = luminanceOf(ground.paper);
  if (lf == null || lp == null) return fallback;
  const darker = lf < lp;
  // Most faithful first: the clamp in the direction the mark actually falls, then a straight mix, then
  // the multiplicative rescue the old code always used.
  const candidates = [darker ? "darken" : "lighten", "normal", darker ? "multiply" : "screen"];
  let best = fallback, bestRatio = -1;
  for (const mode of candidates) {
    const onPaper = compositeMark(ground.paper, fill, op, mode);
    const onGlyph = compositeMark(ground.text, fill, op, mode);
    if (contrastRatio(onPaper, ground.paper) < MARK_VISIBLE_CONTRAST) continue; // invisible — never
    const ratio = contrastRatio(onGlyph, onPaper);
    if (channelDistance(onGlyph, ground.text) <= INK_UNTOUCHED) return mode; // the words are untouched
    if (ratio >= MIN_READABLE_CONTRAST) return mode;
    if (ratio > bestRatio) { best = mode; bestRatio = ratio; }
  }
  return best;
}

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
//
// `ground` is the surface the mark will be painted onto. WITHOUT it the per-polarity constant is used,
// exactly as before — that path is for a caller that has no page to measure (a settings preview reading
// its own specimen). The Reader always has one and always passes it.
export function resolvePill(
  style: ReadingStyle | undefined,
  dark: boolean,
  ground?: TrackGround,
): PillDraw {
  const base = dark ? READING_PILL.dark : READING_PILL.light;
  const fill = style?.ttsKaraokeColor ?? base.fill;
  const op = style?.ttsKaraokeOpacity ?? base.op;
  return { fill, op, blend: pillBlendFor(fill, op, ground, dark) };
}
