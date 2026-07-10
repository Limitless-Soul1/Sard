// Photo Mode (RAWY-49, design Band I) — types + constants for the "photo card": a selected
// passage rendered as a beautiful, theme-matched, shareable image. Part 1 = single passage →
// composer → Save/Copy. The card uses the reading theme's tokens (paper + ink + accent) and the
// book's script font (Amiri for Arabic, Literata for Latin), so it adapts across all 15 themes
// and both directions with no per-theme code. Multi-passage collection + gallery come in part 2.

export type CardFormat = "square" | "portrait" | "story" | "landscape";

// EXPORT pixel size per format. The on-screen card renders at HALF these (its "natural" size)
// and rasterises at pixelRatio 2 → exactly these pixels (crisp, social-ready).
export const FORMATS: { key: CardFormat; w: number; h: number; label: string }[] = [
  { key: "square", w: 1080, h: 1080, label: "Square" },
  { key: "portrait", w: 1080, h: 1350, label: "Portrait" },
  { key: "story", w: 1080, h: 1920, label: "Story" },
  { key: "landscape", w: 1440, h: 1080, label: "Landscape" },
];
export const EXPORT_RATIO = 2; // natural size = export / 2; toBlob({ pixelRatio: 2 }) → export px

export function formatDims(key: CardFormat): { w: number; h: number } {
  const f = FORMATS.find((x) => x.key === key)!;
  return { w: f.w, h: f.h };
}

// RAWY-150: the card STYLE — the layout/ornament treatment, chosen independently of the PAPER
// (theme). Every style recolours from the selected theme's tokens (paper + ink + accent + muted),
// so any style pairs with any of the 16 themes. "minimal" is the original card (unchanged), so an
// existing card looks exactly as before; the four new styles ADD to it (the additive invariant).
export type CardStyle = "minimal" | "moonlit" | "gilded" | "manuscript" | "editorial";
export const CARD_STYLES: CardStyle[] = ["minimal", "moonlit", "gilded", "manuscript", "editorial"];

// RAWY-150: the quote text size. "auto" = fit-to-box (the original behaviour — short quotes grow,
// long quotes shrink to fit the fixed card). The five presets XS–XL are a manual override: the
// chosen size is used verbatim and, if the passage is long, the CANVAS GROWS to fit it — text is
// never trimmed (design "grow the canvas, never trim"). Fractions are of the card width.
export type TextSize = "auto" | "xs" | "s" | "m" | "l" | "xl";
export const TEXT_SIZE_STEPS: Exclude<TextSize, "auto">[] = ["xs", "s", "m", "l", "xl"];
export const TEXT_SIZE_FRACTIONS: Record<Exclude<TextSize, "auto">, number> = {
  xs: 0.04,
  s: 0.05,
  m: 0.062,
  l: 0.076,
  xl: 0.092,
};

// RAWY-154: the card now ALWAYS keeps its format's fixed aspect ratio — the quote AUTO-FITS (the
// largest font that fills the fixed card without overflow). "auto" fills it maximally; a preset
// XS–XL is a CAP (the fit never exceeds it, and still shrinks a long passage to fit). The card never
// grows out of aspect and text is never trimmed — a long passage shrinks (down to a low floor).

// The quote's own font weight. Amiri ships 400/700 (so "light" ≈ regular for it); Literata/Inter
// carry all three. Applied to the quote text; default 400 = the pre-RAWY-154 look.
export type QuoteWeight = 300 | 400 | 700;
export const QUOTE_WEIGHTS: QuoteWeight[] = [300, 400, 700];

// Line spacing (line-height) for the quote. "normal" = the pre-RAWY-154 values (Arabic 1.85 / Latin
// 1.55), so the default is a no-op; Tight/Relaxed step around it. Arabic wants more leading.
export type QuoteSpacing = "tight" | "normal" | "relaxed";
export const QUOTE_SPACINGS: QuoteSpacing[] = ["tight", "normal", "relaxed"];
export function spacingLineHeight(sp: QuoteSpacing, arabic: boolean): number {
  const set = arabic
    ? { tight: 1.5, normal: 1.85, relaxed: 2.2 }
    : { tight: 1.3, normal: 1.55, relaxed: 1.95 };
  return set[sp];
}

// Quote alignment (RTL-aware via the CSS logical `start`: right for RTL, left for LTR). "auto" =
// follow each card style's built-in alignment (zero regression); a chosen value overrides it.
export type QuoteAlign = "auto" | "start" | "center" | "justify";
export const QUOTE_ALIGN_OPTS: Exclude<QuoteAlign, "auto">[] = ["start", "center", "justify"];

// What the user can show/hide on the card (design "SHOW ON CARD"). Brand ON by default. RAWY-150
// added `time` as a second, independent switch beside `date`.
export interface CardMeta {
  date: boolean;
  time: boolean;
  title: boolean;
  chapter: boolean;
  author: boolean;
  brand: boolean;
}
export const DEFAULT_META: CardMeta = {
  date: false,
  time: false,
  title: true,
  chapter: true,
  author: true,
  brand: true,
};

// One collected passage on a multi-passage card (RAWY-60). `chapterLabel` is captured at the
// moment it was added, so a card can span chapters and still show each passage's provenance.
export interface CardPassage {
  text: string;
  chapterLabel?: string;
}

export interface CardData {
  quote: string; // the single passage (part 1) OR the joined text of `passages` (fallback/storage)
  passages?: CardPassage[]; // RAWY-60: when present with >1 entry, the card renders a collection
  dir: "rtl" | "ltr";
  bookId?: string; // for "Save in app" provenance (RAWY-52)
  cfi?: string; // the selection location (RAWY-52)
  bookTitle?: string;
  author?: string;
  chapterLabel?: string;
  date: Date;
}

// The separator drawn BETWEEN passages on a multi-passage card (RAWY-60, design Band I-IV: "elegant
// separators ✦ / dot / ۞ per theme"). A per-theme glyph so the ornament suits the paper — an ornate
// Arabic star on the deep/rich darks, a quiet dot on the cool darks, the four-pointed star elsewhere.
const SEPARATORS: Record<string, string> = {
  trueblack: "۞",
  nocturne: "۞",
  mulberry: "۞",
  espresso: "۞",
  forestnight: "۞",
  slate: "•",
  charcoal: "•",
  dusk: "•",
};
export const cardSeparator = (themeId: string): string => SEPARATORS[themeId] ?? "✦";

// The card fits the quote to the reserved area by MEASUREMENT (fit-to-box in PhotoComposer), so
// the length→scale heuristic is no longer needed (RAWY-50).

// A localized "30 June 2026" style date for the card meta line.
export function formatCardDate(d: Date, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// RAWY-150: a localized "7:42 PM" / "١٩:٤٢" style time for the card meta line (its own toggle).
export function formatCardTime(d: Date, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", {
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}
