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
  | "search"       // was U+2315
  // ---- settings navigation ----------------------------------------------------------------
  // These replace MEANING, not shape. The old marks were stand-ins picked for what characters
  // existed, so four were already apt (appearance, book styles, activity, about) and three said
  // something else entirely: the bookmark row was a triangle, the language row was the command
  // symbol, the profiles row was a diamond. Each is drawn from what its section actually holds,
  // read from the section body rather than from the glyph.
  | "appearance"   // "Appearance"     — day / night / auto        (was U+25D1)
  | "profiles"     // "Profiles"       — saved appearance sets     (was U+25C8)
  | "bookStyles"   // "Book styles"    — text and paragraph        (was U+25A4)
  | "bookmark"     // "Bookmark style" — the ribbon marker         (was U+25B8)
  | "language"     // "Language"                                   (was U+2318)
  | "activity"     // "Activity"       — presence sharing          (was U+25C9)
  | "about"        // "About"                                      (was U+24D8)
  // ---- state, action and direction -----------------------------------------------------------
  // The second sweep found marks the audit's list never named. They are UI controls, not text, and
  // they were falling through the same way -- the inbox "all colours" dot measured as Cambria Math,
  // and the 63px empty-state quotation ornament declares `Literata, serif` but actually renders in
  // Segoe UI Symbol, because Literata has no such codepoint.
  | "filter"       // format filter                                (was U+26DB)
  | "check"        // selected / applied                           (was U+2713)
  | "sort"         // a shelf's order rule                         (was U+21C5)
  | "swatchAny"    // the "all colours" slot among colour swatches (was U+25CD)
  | "quote"        // the empty-state quotation ornament           (was U+275D)
  | "image"        // "no image chosen" placeholder                (was U+25A3)
  | "caretLeft"    // disclosure, inline-start                     (was U+2190)
  | "caretUp";     // disclosure, collapse                         (was U+2191)

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
  // Half-lit disc: the section switches day / night / auto, which is exactly what the old mark
  // already said. Kept, only drawn properly.
  appearance: (
    <>
      <circle cx="12" cy="12" r="6.8" />
      <path d="M12 5.2a6.8 6.8 0 0 1 0 13.6z" fill="currentColor" stroke="none" />
    </>
  ),
  // A profile in Sard is a SAVED LOOK, not a person -- palette, backgrounds and book face stored
  // together. A card behind a card says "one of several saved sets"; a person would be wrong.
  profiles: (
    <>
      <rect x="3.8" y="7.6" width="12.6" height="12.6" rx="2.4" />
      <path d="M8 4.5h9.6A1.9 1.9 0 0 1 19.5 6.4V16" />
    </>
  ),
  bookStyles: (
    <>
      <rect x="4.5" y="3.6" width="15" height="16.8" rx="2.2" />
      <path d="M8.2 8.6h7.6M8.2 12h7.6M8.2 15.4h4.8" />
    </>
  ),
  // The ribbon, which is this app's own default bookmark shape (BookmarkShape.tsx draws twelve,
  // and `ribbon` is the first of them) -- so the icon and the thing it configures agree.
  bookmark: <path d="M7 4.4h10a1 1 0 0 1 1 1v14.2l-6-4.4-6 4.4V5.4a1 1 0 0 1 1-1z" />,
  language: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.15 2.4 3.25 5 3.25 8S14.15 17.6 12 20c-2.15-2.4-3.25-5-3.25-8S9.85 6.4 12 4z" />
    </>
  ),
  // Presence broadcast: a lit centre with signal arcs. The old filled disc was already a status
  // dot, so this keeps that reading and adds what the section is for -- sharing it outward.
  activity: (
    <>
      <circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none" />
      <path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 15.9a5.5 5.5 0 0 0 0-7.8M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 18.8a9.6 9.6 0 0 0 0-13.6" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11.1v5.2" />
      <circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  filter: <path d="M4.4 5.2h15.2l-6 7.1v5.2l-3.2 1.8v-7z" />,
  check: <path d="m5.2 12.6 4.5 4.5L18.8 7.4" />,
  // Two arrows, up and down: the chip cycles a shelf between hand order and a sort rule, so the
  // mark has to say "ordering", not "more" or "swap".
  sort: (
    <>
      <path d="M7.2 19.2V4.8m0 0L4.6 7.4M7.2 4.8l2.6 2.6" />
      <path d="M16.8 4.8v14.4m0 0-2.6-2.6m2.6 2.6 2.6-2.6" />
    </>
  ),
  // The "all colours" slot sits among solid colour dots, so it is the same circle with no colour
  // in it -- an open ring reads as "any", where a filled one would read as one more colour.
  swatchAny: <circle cx="12" cy="12" r="7" />,
  // A typographic quotation ornament, drawn. The inbox holds passages taken out of books, so the
  // mark is right; only its rendering was not. Filled, like the other mark-shaped icons.
  quote: (
    <>
      <path d="M10.4 5.6c-3.4 1.6-5.6 4.6-5.6 8 0 2.9 1.9 4.8 4.4 4.8 2.2 0 3.9-1.6 3.9-3.8 0-2.1-1.5-3.6-3.5-3.6-.4 0-.8.05-1.1.15.6-1.8 2-3.3 3.9-4.2z"
        fill="currentColor" stroke="none" />
      <path d="M19.9 5.6c-3.4 1.6-5.6 4.6-5.6 8 0 2.9 1.9 4.8 4.4 4.8 2.2 0 3.9-1.6 3.9-3.8 0-2.1-1.5-3.6-3.5-3.6-.4 0-.8.05-1.1.15.6-1.8 2-3.3 3.9-4.2z"
        fill="currentColor" stroke="none" />
    </>
  ),
  image: (
    <>
      <rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4" />
      <circle cx="8.9" cy="9.9" r="1.7" />
      <path d="m4.4 16.6 4.3-4.1 3.1 3 3.1-2.7 5.1 4.6" />
    </>
  ),
  caretLeft: <path d="m14.5 6-6 6 6 6" />,
  caretUp: <path d="m6 14.5 6-6 6 6" />,
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
