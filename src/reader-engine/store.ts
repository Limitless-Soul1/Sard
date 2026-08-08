// Reader store — UI dispatches intents, the controller executes, relocate flows back.
// Holds book id, direction, progress (fraction/cfi), status, and the current ReadingStyle.

import { create } from "zustand";
import type { ReadingStyle } from "./injectedCss";
import type { Classified } from "../lib/errors";

export type ReaderStatus = "idle" | "loading" | "ready" | "error";

interface ReaderState {
  bookId: string | null;
  /**
   * The book's EFFECTIVE title — the reader's override if they set one, else what was extracted
   * (RESILIENCE-1 / WP-3). It used to be `ctrl.title`, the `dc:title` read straight out of the file,
   * so renaming a book in the library left the reading chrome still showing the old embedded name.
   * Written ONLY from a database row through `resolveBookMeta`. `null` means the book has no
   * usable title at all; every display site substitutes chrome, and none of them stores it.
   */
  bookTitle: string | null;
  /** The effective author, same rule as `bookTitle`. `null` = the book named nobody (WP-3). */
  bookAuthor: string | null;
  /**
   * RESILIENCE-1 / WP-5A: the script SNIFFED from the book's own text at import — never its declared
   * language, because WP-2 exists precisely because declared metadata lies. The read-aloud pre-flight
   * gates on this, so gating on the declared field would reuse the value that was already wrong.
   */
  bookScript: "arabic" | "latin" | null;
  dir: string;
  fraction: number;
  cfi: string | null;
  chapterLabel: string | null;
  chapterHref: string | null; // current TOC href (chapters-panel highlighting, RAWY-21)
  /**
   * RESILIENCE-1 / WP-4F: where the reader is, in foliate's own units. Byte-derived, so it is stable
   * under every typography control — see reader-engine/position.ts for why a synthetic page number
   * is deliberately NOT computed. `null` until the first relocate, or when the book offers nothing.
   */
  location: { current: number; total: number } | null;
  /** The source edition's real printed page, when the book ships a page-list. Never synthesised. */
  pageLabel: string | null;
  status: ReaderStatus;
  /**
   * RESILIENCE-1 / WP-1: the CLASSIFIED failure, not a raw string. It used to be `String(e)`, which
   * is how `UnknownErrorException: hashOriginal.toHex is not a function` reached a tester's screen.
   * The raw text still exists — inside `Classified.raw`, shown only behind Details.
   */
  error: Classified | null;
  style: ReadingStyle | null;
  set: (patch: Partial<ReaderState>) => void;
}

export const useReader = create<ReaderState>((set) => ({
  bookId: null,
  bookTitle: null,
  bookAuthor: null,
  bookScript: null,
  dir: "?",
  fraction: 0,
  cfi: null,
  chapterLabel: null,
  chapterHref: null,
  location: null,
  pageLabel: null,
  status: "idle",
  error: null,
  style: null,
  set: (patch) => set(patch),
}));
