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

// What the user can show/hide on the card (design "SHOW ON CARD"). Brand ON by default.
export interface CardMeta {
  date: boolean;
  title: boolean;
  chapter: boolean;
  author: boolean;
  brand: boolean;
}
export const DEFAULT_META: CardMeta = {
  date: false,
  title: true,
  chapter: true,
  author: true,
  brand: true,
};

export interface CardData {
  quote: string;
  dir: "rtl" | "ltr";
  bookId?: string; // for "Save in app" provenance (RAWY-52)
  cfi?: string; // the selection location (RAWY-52)
  bookTitle?: string;
  author?: string;
  chapterLabel?: string;
  date: Date;
}

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
