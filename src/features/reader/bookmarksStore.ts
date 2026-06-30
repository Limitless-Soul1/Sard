// Per-book bookmarks store (RAWY-41) — mirrors the annotations store: holds the current book's
// bookmarks, toggles one at the current CFI/fraction, and tells the marker whether a bookmark sits
// within the visible viewport (so it shows ONLY where placed, not always-on).

import { create } from "zustand";

import { bookmarkCreate, bookmarkDelete, bookmarksForBook, type BookmarkRow } from "../../lib/ipc";

// A bookmark is "at the visible location" when its fraction is within this window of the current
// reading fraction (≈ a few pages). Used for the on-page marker + the toggle's already-bookmarked
// test. CFI-anchored data; fraction only decides VISIBILITY of the marker.
export const MARKER_WINDOW = 0.01;

interface BookmarksState {
  bookId: string | null;
  bookmarks: BookmarkRow[];
  load: (bookId: string) => Promise<void>;
  /** Toggle a bookmark at the current location: remove the nearby one if present, else add. */
  toggle: (cfi: string, chapterLabel: string | null, fraction: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** The bookmark within MARKER_WINDOW of `fraction` (closest), or null. */
  nearest: (fraction: number) => BookmarkRow | null;
}

export const useBookmarks = create<BookmarksState>((set, get) => ({
  bookId: null,
  bookmarks: [],
  load: async (bookId) => {
    set({ bookId, bookmarks: [] });
    const rows = await bookmarksForBook(bookId).catch(() => [] as BookmarkRow[]);
    if (get().bookId === bookId) set({ bookmarks: rows });
  },
  toggle: async (cfi, chapterLabel, fraction) => {
    const bookId = get().bookId;
    if (!bookId) return;
    const existing = get().nearest(fraction);
    if (existing) {
      await bookmarkDelete(existing.id).catch(console.error);
      set({ bookmarks: get().bookmarks.filter((b) => b.id !== existing.id) });
      return;
    }
    const row = await bookmarkCreate({ bookId, cfi, chapterLabel, fraction }).catch(() => null);
    if (row && get().bookId === bookId) {
      set({ bookmarks: [...get().bookmarks.filter((b) => b.id !== row.id), row].sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0)) });
    }
  },
  remove: async (id) => {
    await bookmarkDelete(id).catch(console.error);
    set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) });
  },
  nearest: (fraction) => {
    let best: BookmarkRow | null = null;
    let bestD = MARKER_WINDOW;
    for (const b of get().bookmarks) {
      if (b.fraction == null) continue;
      const d = Math.abs(b.fraction - fraction);
      if (d <= bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  },
}));
