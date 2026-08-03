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
  highlightSetAlpha, // RAWY-259: per-highlight ink density
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
  /** RAWY-259: this highlight’s own ink density; null = follow the theme default. */
  setAlpha: (id: string, alpha: number | null) => Promise<void>;
  removeHighlight: (id: string) => Promise<void>;
  // RAWY-203: returns the saved note (so the caller can attach tags), or null when the body was empty
  // (which deletes/skips the note — nothing to tag).
  // RAWY-205: `keepForTags` keeps an EMPTY-body note alive as a pure tag anchor (see the impl).
  // RAWY-282: `title` is optional everywhere. Omitting it means "untitled", which is what every caller
  // written before this ticket means, so no call site had to change to keep working.
  saveNoteForHighlight: (hi: HighlightRow, body: string, keepForTags?: boolean, title?: string) => Promise<NoteRow | null>;
  addMarginNote: (cfi: string, color: HighlightColor, body: string, chapterLabel: string | null, title?: string) => Promise<NoteRow | null>;
  updateNote: (id: string, body: string, color?: string | null, title?: string) => Promise<void>;
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
    // RAWY-259: carry each mark's saved ink density through, so a reopened book renders the densities the
    // reader set rather than falling back to the theme default until the highlight is next edited.
    // RAWY-283: the STORE keeps newest-first (that is what both lists render), but the OVERLAY is fed a
    // chronologically ascending COPY. `loadHighlights` calls `addAnnotation` once per item in array
    // order, so array order is paint order: handing it the reversed list would change which of two
    // OVERLAPPING marks ends up on top. Sorting a copy keeps the drawn page byte-identical to before
    // while the panel gets the ordering the reader asked for. `slice()` so the store array is untouched.
    const chronological = highlights.slice().sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    await ctrl?.loadHighlights(chronological.map((h) => ({ cfi: h.cfi, color: h.color, alpha: h.alpha })));
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

  // RAWY-259: set THIS highlight's ink density. Mirrors `setColor` exactly — optimistic redraw of the one
  // mark, then the DB write, with a restore on failure — so the page and the row can never disagree. Only
  // the row with this id is touched, so editing one highlight can never move another. `null` clears the
  // override and returns the mark to the theme default.
  setAlpha: async (id, alpha) => {
    const hi = get().highlights.find((h) => h.id === id);
    if (!hi) return;
    const prev = hi.alpha ?? null;
    get().ctrl?.setHighlightAlpha(hi.cfi, alpha); // optimistic (local, instant)
    try {
      const updated = await highlightSetAlpha(id, alpha);
      if (updated) set({ highlights: upsert(get().highlights, updated) });
      else get().ctrl?.setHighlightAlpha(hi.cfi, prev); // no DB row → restore the on-page density
    } catch (e) {
      console.error(e);
      get().ctrl?.setHighlightAlpha(hi.cfi, prev); // failed write → restore the on-page density
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

  // Upsert the single note attached to a highlight; an empty body removes it — UNLESS the highlight is
  // being TAGGED (`keepForTags`), in which case an empty-body note is created/kept as a pure tag ANCHOR.
  // RAWY-205: note_tags anchors to notes.id, so a body-less highlight has nothing to hang a tag on — the
  // tag was silently dropped (the RAWY-203 latent bug). A tag alone is now enough to persist; a body is
  // never required. Body AND tags both empty still removes the note (its links cascade away).
  // An anchor note is not a note the user wrote: it is hidden from the reader's Notes tab + count, and it
  // never surfaces in the Inbox (annotations_all folds a highlight's note into the highlight row, and its
  // note branch is `highlight_id IS NULL`).
  saveNoteForHighlight: async (hi, rawBody, keepForTags = false, rawTitle = "") => {
    const { bookId } = get();
    if (!bookId) return null;
    const body = rawBody.trim();
    // RAWY-282: a TITLE alone keeps the note alive, exactly as RAWY-205 made a TAG alone keep it alive.
    // Without this, typing only a title and saving would delete the note the reader just wrote.
    const title = rawTitle.trim();
    const existing = get().notes.find((n) => n.highlight_id === hi.id);
    if (!body && !title && !keepForTags) {
      if (existing) {
        // Apply-on-success: only drop it from the panel if the DB delete resolves.
        try {
          await noteDelete(existing.id);
          set({ notes: get().notes.filter((n) => n.id !== existing.id) });
        } catch (e) {
          console.error(e);
        }
      }
      return null;
    }
    const note = await noteCreate({ bookId, highlightId: hi.id, color: hi.color, body, chapterLabel: hi.chapter_label, title: title || null });
    if (note) set({ notes: upsert(get().notes, note) });
    return note ?? null;
  },

  // A standalone "margin" note at a location (no highlight) — the affordance deferred from RAWY-20.
  addMarginNote: async (cfi, color, body, chapterLabel, rawTitle = "") => {
    const { bookId } = get();
    const title = rawTitle.trim();
    // RAWY-282: a title alone is a note worth keeping — see `saveNoteForHighlight`.
    if (!bookId || (!body.trim() && !title)) return null;
    const note = await noteCreate({ bookId, cfi, color, body: body.trim(), chapterLabel, title: title || null });
    if (note) set({ notes: upsert(get().notes, note) });
    return note;
  },

  updateNote: async (id, body, color, rawTitle = "") => {
    const trimmed = body.trim();
    const title = rawTitle.trim();
    // RAWY-282: deletion now requires BOTH fields empty. Previously an empty body deleted the note; with
    // titles that would silently destroy a note the reader had reduced to a heading.
    if (!trimmed && !title) {
      await get().deleteNote(id);
      return;
    }
    // `title || null` so an erased title is stored as NULL (absent), not as "" — the list branches on
    // absence to decide whether to render the title line at all.
    const updated = await noteUpdate(id, trimmed, color ?? null, title || null);
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
