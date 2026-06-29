// injectedCss — the single funnel that compiles a ReadingStyle into ONE CSS string
// injected into book sections via renderer.setStyles(). Everything visual goes through
// here (size, fonts, leading, margins, alignment, diacritics). Structured so the theme
// token system (next task) can plug colors into the same string.

import type { Theme } from "../theme/tokens";

export type DiacriticsMode = "show" | "dim" | "hide";
export type Align = "justify" | "start";
export type ArabicFont = "amiri" | "notoNaskh";
export type LatinFont = "literata";

export interface ReadingStyle {
  zoom: number; // size via CSS zoom (D6): 0.8 .. 2.5
  arabicFont: ArabicFont;
  latinFont: LatinFont;
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
}

// Page-width fraction (0 = Narrow, 1 = Wide). Default ~comfortable. The CSS clamp bounds the
// actual rendered width to a readable range; "Match window" overrides to fill.
export const PAGE_WIDTH_MIN = 0;
export const PAGE_WIDTH_MAX = 1;
export const PAGE_WIDTH_DEFAULT = 0.5;
// Slider fraction → preferred width in vw (then clamped 540..1280px in CSS). Narrow≈42vw, Wide≈88vw.
export const pageWidthVw = (t: number): number => 42 + Math.max(0, Math.min(1, t)) * 46;

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
};

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
};

export const defaultsForDir = (dir?: string): ReadingStyle =>
  dir === "rtl" ? ARABIC_DEFAULTS : LATIN_DEFAULTS;

export interface BookThemeFlags {
  overrideBookColor: boolean;
  hideChapterTitles: boolean;
}

// Theme colours + flags compile into the SAME injected string as typography (RAWY-13).
// The page background always follows the theme; text colour is forced (!important) when
// override is on OR the theme is dark (a light book on a dark page must be re-inked).
function themeBlock(theme: Theme | undefined, flags: BookThemeFlags | undefined): string {
  if (!theme) return "";
  const c = theme.colors;
  const forceText = (flags?.overrideBookColor ?? false) || theme.dark;
  return `
    html, body { background: ${c.paperBg} !important; }
    ::selection { background: ${c.selection}; }
    ${
      forceText
        ? `html, body, p, li, blockquote, div, span, h1, h2, h3, h4, h5, h6, td, th, dd, dt {
             color: ${c.text} !important;
           }
           a, a:link, a:visited { color: ${c.accent} !important; }`
        : `html, body { color: ${c.text}; }`
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
  const ar = ARABIC_FONTS[style.arabicFont];
  const lat = LATIN_FONTS[style.latinFont];

  const diacriticsRule =
    style.diacritics === "dim"
      ? ".sard-tashkil { opacity: 0.28; }"
      : style.diacritics === "hide"
        ? ".sard-tashkil { font-size: 0 !important; }"
        : "";

  // Per-script @font-face. Variable fonts (Literata, Noto Naskh) declare a weight RANGE so the
  // weight control drives the real axis; Amiri ships two static files (regular + a real Bold).
  const fontFaces = `
    @font-face {
      font-family: 'SardArabic';
      src: url('${ar.regular}') format('truetype');
      font-weight: ${ar.variable ? "100 900" : "normal"};
      unicode-range: ${ARABIC_RANGE};
    }
    ${
      ar.bold && !ar.variable
        ? `@font-face {
      font-family: 'SardArabic';
      src: url('${ar.bold}') format('truetype');
      font-weight: bold;
      unicode-range: ${ARABIC_RANGE};
    }`
        : ""
    }
    @font-face {
      font-family: 'SardLatin';
      src: url('${lat.regular}') format('truetype');
      font-weight: ${lat.variable ? "200 700" : "normal"};
      unicode-range: ${LATIN_RANGE};
    }`;

  // Typography extras (RAWY-23). Weight applies to body text (not headings → keep hierarchy).
  // Letter-spacing is LATIN-ONLY — it inserts gaps that break Arabic cursive joining.
  const latinText = bookDir !== "rtl";
  const extras = `
    p, li, blockquote, div, td, th, dd, dt {
      font-weight: ${style.fontWeight};
    }
    ${style.paragraphSpacing > 0 ? `p { margin-block: ${style.paragraphSpacing}px; }` : ""}
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

    /* deterministic section box → no stray paginated scrollbar (RAWY-04); inline margins */
    html, body { height: 100%; margin: 0; overflow: hidden; box-sizing: border-box; }
    html { padding-inline: ${style.marginPx}px; }
    /* a corrected reading direction (RAWY-19 override) flows + aligns the text accordingly */
    ${bookDir ? `html, body { direction: ${bookDir}; }` : ""}
    /* highlight ink (RAWY-22): a clearly-visible "wick" — multiply blend on light paper,
       screen on dark, at a per-theme opacity (was a washed-out flat 0.3). */
    :root {
      --overlayer-highlight-opacity: ${theme?.dark ? "0.5" : "0.62"};
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
    ${themeBlock(theme, flags)}
  `;
}
