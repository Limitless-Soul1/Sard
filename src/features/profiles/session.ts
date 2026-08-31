import { readingThemeId } from "./model/profile";
// UNSAVED CHANGES — one derived answer to "has the active profile been changed?", and one moment to
// ask about it.
//
// WHAT THIS REPLACED, AND WHY. A profile owns values that can be changed from OUTSIDE its editor:
// the app paper, the book paper, the two book faces, and the number ink. The old layer watched those
// on a `setInterval(check, 1000)` and opened a three-destination dialog the instant any of them
// moved — so choosing a paper, then a face, then an ink asked the reader where the change should go
// three separate times, mid-edit, before they had finished deciding what they wanted. Editing is not
// a sequence of commitments, and treating it as one is what made the question feel like an alarm.
//
// THE RULE NOW: a change never interrupts. It makes the profile DIRTY, which is a fact the interface
// can show quietly. The question is asked only where the answer actually matters — where the changes
// are about to be lost or about to travel:
//
//     switching to another profile   · the live values are about to be replaced
//     leaving the editor             · the draft is about to go
//     sharing or exporting           · the package would carry a look that was never saved
//
// DIRTY IS DERIVED, NEVER STORED. It is `driftOf(activeProfile)` — what the profile says versus what
// Sard is showing — read from the two stores that hold those values. Nothing latches, so Save and
// Discard do not have to remember to clear a flag: after either one the comparison simply comes out
// equal. That is also why there is no second source of truth to drift out of step with the first.
//
// The poll had a stated reason — "the reading style is not a zustand slice, so there is nothing to
// subscribe to". That is not so: `useReader` is a zustand store like `useTheme`, and both are
// subscribed to below.

import { create } from "zustand";

import { useReader } from "../../reader-engine/store";
import { useTheme } from "../../theme/store";
import type { Profile } from "./model/profile";
import { useProfiles } from "./store";

/**
 * The profile-owned values reachable from outside the editor.
 *
 * `numberColor` joined them when the Reader gained its own number-ink row: a profile carries that
 * colour, so changing it from the reading drawer changes the profile, exactly as changing a face
 * does. Values a profile has NO opinion about are deliberately absent — those are the reader's own
 * settings and changing one is not an edit to any profile.
 */
export type SessionKey = "theme_id" | "book_theme_id" | "arabicFont" | "latinFont" | "numberColor";

export const SESSION_KEYS: readonly SessionKey[] = [
  "theme_id",
  "book_theme_id",
  "arabicFont",
  "latinFont",
  "numberColor",
] as const;

/** What the profile says each of the four should be. */
export function profileValues(p: Profile): Record<SessionKey, string> {
  return {
    // A profile IS its theme, under its own id — that is what the resolver registers.
    theme_id: p.id,
    // AND THE BOOK'S IS A DIFFERENT ID. This said `p.id` too, which made the drift detector believe
    // a correctly-applied profile had drifted the moment the two scopes were separated — and
    // `reassertProfileValues` then "corrected" the book back onto the library's palette on the next
    // startup. Measured: the two ids were distinct after applying and identical again after a
    // reload, with the reader's book colour gone.
    book_theme_id: readingThemeId(p.id),
    arabicFont: p.data.type.arabic,
    latinFont: p.data.type.latin,
    // "" is the honest reading of "this profile paints no number ink" — `readingPatch` writes the
    // field either way, so an absent colour is a value the profile holds, not a gap.
    numberColor: p.data.theme.reading.numbers ?? "",
  };
}

/** What Sard is actually showing right now. */
export function liveValues(): Record<SessionKey, string> {
  const t = useTheme.getState();
  const s = useReader.getState().style;
  return {
    theme_id: String(t.themeId),
    book_theme_id: String(t.bookThemeId),
    arabicFont: String(s?.arabicFont ?? ""),
    latinFont: String(s?.latinFont ?? ""),
    numberColor: String(s?.numberColor ?? ""),
  };
}

/**
 * Which of the four differ from what the profile saved.
 *
 * An empty face reads as "no drift" rather than as a change to nothing: the reading style fills
 * absent fields from the per-script defaults at render time, and an absent field is not a value the
 * reader chose.
 */
export function driftOf(p: Profile): SessionKey[] {
  // NOTHING IS KNOWN UNTIL THE THEME LAYER HAS LOADED.
  //
  // `useTheme` starts on Sard's defaults for both ids and `initTheme()` runs after `initProfiles()`,
  // so in the moment between them the active profile is named while the theme store still holds
  // values nobody has read — which compares as "the paper changed" on a launch where the reader has
  // done nothing. The old watcher guarded exactly this; it is stated once here instead.
  //
  // It is the THEME layer, not the reading style. Guarding on the reading style would switch the
  // whole model off whenever the Reader is closed — which is where the profile editor lives, so
  // every change made in it would look like no change at all. The three reading-derived keys need no
  // guard of their own: `liveValues` reports them as "" when there is no style, and the rule below
  // already treats an absent value as no opinion.
  if (!useTheme.getState().ready) return [];
  const want = profileValues(p);
  const have = liveValues();
  return SESSION_KEYS.filter((k) => {
    // AN ABSENT LIVE VALUE IS NOT A CHANGE. A field the reading style does not carry is one the
    // reader has expressed no opinion about — not a value they chose that happens to differ. The
    // rule already held for the two faces; it holds for the number ink for the same reason, and it
    // is what keeps a reading blob written before that field existed from reading as an edit.
    if (k === "arabicFont" || k === "latinFont" || k === "numberColor") {
      return have[k] !== "" && have[k] !== want[k];
    }
    return have[k] !== want[k];
  });
}

/**
 * THE GATE, not a watcher.
 *
 * `pending` is an ACTION waiting on a decision — never a change waiting to be classified. It is set
 * by `guardUnsaved` at a boundary and cleared by the reader answering, so nothing here can fire on
 * its own while someone is still editing.
 */
export interface Pending {
  /** Which profile-owned values drifted, for the wording. Empty when the change is a draft. */
  keys: SessionKey[];
  /** The action that was waiting on the answer. */
  proceed: () => void;
  /**
   * WHAT SAVE AND DISCARD MEAN HERE, when that is not "fold the drift in" / "re-apply the profile".
   *
   * The editor needs both to mean something else: its changes live in a DRAFT that is never applied,
   * so `driftOf` cannot see them and re-applying the profile would not undo them. Rather than give
   * the editor a second dialog — a second thing to keep in step — the boundary supplies its own two
   * verbs and the one dialog carries them out.
   */
  onSave?: () => Promise<void> | void;
  onDiscard?: () => Promise<void> | void;
}

interface SessionState {
  pending: Pending | null;
  open: (p: Pending) => void;
  close: () => void;
}

export const useSession = create<SessionState>((set) => ({
  pending: null,
  open: (p) => set({ pending: p }),
  close: () => set({ pending: null }),
}));

/**
 * Run `action`, asking first if the active profile has unsaved changes.
 *
 * The three boundaries call this instead of acting directly. With nothing changed it is a plain call
 * — switching profiles when you have changed nothing must stay silent, which is most of the time.
 */
export function guardUnsaved(
  action: () => void,
  opts?: { alsoDirty?: boolean; onSave?: Pending["onSave"]; onDiscard?: Pending["onDiscard"] },
): void {
  const { profiles, activeId } = useProfiles.getState();
  const active = profiles.find((p) => p.id === activeId) ?? null;
  const keys = active ? driftOf(active) : [];
  // `alsoDirty` is how a boundary reports a change this module cannot see — the editor's draft is
  // the only one, and without it the ✕ would close on an unsaved draft without a word.
  if (!keys.length && !opts?.alsoDirty) { action(); return; }
  useSession.getState().open({ keys, proceed: action, onSave: opts?.onSave, onDiscard: opts?.onDiscard });
}

/**
 * Is a decision on screen right now?
 *
 * Share and Import still stand aside for it: acting on a profile whose saved state is the very thing
 * in question would package or merge a look nobody has committed to.
 */
export function profileChangePending(): boolean {
  return useSession.getState().pending !== null;
}

/**
 * The live dirty state, for anything that wants to SHOW it.
 *
 * Subscribed, not polled: `useProfiles`, `useTheme` and `useReader` all publish, so this re-derives
 * exactly when one of them moves and at no other time.
 */
export function useProfileDirty(): SessionKey[] {
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const themeId = useTheme((s) => s.themeId);
  const bookThemeId = useTheme((s) => s.bookThemeId);
  const style = useReader((s) => s.style);
  const active = profiles.find((p) => p.id === activeId) ?? null;
  // `themeId`/`bookThemeId`/`style` are read so this re-runs when they change; `driftOf` re-reads
  // them itself, which keeps the comparison in exactly one place.
  void themeId; void bookThemeId; void style;
  return active ? driftOf(active) : [];
}
