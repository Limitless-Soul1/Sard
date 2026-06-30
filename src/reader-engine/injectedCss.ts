// injectedCss — the single funnel that compiles a ReadingStyle into ONE CSS string
// injected into book sections via renderer.setStyles(). Everything visual goes through
// here (size, fonts, leading, margins, alignment, diacritics). Structured so the theme
// token system (next task) can plug colors into the same string.

import type { Theme } from "../theme/tokens";

export type DiacriticsMode = "show" | "dim" | "hide";
export type Align = "justify" | "start";
export type FlowMode = "scrolled" | "paged";
export type ArabicFont = "amiri" | "notoNaskh";
export type LatinFont = "literata" | "sourceSerif";

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
// Slider fraction → preferred width in vw (then clamped 460..1360px in CSS, RAWY-36). A wider
// 36→92vw span makes Narrow↔Wide clearly visible across window sizes. Narrow≈36vw, Wide≈92vw.
export const pageWidthVw = (t: number): number => 36 + Math.max(0, Math.min(1, t)) * 56;

interface FontDef {
  regular: string;
  bold?: string; // a separate static bold file (Amiri)
  variable?: boolean; // a variable font with a weight axis (Literata, Noto Naskh) → real weights
  label: string;
}

export const ARABIC_FONTS: Record<ArabicFont, FontDef> = {
  amiri: { regular: "/fonts/Amiri-Regular.ttf", bold: "/fonts/Amiri-Bold.ttf", label: "Amiri" },
  notoNaskh: { regular: "/fonts/NotoNaskhArabic.ttf", variable: true, label: "Noto Naskh" },
};
export const LATIN_FONTS: Record<LatinFont, FontDef> = {
  literata: { regular: "/fonts/Literata.ttf", variable: true, label: "Literata" },
  sourceSerif: { regular: "/fonts/SourceSerif4.ttf", variable: true, label: "Source Serif" },
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
}

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
function themeBlock(
  theme: Theme | undefined,
  flags: BookThemeFlags | undefined,
  textColor?: string | null,
): string {
  if (!theme) return "";
  const c = theme.colors;
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
             the heading still has a position the paginator can resolve, so the page renders. */
          `h1, h2 {
             visibility: hidden !important;
             font-size: 0 !important; line-height: 0 !important;
             height: 0 !important; min-height: 0 !important; max-height: 0 !important;
             margin: 0 !important; padding: 0 !important; border: 0 !important;
             overflow: hidden !important;
           }`
        : ""
    }
  `;
}

export function buildReadingCss(
  style: ReadingStyle,
  theme?: Theme,
  flags?: BookThemeFlags,
  bookDir?: string,
): string {
  // Resolve each slot to a source URL. Built-in → its bundled file; imported → its asset URL
  // (RAWY-44; falls back to the built-in default if the imported font is missing/unloaded).
  const latBuiltin = isBuiltinLatin(style.latinFont) ? LATIN_FONTS[style.latinFont] : undefined;
  const arBuiltin = isBuiltinArabic(style.arabicFont) ? ARABIC_FONTS[style.arabicFont] : undefined;
  const latSrc = latBuiltin?.regular ?? importedFontUrl(style.latinFont) ?? LATIN_FONTS.literata.regular;
  const arSrc = arBuiltin?.regular ?? importedFontUrl(style.arabicFont) ?? ARABIC_FONTS.amiri.regular;
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
      src: url('${arBuiltin.bold}') format('truetype');
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
    }
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
