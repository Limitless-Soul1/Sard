// RAWY-281 — THE REFERENCE TWIN RULE (docs/design/Sard Reference Twin Rule (standalone).html).
//
// The single source of truth for the mark under a referenced word or phrase, and for the three
// per-book controls that adjust it. Kept in its own tiny module — exactly like `ttsTrack.ts` — so the
// settings panel can import the resolver WITHOUT dragging in `FoliateController` (which loads
// foliate-js). One resolver, two consumers (the draw and the UI), so the panel can never show a
// number the page does not draw.
//
// THE DESIGN, quoted from the file's own "THE SPEC" block:
//   "Two strokes, drawn (not text-decoration), both full word width, both fully rounded.
//    Thickness clamp(1.5px, .10em, 2.5px); gap clamp(2px, .13em, 4px); first rule .30em below the
//    content box. Colour is the theme accent at 100% — no opacity anywhere, since that is what made
//    the old mark disappear. On wrap, each fragment carries the full pair."
// Variation 6a "Equal pair" is the design's own recommendation and is what this implements: both
// rules the SAME thickness, both the full run width, both fully rounded.
//
// GEOMETRY, stated once so the draw and the controls agree on what each number means. Reading down
// from the text, with `off` measured from the BOTTOM of the text's content box:
//     content-box bottom
//        ↓  off            (default .30em — the design's clearance, keeps Arabic descenders clear)
//     ▬▬▬▬  thickness      (rule 1 — its BOTTOM edge sits exactly `off` below the box, per the
//        ↓  gap             design's `bottom: -.30em` on an absolutely-positioned rule)
//     ▬▬▬▬  thickness      (rule 2)
// `gap` is the CLEAR SPACE between the two rules, not a centre distance — the design's second rule
// sits at `bottom: -(.30em + (t + gap)/fontSize)`, which is the same thing.

import type { ReadingStyle } from "./injectedCss";

/** The design's own numbers. Every one of them is a literal from the standalone file; nothing here is
 *  interpolated or rounded, so "default" and "the design" are the same object. */
export const REF_RULE = {
  /** Thickness: `clamp(1.5px, .10em, 2.5px)`. Clamped LOW so small type stays crisp on a 1× screen
   *  and HIGH so the pair never turns into a slab at 28px+. */
  thickEm: 0.1,
  thickMin: 1.5,
  thickMax: 2.5,
  /** Gap: `clamp(2px, .13em, 4px)`. Grows with em so the pair never fuses into one thick rule. */
  gapEm: 0.13,
  gapMin: 2,
  gapMax: 4,
  /** The first rule's clearance below the content box: `.30em`. */
  offsetEm: 0.3,
  /** ⚠️ NOT A DESIGN FIGURE — a FLOOR, and the reason it exists was found by measurement, not by
   *  inspection. The two size controls are independent, so their extremes COMBINE: at 20px with the
   *  thickness at 200% and the distance at 50%, the design's own arithmetic gives thickness 4px and
   *  offset 3px — and since `offset` measures to the stroke's BOTTOM edge, its TOP edge lands 1px INSIDE
   *  the text's content box. The pair would sit on the letterforms, which is the one thing the design's
   *  ".30em clearance keeps Arabic descenders clear" exists to prevent. Neither slider is wrong on its
   *  own; only the pair is, which is exactly the case a per-control range check cannot catch.
   *
   *  So the resolved offset is floored at `thickness + .06em` — the stroke always clears the glyph box.
   *  .06em is chosen so the floor CANNOT bite at the design default: it engages only below a ~6.25px
   *  font (solve .30F = 1.5 + .06F), which no reader will ever see. The default therefore stays byte-
   *  identical to the design at every real size, and the guard is inert until a reader combines the two
   *  controls into something the design never described. */
  minClearEm: 0.06,
} as const;

/** The user-adjustable range for the two size controls. Both are expressed as a MULTIPLE of the
 *  design value, so 1 is the design exactly and the stored number carries its own meaning at every
 *  font size — a stored px would be wrong the moment the reader changed zoom. The bounds are what
 *  keeps "never break the design" true rather than a matter of taste: see the notes on each. */
export const REF_WEIGHT_MIN = 0.5;
export const REF_WEIGHT_MAX = 2;
export const REF_OFFSET_MIN = 0.5;
export const REF_OFFSET_MAX = 2;

export interface RefRuleDraw {
  /** The stroke colour — the theme accent at full strength unless the reader overrode it. */
  color: string;
  /** Each rule's thickness in CSS px at this text size. Both rules are identical ("Equal pair"). */
  thickness: number;
  /** The CLEAR space between the two rules, in CSS px. */
  gap: number;
  /** The first rule's clearance below the text's content box, in CSS px. */
  offset: number;
  /** The smallest clearance that still keeps the pair off the glyph box — the floor `offset` was already
   *  held to. Exposed so the paged-mode clip clamp in `refRuleBars` can shift the pair up without ever
   *  pushing it onto the letterforms; the two would otherwise each need their own copy of the rule. */
  minOffset: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Resolve the pair's geometry for a run of text whose FONT SIZE is `fontPx`.
 *
 * `weight` scales the thickness AND the gap by the same factor, and that is the whole reason the
 * control "never breaks the design": thickness ÷ gap is invariant under it, so a thicker pair is the
 * design at a larger size rather than two rules closing on each other. Scaling thickness alone would
 * fuse the pair at the top of the range and is exactly the failure the design's em-based gap exists
 * to prevent. The clamps scale too — clamping AFTER the multiply would flatten the whole upper half
 * of the slider to a constant on ordinary reading sizes.
 *
 * `offset` moves BOTH rules together. Thickness and gap are untouched by it, which is the stated
 * requirement: only the pair's distance from the text changes, never its internal relationship.
 */
export function resolveRefRule(
  style: ReadingStyle | undefined,
  accent: string,
  fontPx: number,
): RefRuleDraw {
  const w = style?.refRuleWeight ?? 1;
  const o = style?.refRuleOffset ?? 1;
  const thickness = clamp(REF_RULE.thickEm * fontPx, REF_RULE.thickMin, REF_RULE.thickMax) * w;
  const minOffset = thickness + REF_RULE.minClearEm * fontPx;
  return {
    color: style?.refRuleColor ?? accent,
    thickness,
    minOffset,
    gap: clamp(REF_RULE.gapEm * fontPx, REF_RULE.gapMin, REF_RULE.gapMax) * w,
    // The floor is applied HERE rather than in the UI, and that placement is deliberate: it has to hold
    // for a value that arrived from the database (a book saved on a build with a different range, or a
    // hand-edited settings blob), not merely for one that came from a slider. A guard that only exists
    // in the control is not a guard on the drawing. See `REF_RULE.minClearEm`.
    offset: Math.max(REF_RULE.offsetEm * fontPx * o, minOffset),
  };
}

/** The total vertical extent the pair occupies BELOW the text's content box, in CSS px. The reference
 *  hit-test uses it so a tap aimed at the visible mark still opens the reference however the reader
 *  has tuned it — the target is the word AND its rules, at every setting. */
export function refRuleReach(d: RefRuleDraw): number {
  return d.offset + d.thickness + d.gap;
}

/** One drawn stroke, in the same coordinate space as the text rect it came from. */
export interface RefRuleBar { x: number; y: number; width: number; height: number; rx: number }

/**
 * The two strokes for ONE line fragment of a marked run — the whole of the design's geometry, in one
 * place, with no DOM. Kept out of `FoliateController` deliberately: the draw there becomes a plain
 * translation of these numbers into <rect>s, so the design can be verified headlessly rather than only
 * by looking at the screen.
 *
 * `rect` is the fragment's client rect; only its `left`, `right`/`width` and `bottom` are read.
 *
 * ⚠️ THE EDGE THAT IS EASY TO GET WRONG: the design positions rule 1 with `bottom: -.30em`, so `offset`
 * measures to the stroke's BOTTOM edge, not its top. Reading it as a top offset shifts the entire pair
 * down by one thickness — a change no single mock-up would obviously reveal, and one that would quietly
 * break the design's stated clearance from Arabic descenders.
 */
export function refRuleBars(
  rect: { left: number; width: number; bottom: number },
  d: RefRuleDraw,
  /** RAWY-281 (live verification): the bottom of the CLIP the strokes are painted into, in the same
   *  coordinate space as `rect`, or `undefined` where there is no meaningful limit.
   *
   *  ⚠️ THIS EXISTS BECAUSE PAGED MODE MEASURED AS A REAL FAILURE, not as a precaution. foliate's
   *  overlayer is an `<svg>` with `overflow: hidden` sized to the PAGE, and the twin rule is the first
   *  overlay draw that reaches meaningfully BELOW its text (the RAWY-258 highlight reaches 0.09em; this
   *  reaches ~0.53em). Measured over 40 pages of a real book, the slack under the LAST line of a page
   *  falls as low as **6.14px** while the mark's default reach is **11.87px** — so a reference on a
   *  page's last line had its lower stroke cut off. Scrolled mode is unaffected (its overlayer spans the
   *  whole chapter), and this argument is why the limit is passed rather than assumed: with no clip
   *  supplied the geometry below is exactly what it always was. */
  clipBottom?: number,
): [RefRuleBar, RefRuleBar] {
  // Shift the PAIR up just enough to stay inside the clip — but ONLY when that actually rescues it.
  //
  // ⚠️ THE ALL-OR-NOTHING CONDITION IS THE WHOLE POINT, AND IT WAS ADDED AFTER MEASURING THE NAIVE
  // VERSION. A first cut clamped unconditionally, bounded by the floor. On the measured worst page
  // (6.17px of slack) the pair needs `thickness + gap + thickness` = 7.39px BEFORE any clearance, so it
  // physically cannot fit at any offset: clamping merely crushed the clearance from 6.7px to 1.34px —
  // the rules sitting almost on the letterforms — and the lower stroke was STILL cut. That is worse on
  // both counts than leaving it alone, where the reader simply sees the upper rule at its correct
  // distance and reads it as a single underline.
  //
  // So: if the pair fits after shifting, shift it (both rules visible, clearance slightly tightened on
  // that one line). If it cannot fit, do nothing and keep the design's exact geometry. The pair always
  // moves as a UNIT — thickness and gap are never touched — so the design's internal relationship holds
  // in every branch.
  let offset = d.offset;
  if (clipBottom != null) {
    const overflow = rect.bottom + offset + d.gap + d.thickness - clipBottom;
    const rescuable = rect.bottom + d.minOffset + d.gap + d.thickness <= clipBottom;
    if (overflow > 0 && rescuable) offset = Math.max(d.minOffset, offset - overflow);
  }
  const bar = (y: number): RefRuleBar => ({
    x: rect.left,
    y,
    width: rect.width,
    height: d.thickness,
    // "Every terminal is a half-round" — the cap radius is always HALF the thickness, never a fixed px,
    // which is the one thing a CSS text-decoration can never produce.
    rx: d.thickness / 2,
  });
  return [
    bar(rect.bottom + offset - d.thickness), // rule 1: its BOTTOM edge sits `offset` below the box
    bar(rect.bottom + offset + d.gap), // rule 2: one CLEAR `gap` below rule 1's bottom edge
  ];
}
