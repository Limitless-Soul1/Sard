// Per-book bookmarks store (RAWY-41) — holds the current book's bookmarks and adds/removes one at the
// current spot. RAWY-229 (corrected): a bookmark belongs to its CHAPTER — the Reader shows/toggles it by
// SECTION identity (FoliateController.bookmarkVisible), NOT the whole-book fraction window that lit the
// marker in every chapter of a long book. The stored `fraction` is untouched (the cross-book shelf's %-read).

import { create } from "zustand";

import { bookmarkCreate, bookmarkDelete, bookmarksForBook, type BookmarkRow } from "../../lib/ipc";

interface BookmarksState {
  bookId: string | null;
  bookmarks: BookmarkRow[];
  load: (bookId: string) => Promise<void>;
  /** Add a bookmark at a location (CFI + chapter + whole-book fraction — the fraction is still stored for
   *  the cross-book Bookmarks shelf's %-read, D51). Create-only: the Reader decides add-vs-remove from the
   *  VISIBLE bookmark, so a click only reaches here when nothing is bookmarked at the current spot. */
  add: (
    cfi: string,
    chapterLabel: string | null,
    fraction: number,
    /** The opening words of the block the place sits in — what the shelf shows instead of a figure. */
    words?: string | null,
    /** The dye it is marked in, so the ribbons on a cover show a palette and not one repeated swatch. */
    color?: string | null,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useBookmarks = create<BookmarksState>((set, get) => ({
  bookId: null,
  bookmarks: [],
  load: async (bookId) => {
    set({ bookId, bookmarks: [] });
    const rows = await bookmarksForBook(bookId).catch(() => [] as BookmarkRow[]);
    if (get().bookId === bookId) set({ bookmarks: rows });
  },
  add: async (cfi, chapterLabel, fraction, words, color) => {
    const bookId = get().bookId;
    if (!bookId) return;
    // Either may be absent: a place whose words could not be read stores none rather than a guess,
    // and the shelf falls back to its chapter. The Rust upsert COALESCEs, so re-marking a place
    // never blanks what an earlier marking captured.
    const row = await bookmarkCreate({
      bookId, cfi, chapterLabel, fraction, label: words ?? null, color: color ?? null,
    }).catch(() => null);
    if (row && get().bookId === bookId) {
      set({ bookmarks: [...get().bookmarks.filter((b) => b.id !== row.id), row].sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0)) });
    }
  },
  remove: async (id) => {
    // Apply-on-success: drop it locally only when the DB delete resolves; on failure keep it so the list
    // stays consistent with the surviving row (no phantom-gone bookmark, no duplicate on retry).
    try {
      await bookmarkDelete(id);
      set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) });
    } catch (e) {
      console.error(e);
    }
  },
}));
