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
/**
 * THE FLOOR FOR A MARK THAT IS THERE AT ALL — and it is a floor, not a minimum.
 *
 * Below this a mark is present, claims a passage and cannot be seen, which is the worst of both. So
 * every density the reader dials is held at or above it — EXCEPT the one value that is not a density
 * at all. See `INK_NONE`.
 */
export const INK_MIN = 0.15;
/**
 * NO SHADING. Not a faint one: none.
 *
 * The scale used to begin at `INK_MIN`, so the lowest a reader could go still laid colour over the
 * words. "A mark I can keep without the colour" is an ordinary thing to want — the note, the tags and
 * the place all survive, and only the wash goes — and it had no value on the dial.
 *
 * It is a SEPARATE value rather than a lower floor, deliberately: everything above zero keeps the
 * meaning it has always had, so no stored density changes appearance and nothing already saved has
 * to be migrated.
 */
export const INK_NONE = 0;
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

// RAWY-260: a mark drawn ON THE PAGE (not on chrome) must be legible against the paper in every theme.
// `--accent` is not that colour: measured against each theme's paper it lands between 1.7:1 and 3.6:1 at
// half strength, i.e. under the 3:1 non-text floor on 15 of 16 themes — which is precisely why the
// reference underline read as "invisible unless you knew it was there". Same shape as the RAWY-256
// read-marker rule: keep the source colour when it clears the floor, otherwise carry it toward `--text` in
// small steps and stop at the first step that does. Blending rather than substituting keeps as much of
// Sard's terracotta as each theme allows instead of turning the mark grey.
const MARK_FLOOR = 3;
const MARK_STEP = 0.05;
const srgb = (c: string): [number, number, number] | null => {
  const h = c.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return null;
  const f = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};
const relLum = (v: [number, number, number]): number => {
  const ch = v.map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const x = relLum(a);
  const y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Resolve a mark colour that is guaranteed legible against `ground`, keeping as much of `ink` as it can. */
export function resolveMarkOnGround(ink: string, ground: string, text: string): string {
  const a = srgb(ink);
  const g = srgb(ground);
  const t = srgb(text);
  if (!a || !g || !t) return ink; // a themed var / non-hex — never blank the mark out
  for (let k = 0; k <= 1.0001; k += MARK_STEP) {
    const c = a.map((v, i) => Math.round(v * (1 - k) + t[i] * k)) as [number, number, number];
    if (contrast(c, g) >= MARK_FLOOR) {
      return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return text; // the ground is so close to both that only the ink colour reaches the floor
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
  const fill = opts.dark ? mixInk(opts.ink, opts.paper ?? "#000000", DARK_INK_MIX) : opts.ink;
  const blend: ResolvedInk["blend"] = opts.dark ? "screen" : "multiply";
  // ZERO IS NOT A DENSITY. It is the reader saying "no colour", so it is answered before the floor
  // and before the 0.06 guard below — both of which exist to stop a density becoming invisible by
  // accident, which is precisely not what this is.
  if (opts.alpha != null && opts.alpha <= INK_NONE) return { fill, blend, opacity: 0 };
  const a = opts.alpha == null ? base : base * Math.max(INK_MIN, Math.min(1, opts.alpha)) * 1.35;
  return {
    fill,
    blend,
    opacity: Math.max(0.06, Math.min(ceiling, a)),
  };
}
