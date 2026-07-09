// injectedCss — the single funnel that compiles a ReadingStyle into ONE CSS string
// injected into book sections via renderer.setStyles(). Everything visual goes through
// here (size, fonts, leading, margins, alignment, diacritics). Structured so the theme
// token system (next task) can plug colors into the same string.

import type { Theme } from "../theme/tokens";

export type DiacriticsMode = "show" | "dim" | "hide";
export type Align = "justify" | "start";
export type FlowMode = "scrolled" | "paged";
export type ArabicFont = "amiri" | "notoNaskh" | "arefRuqaa" | "plexArabic";
export type LatinFont = "literata" | "sourceSerif" | "inter" | "plexLatin";

export interface ReadingStyle {
  zoom: number; // size via CSS zoom (D6): 0.8 .. 2.5
  // A built-in key (ArabicFont/LatinFont) OR an IMPORTED font's family name (RAWY-44). Imported
  // fonts resolve to an asset URL via the resolver below so their @font-face reaches the iframe.
  arabicFont: string;
  latinFont: string;
  lineHeight: number;
  marginPx: number; // inline page padding
  align: Align;
  diacritics: DiacriticsMode;
  // Page width / measure (RAWY-21; RAWY-23 made it RESPONSIVE): a 0..1 "Narrow → Wide" fraction.
  // It maps to a window-relative preferred width (vw) clamped to a readable range, so the page
  // SCALES with window size instead of staying a fixed narrow column in a void. Applied to the
  // chrome sheet (a CSS var), NOT injected into the book, so it composes cleanly with zoom (D6).
  pageWidth: number;
  pageFitWindow: boolean; // "match window" — the sheet fills the desk, ignoring pageWidth
  // Typography extras (RAWY-23), all via this funnel, both scripts unless noted:
  fontWeight: number; // 400 normal · 500 medium · 700 bold (real weight — variable Latin / Amiri-Bold)
  paragraphSpacing: number; // px of extra space between paragraphs
  firstLineIndent: boolean; // classic first-line indent instead of/with spacing
  letterSpacing: number; // px tracking — LATIN ONLY (it breaks Arabic cursive joining)
  // Per-book TEXT COLOUR (RAWY-40): an explicit ink within the active theme. `null` = follow the
  // theme's own text colour. A set colour is forced through the same `:root:root` mechanism the
  // override uses (RAWY-38), so it wins over the book's own CSS. Contrast is guarded in the UI.
  textColor: string | null;
  // Reading flow (RAWY-25): "scrolled" (default — continuous vertical scroll per chapter,
  // boundary-stop) or "paged" (foliate columns/pages). Drives the renderer's flow attribute,
  // not injected CSS — but the deterministic paged section box (overflow:hidden) is paged-only.
  flowMode: FlowMode;
}

// Page-width fraction (0 = Narrow, 1 = Wide). Default ~comfortable. The CSS clamp bounds the
// actual rendered width to a readable range; "Match window" overrides to fill.
export const PAGE_WIDTH_MIN = 0;
export const PAGE_WIDTH_MAX = 1;
export const PAGE_WIDTH_DEFAULT = 0.5;
// Slider fraction → preferred page width in PX, mapped LINEARLY across the whole 0..1 range so
// the ENTIRE slider changes the width (RAWY-48 fix). The old model returned a vw value that CSS
// then `clamp(…, 1360px)`-ed, so on a wide/maximized window the width hit 1360px around t≈0.3 and
// the top ~⅔ of the slider did nothing. Now the fraction maps directly to 480..1400px; CSS only
// caps it with `min(100%)` so it never exceeds the window. "Match window" still fills the sheet.
export const PAGE_WIDTH_PX_MIN = 480;
export const PAGE_WIDTH_PX_MAX = 1400;
export const pageWidthPx = (t: number): number =>
  PAGE_WIDTH_PX_MIN + Math.max(0, Math.min(1, t)) * (PAGE_WIDTH_PX_MAX - PAGE_WIDTH_PX_MIN);

interface FontDef {
  regular: string;
  bold?: string; // a separate static bold file (Amiri)
  variable?: boolean; // a variable font with a weight axis (Literata, Noto Naskh) → real weights
  label: string;
}

// RAWY-92: every bundled face eligible for its SCRIPT is book-selectable here (the book pickers —
// GlobalSettings defaults + the in-reader per-book picker — both iterate these registries, and the
// @font-face injected into the foliate iframe resolves its src from `regular`/`bold`). Arabic faces
// and Latin faces are kept separate because the book injects per-script via unicode-range, so a face
// only appears in the picker for the script it actually covers.
export const ARABIC_FONTS: Record<ArabicFont, FontDef> = {
  amiri: { regular: "/fonts/Amiri-Regular.ttf", bold: "/fonts/Amiri-Bold.ttf", label: "Amiri" },
  notoNaskh: { regular: "/fonts/NotoNaskhArabic.ttf", variable: true, label: "Noto Naskh" },
  arefRuqaa: { regular: "/fonts/ArefRuqaa-Regular.ttf", bold: "/fonts/ArefRuqaa-Bold.ttf", label: "Aref Ruqaa" },
  plexArabic: { regular: "/fonts/IBMPlexSansArabic-Regular.ttf", bold: "/fonts/IBMPlexSansArabic-SemiBold.ttf", label: "IBM Plex Sans Arabic" },
};
export const LATIN_FONTS: Record<LatinFont, FontDef> = {
  literata: { regular: "/fonts/Literata.ttf", variable: true, label: "Literata" },
  sourceSerif: { regular: "/fonts/SourceSerif4.ttf", variable: true, label: "Source Serif" },
  inter: { regular: "/fonts/Inter.ttf", variable: true, label: "Inter" },
  plexLatin: { regular: "/fonts/IBMPlexSans-Regular.ttf", bold: "/fonts/IBMPlexSans-Bold.ttf", label: "IBM Plex Sans" },
};

// RAWY-44: an IMPORTED book font's @font-face must be declared INSIDE the foliate content iframe
// (the app-document @font-face registered by lib/fonts.ts does NOT reach the iframe). injectedCss
// stays pure: lib/fonts.ts (which holds the custom_fonts list) wires this resolver, mapping an
// imported family name → its asset-protocol URL (accessible from the iframe too). null = unknown.
let importedFontUrl: (family: string) => string | null = () => null;
export function setImportedFontUrlResolver(fn: (family: string) => string | null): void {
  importedFontUrl = fn;
}
const isBuiltinLatin = (k: string): k is LatinFont => k in LATIN_FONTS;
const isBuiltinArabic = (k: string): k is ArabicFont => k in ARABIC_FONTS;

// RAWY-135: the book @font-face is injected into the foliate content iframe, which is a `blob:`
// document. A built-in font's absolute-PATH url ("/fonts/Amiri-Regular.ttf") CANNOT be resolved
// against a blob base — it fails to parse, the face loads with status "error", and every book falls
// back to the same system serif, so picking Amiri vs Noto Naskh vs Aref Ruqaa vs IBM Plex looked
// identical. Absolutise the bundled-font paths against the app origin (http://tauri.localhost) so the
// url() resolves from inside the iframe. Imported fonts already carry an absolute asset-protocol URL
// (RAWY-44), which doesn't start with "/", so they're left untouched.
const absFontUrl = (u: string): string =>
  u.startsWith("/") && typeof location !== "undefined" ? `${location.origin}${u}` : u;

// Bold works on Amiri (real Amiri-Bold) + the variable faces; Amiri has only 400/700 so 500
// snaps to the nearest. We never synth-bold Arabic by choice (faux-bold harms shaping).
export const FONT_WEIGHTS = [400, 500, 700] as const;

// Per-script Unicode ranges so the right face renders the right script (font fallback).
const ARABIC_RANGE =
  "U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F";
const LATIN_RANGE = "U+0000-024F, U+2000-206F, U+2070-209F, U+20A0-20BF";

// Per-script sensible defaults — beautiful before the user touches a control.
export const ARABIC_DEFAULTS: ReadingStyle = {
  zoom: 1.15,
  arabicFont: "amiri",
  latinFont: "literata",
  lineHeight: 1.9,
  marginPx: 56,
  align: "start",
  diacritics: "show",
  pageWidth: PAGE_WIDTH_DEFAULT,
  pageFitWindow: false,
  fontWeight: 400,
  paragraphSpacing: 0,
  firstLineIndent: false,
  letterSpacing: 0,
  textColor: null,
  flowMode: "scrolled",
};
export const LATIN_DEFAULTS: ReadingStyle = {
  zoom: 1.0,
  arabicFont: "amiri",
  latinFont: "literata",
  lineHeight: 1.6,
  marginPx: 56,
  align: "justify",
  diacritics: "show",
  pageWidth: PAGE_WIDTH_DEFAULT,
  pageFitWindow: false,
  fontWeight: 400,
  paragraphSpacing: 0,
  firstLineIndent: false,
  letterSpacing: 0,
  textColor: null,
  flowMode: "scrolled",
};

export const defaultsForDir = (dir?: string): ReadingStyle =>
  dir === "rtl" ? ARABIC_DEFAULTS : LATIN_DEFAULTS;

export interface BookThemeFlags {
  overrideBookColor: boolean;
  hideChapterTitles: boolean;
  // RAWY-69: independent from hideChapterTitles — hides the section's detected leading "first
  // line" (FoliateController's `.sard-chapter-heading`, RAWY-68) without touching the semantic
  // heading. A book can have EITHER a title, a repeated first line, both, or neither hidden.
  hideFirstLine: boolean;
}

// RAWY-70: the localized strings for the hide-first-line placeholder + two-step reveal. They ride
// into the content frame as CSS `content` custom properties (the placeholder DOM FoliateController
// injects is purely structural — text lives in CSS), so a UI-language change is a plain re-inject,
// no DOM text to keep in sync. Defaults are English so a missing config never renders blank.
export interface RevealLabels {
  hidden: string; // "Title hidden" — the idle placeholder
  confirm: string; // "Reveal the title?" — the confirm question (step 2)
  reveal: string; // "Reveal" — confirm-yes
  cancel: string; // "Cancel" — confirm-no
  // RAWY-71: the UI-LANGUAGE direction (not the book's). The placeholder is a localized widget whose
  // text is entirely CSS `content` (pseudo-elements) — `dir="auto"` on the element sees NO real text
  // nodes and so resolves LTR always, which laid the confirm row (question · Reveal · Cancel) out
  // element-reversed in an Arabic UI. Setting `direction` explicitly from the UI language fixes the
  // logical order in both directions (and rides the same re-inject as the labels on a language change).
  dir: "rtl" | "ltr";
}
const DEFAULT_REVEAL_LABELS: RevealLabels = {
  hidden: "Title hidden",
  confirm: "Reveal the title?",
  reveal: "Reveal",
  cancel: "Cancel",
  dir: "ltr",
};

// A CSS string literal from an arbitrary label — escape the two chars that could break out of a
// double-quoted `content` value. Arabic/English labels never contain these, but never trust input.
const cssString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Theme colours + flags compile into the SAME injected string as typography (RAWY-13).
// The page background always follows the theme; text colour is forced when override is on OR
// the theme is dark (a light-inked book on a dark page must be re-inked).
//
// SPECIFICITY (RAWY-37 — the real fix): self-published EPUBs routinely hard-code their OWN
// colours with `!important` on CLASS selectors — e.g. this repo's test book bakes in a dark
// mode: `.bixbox{background:#1a1a1a!important} .epcontent{color:#e8e8e8!important} article{…}`.
// A class selector (0,1,0) out-specifies an element selector (0,0,1) EVEN when ours has
// !important, and our injected <style> is only *appended* (source order can't break a
// specificity tie the book wins). RAWY-36's element-level rules therefore lost on these books
// → override looked weak and Day/Night never repainted the page (the book's container bg won).
// Fix: anchor the forced rules on `:root:root` (two structural pseudo-classes → specificity
// (0,2,0), NO IDs) so they beat class-level !important, plus ONE never-matching ID guard
// `:not(#<NEVER>)` (RAWY-38) that adds an ID-column of specificity (→ (1,2,x)) WITHOUT changing
// what matches — so the rules also beat a book's own ID-selector !important (specificity 1,0,0),
// e.g. `#wrap{background:#0a0a0a!important}`. Container backgrounds are neutralised so the themed
// paper shows. HONEST LIMITS (can't be beaten from a stylesheet): an inline `style="…!important"`
// on the element, or a multi-ID chain like `#a #b{…!important}` (specificity ≥ 2,0,0) — both are
// essentially unseen in real EPUBs. See §9.
// Shared by both hide-title/hide-first-line rules (RAWY-69 split them into two independent
// selectors): `visibility:hidden` + a collapsed box, never `display:none` — see the RAWY-22 note
// where a fully-removed heading (no layout box) broke CFI navigation to a chapter whose TOC anchor
// pointed at it.
const HIDE_BOX_RULE = (selector: string): string => `
  ${selector} {
    visibility: hidden !important;
    font-size: 0 !important; line-height: 0 !important;
    height: 0 !important; min-height: 0 !important; max-height: 0 !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important;
    overflow: hidden !important;
  }`;

function themeBlock(
  theme: Theme | undefined,
  flags: BookThemeFlags | undefined,
  textColor?: string | null,
): string {
  if (!theme) return "";
  const c = theme.colors;
  // A never-matching id guard — raises specificity into the ID column so placeholder colours beat
  // the forceInk re-ink rule below (which paints every `body *` to the theme ink !important) and
  // the container-background neutraliser. Same technique/name as the RAWY-38 forced rules.
  const G = ":root:root .sard-title-ph:not(#__sard_never__)";
  // The ink: a per-book TEXT COLOUR (RAWY-40) wins over the theme's own text colour when set.
  const ink = textColor || c.text;
  // Background + container neutralisation are forced when override is on OR the theme is dark
  // (a light-inked book on a dark page must be re-inked). The INK is also forced whenever a
  // custom text colour is set — an explicit per-book choice that must win over the book's CSS.
  const forceBg = (flags?.overrideBookColor ?? false) || theme.dark;
  const forceInk = forceBg || !!textColor;
  // A never-matching id (no element is `id="__sard_never__"`) used purely to raise specificity.
  const ID = ":not(#__sard_never__)";
  const inkRules = `:root:root body${ID}, :root:root body${ID} *:not(a) { color: ${ink} !important; }
           :root:root body${ID} a, :root:root body${ID} a * { color: ${c.accent} !important; }`;
  return `
    html, body { background: ${c.paperBg} !important; }
    ::selection { background: ${c.selection}; }
    ${
      forceBg
        ? `:root:root, :root:root body${ID} { background-color: ${c.paperBg} !important; }
           /* neutralise the book's own container backgrounds so the themed paper shows through */
           :root:root body${ID} * { background-color: transparent !important; }
           /* re-ink every text element (incl. <body> itself) to the theme; links take the accent */
           ${inkRules}`
        : forceInk
          ? /* a custom ink with no bg-override: force just the ink (RAWY-40) */ inkRules
          : `html, body { color: ${ink}; }`
    }
    ${
      flags?.hideChapterTitles
        ? /* Hide the chapter-title TEXT, but keep the heading element in normal flow with a
             valid (zero-size) box. `display:none` removed it from layout entirely, and since
             TOC entries anchor to the heading id, navigating to a chapter whose heading was
             display:none landed on a geometry-less element → a blank page (RAWY-22 bug). Here
             the heading still has a position the paginator can resolve, so the page renders.
             h1-h6 (RAWY-67 — was only h1/h2; some books use a lower heading level for the
             chapter title) — the book's OWN semantic heading element. `.sard-chapter-heading`
             is deliberately NOT included here (RAWY-69 split it into its own independent toggle
             below) — a heading-tag element never gets that class in the first place (see
             `markInBodyHeading`), so the two rules can never fight over the same element. */
          HIDE_BOX_RULE("h1, h2, h3, h4, h5, h6")
        : ""
    }
    ${
      flags?.hideFirstLine
        ? /* RAWY-69: independent from hideChapterTitles above — hides ONLY the section's
             detected leading "first line" (`.sard-chapter-heading`, a class FoliateController
             adds — RAWY-68 — to a section's leading non-heading block ONLY when it provably
             echoes that section's own TOC number; never a semantic heading, see above). A
             converted/scraped EPUB that repeats its title as a plain first line of body text
             (not a real heading) is exactly what this catches — the RAWY-67 problem this toggle
             was originally introduced for, now controllable separately from the heading itself.
             RAWY-70: instead of a blank removal, the line is replaced by a quiet placeholder
             (the `.sard-title-ph` element FoliateController injects right before each detected
             line) offering a TWO-STEP reveal — tap → "Reveal the title?" → confirm — so an
             accidental tap can never instantly spoil. A revealed instance carries
             `.sard-revealed`, so it is excluded from the hide here (per-instance; a fresh section
             loads a fresh idle placeholder). */
          `${HIDE_BOX_RULE(".sard-chapter-heading:not(.sard-revealed)")}
           /* the placeholder takes the hidden line's place — quiet, in the book's theme */
           .sard-title-ph {
             display: inline-flex; align-items: baseline; gap: .4em; flex-wrap: wrap;
             margin: .15em 0 .75em; font-size: .82em; line-height: 1.6;
             font-family: 'SardArabic', 'SardLatin', serif;
             user-select: none; -webkit-user-select: none;
           }
           .sard-title-ph[data-sard-state="revealed"] { display: none; }
           .sard-title-ph .sard-ph-confirm { display: none; }
           .sard-title-ph[data-sard-state="confirm"] .sard-ph-main { display: none; }
           .sard-title-ph[data-sard-state="confirm"] .sard-ph-confirm { display: inline-flex; align-items: baseline; gap: .5em; flex-wrap: wrap; }
           /* the clickable bits — reset UA button chrome, keep them looking like quiet links */
           .sard-title-ph .sard-ph-main, .sard-title-ph .sard-ph-yes, .sard-title-ph .sard-ph-no {
             background: none; border: 0; padding: 0; margin: 0; font: inherit; cursor: pointer;
             text-decoration: underline; text-underline-offset: 3px;
           }
           /* text comes from the localized CSS vars (defined once in :root, RAWY-70) */
           .sard-title-ph .sard-ph-main::before { content: var(--sard-ph-hidden); }
           .sard-title-ph .sard-ph-q::before { content: var(--sard-ph-confirm); }
           .sard-title-ph .sard-ph-yes::before { content: var(--sard-ph-reveal); }
           .sard-title-ph .sard-ph-no::before { content: var(--sard-ph-cancel); }
           /* colours — the G-guarded selectors beat the forceInk re-ink + bg-neutralise rules above */
           ${G}, ${G} .sard-ph-main, ${G} .sard-ph-q, ${G} .sard-ph-no { color: ${c.muted} !important; }
           ${G} .sard-ph-yes { color: ${c.accent} !important; }`
        : ""
    }
  `;
}

export function buildReadingCss(
  style: ReadingStyle,
  theme?: Theme,
  flags?: BookThemeFlags,
  bookDir?: string,
  revealLabels?: RevealLabels,
): string {
  const rl = revealLabels ?? DEFAULT_REVEAL_LABELS;
  // RAWY-134 (B): the reading iframe's scrollbar thumb tracks the theme INK (a per-book text colour
  // wins, then the theme's own) so it stays visible on dark paper — `currentColor` on the iframe's
  // <html> is the default black under a forced-background theme, which would vanish on a dark page.
  const scrollInk = style.textColor || theme?.colors?.text || "currentColor";
  // Resolve each slot to a source URL. Built-in → its bundled file; imported → its asset URL
  // (RAWY-44; falls back to the built-in default if the imported font is missing/unloaded).
  const latBuiltin = isBuiltinLatin(style.latinFont) ? LATIN_FONTS[style.latinFont] : undefined;
  const arBuiltin = isBuiltinArabic(style.arabicFont) ? ARABIC_FONTS[style.arabicFont] : undefined;
  const latSrc = absFontUrl(latBuiltin?.regular ?? importedFontUrl(style.latinFont) ?? LATIN_FONTS.literata.regular);
  const arSrc = absFontUrl(arBuiltin?.regular ?? importedFontUrl(style.arabicFont) ?? ARABIC_FONTS.amiri.regular);
  const latImported = !latBuiltin;
  const arImported = !arBuiltin;

  const diacriticsRule =
    style.diacritics === "dim"
      ? ".sard-tashkil { opacity: 0.28; }"
      : style.diacritics === "hide"
        ? ".sard-tashkil { font-size: 0 !important; }"
        : "";

  // Per-script @font-face injected INTO the foliate content. Variable built-ins (Literata, Noto
  // Naskh) declare a weight RANGE so the weight control drives the real axis; Amiri ships two
  // static files (regular + a real Bold). IMPORTED fonts (RAWY-44) omit the format() hint (so any
  // ttf/otf/woff loads) and the weight descriptor (→ normal; bolder weights synth-bold), and carry
  // the same unicode-range as their slot so script routing still works (an imported Arabic font in
  // the Arabic slot renders Arabic).
  const fontFaces = `
    @font-face {
      font-family: 'SardArabic';
      src: url('${arSrc}')${arImported ? "" : " format('truetype')"};
      ${arImported ? "" : `font-weight: ${arBuiltin!.variable ? "100 900" : "normal"};`}
      unicode-range: ${ARABIC_RANGE};
    }
    ${
      arBuiltin?.bold && !arBuiltin.variable
        ? `@font-face {
      font-family: 'SardArabic';
      src: url('${absFontUrl(arBuiltin.bold)}') format('truetype');
      font-weight: bold;
      unicode-range: ${ARABIC_RANGE};
    }`
        : ""
    }
    @font-face {
      font-family: 'SardLatin';
      src: url('${latSrc}')${latImported ? "" : " format('truetype')"};
      ${latImported ? "" : `font-weight: ${latBuiltin!.variable ? "200 700" : "normal"};`}
      unicode-range: ${LATIN_RANGE};
    }`;

  // Typography extras (RAWY-23). Weight applies to body text (not headings → keep hierarchy).
  // Letter-spacing is LATIN-ONLY — it inserts gaps that break Arabic cursive joining.
  const latinText = bookDir !== "rtl";
  const extras = `
    p, li, blockquote, div, td, th, dd, dt {
      font-weight: ${style.fontWeight};
    }
    ${/* Paragraph spacing. RAWY-37: !important + `:root:root` so it beats the book's own class
          margins (e.g. `.calibre4{margin:1em 0}`). RAWY-38 hardening: (a) a never-matching id guard
          `:not(#__sard_never__)` raises specificity into the ID column so it also beats `#x{margin}`;
          (b) ALSO target <div> paragraphs — some EPUBs use <div> not <p> for paragraphs — but ONLY
          a "leaf" text div (`:not(:has(<block>))`), so layout/container divs (which wrap headings,
          paragraphs, lists, figures…) are spared and the page isn't stretched apart. `:has()` is
          supported in the bundled evergreen WebView2 (Chromium). */ ""}
    ${
      style.paragraphSpacing > 0
        ? `:root:root p:not(#__sard_never__),
           :root:root body div:not(#__sard_never__):not(:has(p, div, ul, ol, table, section, article, aside, figure, blockquote, h1, h2, h3, h4, h5, h6, hr))
           { margin-block: ${style.paragraphSpacing}px !important; }`
        : ""
    }
    ${style.firstLineIndent ? `p { text-indent: 1.5em; }` : ""}
    ${
      latinText && style.letterSpacing > 0
        ? `p, li, blockquote, div, td, th { letter-spacing: ${style.letterSpacing}px; }`
        : ""
    }`;

  return `
    ${fontFaces}

    /* size via zoom (D6 — scales even absolute-CSS books). Zoom the column CONTENT (body),
       NOT the column container (:root/html, where foliate sets column-width): that way the
       scaled text reflows WITHIN foliate's fixed-width columns instead of overflowing them
       and clipping line-ends (worse at higher zoom / narrower measures). */
    body { zoom: ${style.zoom}; }

    /* deterministic section box → no stray paginated scrollbar (RAWY-04). PAGED-ONLY
       (RAWY-25): in scrolled mode foliate makes the section full-height and the container
       scrolls, so forcing height:100%/overflow:hidden here would clip the scroll. */
    html, body { margin: 0; box-sizing: border-box; }
    /* RAWY-134 (B): thin, on-brand scrollbar for the reading iframe's OWN scroll (a wide table/pre can
       overflow horizontally), matched to the app-shell bars (global.css). The app's inherited
       scrollbar-color doesn't cross the frame boundary, so set it here from the reading ink (scrollInk)
       so it tracks the theme/paper. Still a real, draggable scrollbar — only restyled. */
    html, body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, ${scrollInk} 30%, transparent) transparent; }
    ${style.flowMode === "paged" ? "html, body { height: 100%; overflow: hidden; }" : ""}
    /* MARGINS are applied on the CHROME side (RAWY-36): foliate's paginator sets html padding
       inline with !important in BOTH scrolled + paged modes, which overrode an injected
       html padding-inline here (inline styles always beat a stylesheet rule). So the page
       margin now insets the foliate host within the sheet (--page-margin -> .page-host), which
       foliate cannot override and which works identically in both flow modes. */
    /* a corrected reading direction (RAWY-19 override) flows + aligns the text accordingly */
    ${bookDir ? `html, body { direction: ${bookDir}; }` : ""}
    /* highlight ink (RAWY-22): a clearly-visible "wick" — multiply blend on light paper,
       screen on dark. Opacity = the theme's own highlightAlpha when set (RAWY-29 themes.json:
       light = 1, dark ≈ 0.32–0.36), else the original RAWY-22 intensities (0.62 / 0.5) so the
       first 4 themes are unchanged. */
    :root {
      --overlayer-highlight-opacity: ${theme?.highlightAlpha ?? (theme?.dark ? 0.5 : 0.62)};
      --overlayer-highlight-blend: ${theme?.dark ? "screen" : "multiply"};
      /* RAWY-70: localized text for the hide-first-line placeholder + reveal (CSS-var driven, so a
         UI-language change is a re-inject, not a DOM edit). Definitions live here; the placeholder
         is only ever VISIBLE when hideFirstLine is on (themeBlock), so these are inert otherwise. */
      --sard-ph-hidden: ${cssString(rl.hidden)};
      --sard-ph-confirm: ${cssString(rl.confirm)};
      --sard-ph-reveal: ${cssString(rl.reveal)};
      --sard-ph-cancel: ${cssString(rl.cancel)};
    }
    /* RAWY-70: the injected placeholder is display:none by default (FoliateController injects it
       into every section with a detected first line, regardless of the toggle — matching how the
       sard-chapter-heading class is always tagged and CSS gates the effect). themeBlock reveals
       it only when hideFirstLine is on. So with the toggle OFF there is no placeholder at all and
       the real first line renders normally.
       RAWY-71: force the placeholder's direction to the UI language (its labels' language) and
       bidi-isolate it — a self-contained localized widget. A dir=auto attribute failed here because
       the text is all CSS pseudo-content (no real text nodes to infer direction from), so the confirm
       row (question · Reveal · Cancel) came out element-reversed in Arabic. Explicit direction lays
       it out in correct logical order, mirrored, in both LTR and RTL. */
    .sard-title-ph { display: none; direction: ${rl.dir}; unicode-bidi: isolate; }
    img, svg, video, table { max-width: 100%; max-height: 100%; }

    /* per-script fonts: Arabic glyphs use the chosen Arabic face, Latin uses Literata */
    html, body, p, li, blockquote, div, span, h1, h2, h3, h4, h5, h6, td, th, a {
      font-family: 'SardArabic', 'SardLatin', serif !important;
    }
    p, li, blockquote, div {
      line-height: ${style.lineHeight};
      text-align: ${style.align};
    }
    /* keep the book's intentional alignment for headings etc. */
    [align="center"], center { text-align: center; }
    [align="right"] { text-align: right; }

    ${extras}
    ${diacriticsRule}
    ${themeBlock(theme, flags, style.textColor)}
  `;
}
