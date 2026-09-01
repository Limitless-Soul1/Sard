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
import {
  TTS_TRACKING_DEFAULTS,
  TTS_TRACKING_KEYS,
  defaultsForDir,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { useTheme } from "../../theme/store";
import {
  PROFILE_READING_FIELDS,
  TYPOGRAPHY_KEYS,
  readingThemeId,
  type Profile,
} from "./model/profile";
import { useProfiles } from "./store";

/**
 * WHAT COUNTS AS AN EDIT TO THE ACTIVE هيئة, derived from the هيئة's own definition of what it owns.
 *
 * THE DEFECT THIS ENDS. This list used to be written out by hand, and it fell behind the model twice:
 * `PROFILE_READING_FIELDS` already names every reading value a هيئة owns, and nothing in the product
 * consulted it. So changing the size, the leading, the margins or the page width from inside the
 * reader moved the page, was written to the row the هيئة owns, and was invisible to the dirty check
 * — the reader could reshape their reading, switch هيئة, and lose it with no prompt at all.
 *
 * It is derived now. A field added to `PROFILE_READING_FIELDS` is a field this compares, an editor
 * row, and a value `readingPatch` asserts, in one edit; a future setting cannot escape by being
 * forgotten in a second list.
 */
const READING_KEYS = PROFILE_READING_FIELDS;

export type SessionKey = "theme_id" | "book_theme_id" | (typeof READING_KEYS)[number];

/**
 * The two the THEME layer owns, and the reading ones it does not.
 *
 * The split matters at exactly one point: `useReader.style` is `null` in the Library (the Reader
 * nulls it on the way out), so a reading value is UNKNOWN there rather than empty, and none of them
 * can be compared. The two ids are always known. See `driftOf`.
 */
export const SESSION_KEYS: readonly SessionKey[] = [
  "theme_id",
  "book_theme_id",
  ...READING_KEYS,
] as const;

/**
 * What the profile says each of these should be.
 *
 * THE READ-ALOUD MARKS JOINED for the reason `numberColor` did, and it is the model's own rule rather
 * than a new one: a value the هيئة OWNS and that can be changed from OUTSIDE the editor belongs here.
 * The seven are now carried by a هيئة and are settable from the reading drawer's read-aloud tab, so
 * changing one there is an edit to the هيئة exactly as changing a face is.
 *
 * A هيئة carrying no read-aloud opinion is not exempt: activating it asserts Sard's own marks (see
 * `readingPatch`), so that IS what it says they should be, and a reader who changes them has changed
 * something the هيئة would put back.
 */
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
    ...Object.fromEntries(
      TTS_TRACKING_KEYS.map((k) => [k, String((p.data.voice ?? TTS_TRACKING_DEFAULTS)[k] ?? "")]),
    ),
    // THE MEASURE, RESOLVED THE WAY ACTIVATION RESOLVES IT.
    //
    // A هيئة does not assert a number for a field it does not name — `readingPatch` CLEARS it, and
    // `loadGlobalStyle` then fills it from the per-script defaults. So what the هيئة "says" a field
    // should be is its own value where it has one, and the engine's default for THIS BOOK's direction
    // where it has not. Comparing against one script's defaults would report drift on every Arabic
    // book (zoom 1.15 vs 1.0, leading 1.9 vs 1.6, align start vs justify).
    ...Object.fromEntries(
      TYPOGRAPHY_KEYS.map((k) => [k, String(p.data.type.reading[k] ?? readingBase()[k])]),
    ),
  } as Record<SessionKey, string>;
}

/**
 * The defaults a cleared field resolves to, for the book that is open.
 *
 * `defaultsForDir` is the same function `loadGlobalStyle` uses, so "what the هيئة asserts" here and
 * "what activating it produces" are one answer rather than two that have to agree.
 */
function readingBase(): ReadingStyle {
  return defaultsForDir(useReader.getState().dir ?? undefined);
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
    ...Object.fromEntries(TTS_TRACKING_KEYS.map((k) => [k, String(s?.[k] ?? "")])),
    // The live measure. `useReader.style` is the RESOLVED style, so every one of these is a real
    // value while a book is open and the comparison is like for like.
    ...Object.fromEntries(TYPOGRAPHY_KEYS.map((k) => [k, String(s?.[k] ?? "")])),
  } as Record<SessionKey, string>;
}

/**
 * Which profile-owned values differ from what the هيئة saved.
 *
 * This is the whole of "has the reader changed something that belongs to the هيئة", and it is the
 * same question whether the change was made in the profile editor or in the reader's own drawer:
 * both write the values `PROFILE_READING_FIELDS` names, and both are compared here.
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
  // every change made in it would look like no change at all.
  if (!useTheme.getState().ready) return [];
  // AND THE READING STYLE IS UNKNOWN, NOT EMPTY, WHEN NO BOOK IS OPEN.
  //
  // The rule this replaces asked whether the live value was `""`, and that conflated two different
  // facts: "the Reader is closed, so there is nothing to compare" and "the field is genuinely null".
  // It was wrong in both directions. It reported nothing in the Library — right answer, wrong reason —
  // and it also SWALLOWED a real edit: a reader who cleared the number ink while wearing a هيئة that
  // paints one produced `""` live, which the rule read as "no opinion" and never asked about.
  //
  // `style === null` is the fact itself. With a book open every reading key is compared properly,
  // nulls included; with none open, none of them is.
  const readingKnown = useReader.getState().style != null;
  const want = profileValues(p);
  const have = liveValues();
  return SESSION_KEYS.filter((k) => {
    if ((READING_KEYS as readonly string[]).includes(k)) return readingKnown && have[k] !== want[k];
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
