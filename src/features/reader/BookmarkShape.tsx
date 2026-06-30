// BookmarkShape (RAWY-41, design Band J/J-II) — draws a bookmark marker in a given colour,
// scaled by `h` (the marker height in px). Recreated from the design's shape recipes; used by the
// on-page marker, the Global-Settings picker grid, and the bookmarks list. Pure CSS, theme-neutral
// (the colour is passed in). The shape hangs from the TOP of its box so it reads as an edge marker.

import type { CSSProperties } from "react";

import type { BookmarkShapeKey } from "../../lib/bookmarkStyle";

// A darker shade for gradients (mix the colour toward black).
const darker = (c: string) => `color-mix(in srgb, ${c} 78%, #000)`;
const lighter = (c: string) => `color-mix(in srgb, ${c} 84%, #fff)`;

export function BookmarkShape({ shape, color, h = 44 }: { shape: BookmarkShapeKey; color: string; h?: number }) {
  const W = h; // square box; the shape is positioned within it
  const box: CSSProperties = { position: "relative", width: W, height: h, flex: "none" };
  const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", ...s });
  const strip = (w: number, ht: number, clip: string, extra?: CSSProperties): CSSProperties => ({
    width: w,
    height: ht,
    background: `linear-gradient(90deg, ${darker(color)}, ${lighter(color)})`,
    clipPath: clip,
    boxShadow: "1px 2px 4px rgba(0,0,0,.22)",
    ...extra,
  });
  const NOTCH = "polygon(0 0,100% 0,100% 100%,50% 78%,0 100%)";
  const POINT = "polygon(0 0,100% 0,100% 80%,50% 100%,0 80%)";

  let inner: CSSProperties[] = [];
  switch (shape) {
    case "ribbon":
      inner = [abs({ top: 0, left: W * 0.5 - h * 0.16, ...strip(h * 0.32, h, NOTCH) })];
      break;
    case "pointed":
      inner = [abs({ top: 0, left: W * 0.5 - h * 0.16, ...strip(h * 0.32, h, POINT) })];
      break;
    case "double":
      inner = [
        abs({ top: 0, left: W * 0.5 - h * 0.2, ...strip(h * 0.28, h, NOTCH) }),
        abs({ top: 0, left: W * 0.5 + h * 0.0, ...strip(h * 0.28, h * 0.82, NOTCH), background: `linear-gradient(90deg, ${darker("#B8893C")}, #d2a155)` }),
      ];
      break;
    case "corner":
      inner = [abs({ top: 0, right: 0, width: h * 0.46, height: h * 0.46, background: `linear-gradient(225deg, ${color} 50%, transparent 50%)` })];
      break;
    case "tab":
      inner = [abs({ top: h * 0.22, right: 0, width: h * 0.2, height: h * 0.46, background: color, borderRadius: "3px 0 0 3px", boxShadow: "-2px 2px 5px rgba(0,0,0,.18)" })];
      break;
    case "marker":
      inner = [abs({ top: 0, left: W * 0.5 - 1.5, width: 3, height: h * 0.66, background: color, borderRadius: "0 0 2px 2px" })];
      break;
    case "feather":
      inner = [
        abs({ top: h * 0.12, left: W * 0.5 - h * 0.12, width: h * 0.24, height: h * 0.6, background: `linear-gradient(${lighter(color)}, ${color})`, borderRadius: "50% 50% 50% 50%/60% 60% 40% 40%", transform: "rotate(8deg)", boxShadow: "1px 2px 4px rgba(0,0,0,.18)" }),
        abs({ top: h * 0.18, left: W * 0.5 - h * 0.04, width: 1.5, height: h * 0.42, background: "rgba(0,0,0,.35)", transform: "rotate(8deg)" }),
      ];
      break;
    case "tassel":
      inner = [
        abs({ top: 0, left: W * 0.5 - 1, width: 2, height: h * 0.5, background: darker(color) }),
        abs({ top: h * 0.5, left: W * 0.5 - h * 0.07, width: h * 0.14, height: h * 0.28, background: `linear-gradient(${color}, ${darker(color)})`, borderRadius: "0 0 3px 3px" }),
      ];
      break;
    case "seal":
      inner = [abs({ top: h * 0.18, left: W * 0.5 - h * 0.2, width: h * 0.4, height: h * 0.4, borderRadius: "50%", background: `radial-gradient(circle at 38% 32%, ${lighter(color)}, ${darker(color)})`, boxShadow: "0 2px 5px rgba(0,0,0,.28)" })];
      break;
    case "clip":
      inner = [
        abs({ top: h * 0.12, left: W * 0.5 - h * 0.1, width: h * 0.2, height: h * 0.62, border: `2.5px solid ${color}`, borderRadius: 9, boxShadow: "1px 1px 3px rgba(0,0,0,.18)" }),
        abs({ top: h * 0.2, left: W * 0.5 - h * 0.04, width: h * 0.08, height: h * 0.44, border: `2px solid ${lighter(color)}`, borderBottom: "none", borderRadius: "6px 6px 0 0" }),
      ];
      break;
    case "cord":
      inner = [
        abs({ top: 0, left: W * 0.5 - h * 0.06, width: h * 0.12, height: h * 0.62, background: `repeating-linear-gradient(45deg, ${darker(color)} 0 4px, ${color} 4px 8px)`, borderRadius: "0 0 4px 4px", boxShadow: "1px 2px 4px rgba(0,0,0,.2)" }),
        abs({ top: h * 0.58, left: W * 0.5 - h * 0.04, width: h * 0.16, height: h * 0.16, borderRadius: "50%", background: color, boxShadow: "0 1px 2px rgba(0,0,0,.25)" }),
      ];
      break;
    case "leaf":
      inner = [
        abs({ top: h * 0.14, left: W * 0.5 - h * 0.18, width: h * 0.32, height: h * 0.62, background: `linear-gradient(${darker(color)}, ${color})`, borderRadius: "50% 50% 50% 50%/65% 65% 35% 35%", transform: "rotate(14deg)", boxShadow: "1px 2px 4px rgba(0,0,0,.16)" }),
        abs({ top: h * 0.18, left: W * 0.5 - h * 0.02, width: 1.5, height: h * 0.5, background: "rgba(255,255,255,.4)", transform: "rotate(14deg)" }),
      ];
      break;
  }
  return (
    <span className="bm-shape" style={box} aria-hidden>
      {inner.map((s, i) => (
        <span key={i} style={s} />
      ))}
    </span>
  );
}
