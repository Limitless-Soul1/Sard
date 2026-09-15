// THE MOBILE ICON SET — one grid, one stroke, one file.
//
// WHY A MODULE RATHER THAN INLINE SVG PER COMPONENT. The design ships 220 SVG elements across 48
// distinct geometries, and 165 of them are the same shape: 20×20, 1.6px stroke, round caps and
// joins, drawn in the CURRENT TEXT COLOUR. Pasting that per call site is how a set drifts — one
// stray `stroke-width="2"` and a row of icons stops reading as a family. Every glyph below is the
// design's own path data, copied verbatim; the geometry is the design's, the plumbing is ours.
//
// NEVER FILLED. Band B: "drawn in the current text colour — never a filled glyph except the
// bookmark ribbon", which is why `bookmarkFilled` is the one entry that takes a fill.
//
// DIRECTION. Chevrons, the drawer handle and anything else that points must mirror in RTL. That is
// done in CSS (`.m-icon--dir` under `[dir="rtl"]`) rather than by passing the language down, so an
// icon inside a book panel mirrors with the panel it sits in and no caller has to know which
// direction is live. Glyphs whose meaning is PHYSICAL — play, pause, skip, the bookmark ribbon —
// must never carry that class; Band B lists them explicitly.

import type { SVGProps } from "react";

/** The design's paths. Keys are Sard's names for them, not the design's file order. */
const PATHS = {
  // --- shell and navigation ---
  menu: <path d="M3 6h14M3 10h14M3 14h9" />,
  close: <path d="M6 6l8 8M14 6l-8 8" />,
  chevronForward: <path d="M8 5.2l5 4.8-5 4.8" />,
  chevronBack: <path d="M12 5.2L7 10l5 4.8" />,
  chevronDown: <path d="M5.2 8l4.8 5 4.8-5" />,

  // --- the places in the drawer ---
  /** C2's Library glyph: a closed book seen edge-on, with its spine. NOT the open book — that one is
   *  the design's "look up" glyph and means something else. */
  book: (
    <>
      <rect x="4" y="4" width="12" height="13" rx="1.6" />
      <path d="M8 4v13" />
    </>
  ),
  /** C2's Settings glyph: two rails with knobs. The sun below is Appearance (O1), not Settings. */
  settings: (
    <>
      <path d="M4 6.4h12M4 13.6h12" />
      <circle cx="8" cy="6.4" r="2" />
      <circle cx="12.4" cy="13.6" r="2" />
    </>
  ),
  brightness: (
    <>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 3v1.6M10 15.4V17M17 10h-1.6M4.6 10H3M14.9 5.1l-1.1 1.1M6.2 13.8l-1.1 1.1M14.9 14.9l-1.1-1.1M6.2 6.2L5.1 5.1" />
    </>
  ),
  lookUp: (
    <>
      <path d="M10 6.3C8.8 5.1 6.9 4.7 4.2 5.1v9.3c2.7-.4 4.6 0 5.8 1.2 1.2-1.2 3.1-1.6 5.8-1.2V5.1c-2.7-.4-4.6 0-5.8 1.2z" />
      <path d="M10 6.3v9.3" />
    </>
  ),
  note: (
    <>
      <path d="M13.4 3.9l2.7 2.7-7.6 7.6-3.4.7.7-3.4z" />
      <path d="M4.5 17h11" />
    </>
  ),
  photoCard: (
    <>
      <rect x="3.5" y="4.6" width="13" height="10.8" rx="2" />
      <circle cx="7.4" cy="8.4" r="1.2" />
      <path d="M4 13.6l3.5-3.1 2.9 2.5 2.2-1.9 3.9 3.1" />
    </>
  ),
  // --- library ---
  search: (
    <>
      <circle cx="9" cy="9" r="5.2" />
      <path d="M12.9 12.9l4.1 4.1" />
    </>
  ),
  viewList: <path d="M5 5.5h10M5 10h7M5 14.5h4" />,
  viewGrid: (
    <>
      <rect x="3.4" y="3.4" width="5.6" height="5.6" rx="1.2" />
      <rect x="11" y="3.4" width="5.6" height="5.6" rx="1.2" />
      <rect x="3.4" y="11" width="5.6" height="5.6" rx="1.2" />
      <rect x="11" y="11" width="5.6" height="5.6" rx="1.2" />
    </>
  ),
  sort: <path d="M5 7h10M5 10h10M5 13h10" />,
  contents: <path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9M4 5.5h.6M4 10h.6M4 14.5h.6" />,
  plus: <path d="M10 4.4v11.2M4.4 10h11.2" />,
  check: <path d="M5.2 10.4l3.2 3.2 6.4-7" />,
  checkCircle: (
    <>
      <circle cx="10" cy="10" r="6.4" />
      <path d="M7.2 10.2l2.1 2.1 3.9-4.3" />
    </>
  ),
  trash: <path d="M4.5 6.5h11M8 6.5V5.2a1.2 1.2 0 0 1 1.2-1.2h1.6A1.2 1.2 0 0 1 12 5.2v1.3M6.6 6.5l.6 8.8a1.2 1.2 0 0 0 1.2 1.1h3.2a1.2 1.2 0 0 0 1.2-1.1l.6-8.8" />,
  warning: (
    <>
      <path d="M10 4.4l6.2 11.2H3.8z" />
      <path d="M10 8.4v3.1M10 13.7h.02" />
    </>
  ),
  addToShelf: (
    <>
      <rect x="3.5" y="4.6" width="13" height="10.8" rx="2" />
      <path d="M3.5 8.4h13" />
    </>
  ),

  // --- reader surfaces (present now so the set stays one file; used from the Reader milestone) ---
  bookmark: <path d="M5.6 3.6h8.8v13l-4.4-3.3-4.4 3.3z" />,
  typography: <path d="M4.4 15.6L10 4.4l5.6 11.2M6.8 11.6h6.4" />,
  reference: (
    <>
      <path d="M6.6 4.4h5.2l3.6 3.6v8a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 16V6a1.6 1.6 0 0 1 1.6-1.6z" />
      <path d="M11.6 4.4V8h3.6" />
    </>
  ),
  listen: (
    <>
      <path d="M4.2 7.8h2.6L10.2 4.9v10.2L6.8 12.2H4.2z" />
      <path d="M13.2 7.6a3.4 3.4 0 0 1 0 4.8" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9.2" height="9.2" rx="2" />
      <path d="M13.2 7V5.4A1.4 1.4 0 0 0 11.8 4H5.4A1.4 1.4 0 0 0 4 5.4v6.4a1.4 1.4 0 0 0 1.4 1.4H7" />
    </>
  ),
  share: (
    <>
      <path d="M10 12.8V3.8M6.9 6.9L10 3.8l3.1 3.1" />
      <path d="M4.8 12.2v3a1.6 1.6 0 0 0 1.6 1.6h7.2a1.6 1.6 0 0 0 1.6-1.6v-3" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

/** The glyphs that point somewhere, and so must mirror with the reading direction. */
const DIRECTIONAL = new Set<IconName>(["menu", "chevronForward", "chevronBack"]);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** An accessible name. Omit for decoration beside a visible label — the default, and the common case. */
  label?: string;
}

export function Icon({ name, label, className, ...rest }: IconProps) {
  const cls = ["m-icon", DIRECTIONAL.has(name) ? "m-icon--dir" : "", className].filter(Boolean).join(" ");
  return (
    <svg
      className={cls}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative unless it is the only thing naming its control. A bare icon button passes `label`.
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
