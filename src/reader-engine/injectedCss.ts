// injectedCss — the single funnel that compiles a ReadingStyle into ONE CSS string
// injected into book sections via renderer.setStyles(). Everything visual goes through
// here (size, fonts, leading, margins, alignment, diacritics). Structured so the theme
// token system (next task) can plug colors into the same string.

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
}

interface FontDef {
  regular: string;
  bold?: string;
  label: string;
}

export const ARABIC_FONTS: Record<ArabicFont, FontDef> = {
  amiri: { regular: "/fonts/Amiri-Regular.ttf", bold: "/fonts/Amiri-Bold.ttf", label: "Amiri" },
  notoNaskh: { regular: "/fonts/NotoNaskhArabic.ttf", label: "Noto Naskh" },
};
export const LATIN_FONTS: Record<LatinFont, FontDef> = {
  literata: { regular: "/fonts/Literata.ttf", label: "Literata" },
};

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
};
export const LATIN_DEFAULTS: ReadingStyle = {
  zoom: 1.0,
  arabicFont: "amiri",
  latinFont: "literata",
  lineHeight: 1.6,
  marginPx: 56,
  align: "justify",
  diacritics: "show",
};

export const defaultsForDir = (dir?: string): ReadingStyle =>
  dir === "rtl" ? ARABIC_DEFAULTS : LATIN_DEFAULTS;

export function buildReadingCss(style: ReadingStyle): string {
  const ar = ARABIC_FONTS[style.arabicFont];
  const lat = LATIN_FONTS[style.latinFont];

  const diacriticsRule =
    style.diacritics === "dim"
      ? ".erawy-tashkil { opacity: 0.28; }"
      : style.diacritics === "hide"
        ? ".erawy-tashkil { font-size: 0 !important; }"
        : "";

  return `
    @font-face {
      font-family: 'ErawyArabic';
      src: url('${ar.regular}') format('truetype');
      font-weight: normal;
      unicode-range: ${ARABIC_RANGE};
    }
    ${
      ar.bold
        ? `@font-face {
      font-family: 'ErawyArabic';
      src: url('${ar.bold}') format('truetype');
      font-weight: bold;
      unicode-range: ${ARABIC_RANGE};
    }`
        : ""
    }
    @font-face {
      font-family: 'ErawyLatin';
      src: url('${lat.regular}') format('truetype');
      unicode-range: ${LATIN_RANGE};
    }

    /* size via zoom (D6 — scales even absolute-CSS books, reflows columns) */
    :root { zoom: ${style.zoom}; }

    /* deterministic section box → no stray paginated scrollbar (RAWY-04); inline margins */
    html, body { height: 100%; margin: 0; overflow: hidden; box-sizing: border-box; }
    html { padding-inline: ${style.marginPx}px; }
    img, svg, video, table { max-width: 100%; max-height: 100%; }

    /* per-script fonts: Arabic glyphs use the chosen Arabic face, Latin uses Literata */
    html, body, p, li, blockquote, div, span, h1, h2, h3, h4, h5, h6, td, th, a {
      font-family: 'ErawyArabic', 'ErawyLatin', serif !important;
    }
    p, li, blockquote, div {
      line-height: ${style.lineHeight};
      text-align: ${style.align};
    }
    /* keep the book's intentional alignment for headings etc. */
    [align="center"], center { text-align: center; }
    [align="right"] { text-align: right; }

    ${diacriticsRule}
  `;
}
