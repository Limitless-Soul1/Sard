// RAWY-259 — THE ONE PLACE a highlight's ink is resolved.
//
// A highlight is painted in two very different surfaces: the book page (an SVG overlay drawn by
// FoliateController.drawHighlight) and the Notes editor's passage preview (CSS on a <span>). They MUST look
// identical — the reader has to feel the editor is showing the very mark they are editing, not a
// representation of it — and the only way to guarantee that is for both to ask the SAME function for the
// same three answers: which colour, which blend, which opacity. Any "preview style" that re-derives those
// separately drifts the moment one side is tuned, which is exactly what happened before this module existed.
//
// The values themselves come from the Ink Swatch design + the RAWY-258 readability work:
//   LIGHT paper — the ink at its own value under MULTIPLY. Multiply can only darken, so dark glyphs keep
//     their contrast while the paper around them takes the colour.
//   DARK paper — the SAME ink carried down INTO the paper (a deeper mix, never a fainter one) under SCREEN,
//     which can only lighten, so light glyphs on a dark page stay light.
// Both sit short of full value so the text stays the primary element and the mark never buries it.

/** Base opacity per paper polarity — tuned in RAWY-258 against measured text-contrast-through-the-mark. */
export const INK_BASE_LIGHT = 0.72;
export const INK_BASE_DARK = 0.5;
/** How far the ink is carried into a dark paper. Calibrated on the design's own light/dark pairs
 *  (amber #E8C36A → #584324, marigold, green, teal, purple — all ≈0.34–0.40 of the ink's value). */
export const DARK_INK_MIX = 0.37;
/** What an untouched highlight (alpha NULL = "follow the theme") shows in the density control. */
export const DEFAULT_INK = 0.75;
/** The density control's floor — a mark can be faint, never invisible. */
export const INK_MIN = 0.15;
/** The design's horizontal mask: the stroke fades in/out over this much at each end. */
export const INK_EDGE_EM = 0.24;
// THE MARK'S GEOMETRY, in em — the Ink Swatch's "identical everywhere" figures
// (`padding: .05em .2em .09em` · `border-radius: .12em`). They live here, next to the colour resolution,
// because BOTH surfaces must draw the same shape: the page renderer grows each line-run rect by these
// amounts, and the Notes editor's preview applies the same values as CSS padding/radius. Anything that
// re-types one of these numbers locally is how the preview and the real mark drift apart.
export const INK_PAD_X_EM = 0.2;
export const INK_PAD_TOP_EM = 0.05;
export const INK_PAD_BOTTOM_EM = 0.09;
export const INK_RADIUS_EM = 0.12;

const parseHex = (c: string): [number, number, number] | null => {
  const h = c.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return null;
  const f = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};

/** Mix `ink` toward `paper` by `t` (1 = the ink untouched, 0 = the paper). Returns `ink` unchanged if
 *  either value isn't a hex colour, so a themed CSS var can never blank the mark out. */
export function mixInk(ink: string, paper: string, t: number): string {
  const a = parseHex(ink);
  const b = parseHex(paper);
  if (!a || !b) return ink;
  const m = a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
  return `#${m.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

export interface ResolvedInk {
  /** The colour actually painted (already carried into the paper on a dark theme). */
  fill: string;
  /** The compositing mode that keeps the glyphs readable through the mark. */
  blend: "multiply" | "screen";
  /** Final opacity, with the highlight's own density applied. */
  opacity: number;
}

/** Resolve a highlight's ink. `alpha` is the highlight's OWN density (null = follow the theme default);
 *  it SCALES the readability-tuned base rather than replacing it, so no stored density can bury the text. */
export function resolveHighlightInk(opts: {
  ink: string;
  dark: boolean;
  paper?: string;
  alpha?: number | null;
}): ResolvedInk {
  const base = opts.dark ? INK_BASE_DARK : INK_BASE_LIGHT;
  const ceiling = base * 1.35;
  const a = opts.alpha == null ? base : base * Math.max(INK_MIN, Math.min(1, opts.alpha)) * 1.35;
  return {
    fill: opts.dark ? mixInk(opts.ink, opts.paper ?? "#000000", DARK_INK_MIX) : opts.ink,
    blend: opts.dark ? "screen" : "multiply",
    opacity: Math.max(0.06, Math.min(ceiling, a)),
  };
}
