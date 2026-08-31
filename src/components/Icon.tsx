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
  // ---- the five library formats -----------------------------------------------------------
  // Each is a MINIATURE OF ITS OWN LAYOUT, drawn from the rendered view rather than from the
  // word. What they replaced were CSS gradients on a 12px box: `grid` and `covers` were the
  // same string character for character, `spines` and `details` were stripes turned two ways,
  // and `vista` was a dot. Three of the five could not have been told apart by anyone.
  | "viewCovers"   // covers grouped under a shelf heading
  | "viewGrid"     // one ungrouped uniform matrix
  | "viewSpines"   // narrow spines of uneven height, standing
  | "viewDetails"  // rows: thumbnail, title, sub-line
  | "viewVista"    // a framed scene with books standing in it
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
  // ---- what can be done TO A BOOK --------------------------------------------------------------
  // The ⋯ menu named its actions in words alone. These give each one a mark, drawn in the same
  // register as the rest of the set — a single stroked outline on the 24 box, no fill, no ornament
  // — so the menu reads as Sard's and not as a borrowed icon sheet.
  | "edit"         // "Edit details"          — a nib over the line it writes
  | "bookOpen"     // "Open"                  — a spread, opened
  | "folder"       // "Open in folder"        — the container the file sits in
  | "trash"        // "Remove from shelf"     — taken off, not destroyed
  | "image"        // "no image chosen" placeholder                (was U+25A3)
  | "caretLeft"    // disclosure, inline-start                     (was U+2190)
  | "caretUp"      // disclosure, collapse                         (was U+2191)
  // ---- Direction 02 v3 — the library destinations and the annotation kinds ----------------------
  // Five of these replace the 13x13 CSS box in `Chrome.tsx`, where Library, Bookmarks and Photo
  // cards were three IDENTICAL squares. Each destination now owns a silhouette from a different
  // register — furniture, page, mark — so the sidebar reads before any label does.
  | "navLibrary"        // REQ-01  volumes on a plank            — Furniture
  | "navReadingNow"     // REQ-02  an open spread, one wick      — Page
  | "navHighlightsNotes" // REQ-03 margin bracket holding both   — Mark, gathered
  | "navBookmarks"      // REQ-07  three ribbons at three depths — Mark, many
  | "navPhotoCards"     // REQ-08  a wick mounted, set at a tilt — Page, made
  // Kinds of mark rather than places, so they carry no container at all — which is also the
  // fastest way to tell them from the destinations that hold them.
  | "markHighlight"     // REQ-04  the wick, word-shaped, on a line
  | "markNote"          // REQ-05  set text above, a written stroke below
  | "markReference";    // REQ-06  the same phrase twin-ruled twice, tied

export type IconSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<IconSize, string> = {
  sm: "var(--icon-sm)",
  md: "var(--icon-md)",
  lg: "var(--icon-lg)",
  xl: "var(--icon-xl)",
};

/** Marks drawn with strokes; `more` and `grip` are dot patterns and are filled instead. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["more", "grip"]);

/**
 * Icons whose SHAPES CARRY THEIR OWN WEIGHTS, so the component must not impose one.
 *
 * The original set draws every mark at a single `--icon-stroke`, which is right for a family of
 * simple outlines. Direction 02 v3 is not that: it uses a seven-rung ladder in which each weight has
 * a stated job — 1.2 hairline, 1.3 rule (type), 1.6 structure repeated, 1.75 structure primary,
 * 1.9 object, 3.0 ink contained, 4.2 ink solo — and seven of its ten icons genuinely need more than
 * one. A global override collapses the shelf's four volumes into a bar and REQ-09's graded specimen
 * into three identical rules, which is precisely what the icon is about.
 *
 * So for these, `strokeWidth` is omitted at the `<svg>` and every child declares its own. Everything
 * else is unchanged: `--icon-stroke` still carries 1.75, which remains the primary-structure value.
 */
const PER_PATH: ReadonlySet<IconName> = new Set<IconName>([
  "navLibrary", "navReadingNow", "navHighlightsNotes", "navBookmarks", "navPhotoCards",
  "markHighlight", "markNote", "markReference", "bookStyles", "appearance",
  // The format marks mix solid and outlined parts — a thumbnail is a block, a caption is a rule —
  // so each shape states its own weight and its own fill.
  "viewCovers", "viewGrid", "viewSpines", "viewDetails", "viewVista",
]);

const PATHS: Record<IconName, ReactElement> = {
  /* ---- THE FIVE FORMATS ----------------------------------------------------------------------
     Read off the rendered views, not off their names, and the differences between them are the
     differences between the layouts:

       COVERS   groups larger covers UNDER SHELF HEADINGS, inside a case card. The heading rule is
                what makes this icon not the grid one.
       GRID     is one ungrouped, edge-to-edge matrix with no headings at all. Its identity is the
                REGULARITY, so it is drawn as an even lattice with nothing above it.
       SPINES   stands books on a shelf, and real spines differ in height and in width. The
                unevenness is the whole mark; a row of equal bars would be a barcode.
       DETAILS  is a row of: thumbnail, title, quieter sub-line. Drawn literally.
       VISTA    is the only one that is a PICTURE WITH BOOKS IN IT, so it is the only one drawn as
                a frame, and the only one carrying a horizon.
     ------------------------------------------------------------------------------------------ */
  viewCovers: (
    <>
      {/* ONE COVER IN FRONT, TWO BEHIND IT.
          The first drawing was a shelf heading over three equal cards, which is what the view
          literally does — and at 16px it read as Grid with a dash above it, because a row of
          equal rounded rectangles IS the grid mark. Depth is the thing a lattice cannot have:
          a card standing in front of two others cannot be mistaken for a matrix at any size,
          and it says "covers" rather than "cells". It is also true to the view, where a cover
          is large enough to be looked at rather than counted. */}
      <rect x="8.4" y="5.6" width="6.6" height="12.2" rx="1" strokeWidth={1.5} />
      <rect x="15.2" y="7.4" width="5" height="10.4" rx="1" strokeWidth={1.5} />
      <rect x="3.2" y="9.6" width="6.9" height="10.8" rx="1.1" strokeWidth={1.7} fill="currentColor" />
    </>
  ),
  viewGrid: (
    <>
      <rect x="3.4" y="4.3" width="5.1" height="7" rx="0.8" strokeWidth={1.55} />
      <rect x="9.9" y="4.3" width="5.1" height="7" rx="0.8" strokeWidth={1.55} />
      <rect x="16.4" y="4.3" width="4.6" height="7" rx="0.8" strokeWidth={1.55} />
      <rect x="3.4" y="13.1" width="5.1" height="7" rx="0.8" strokeWidth={1.55} />
      <rect x="9.9" y="13.1" width="5.1" height="7" rx="0.8" strokeWidth={1.55} />
      <rect x="16.4" y="13.1" width="4.6" height="7" rx="0.8" strokeWidth={1.55} />
    </>
  ),
  viewSpines: (
    <>
      {/* the shelf they stand on */}
      <path d="M3.2 20.4h17.6" strokeWidth={2} />
      <rect x="4.1" y="7.4" width="2.7" height="10.9" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="7.7" y="4.9" width="2.2" height="13.4" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="10.8" y="8.9" width="3" height="9.4" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="14.7" y="6.2" width="2.2" height="12.1" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="17.8" y="9.6" width="2.7" height="8.7" rx="0.5" fill="currentColor" stroke="none" />
    </>
  ),
  viewDetails: (
    <>
      <rect x="3.3" y="4.4" width="4.3" height="5" rx="0.7" fill="currentColor" stroke="none" />
      <path d="M9.5 6h11.2" strokeWidth={1.7} />
      <path d="M9.5 8.6h7" strokeWidth={1.5} />
      <rect x="3.3" y="14.6" width="4.3" height="5" rx="0.7" fill="currentColor" stroke="none" />
      <path d="M9.5 16.2h11.2" strokeWidth={1.7} />
      <path d="M9.5 18.8h7" strokeWidth={1.5} />
    </>
  ),
  viewVista: (
    <>
      {/* A FRAME, A LIGHT AND A HORIZON — and nothing else.
          It first carried two book bars standing on the hill as well. Measured at the size the
          selector ships, frame + disc + hill + two bars collapsed into a blob: the bars touched
          the hill and read as more landscape. Three elements survive the reduction, and they are
          the three that matter — this is the only format that is a PICTURE, so it is the only
          mark that is framed, and the frame alone already separates it from the other four. */}
      <rect x="2.9" y="4.6" width="18.2" height="14.8" rx="2.2" strokeWidth={1.7} />
      <circle cx="8" cy="9.4" r="1.7" fill="currentColor" stroke="none" />
      <path d="M3.4 17.4c2.9-4.6 5.6-4.6 8.1-.5 1.9-3.1 4.3-3.6 9.1.2" strokeWidth={1.7} />
    </>
  ),
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
  // REQ-10. The window holding a page, one half lit: the subject is the APPLICATION, which is the
  // whole difference from `bookStyles` — a difference of subject rather than of detail, so the two
  // adjacent settings rows cannot be confused. The 2-unit corner is the only soft corner in the set,
  // deliberately, because this is the one icon whose subject is not a printed object. The lit half
  // does not mirror in RTL: light has a physical direction, not a reading one.
  appearance: (
    <>
      <rect x="3" y="4.75" width="18" height="14.5" rx="2" strokeWidth={1.75} />
      <path d="M8.25 7.75h7.5v8.5h-7.5z" strokeWidth={1.3} strokeOpacity={0.7} />
      <path d="M12 7.75h3.75v8.5H12z" fill="currentColor" stroke="none" fillOpacity={0.9} />
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
  // REQ-09. A closed page whose rules are set in GRADED weights — the typographic scale itself is
  // the subject, so the three specimen values (2.3 / 1.4 / 1.0) are content rather than construction
  // and sit outside the stroke ladder on purpose. The caption rule is short, which gives the icon a
  // ragged trailing edge, which is why the whole thing mirrors in RTL.
  bookStyles: (
    <>
      <rect x="5.5" y="3.5" width="13" height="17" rx="0.75" strokeWidth={1.75} />
      <path d="M8.25 8h7.5" strokeWidth={2.3} />
      <path d="M8.25 11.6h7.5" strokeWidth={1.4} />
      <path d="M8.25 14.9h5" strokeWidth={1} />
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
  // A nib laid on its stroke: the body angled, the tip resolved, and the rule it has just drawn.
  edit: (
    <>
      <path d="M16.4 3.9a2.1 2.1 0 0 1 3 3L9.1 17.2l-3.9 1 1-3.9z" />
      <path d="M14.3 6 18 9.7" />
    </>
  ),
  // A spread held open at the spine — the same page register the reading marks are drawn in.
  bookOpen: (
    <>
      <path d="M12 6.6v13" />
      <path d="M12 6.6C10.3 5.2 8.2 4.6 4.6 4.6v12.8c3.6 0 5.7.6 7.4 2 1.7-1.4 3.8-2 7.4-2V4.6c-3.6 0-5.7.6-7.4 2z" />
    </>
  ),
  // The container, with the tab that says it is one.
  folder: <path d="M3.8 7.1a1.4 1.4 0 0 1 1.4-1.4h3.6l2 2.4h7.8a1.4 1.4 0 0 1 1.4 1.4v8.4a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4z" />,
  // Lifted off and set down elsewhere: a lid, a body, and the two strokes inside it.
  trash: (
    <>
      <path d="M4.6 6.9h14.8" />
      <path d="M9.2 6.9V5.2a1.2 1.2 0 0 1 1.2-1.2h3.2a1.2 1.2 0 0 1 1.2 1.2v1.7" />
      <path d="M6.4 6.9 7.2 19a1.4 1.4 0 0 0 1.4 1.3h6.8a1.4 1.4 0 0 0 1.4-1.3l.8-12.1" />
      <path d="M10.4 10.4v6M13.6 10.4v6" />
    </>
  ),
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

  // ---- Direction 02 v3 · the five library destinations ------------------------------------------
  // REQ-01. Volumes standing on a plank, one leaning. FURNITURE, so no view mode can be mistaken for
  // it — the view marks are equal stripes with no plank and no character. The plank is 1.9 (Object)
  // because support has to out-weight the thing supported; the volumes are 1.6 (Structure, repeated)
  // because four outlines at 1.75 close their gaps at 16px and the shelf becomes a smear. The lean
  // rotates about its foot so the volume stays seated rather than floating.
  navLibrary: (
    <>
      <path d="M3.5 19.6h17" strokeWidth={1.9} />
      <rect x="4" y="7" width="3" height="11.6" rx="0.4" strokeWidth={1.6} />
      <rect x="7.75" y="4.75" width="3" height="13.85" rx="0.4" strokeWidth={1.6} />
      <rect x="11.5" y="8.25" width="3" height="10.35" rx="0.4" strokeWidth={1.6} />
      <g transform="rotate(10 18.5 18.6)">
        <rect x="15.5" y="8" width="3" height="10.6" rx="0.4" strokeWidth={1.6} />
      </g>
    </>
  ),
  // REQ-02. A book lying OPEN — the only open icon in the set. One wick on the read side, the other
  // still blank: started, not finished. No play triangle, no progress bar. The gutter is its own
  // path so the 14px drawing can drop it. Mirrors in RTL so the wick lands on the side already read.
  navReadingNow: (
    <>
      <path d="M12 8.1v10.4" strokeWidth={1.3} strokeOpacity={0.5} />
      <path
        d="M12 8.1C10.1 6.6 7.1 6.1 3.5 6.6v10.2c3.6-.5 6.6 0 8.5 1.5 1.9-1.5 4.9-2 8.5-1.5V6.6c-3.6-.5-6.6 0-8.5 1.5"
        strokeWidth={1.75}
      />
      <path d="M5.9 11.4h4.2" strokeWidth={3} />
    </>
  ),
  // REQ-03. A margin bracket holding one wick and one written stroke — the editor's mark for "these
  // belong together". Literally the sum of REQ-04 and REQ-05, never a third kind of thing. The hand
  // is 1.9, the same weight as REQ-05's: a written line is a written line, and thinning it here
  // would imply a hierarchy between the two kinds that does not exist.
  navHighlightsNotes: (
    <>
      <path d="M6.6 5.75H4.6V18.25h2" strokeWidth={1.6} />
      <path d="M9.4 10.4h5.6" strokeWidth={3} />
      <path
        d="M9.2 15.9c1.35-1.5 2.2.9 3.4.15 1.2-.75 1.3-1.7 2.5-1.7.9 0 1.45.75 1.6 1.45"
        strokeWidth={1.9}
      />
    </>
  ),
  // REQ-07. Three ribbons at three depths hanging from one head edge — the view of a book you have
  // left markers in. Plural by construction, which is what separates the DESTINATION from the
  // reader's own single marker. Rhythm is medium-long-short so it never looks sorted.
  navBookmarks: (
    <>
      <path d="M3.75 5.25h16.5" strokeWidth={1.6} strokeOpacity={0.5} />
      <path d="M5.75 5.25h3.2v10.4l-1.6-1.3-1.6 1.3z" fill="currentColor" stroke="none" />
      <path d="M10.4 5.25h3.2v13.6l-1.6-1.3-1.6 1.3z" fill="currentColor" stroke="none" />
      <path d="M15.05 5.25h3.2v8.6l-1.6-1.3-1.6 1.3z" fill="currentColor" stroke="none" />
    </>
  ),
  // REQ-08. A wick mounted inside a border and set down at an angle — a passage that has become an
  // object you can hand to someone. The tilt is the only tilt in the set: made, not read. It is NOT
  // mirrored in RTL, because a tilt is a gesture of placement; flipping it would make the two
  // locales look like different products. The rotate stays a live transform so the 14px drawing can
  // change the angle alone.
  navPhotoCards: (
    <g transform="rotate(-7 12 12)">
      <rect x="4.25" y="6.5" width="15.5" height="11.25" rx="0.75" strokeWidth={1.75} />
      <rect x="6.9" y="9" width="10.2" height="6.25" rx="0.4" strokeWidth={1.2} strokeOpacity={0.5} />
      <path d="M9 12.1h6" strokeWidth={3} />
    </g>
  ),

  // ---- Direction 02 v3 · the three annotation KINDS ---------------------------------------------
  // REQ-04. The wick, word-shaped, on a line that continues past it both sides. The ink is
  // horizontal and mechanical, which is exactly what a note is not. 4.2 is "ink, solo": the wick is
  // the whole icon here and has no container to borrow presence from.
  markHighlight: (
    <>
      <path d="M4 7h16M4 17h11" strokeWidth={1.3} strokeOpacity={0.7} />
      <path d="M6.5 12h8.5" strokeWidth={4.2} />
    </>
  ),
  // REQ-05. Set text above, a written stroke below — uneven and cursive, unmistakably a hand rather
  // than a machine. The three inflections are unequal by intent; an even wave reads as a signal or a
  // chart. No pencil, no square, no speech bubble.
  markNote: (
    <>
      <path d="M4 7.25h16" strokeWidth={1.3} strokeOpacity={0.5} />
      <path
        d="M4.25 16c2.1-2.35 3.6 1.5 5.7.3 2.1-1.2 2.3-2.7 4.4-2.7 1.5 0 2.4 1.05 2.6 2.1"
        strokeWidth={1.9}
      />
    </>
  ),
  // REQ-06. The same phrase twin-ruled in two places and joined by a tie — Sard's own inline
  // recurrence indicator (RAWY-281) raised to icon scale. Recurrence with one standing explanation,
  // never a chain link. The twin pairs sit 1.8 units apart so the GAP does the separating and the
  // weight can stay on the text rung. Drawing it is not a proposal that a References destination
  // should exist: `refsForBook` is per book, and the brief records that there is no such surface.
  markReference: (
    <>
      <path d="M9.5 5.4h9.5M9.5 18.6h9.5" strokeWidth={1.3} strokeOpacity={0.45} />
      <path d="M9.5 7.9h6.5M9.5 9.7h6.5M9.5 14.3h6.5M9.5 16.1h6.5" strokeWidth={1.3} />
      <path d="M6.6 9.4C4.3 11 4.3 13 6.6 14.6" strokeWidth={1.6} />
    </>
  ),
};

/**
 * The 14 px drawings, for the seven icons that need one.
 *
 * NOT a scaled master: what changes is the COUNT of things drawn and the air between them, never the
 * stroke weight — thinning strokes at small sizes is what makes an icon set look faded. The shelf
 * drops to three volumes, the spread loses its gutter, the bracket loses its serifs, the reference
 * twins become single marks, the card loses its mount, the specimen drops to two rules and the
 * window loses its page outline. Both drawings keep the 24x24 viewBox, so the swap changes nothing
 * about layout or alignment.
 *
 * Three icons deliberately have none: REQ-04 (two rules and a wick — nothing left to simplify),
 * REQ-05 (a single stroke) and REQ-07 (solid shapes 3.2 units wide, the most robust in the set).
 */
const SMALL: Partial<Record<IconName, ReactElement>> = {
  navLibrary: (
    <>
      <path d="M3.5 19.6h17" strokeWidth={1.9} />
      <rect x="4.25" y="6.6" width="3.6" height="12" rx="0.4" strokeWidth={1.6} />
      <rect x="8.9" y="4.6" width="3.6" height="14" rx="0.4" strokeWidth={1.6} />
      <g transform="rotate(11 18.6 18.6)">
        <rect x="14.3" y="7.6" width="3.6" height="11" rx="0.4" strokeWidth={1.6} />
      </g>
    </>
  ),
  navReadingNow: (
    <>
      <path
        d="M12 8.6C10.2 7.4 7.2 7 3.4 7.4v9.6c3.8-.4 6.6.1 8.6 1.4 2-1.3 4.8-1.8 8.6-1.4V7.4c-3.8-.4-6.8 0-8.6 1.2"
        strokeWidth={1.75}
      />
      <path d="M6.1 12.1h3.9" strokeWidth={3} />
    </>
  ),
  navHighlightsNotes: (
    <>
      <path d="M5 5.4v13.2" strokeWidth={1.6} />
      <path d="M9 10.2h6" strokeWidth={3} />
      <path d="M9 16c1.5-1.6 2.4 1 3.7.2 1.3-.8 1.4-1.8 2.7-1.8.9 0 1.5.8 1.65 1.5" strokeWidth={1.9} />
    </>
  ),
  // The twin gap is 0.26 px at this size and merges into a blur, so the twins become single marks
  // and move to 1.9 (Object) — they are marks now, not type. The tie is what carries the meaning.
  markReference: (
    <>
      <path d="M9.5 8h8.5M9.5 16h8.5" strokeWidth={1.9} />
      <path d="M6.4 9.6C3.9 11.2 3.9 12.8 6.4 14.4" strokeWidth={1.6} />
    </>
  ),
  navPhotoCards: (
    <g transform="rotate(-5 12 12)">
      <rect x="3.9" y="6.9" width="16.2" height="10.5" rx="0.75" strokeWidth={1.75} />
      <path d="M8 12.15h8" strokeWidth={3} />
    </g>
  ),
  bookStyles: (
    <>
      <rect x="5.2" y="3.5" width="13.6" height="17" rx="0.75" strokeWidth={1.75} />
      <path d="M8.1 8.6h7.8" strokeWidth={2.4} />
      <path d="M8.1 14.4h5.2" strokeWidth={1.3} />
    </>
  ),
  appearance: (
    <>
      <rect x="3" y="4.75" width="18" height="14.5" rx="2" strokeWidth={1.75} />
      <path d="M12 6.9h5.1v10.2H12z" fill="currentColor" stroke="none" fillOpacity={0.9} />
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
  const perPath = PER_PATH.has(name);
  // Below 16px a drawing with fewer parts is used where one exists — the switch the designer
  // specified, and the reason both drawings keep the same viewBox.
  const shapes = (size === "sm" && SMALL[name]) || PATHS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={SIZE[size]}
      height={SIZE[size]}
      // COLOUR IS NEVER FIXED HERE. Both channels resolve to `currentColor`, so a mark takes the ink
      // of whatever control holds it and follows the active theme across all sixteen papers with no
      // per-theme artwork. A `fill`/`stroke` set on a child overrides only that child, and the
      // children that do so also use `currentColor` — the mixed icons (the bookmark ribbons, the lit
      // half of the window) are solid AND theme-following, not one or the other.
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      // Omitted for the per-path set so each shape's own weight applies; `--icon-stroke` still
      // carries 1.75, which is exactly the primary-structure rung those icons draw at.
      strokeWidth={filled || perPath ? undefined : "var(--icon-stroke)"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ flex: "none", display: "block" }}
      {...rest}
    >
      {shapes}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];
