// THE UNSAVED هيئة — an appearance-owned edit made inside a book, held until the reader leaves it.
//
// WHAT THIS CHANGES, AND WHY IT HAD TO. A هيئة is the complete appearance and it has ONE owner, so an
// appearance-owned property changed while a book wears one is an edit to THAT هيئة. That rule is
// right and stays. What was wrong was the moment of commitment: the edit was written the instant it
// was made, which meant choosing a paper to see how it looked silently rewrote a هيئة that other
// books wear — and there was no way back that did not involve remembering what it used to be.
//
// So the edit now becomes a DRAFT. The book shows it immediately, because that is the whole point of
// changing a paper; the هيئة does not receive it until the reader says so on the way out. Editing is
// not a sequence of commitments, and the moment the answer actually matters is the moment the draft
// is about to be lost — which is exactly where `session.ts` already asks its question.
//
// NOT A SECOND SAVE SYSTEM. It is the same question the editor's own draft asks, asked at the reader's
// boundary instead of the editor's: `guardUnsaved` already carries `subject`, `onSave` and
// `onDiscard` for precisely a draft that `driftOf` cannot see. This supplies those three and adds no
// dialog, no toast and no verb of its own.
//
// NOT PERSISTENCE, EITHER. One draft, in memory, for the sitting. There is no history, no snapshot
// column, no versions and no undo stack — a هيئة's saved state is the only durable state, and a draft
// that outlived the session would be a second one. A crash therefore loses the draft, which is the
// same thing an unsaved editor draft has always done.

import { create } from "zustand";

import type { CustomThemeId } from "../../theme/tokens";
import type { Profile } from "../profiles/model/profile";
import { serialiseProfileData } from "../profiles/model/profile";
import { saveProfile, useProfiles } from "../profiles/store";

/** The one unsaved هيئة, and the saved row it departed from. */
export interface AppearanceDraft {
  /** Whose draft this is. There is at most one, because at most one book is open. */
  id: CustomThemeId;
  /**
   * THE SAVED ROW, RE-READ ON EVERY EDIT rather than captured once.
   *
   * It is what Discard puts back and what "has anything actually changed?" is measured against. Read
   * fresh each time so that a هيئة saved from elsewhere while a draft is open — the editor, an
   * import — is compared against what is in the database now, not against a copy that has gone stale.
   */
  saved: Profile;
  /** The هيئة as the reader has shaped it: complete, never a patch. */
  draft: Profile;
}

interface DraftState {
  current: AppearanceDraft | null;
  put: (d: AppearanceDraft | null) => void;
}

/**
 * Subscribed, not polled — the Reader repaints from this, so it has to publish.
 *
 * A store rather than a ref because two different things read it: the Reader's own render (the
 * palette, the interface face, the texture) and the imperative writers that run outside React.
 */
export const useAppearanceDraft = create<DraftState>((set) => ({
  current: null,
  put: (current) => set({ current }),
}));

/**
 * Record an edit to the هيئة a book is wearing.
 *
 * `next` is the COMPLETE هيئة as it should now look — the `with…Edit` helpers all return one — so a
 * second edit simply replaces the first and several edits are one draft. That is what makes leaving
 * the book one question rather than one per property.
 */
export function editAppearance(next: Profile): void {
  const saved = useProfiles.getState().profiles.find((p) => p.id === next.id) ?? null;
  // A هيئة that is no longer in the list cannot be drafted against anything. Dropping the edit is the
  // honest outcome: there is nothing to save it into and nothing to put back.
  if (!saved) return;
  useAppearanceDraft.getState().put({ id: next.id, saved, draft: next });
}

/**
 * THE هيئة A BOOK IS READ IN — its unsaved draft while one is open, its saved row otherwise.
 *
 * Every surface that resolves an appearance goes through here, which is what keeps the draft from
 * becoming a second source of truth: there is one function, and the only question it answers is
 * "which object is in force for this id right now".
 */
export function resolveAppearance(id: string | null, profiles: readonly Profile[]): Profile | null {
  if (!id) return null;
  const d = useAppearanceDraft.getState().current;
  if (d && d.id === id) return d.draft;
  return profiles.find((p) => p.id === id) ?? null;
}

/** The draft in force for this id, or null — for the surfaces that need to know it IS a draft. */
export function draftFor(id: string | null): AppearanceDraft | null {
  const d = useAppearanceDraft.getState().current;
  return d && id && d.id === id ? d : null;
}

/**
 * THE DRAFT THAT IS ACTUALLY HELD, whatever it is about.
 *
 * WHY THIS EXISTS RATHER THAN `draftFor(ownerFor()?.id)`. A draft is bound to the هيئة it departed
 * from, and nothing the reader does afterwards may move it: the boundary must ask about THAT هيئة,
 * name it, list its changes and commit to it.
 *
 * MEASURED DEFECT: a following book drafted the global default «TNocturne»; the reader then changed
 * the Library's هيئة to «TRing» while the draft was still dirty. Looking the draft up by the owner
 * re-derived TRing, found no draft for it, and the dialog said «Unsaved changes in TRing» over the
 * generic "you have changes" body — having lost the list — while Save correctly wrote TNocturne. The
 * reader was asked about one هيئة and their answer applied to another.
 *
 * `ownerFor()` still decides the owner for a NEW edit. Once a draft exists, this is its identity.
 */
export function heldDraft(): AppearanceDraft | null {
  return useAppearanceDraft.getState().current;
}

/**
 * Has the draft actually departed from what the هيئة holds?
 *
 * DERIVED, NEVER LATCHED, which is the rule `session.ts` already follows for drift: after Save the
 * two agree and after Discard the draft is gone, so neither has to remember to clear a flag. It also
 * means an edit that lands back on the saved value — Sepia, then back to the original — asks nothing
 * on the way out, because nothing is unsaved.
 */
export function appearanceDraftDirty(): boolean {
  const d = useAppearanceDraft.getState().current;
  if (!d) return false;
  return serialiseProfileData(d.draft.data) !== serialiseProfileData(d.saved.data);
}

/** Throw the draft away. The caller re-resolves and the book returns to the saved هيئة. */
export function clearAppearanceDraft(): void {
  useAppearanceDraft.getState().put(null);
}

/**
 * Anything unsaved? One half now, and deliberately.
 *
 * A SECOND HALF EXISTED BRIEFLY, holding the page colour and the ink while they were still session
 * values. They are the هيئة's own palette now — one owner — so the only unsaved thing a sitting can
 * hold is the هيئة draft itself. What is left on the session row is reading MODE (the flow, the fit,
 * the immersive pair), which is not appearance and must not be inside this boundary: switching from
 * Pages to Scroll is not an edit to a هيئة and must never ask to be saved into one.
 */
export function draftDirty(): boolean {
  return appearanceDraftDirty();
}

/**
 * Commit the draft to the هيئة itself, then clear it.
 *
 * ONE SAVE, through the one path every other write takes — so every book wearing this هيئة follows,
 * the theme registry is refreshed by `saveProfile`, and nothing about sharing, ordering or the use
 * stamp behaves differently because the edit happened to be made in a book.
 */
export async function commitAppearanceDraft(): Promise<void> {
  const d = useAppearanceDraft.getState().current;
  if (!d) return;
  // Cleared FIRST, so that the re-resolve `saveProfile` triggers already reads the saved row rather
  // than a draft that is about to be identical to it. Leaving it in place made the Reader resolve the
  // draft object for one more render — harmless, but it means "is there a draft?" answers yes after
  // the thing that made it one has been written.
  useAppearanceDraft.getState().put(null);
  await saveProfile(d.draft);
}
