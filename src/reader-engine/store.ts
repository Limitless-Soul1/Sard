// Reader store — UI dispatches intents, the controller executes, relocate flows back.
// Holds book id, direction, progress (fraction/cfi), status, and the current ReadingStyle.

import { create } from "zustand";
import type { ReadingStyle } from "./injectedCss";

export type ReaderStatus = "idle" | "loading" | "ready" | "error";

interface ReaderState {
  bookId: string | null;
  bookTitle: string | null; // EPUB metadata title (reading-chrome nav block, RAWY-33)
  dir: string;
  fraction: number;
  cfi: string | null;
  chapterLabel: string | null;
  chapterHref: string | null; // current TOC href (chapters-panel highlighting, RAWY-21)
  status: ReaderStatus;
  error: string;
  style: ReadingStyle | null;
  set: (patch: Partial<ReaderState>) => void;
}

export const useReader = create<ReaderState>((set) => ({
  bookId: null,
  bookTitle: null,
  dir: "?",
  fraction: 0,
  cfi: null,
  chapterLabel: null,
  chapterHref: null,
  status: "idle",
  error: "",
  style: null,
  set: (patch) => set(patch),
}));
