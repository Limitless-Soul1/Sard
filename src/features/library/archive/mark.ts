// ONE MARK, AND IT IS THE READER'S MARK — flattened, because here it sits BEHIND the glyphs.
//
// WHY THIS IS NOT JUST `background + mix-blend-mode + opacity`. That combination is right in the book,
// where the mark is an SVG group ABOVE the text and contains no text of its own: the blend converts an
// over-the-text overlay back into something that behaves like pigment under it, and the opacity applies
// only to the mark. Carried onto an inline span that WRAPS the words, both properties change meaning —
// `opacity` is an element property, so it fades the glyphs together with their ink and forces the whole
// span into a composited group. Measured on the page, that is what made a quotation look like a dark
// panel laid over the text rather than a passage someone had marked.
//
// So the mark is flattened here instead: the same ink, the same blend arithmetic and the same strength
// the resolver returns, composited ONCE against the surface the mark is painted on, and emitted as a
// single opaque colour. The result is the pixel the book produces, with the text drawn over it at full
// contrast — which is also exactly the shape the design asks for, a plain `background` with a radius and
// an em padding and nothing else.

import type { CSSProperties } from "react";

import {
  INK_PAD_BOTTOM_EM,
  INK_PAD_TOP_EM,
  INK_PAD_X_EM,
  INK_RADIUS_EM,
  type ResolvedInk,
} from "../../../lib/highlightInk";

const parseHex = (c: string): [number, number, number] | null => {
  const h = (c ?? "").trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return null;
  const f = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};

const hex = (v: number[]): string =>
  `#${v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;

/**
 * The one colour a mark actually paints, given the ground it is painted on.
 *
 * `multiply` can only darken and `screen` can only lighten — that asymmetry is the whole reason the
 * book stays readable on light paper and on dark. Both are computed here exactly as the compositor
 * would, then mixed toward the ground by the mark's own strength. A ground that is not a plain hex
 * (a CSS variable, say) leaves the ink untouched rather than blanking the mark out.
 */
export function flattenInk(ink: ResolvedInk, ground: string): string {
  const a = parseHex(ink.fill);
  const b = parseHex(ground);
  if (!a || !b) return ink.fill;
  const blended = a.map((v, i) =>
    ink.blend === "multiply" ? (v * b[i]) / 255 : 255 - ((255 - v) * (255 - b[i])) / 255,
  );
  const t = Math.max(0, Math.min(1, ink.opacity));
  return hex(blended.map((v, i) => b[i] + (v - b[i]) * t));
}

/**
 * The inline style of a mark: one flat colour, the shared `em` geometry, and nothing else.
 *
 * Geometry is per element because it is measured in `em` of the text it wraps — a mark around a 13px
 * quote and one around a 16px passage are the same shape at two sizes, which is what makes the
 * archive's marks and the book's marks recognisably one thing.
 */
export function markStyle(ink: ResolvedInk, ground: string): CSSProperties {
  return {
    background: flattenInk(ink, ground),
    padding: `${INK_PAD_TOP_EM}em ${INK_PAD_X_EM}em ${INK_PAD_BOTTOM_EM}em`,
    borderRadius: `${INK_RADIUS_EM}em`,
  };
}
