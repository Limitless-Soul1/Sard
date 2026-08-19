// The icon set — one drawing system for the marks that were previously text glyphs.
//
// WHY this exists (measured 2026-08-19, Library + Profiles only; the Reader was not sampled):
// 69 glyph-icons were rendering in FOUR typefaces, none of them the app's own —
//   Cambria Math (a maths font) ....... 36   caret, ellipsis, search, most of the settings nav
//   Segoe UI Symbol ................... 7    close, grip, gear
//   MS PGothic (a Japanese font) ...... 1    the "about" mark
//   Amiri / IBM Plex Sans ............. text, not icons
// The engine picks the face per CODEPOINT from the OS fallback chain, so weight and optical size
// are decided by whichever font happens to own that character on that machine. All three fallback
// faces are Windows-specific, so the same marks resolve differently on macOS and Linux.
//
// Geometry follows Stage 3: a 24x24 view box, `currentColor`, round caps and joins, and
// `--icon-stroke` (1.75) rather than the 1.9/2 that inline SVG in the reader currently varies over.
// Size comes from the `--icon-*` tokens, never a raw px.
//
// NOT covered here, deliberately: the eight `gs-nav-ico` marks. Those glyphs are arbitrary
// stand-ins for their sections -- the bookmark row is a triangle, the language row is the command
// symbol, the presence row is a filled circle -- so replacing them means CHOOSING NEW IMAGERY,
// which is a design decision and not a rendering fix. They are recorded in the checklist as
// needing that decision before any swap.

import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "close"        // was U+2715
  | "more"         // was U+22EF  (overflow menu)
  | "caretDown"    // was U+25BE  (disclosure, open)
  | "caretRight"   // was U+25B8  (disclosure, collapsed)
  | "grip"         // was U+283F  (drag handle)
  | "gear"         // was U+2699
  | "search";      // was U+2315

export type IconSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<IconSize, string> = {
  sm: "var(--icon-sm)",
  md: "var(--icon-md)",
  lg: "var(--icon-lg)",
  xl: "var(--icon-xl)",
};

/** Marks drawn with strokes; `more` and `grip` are dot patterns and are filled instead. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["more", "grip"]);

const PATHS: Record<IconName, ReactElement> = {
  close: <path d="M6 6 18 18M18 6 6 18" />,
  more: (
    <>
      <circle cx="5.2" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18.8" cy="12" r="1.5" />
    </>
  ),
  caretDown: <path d="m6 9.5 6 6 6-6" />,
  caretRight: <path d="m9.5 6 6 6-6 6" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
    </>
  ),
  // A cog, not a sun. The first draft was a small hub with eight long detached rays, which is the
  // universal BRIGHTNESS mark -- it typechecked, rendered and measured correctly and was still the
  // wrong icon. What separates the two is that gear teeth are SHORT and ATTACHED to a large rim,
  // so the rim carries the weight and the teeth only interrupt its edge.
  gear: (
    <>
      <circle cx="12" cy="12" r="6.6" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M18.6 12H21M5.4 12H3M12 18.6V21M12 5.4V3M16.67 16.67l1.69 1.69M7.33 7.33 5.64 5.64M7.33 16.67l-1.69 1.69M16.67 7.33l1.69-1.69" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4.2 4.2" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: IconSize;
}

/**
 * An icon carries no accessible name of its own: it is `aria-hidden`, and the CONTROL around it
 * keeps the `aria-label` / `title` it already had. Every glyph replaced by this component was the
 * sole label of its button, so dropping that name would leave the control unnamed.
 */
export function Icon({ name, size = "md", ...rest }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={SIZE[size]}
      height={SIZE[size]}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : "var(--icon-stroke)"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ flex: "none", display: "block" }}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];
