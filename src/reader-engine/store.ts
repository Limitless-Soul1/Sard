// Reader store — UI dispatches intents, the controller executes, and relocate events
// flow back here. Holds the current book id, direction, progress fraction, and CFI.

import { create } from "zustand";

export type ReaderStatus = "idle" | "loading" | "ready" | "error";

interface ReaderState {
  bookId: string | null;
  dir: string;
  fraction: number;
  cfi: string | null;
  status: ReaderStatus;
  error: string;
  set: (patch: Partial<ReaderState>) => void;
}

export const useReader = create<ReaderState>((set) => ({
  bookId: null,
  dir: "?",
  fraction: 0,
  cfi: null,
  status: "idle",
  error: "",
  set: (patch) => set(patch),
}));
