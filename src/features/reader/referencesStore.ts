// RAWY-260 — REFERENCES: the shared store for the open book's references.
//
// One source of truth, mirroring `annotationsStore`'s shape so the two read the same way: every mutation
// goes through here, writes to the DB, and hands the refreshed set to the controller — which re-marks every
// rendered section. That is why a save or delete is visible immediately and needs no reload: replacing the
// set IS the redraw, and a deleted reference's marks disappear because nothing was ever written into the
// book to clean up.
//
// RAWY-281: the mark used to be a CSS Custom Highlight; it is now SVG drawn into foliate's overlayer
// (the Custom Highlight API cannot draw the accepted twin-rule design — no rounded caps, no second
// stroke, no controllable gap). Nothing in THIS file changed: the controller still owns the drawing and
// still re-marks from `setReferences`, which is exactly why the switch did not reach the store.

import { create } from "zustand";

import type { FoliateController } from "../../reader-engine/FoliateController";
import { foldPhrase, phraseWordCount } from "../../lib/references";
import { refDelete, refSave, refsForBook, type RefRow } from "../../lib/ipc";

interface RefState {
  bookId: string | null;
  ctrl: FoliateController | null;
  refs: RefRow[];
  bind: (ctrl: FoliateController | null, bookId: string | null) => void;
  load: () => Promise<void>;
  /** The reference whose phrase folds to this text, if the reader has already made one. */
  byPhrase: (phrase: string) => RefRow | undefined;
  byId: (id: string) => RefRow | undefined;
  /** Create OR edit — one path, matching the single dialog. An empty note is rejected by the caller. */
  save: (phrase: string, note: string) => Promise<RefRow | null>;
  remove: (id: string) => Promise<void>;
}

/** Push the current set at the renderer. Kept in one place so every mutation re-marks identically. */
function syncCtrl(ctrl: FoliateController | null, refs: RefRow[]): void {
  ctrl?.setReferences(refs.map((r) => ({ id: r.id, phrase_fold: r.phrase_fold })));
}

export const useReferences = create<RefState>((set, get) => ({
  bookId: null,
  ctrl: null,
  refs: [],

  bind: (ctrl, bookId) => set({ ctrl, bookId }),

  load: async () => {
    const { bookId, ctrl } = get();
    if (!bookId) {
      set({ refs: [] });
      syncCtrl(ctrl, []);
      return;
    }
    const refs = await refsForBook(bookId).catch(() => [] as RefRow[]);
    set({ refs });
    syncCtrl(ctrl, refs);
  },

  byPhrase: (phrase) => {
    const f = foldPhrase(phrase);
    return f ? get().refs.find((r) => r.phrase_fold === f) : undefined;
  },
  byId: (id) => get().refs.find((r) => r.id === id),

  save: async (phrase, note) => {
    const { bookId, ctrl } = get();
    if (!bookId) return null;
    const fold = foldPhrase(phrase);
    if (!fold) return null; // nothing selectable to match on (punctuation/whitespace only)
    try {
      const row = await refSave(bookId, phrase.trim(), fold, phraseWordCount(phrase), note);
      if (!row) return null;
      // Upsert by id: the backend keys on (book, folded phrase), so an edit returns the ORIGINAL row id
      // and this replaces it in place instead of appending a duplicate.
      const next = get().refs.some((r) => r.id === row.id)
        ? get().refs.map((r) => (r.id === row.id ? row : r))
        : [...get().refs, row];
      set({ refs: next });
      syncCtrl(ctrl, next);
      return row;
    } catch (e) {
      console.error(e);
      return null;
    }
  },

  remove: async (id) => {
    const { ctrl } = get();
    const prev = get().refs;
    const next = prev.filter((r) => r.id !== id);
    // Optimistic: drop the marks at once (that is the whole point of "deleting removes every marker
    // immediately"), then restore them if the DB write fails so the page and the row never disagree.
    set({ refs: next });
    syncCtrl(ctrl, next);
    try {
      await refDelete(id);
    } catch (e) {
      console.error(e);
      set({ refs: prev });
      syncCtrl(ctrl, prev);
    }
  },
}));
