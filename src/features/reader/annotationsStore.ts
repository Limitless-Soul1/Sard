// Shared annotations store (RAWY-21). One source of truth for the current book's
// highlights + notes, used by BOTH the in-context layer (AnnotationLayer — select →
// highlight / note) and the side list panel (AnnotationsPanel — list / jump / edit).
// Every mutation goes through here so the two stay in sync: it calls the RAWY-20 IPC,
// keeps the foliate overlay in step via the controller, and updates the arrays.

import { create } from "zustand";

import type { FoliateController } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import {
  highlightCreate,
  highlightDelete,
  highlightSetColor,
  highlightsForBook,
  noteCreate,
  noteDelete,
  noteUpdate,
  notesForBook,
  type HighlightColor,
  type HighlightRow,
  type NoteRow,
} from "../../lib/ipc";

const upsert = <T extends { id: string }>(arr: T[], row: T): T[] => {
  const i = arr.findIndex((x) => x.id === row.id);
  if (i === -1) return [...arr, row];
  const copy = arr.slice();
  copy[i] = row;
  return copy;
};

interface AnnoState {
  bookId: string | null;
  ctrl: FoliateController | null;
  highlights: HighlightRow[];
  notes: NoteRow[];
  bind: (ctrl: FoliateController | null, bookId: string | null) => void;
  load: () => Promise<void>;
  highlightByCfi: (cfi: string) => HighlightRow | undefined;
  noteForHighlight: (highlightId: string) => NoteRow | undefined;
  createHighlight: (cfi: string, color: HighlightColor, text: string) => Promise<HighlightRow | null>;
  setColor: (id: string, color: HighlightColor) => Promise<void>;
  removeHighlight: (id: string) => Promise<void>;
  saveNoteForHighlight: (hi: HighlightRow, body: string) => Promise<void>;
  addMarginNote: (cfi: string, color: HighlightColor, body: string, chapterLabel: string | null) => Promise<NoteRow | null>;
  updateNote: (id: string, body: string, color?: string | null) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
}

export const useAnnotations = create<AnnoState>((set, get) => ({
  bookId: null,
  ctrl: null,
  highlights: [],
  notes: [],

  bind: (ctrl, bookId) => set({ ctrl, bookId }),

  load: async () => {
    const { bookId, ctrl } = get();
    if (!bookId) {
      set({ highlights: [], notes: [] });
      return;
    }
    const [highlights, notes] = await Promise.all([highlightsForBook(bookId), notesForBook(bookId)]);
    set({ highlights, notes });
    await ctrl?.loadHighlights(highlights.map((h) => ({ cfi: h.cfi, color: h.color })));
  },

  highlightByCfi: (cfi) => get().highlights.find((h) => h.cfi === cfi),
  noteForHighlight: (highlightId) => get().notes.find((n) => n.highlight_id === highlightId),

  createHighlight: async (cfi, color, text) => {
    const { bookId, ctrl } = get();
    if (!bookId) return null;
    // Draw the overlay first — it's local (instant, keeps selection→highlight snappy) and yields the
    // chapter label the row needs. If the DB write then fails or returns nothing, revert the overlay
    // so no highlight is left drawn with no row backing it (which would vanish on reopen).
    const label = await ctrl?.addHighlight(cfi, color);
    const fallback = label ?? useReader.getState().chapterLabel;
    try {
      const row = await highlightCreate(bookId, cfi, color, text, fallback);
      if (row) {
        set({ highlights: upsert(get().highlights, row) });
        return row;
      }
      ctrl?.removeHighlight(cfi); // no DB row → erase the dangling overlay
      return null;
    } catch (e) {
      console.error(e);
      ctrl?.removeHighlight(cfi); // failed write → erase the dangling overlay
      return null;
    }
  },

  setColor: async (id, color) => {
    const hi = get().highlights.find((h) => h.id === id);
    if (!hi) return;
    const prevColor = hi.color;
    get().ctrl?.setHighlightColor(hi.cfi, color); // optimistic recolour (local, instant)
    try {
      const updated = await highlightSetColor(id, color);
      if (updated) set({ highlights: upsert(get().highlights, updated) });
      else get().ctrl?.setHighlightColor(hi.cfi, prevColor); // no DB row → restore the on-page colour
    } catch (e) {
      console.error(e);
      get().ctrl?.setHighlightColor(hi.cfi, prevColor); // failed write → restore the on-page colour
    }
  },

  removeHighlight: async (id) => {
    const hi = get().highlights.find((h) => h.id === id);
    if (!hi) return;
    // Erase the overlay optimistically, but gate the array removal on the DB delete: if it fails,
    // redraw the highlight so the panel entry + on-page mark stay in step with the surviving row
    // (no ghost entry whose jump would land on unhighlighted text).
    get().ctrl?.removeHighlight(hi.cfi);
    try {
      await highlightDelete(id);
    } catch (e) {
      console.error(e);
      get().ctrl?.addHighlight(hi.cfi, hi.color); // failed delete → restore the overlay, keep arrays
      return;
    }
    // Row is gone from the DB — commit the removal. Its note delete is best-effort (the FK already
    // detached it); only drop the note from the panel if its own delete resolves.
    const note = get().notes.find((n) => n.highlight_id === id);
    let noteRemoved = true;
    if (note) {
      try {
        await noteDelete(note.id);
      } catch (e) {
        console.error(e);
        noteRemoved = false;
      }
    }
    set({
      highlights: get().highlights.filter((h) => h.id !== id),
      notes: noteRemoved ? get().notes.filter((n) => n.highlight_id !== id) : get().notes,
    });
  },

  // Upsert the single note attached to a highlight; an empty body removes it.
  saveNoteForHighlight: async (hi, rawBody) => {
    const { bookId } = get();
    if (!bookId) return;
    const body = rawBody.trim();
    const existing = get().notes.find((n) => n.highlight_id === hi.id);
    if (!body) {
      if (existing) {
        // Apply-on-success: only drop it from the panel if the DB delete resolves.
        try {
          await noteDelete(existing.id);
          set({ notes: get().notes.filter((n) => n.id !== existing.id) });
        } catch (e) {
          console.error(e);
        }
      }
      return;
    }
    const note = await noteCreate({ bookId, highlightId: hi.id, color: hi.color, body, chapterLabel: hi.chapter_label });
    if (note) set({ notes: upsert(get().notes, note) });
  },

  // A standalone "margin" note at a location (no highlight) — the affordance deferred from RAWY-20.
  addMarginNote: async (cfi, color, body, chapterLabel) => {
    const { bookId } = get();
    if (!bookId || !body.trim()) return null;
    const note = await noteCreate({ bookId, cfi, color, body: body.trim(), chapterLabel });
    if (note) set({ notes: upsert(get().notes, note) });
    return note;
  },

  updateNote: async (id, body, color) => {
    const trimmed = body.trim();
    if (!trimmed) {
      await get().deleteNote(id);
      return;
    }
    const updated = await noteUpdate(id, trimmed, color ?? null);
    if (updated) set({ notes: upsert(get().notes, updated) });
  },

  deleteNote: async (id) => {
    // Apply-on-success: drop it from the panel only when the DB delete resolves, else it would vanish
    // from the UI while its row survives (and reappear on reopen).
    try {
      await noteDelete(id);
      set({ notes: get().notes.filter((n) => n.id !== id) });
    } catch (e) {
      console.error(e);
    }
  },
}));
