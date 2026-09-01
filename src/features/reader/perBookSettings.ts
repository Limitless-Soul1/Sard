// THE READING STYLE — one row, for every book.
//
// WHAT THIS FILE USED TO BE, and why it is smaller. Sard carried a two-level model (RAWY-40): GLOBAL
// reading defaults in the `reading_style` row, and a PARTIAL per-book override under
// `book_style:<bookId>`, resolved field-by-field as `{ ...global, ...override.style }`, with a
// `style_scope` setting choosing whether that second level applied at all.
//
// It is gone because a هيئة is now the complete reading appearance. Two levels meant two owners of
// the same fields, and the reader could see it: a book that had once been tuned kept its own type
// face, paper and read-aloud colours whatever هيئة was worn, so switching هيئة changed everything
// except the book in front of you. Measured on a real library — two books held their own
// tracking colours and neither followed a هيئة.
//
// EXISTING ROWS ARE LEFT WHERE THEY ARE. `book_style:<id>` is never read and never written now, so
// nothing a reader stored is destroyed — the same "ignore, never delete" rule the shared model always
// followed for overrides. Nothing in the app can resurrect them, which is the point: there is no
// second level left for a هيئة to lose to.

import { settingsGet, settingsSet } from "../../lib/ipc";
import { defaultsForDir, type ReadingStyle } from "../../reader-engine/injectedCss";

const GLOBAL_KEY = "reading_style";

/** The GLOBAL reading style (RAWY-39) — the one every book is read in. RAWY-176
 * (AUD-6): the per-script fallback is DIRECTION-AWARE. Pass the book's `dir` so any field the saved
 * row lacks falls back to the Arabic baseline for an RTL book (zoom 1.15 / line-height 1.9 /
 * text-align start) instead of the Latin one — otherwise a fresh install (no row yet) opened every
 * Arabic book at the Latin baseline. With no `dir` (or an LTR book) the base is LATIN_DEFAULTS,
 * exactly as before (`defaultsForDir(undefined) === LATIN_DEFAULTS`). Global Settings always writes
 * a FULL row, so on any machine that has a row every field is masked and existing users see no
 * change — the direction baseline only shows through when there is no row. */
export async function loadGlobalStyle(dir?: string): Promise<ReadingStyle> {
  const base = defaultsForDir(dir);
  const raw = await settingsGet(GLOBAL_KEY).catch(() => null);
  if (!raw) return { ...base };
  try {
    const s = JSON.parse(raw) as Partial<ReadingStyle>;
    // RAWY-23 migration: pageWidth used to be an absolute px (480..1040) → a 0..1 fraction.
    if (typeof s.pageWidth === "number" && s.pageWidth > 1.5) {
      s.pageWidth = Math.max(0, Math.min(1, (s.pageWidth - 480) / 560));
    }
    return { ...base, ...s };
  } catch {
    return { ...base };
  }
}

/** Persist the reading style. The reader's own drawer and Profiles both write this one row. */
export function saveGlobalStyle(style: ReadingStyle): void {
  settingsSet(GLOBAL_KEY, JSON.stringify(style)).catch(console.error);
}
