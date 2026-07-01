// The photo-card BASKET (RAWY-60, Photo Mode part 2b) — a session collection of separate passages
// the user gathers one at a time (foliate renders each chapter separately, so a single drag can't
// span chapters) and later composes into ONE multi-passage card. In-memory only: a card credits one
// book, so opening a DIFFERENT book resets the basket, and leaving the reader clears it entirely
// (Reader unmount). The toolbar's "Add to card", the top-bar basket badge, the passages tray, and
// the "Create card · N" compose all read/mutate through this single store.

import { create } from "zustand";

export interface BasketPassage {
  id: string; // local id for keys / remove
  text: string;
  chapterLabel: string | null; // captured when added (so a card can span chapters)
  cfi: string | null;
}

interface BasketCtx {
  bookId: string | null;
  bookTitle: string | null;
  author: string | null;
  dir: "rtl" | "ltr";
}

interface PhotoBasketState extends BasketCtx {
  passages: BasketPassage[];
  add: (p: BasketPassage, ctx: BasketCtx) => void;
  remove: (id: string) => void;
  reorder: (from: number, to: number) => void;
  clear: () => void;
}

export const usePhotoBasket = create<PhotoBasketState>((set) => ({
  bookId: null,
  bookTitle: null,
  author: null,
  dir: "ltr",
  passages: [],

  add: (p, ctx) =>
    set((s) => {
      // A new book starts a fresh basket (one card = one book's credit).
      const base = s.bookId && s.bookId !== ctx.bookId ? [] : s.passages;
      // Ignore an exact re-add of the same spot.
      if (base.some((x) => x.text === p.text && (p.cfi ? x.cfi === p.cfi : true) && x.chapterLabel === p.chapterLabel)) {
        return { ...ctx, passages: base };
      }
      return { ...ctx, passages: [...base, p] };
    }),

  remove: (id) => set((s) => ({ passages: s.passages.filter((x) => x.id !== id) })),

  reorder: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.passages.length || to >= s.passages.length) return s;
      const next = [...s.passages];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { passages: next };
    }),

  clear: () => set({ passages: [], bookId: null, bookTitle: null, author: null }),
}));
