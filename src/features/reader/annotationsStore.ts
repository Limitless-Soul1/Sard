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
    const label = await ctrl?.addHighlight(cfi, color);
    const fallback = label ?? useReader.getState().chapterLabel;
    const row = await highlightCreate(bookId, cfi, color, text, fallback);
    if (row) set({ highlights: upsert(get().highlights, row) });
    return row;
  },

  setColor: async (id, color) => {
    const hi = get().highlights.find((h) => h.id === id);
    if (!hi) return;
    get().ctrl?.setHighlightColor(hi.cfi, color);
    const updated = await highlightSetColor(id, color);
    if (updated) set({ highlights: upsert(get().highlights, updated) });
  },

  removeHighlight: async (id) => {
    const hi = get().highlights.find((h) => h.id === id);
    if (!hi) return;
    get().ctrl?.removeHighlight(hi.cfi);
    await highlightDelete(id);
    const note = get().notes.find((n) => n.highlight_id === id);
    if (note) await noteDelete(note.id);
    set({
      highlights: get().highlights.filter((h) => h.id !== id),
      notes: get().notes.filter((n) => n.highlight_id !== id),
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
        await noteDelete(existing.id);
        set({ notes: get().notes.filter((n) => n.id !== existing.id) });
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
    await noteDelete(id);
    set({ notes: get().notes.filter((n) => n.id !== id) });
  },
}));
