// WHICH هيئة THIS BOOK IS READ IN — the whole هيئة, not a colour taken out of it.
//
// A هيئة IS ONE OBJECT, AND THAT IS THE WHOLE DESIGN. `profiles.data` holds the complete definition:
// the reading palette, both faces, the measure, the number ink, the read-aloud marks, the reference
// rule and the reading overlay. `readingPatch(profile)` — the SAME function activation uses — turns
// that object into the reading values, so there is exactly one definition of "what this هيئة means"
// and this file adds a way to READ it rather than a second copy of it.
//
// WHY THIS IS NOT THE DELETED PER-BOOK MODEL. `perBookSettings` records that Sard used to resolve a
// PARTIAL `ReadingStyle` per book over the global one, and that it was removed on measured evidence:
// a book that had once been tuned kept its own faces and colours whatever هيئة was worn. That model
// stored FIELDS, accumulated them implicitly as a side effect of any reading change, and so put two
// owners on every field. This one stores ONE IDENTIFIER, explicitly chosen, and owns no field at all:
// every value still comes from a هيئة, and a هيئة is still the only thing that holds one. There is no
// per-book font, zoom, margin or colour anywhere in this design, and there must never be.
//
// THE OWNERSHIP BOUNDARY IS THE PROJECT'S OWN. `PROFILE_READING_FIELDS` names what a هيئة owns; the
// package firewall refuses everything else BY NAME, in TypeScript and again in Rust, with a test that
// fails if the two lists drift. This file derives from that list rather than restating it, so a field
// added to a هيئة travels here without anyone remembering to add it.

import {
  REF_RULE_DEFAULTS, REF_RULE_KEYS, TTS_TRACKING_DEFAULTS, TTS_TRACKING_KEYS,
  defaultsForDir, type ReadingStyle,
} from "../../reader-engine/injectedCss";
import {
  TYPOGRAPHY_KEYS, profileRefs, readingPatch,
  type Profile, type ProfileRefs, type ProfileVoice,
} from "../profiles/model/profile";
import { isBuiltinThemeId } from "../../theme/themes";
import { resolveTheme } from "../../theme/resolve";
import type { Theme } from "../../theme/tokens";
import type { BgParams } from "../../lib/background";

/**
 * Per-book memory, keyed by the book's own id.
 *
 * THE VALUE IS A PROFILE ID, not the `~r` palette id a هيئة projects. The palette id cannot reach the
 * measure, the faces or the marks — it is one field of the object — so storing it was what limited
 * the first cut of this feature to colour. A builtin paper id (`ivory`) is also accepted: the sixteen
 * Sard ships are papers with no typography of their own, so there is nothing more of them to resolve.
 *
 * `books.id` is the sha256 of the file's bytes, so this follows a book through a rename or a move and
 * carries no path.
 */
export const bookAppearanceKey = (bookId: string): string => `book_appearance:${bookId}`;

/** How «افتراضي» is written: the row stays, empty. The same spelling `tts.speakSymbols.<id>` uses. */
export const BOOK_APPEARANCE_NONE = "";

/**
 * The «افتراضي» row's key inside the selector — a STAND-IN FOR `null`, never a stored value.
 *
 * `~` cannot begin a profile id (`u:`) or a builtin paper name, so nothing can collide with it, and
 * `parseBookAppearance` rejects it — if it ever reached the database it would read as "no override".
 */
export const BOOK_APPEARANCE_FOLLOW = "~follow";

/**
 * WHAT THE READER'S OWN ROW STILL OWNS — reading MODE, and nothing that is appearance.
 *
 * THE PAGE COLOUR AND THE INK USED TO BE HERE, and that was the defect. A هيئة already carries both
 * in `theme.reading.colors`; the session copies shadowed them at render time, were shared by every
 * book, and could not be discarded back out of. They are the هيئة's now — one owner — and the legacy
 * row values are cleared by migration 20260924210000.
 *
 * The four that remain are how the book is READ rather than how it looks: the flow, whether the page
 * fits the window, and the two immersive-chrome answers. Switching from Pages to Scroll is not an
 * edit to a هيئة and must never ask to be saved into one.
 */
export const SESSION_OWNED_FIELDS = [
  "pageFitWindow", "flowMode", "immHidePill", "immHideScrollbar",
] as const;

const isSessionOwned = (k: string): boolean =>
  (SESSION_OWNED_FIELDS as readonly string[]).includes(k);

/**
 * This book's own هيئة, or `null` for "this book has not been asked".
 *
 * Total: an empty row (how a reset is written), a malformed one, or a value from a future version all
 * read as `null`, so the failure mode is following the worn هيئة rather than a guess.
 */
export function parseBookAppearance(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.startsWith("~")) return null;
  return v;
}

/**
 * THE PRECEDENCE, AND WHY IT IS NOT `effectiveAppearance(override, worn)`.
 *
 * The rule reads as "the book's own هيئة, else the worn one", and for the PALETTE that is exactly what
 * the Reader computes. For the reading STYLE it is deliberately not, and the difference is a defect
 * avoided rather than a shortcut taken:
 *
 *   · A book with its own هيئة resolves from that object — `resolveAppearanceStyle` below.
 *   · A book that FOLLOWS reads the session's existing row, untouched.
 *
 * Those two are not the same thing, because the row is the worn هيئة's patch PLUS every reading change
 * the reader has made since and not yet saved into it. Re-resolving a following book from the worn
 * هيئة would silently discard exactly those changes — the ones `driftOf` exists to surface and offer to
 * save. So "follow" means "leave the reader's own row alone", and the untouched path stays untouched.
 *
 * Existence is resolved by the caller's own lookup rather than by a shape test here: a reader who
 * deletes the هيئة a book named must get the هيئة they are actually wearing, not an error and not
 * Ivory. The stale row is left on disk, so re-importing that هيئة restores the book.
 */

/**
 * A هيئة, resolved into the complete reading style it means.
 *
 * `readingPatch` IS THE DEFINITION — the same call `applyProfile` makes when it writes the row. What
 * it does not name is left at `defaultsForDir(dir)`, which is exactly what clearing those keys from
 * the shared row achieves on activation, so a هيئة read here and a هيئة worn resolve identically.
 *
 * The session's own fields are then laid back over the top: they are not the هيئة's to answer, and a
 * book wearing a هيئة must still be read in the flow mode and ink the reader chose.
 */
export function resolveAppearanceStyle(
  p: Profile, dir: string | undefined, session: ReadingStyle,
): ReadingStyle {
  const out = { ...defaultsForDir(dir), ...readingPatch(p).set } as unknown as Record<string, unknown>;
  for (const k of SESSION_OWNED_FIELDS) out[k] = (session as unknown as Record<string, unknown>)[k];
  return out as unknown as ReadingStyle;
}

/**
 * A reading change, split by who owns each field.
 *
 * The هيئة's half is an edit to the هيئة ITSELF — there is no per-book copy to put it in, and inventing
 * one is the deleted model. The session's half is the reader's own row, written exactly as it always
 * was.
 */
export function splitReadingEdit(patch: Partial<ReadingStyle>): {
  appearance: Partial<ReadingStyle>;
  session: Partial<ReadingStyle>;
} {
  const appearance: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) (isSessionOwned(k) ? session : appearance)[k] = v;
  return { appearance: appearance as Partial<ReadingStyle>, session: session as Partial<ReadingStyle> };
}

/**
 * The same هيئة with a reading change folded into it — the inverse of `readingPatch`, field for field.
 *
 * ONE MAPPING, DERIVED FROM THE SAME KEY LISTS `readingPatch` READS, so a field cannot be written here
 * in a place the resolver does not look for it. A هيئة carrying no opinion about the marks gains one
 * the first time the reader moves one, built from the engine's own defaults so the other six are what
 * they already rendered as rather than something invented here.
 *
 * Returns the SAME object when nothing in the patch belongs to a هيئة, so a caller can skip the save.
 */
export function withReadingEdit(p: Profile, patch: Partial<ReadingStyle>): Profile {
  const keys = Object.keys(patch);
  if (!keys.length) return p;
  const d = p.data;
  const type = { ...d.type, reading: { ...d.type.reading } };
  const themeReading = { ...d.theme.reading };
  const bgReading = { ...d.bg.reading };
  let voice: ProfileVoice | null = d.voice ? { ...d.voice } : null;
  let refs: ProfileRefs | null = d.refs ? { ...d.refs } : null;
  let touched = false;

  for (const [k, v] of Object.entries(patch)) {
    if (k === "arabicFont") { type.arabic = v as string; touched = true; continue; }
    if (k === "latinFont") { type.latin = v as string; touched = true; continue; }
    if (k === "numberColor") { themeReading.numbers = (v ?? null) as string | null; touched = true; continue; }
    if (k === "backgroundColor") { bgReading.overlay = (v ?? null) as string | null; touched = true; continue; }
    if ((TYPOGRAPHY_KEYS as readonly string[]).includes(k)) {
      (type.reading as unknown as Record<string, unknown>)[k] = v ?? null;
      touched = true;
      continue;
    }
    if ((TTS_TRACKING_KEYS as readonly string[]).includes(k)) {
      voice = { ...(voice ?? TTS_TRACKING_DEFAULTS) } as ProfileVoice;
      (voice as unknown as Record<string, unknown>)[k] = v;
      touched = true;
      continue;
    }
    if ((REF_RULE_KEYS as readonly string[]).includes(k)) {
      refs = { ...(refs ?? REF_RULE_DEFAULTS) } as unknown as ProfileRefs;
      (refs as unknown as Record<string, unknown>)[k] = v;
      touched = true;
      continue;
    }
  }
  if (!touched) return p;
  return { ...p, data: { ...d, type, theme: { ...d.theme, reading: themeReading }, bg: { ...d.bg, reading: bgReading }, voice, refs } };
}

/**
 * THE PICTURE A هيئة READS ON, and the adjustments it reads it with.
 *
 * TWO SURFACES, AND ONLY ONE OF THEM IS A BOOK'S. A هيئة carries a library picture and a reading
 * picture; the library one is the application's environment and stays where it is. This returns the
 * READING one only.
 *
 * `profileRefs` decides which id that is, rather than this file deciding again: a هيئة may say "the
 * same image, quieter", in which case the reading surface shows the LIBRARY's picture with the
 * reading surface's own adjustments — and that rule already exists, is what activation uses, and must
 * not be restated here where it could drift.
 */
export function readingBackgroundOf(p: Profile): { ref: string | null; params: BgParams } {
  return { ref: profileRefs(p).bgReading, params: p.data.bg.reading.params };
}

/**
 * The same هيئة with a reading-picture change folded into it — the background half of
 * `withReadingEdit`, and the reason the drawer's background controls have somewhere to write.
 *
 * `sameAsLibrary` IS CLEARED BY SETTING AN IMAGE, because it is a statement about where the reading
 * picture comes from and choosing one here answers that question differently. Leaving it set would
 * make the هيئة claim the library's picture while holding a reading ref nothing would ever read.
 */
export function withBackgroundEdit(
  p: Profile, patch: { ref?: string | null; params?: BgParams },
): Profile {
  const rd = { ...p.data.bg.reading };
  if (patch.params) rd.params = { ...patch.params };
  if (patch.ref !== undefined) {
    rd.ref = patch.ref;
    rd.sameAsLibrary = false;
  }
  return { ...p, data: { ...p.data, bg: { ...p.data.bg, reading: rd } } };
}

/**
 * THE هيئة'S OWN PAGE COLOUR AND INK — edited where they have always lived.
 *
 * WHAT THIS REPLACES, AND WHY IT WAS WRONG. A هيئة already carries a paper and an ink
 * (`theme.reading.colors.paperBg` / `.text`); the drawer's two colour rows wrote a SEPARATE session
 * override that shadowed them at render time — `style.pageColor ?? theme.colors.paperBg`. Two owners
 * for one visible property, and the session one was shared by every book, so a colour chosen while
 * reading one book repainted every other and no هيئة could be discarded back out of it.
 *
 * There is one owner now, and it is the one the reader is looking at. A هيئة's palette is where a
 * page colour belongs: it travels with the هيئة, it is shared by exactly the books that share the
 * هيئة, and it comes back on Discard with everything else.
 *
 * `null` MEANS "the palette's own", which is how the control spells «theme default» — so it resolves
 * from the preset the هيئة was built on rather than freezing today's value.
 */
export function withPaletteEdit(
  p: Profile,
  patch: { paperBg?: string | null; text?: string | null },
): Profile {
  const reading = p.data.theme.reading;
  const colors = { ...reading.colors };
  let touched = false;
  if (patch.paperBg !== undefined) {
    colors.paperBg = patch.paperBg ?? resolveBasePaper(reading, "paperBg");
    touched = true;
  }
  if (patch.text !== undefined) {
    colors.text = patch.text ?? resolveBasePaper(reading, "text");
    touched = true;
  }
  if (!touched) return p;
  // THE PRESET LINEAGE IS BROKEN BY A HAND-PICKED COLOUR, and saying so is the honest record: the
  // palette is no longer the preset it started from. `withPaperEdit` re-establishes it when a whole
  // paper is chosen again.
  return {
    ...p,
    data: { ...p.data, theme: { ...p.data.theme, reading: { ...reading, base: null, colors } } },
  };
}

/** What «theme default» resolves to for one slot: the preset this palette was built on, else itself. */
function resolveBasePaper(reading: Profile["data"]["theme"]["reading"], slot: "paperBg" | "text"): string {
  const base = reading.base;
  if (base && isBuiltinThemeId(base)) return resolveTheme(base).colors[slot];
  return reading.colors[slot];
}

/**
 * The same هيئة with a PAPER change folded into it.
 *
 * WHAT IT REPLACES AND WHAT IT LEAVES. A paper is a palette: the ground, the ink, the accent, the
 * polarity and the highlight alpha, plus `base`, which records which of the sixteen it started from
 * so the editor can still say "starts from Sepia" and offer to reset to it. Everything else the
 * reading palette carries is the هيئة's own and is NOT a paper — its bookmark colour, its number ink,
 * its separator, its panel relief — so those are preserved. A wholesale palette snapshot would have
 * silently dropped all four.
 *
 * `base` is the picked id for one of the sixteen and `null` for anything else, which is exactly the
 * rule the editor's own preset picker follows.
 */
export function withPaperEdit(p: Profile, id: string, picked: Theme): Profile {
  const reading = {
    ...p.data.theme.reading,
    base: isBuiltinThemeId(id) ? id : null,
    dark: picked.dark,
    colors: picked.colors,
    highlightAlpha: picked.highlightAlpha,
  };
  return { ...p, data: { ...p.data, theme: { ...p.data.theme, reading } } };
}

/**
 * WHETHER A BOOK IS CURRENTLY BEING READ IN A هيئة OF ITS OWN — and why anything outside the Reader
 * needs to know.
 *
 * `driftOf` asks "has the reader changed something that belongs to the هيئة they are wearing?", and it
 * answers by comparing the worn هيئة against what is LIVE — which it reads from `useReader.style`. With
 * a book resolving its own هيئة, that live style is a DIFFERENT هيئة's values, and the comparison would
 * report the worn one as edited by everything the two disagree about.
 *
 * That is not merely a false prompt. The save path reads the same live style and folds it into the worn
 * هيئة, so accepting that prompt would write هيئة C's measure into هيئة B — a saved هيئة silently
 * rewritten by which book happened to be open. Both call sites consult this instead.
 *
 * A module-level marker rather than a store: it is read from render and from a settings comparison that
 * cannot await, it has exactly one writer, and a reactive store here would invert the dependency — the
 * Profiles layer would import the Reader.
 */
let inForce: string | null = null;

/** The Reader says which هيئة a book has departed to, or `null` when it follows the worn one. */
export function noteBookAppearance(id: string | null): void {
  inForce = id;
}

/** The هيئة a book has departed to, if any. `null` means the live reading style is the session's own. */
export function bookAppearanceInForce(): string | null {
  return inForce;
}
