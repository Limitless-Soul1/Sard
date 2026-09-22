// REPLACEMENTS — the shared store for the open book's substitution rules.
//
// Deliberately the twin of `referencesStore`: one source of truth, every mutation writes to the DB and
// then hands the refreshed set to the controller, which re-applies it to every rendered section. That is
// why saving, deleting or switching a rule is visible at once and needs no reload.
//
// The ONE difference from references is `enabled`, and it is the reason the feature is safe to live with:
// only enabled rules are pushed at the controller, so turning a rule off is not a special code path — the
// page simply goes back to the author's wording because there is nothing left to substitute. The row is
// kept untouched, so nothing the reader wrote is lost and it can be switched back at any time.
import { create } from "zustand";

import type { FoliateController } from "../../reader-engine/FoliateController";
import { foldPhrase, phraseWordCount } from "../../lib/references";
import { repDelete, repSave, repSetEnabled, repsForBook, type RepRow } from "../../lib/ipc";

interface RepState {
  bookId: string | null;
  ctrl: FoliateController | null;
  reps: RepRow[];
  bind: (ctrl: FoliateController | null, bookId: string | null) => void;
  load: () => Promise<void>;
  /** The rule whose phrase folds to this text, if the reader has already made one. */
  byPhrase: (phrase: string) => RepRow | undefined;
  /**
   * The rule this SELECTION belongs to, from either side of it.
   *
   * Once a rule is live the page shows the REPLACEMENT, so a reader who selects the words he changed
   * is selecting the new wording, not the original — and matching only the original meant Sard did not
   * recognise its own rule and offered to make a second one. Either side identifies it.
   */
  byText: (text: string) => RepRow | undefined;
  byId: (id: string) => RepRow | undefined;
  /** Create OR edit — one path, matching the single editor in the design. */
  save: (phrase: string, replacement: string, cfi?: string | null) => Promise<RepRow | null>;
  /**
   * EDIT THE RULE THAT IS ALREADY THERE, from its card — by identity, not by phrase.
   *
   * `save` above keys on the folded phrase, which is right when the reader is composing a rule from a
   * selection: replacing the same words twice edits the rule instead of leaving two fighting over the
   * same text. It is NOT enough for an edit started from an existing card, because the reader may
   * change the ORIGINAL side — and the folded phrase is the row's unique key, so that is a different
   * key and the write would land on a different row, leaving the old one behind as a duplicate.
   *
   * So this takes the row's id and answers the three cases honestly:
   *   · the key is unchanged  → a plain in-place UPDATE; same id, same place, same on/off state. This
   *     is the ordinary case (correcting the replacement, or the original's spacing or diacritics).
   *   · the key changed and nothing else holds it → the write necessarily creates the new key, so the
   *     rule's on/off state and its place are carried across and the old row is removed. The DATA
   *     MODEL forces this, not a preference: `reps` is unique on (book_id, phrase_fold) and the key
   *     is derived from the phrase, so "the same rule, about other words" cannot be expressed as an
   *     UPDATE without a schema change.
   *   · the key changed and ANOTHER rule already holds it → nothing is written at all, and the
   *     conflicting rule is returned. Merging would silently overwrite a rule the reader did not
   *     open, which is the one outcome an edit must never produce.
   */
  edit: (
    id: string,
    phrase: string,
    replacement: string,
  ) => Promise<{ ok: true; row: RepRow } | { ok: false; conflict: RepRow } | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Only the ENABLED rules reach the page. Disabled ones are inert by absence, not by a flag check. */
function syncCtrl(ctrl: FoliateController | null, reps: RepRow[]): void {
  ctrl?.setReplacements(
    reps
      .filter((r) => r.enabled && r.replacement.length > 0)
      .map((r) => ({ id: r.id, phrase: r.phrase, phrase_fold: r.phrase_fold, replacement: r.replacement })),
  );
}

export const useReplacements = create<RepState>((set, get) => ({
  bookId: null,
  ctrl: null,
  reps: [],

  bind: (ctrl, bookId) => set({ ctrl, bookId }),

  load: async () => {
    const { bookId, ctrl } = get();
    if (!bookId) {
      set({ reps: [] });
      syncCtrl(ctrl, []);
      return;
    }
    const reps = await repsForBook(bookId).catch(() => [] as RepRow[]);
    set({ reps });
    syncCtrl(ctrl, reps);
  },

  byPhrase: (phrase) => {
    const f = foldPhrase(phrase);
    return f ? get().reps.find((r) => r.phrase_fold === f) : undefined;
  },
  byText: (text) => {
    const f = foldPhrase(text);
    if (!f) return undefined;
    const reps = get().reps;
    return reps.find((r) => r.phrase_fold === f) ?? reps.find((r) => foldPhrase(r.replacement) === f);
  },
  byId: (id) => get().reps.find((r) => r.id === id),

  // The place the selection stood in, carried to the row — see the note in `referencesStore`.
  save: async (phrase, replacement, cfi) => {
    const { bookId, ctrl } = get();
    if (!bookId) return null;
    const fold = foldPhrase(phrase);
    if (!fold) return null; // nothing to match on (punctuation or whitespace only)
    try {
      const row = await repSave(bookId, phrase.trim(), fold, replacement.trim(), phraseWordCount(phrase), cfi);
      if (!row) return null;
      // Upsert by id: the backend keys on (book, folded phrase), so an edit returns the ORIGINAL row id.
      const next = get().reps.some((r) => r.id === row.id)
        ? get().reps.map((r) => (r.id === row.id ? row : r))
        : [...get().reps, row];
      set({ reps: next });
      syncCtrl(ctrl, next);
      return row;
    } catch (e) {
      console.error(e);
      return null;
    }
  },

  edit: async (id, phrase, replacement) => {
    const { bookId, ctrl } = get();
    const old = get().reps.find((r) => r.id === id);
    if (!bookId || !old) return null;
    const fold = foldPhrase(phrase);
    if (!fold) return null; // nothing to match on (punctuation or whitespace only)
    const rekeyed = fold !== old.phrase_fold;
    if (rekeyed) {
      const clash = get().reps.find((r) => r.id !== id && r.phrase_fold === fold);
      if (clash) return { ok: false as const, conflict: clash };
    }
    try {
      // The row's OWN place travels with it. `rep_save` COALESCEs the cfi, so passing it is a no-op
      // on the in-place update and is what keeps a re-keyed rule on the map instead of losing the
      // place the reader made it from.
      const row = await repSave(bookId, phrase.trim(), fold, replacement.trim(), phraseWordCount(phrase), old.cfi);
      if (!row) return null;
      let saved = row;
      let reps = get().reps;
      if (row.id !== old.id) {
        // A NEW ROW WAS NECESSARILY CREATED (the key changed). It is born enabled, so a rule the
        // reader had switched OFF must be switched off again before anything is shown — otherwise
        // an edit would quietly put the substitution back on the page.
        if (!old.enabled) saved = (await repSetEnabled(row.id, false)) ?? { ...row, enabled: false };
        await repDelete(old.id);
        reps = reps.filter((r) => r.id !== old.id);
      }
      const next = reps.some((r) => r.id === saved.id)
        ? reps.map((r) => (r.id === saved.id ? saved : r))
        : [...reps, saved];
      set({ reps: next });
      syncCtrl(ctrl, next);
      return { ok: true as const, row: saved };
    } catch (e) {
      console.error(e);
      return null;
    }
  },

  setEnabled: async (id, enabled) => {
    const { ctrl } = get();
    const prev = get().reps;
    // Optimistic, so the page changes under the switch rather than after it.
    const next = prev.map((r) => (r.id === id ? { ...r, enabled } : r));
    set({ reps: next });
    syncCtrl(ctrl, next);
    try {
      await repSetEnabled(id, enabled);
    } catch (e) {
      console.error(e);
      set({ reps: prev });
      syncCtrl(ctrl, prev);
    }
  },

  remove: async (id) => {
    const { ctrl } = get();
    const prev = get().reps;
    const next = prev.filter((r) => r.id !== id);
    set({ reps: next });
    syncCtrl(ctrl, next);
    try {
      await repDelete(id);
    } catch (e) {
      console.error(e);
      set({ reps: prev });
      syncCtrl(ctrl, prev);
    }
  },
}));
