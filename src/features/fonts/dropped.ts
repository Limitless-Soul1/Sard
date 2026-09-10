// WHAT A DROPPED FONT DID, waiting to be said.
//
// WHY A STORE AND NOT A PROP, which is the same reason `profiles/dropped.ts` gives: the drop event is
// owned by the Library's single window listener, and the answer has to appear whatever the reader is
// looking at — the Library, a book, an open editor. The route leaves the outcome here and an
// app-level notice picks it up.
//
// IT IS AN ANSWER, NOT A QUESTION. A font import asks the reader nothing: it either happened, it was
// already there, or the file was refused. So this carries a line to show and never a decision to
// make, which is why it is a toast and not the sheet a dropped هيئة gets.
import { create } from "zustand";

import type { TKey } from "../../i18n/locales/en";

export interface FontDropNotice {
  /** The line to show, as a translation key. */
  key: TKey;
  /** The family name, for the keys that name one. */
  name?: string;
  /** A refusal is drawn in the same toast, but it is not a success. */
  bad: boolean;
  /** Bumped per announcement, so a second drop replaces the first and restarts its own window. */
  at: number;
}

interface FontDropState {
  notice: FontDropNotice | null;
  say: (n: Omit<FontDropNotice, "at">) => void;
  clear: () => void;
}

export const useFontDrop = create<FontDropState>((set) => ({
  notice: null,
  say: (n) => set({ notice: { ...n, at: Date.now() } }),
  clear: () => set({ notice: null }),
}));
