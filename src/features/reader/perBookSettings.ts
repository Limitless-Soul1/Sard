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
/**
 * THE DIRECTION THE ROW WAS LAST RESOLVED FOR.
 *
 * The row is direction-aware: a field it does not carry falls back to the Arabic baseline for an RTL
 * book and the Latin one otherwise (AUD-6, below). So the row alone is not a reading style — it is a
 * reading style AND the direction it should be read with, and outside the Reader the second half was
 * simply unavailable.
 *
 * That mattered once the reader's own changes began to outlive the session: the Library has to be
 * able to say whether the worn هيئة has been changed, and comparing a row resolved against the Latin
 * baseline with a هيئة resolved against the Arabic one reports drift on an Arabic reader who has
 * changed nothing. Storing the direction beside the row makes both halves available anywhere.
 */
const GLOBAL_DIR_KEY = "reading_style_dir";

/**
 * The last resolved style, kept in memory so anything can ask "what is Sard reading in?" without an
 * await — `driftOf` is synchronous by design and is called from render.
 *
 * It is a CACHE OF THE PERSISTED ROW, not a second source of truth: it is written only where the row
 * itself is read or written, so the two cannot part.
 */
let cached: { row: Partial<ReadingStyle>; dir?: string } | null = null;

/**
 * What Sard is reading in, as far as the last load or save knows. `null` before either has happened.
 *
 * THE ROW IS CACHED RAW AND RESOLVED HERE, NOT AT LOAD TIME, and the difference is a real defect this
 * closes. The cache used to hold the RESOLVED style — the row merged over `defaultsForDir(dir)` — so
 * whatever direction the CALLER passed decided what every absent field became. A caller that
 * legitimately does not care about direction passes none and gets the Latin baseline, which is
 * correct for that caller and wrong for the cache: the هيئة editor calls `loadGlobalStyle()` with no
 * direction just to read the two font names, and that quietly rewrote the shared answer to
 * "what is Sard showing?" from an Arabic resolution to a Latin one.
 *
 * MEASURED: `driftOf` answered ["zoom","marginPx"] before the editor opened and
 * ["zoom","marginPx","align"] after, on a byte-identical row that carries no `align` at all — the
 * هيئة asserted the RTL default "start" throughout while the cache had silently become "justify".
 *
 * Resolving on READ makes the answer depend only on the row and the direction the cache itself
 * records, so no caller can perturb it and the same question twice gives the same answer.
 */
export function peekGlobalStyle(): ReadingStyle | null {
  if (!cached) return null;
  return { ...defaultsForDir(cached.dir), ...cached.row };
}

/** The direction that style was resolved for, so a caller can resolve a comparison the same way. */
export function peekGlobalDir(): string | undefined {
  return cached ? cached.dir : undefined;
}

/**
 * TELL THE CACHE THE ROW HAS CHANGED UNDER IT.
 *
 * THE DEFECT THIS CLOSES. Wearing a هيئة writes `reading_style` through `patchReadingStyle`, which
 * assembles the row itself (clearing the fields the هيئة does not name, setting the ones it does) and
 * persists it with a bare `settingsSet`. That is the right shape for the write and it went straight
 * past this cache — so `peekGlobalStyle` went on answering with the PREVIOUS هيئة's values, and
 * `driftOf` compared a freshly-applied هيئة against them and reported changes the reader had never
 * made.
 *
 * MEASURED: a هيئة saved with the Noto Naskh face at 135% and worn immediately reported eleven
 * drifted fields, with the هيئة asking for `notoNaskh`/1.35, the ROW already holding `notoNaskh`/1.35,
 * and the cache still holding `plexArabic`/2.5. Restarting cleared it — which is exactly the shape of
 * a stale copy rather than a data fault, and why the warning came back on every return to the هيئة.
 *
 * So every writer of the row says so here. There is one, and this is how it stays one: a second
 * writer that forgets this call reintroduces the same class of bug, which is why the row's key is
 * private to this module and the write path is named rather than duplicated.
 */
export function noteGlobalStyleRow(row: Partial<ReadingStyle>): void {
  cached = { row, dir: cached?.dir };
}

/**
 * Fill the cache before any book is open, so the Library can answer the same questions the Reader can.
 *
 * Uses the stored direction, which is the direction of the last book actually read — the honest
 * answer to "which baseline do this reader's absent fields resolve against".
 */
export async function primeGlobalStyle(): Promise<void> {
  if (cached) return;
  const dir = (await settingsGet(GLOBAL_DIR_KEY).catch(() => null)) || undefined;
  await loadGlobalStyle(dir || undefined);
}

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
  // Remember which baseline this resolution used, for every later comparison — including the ones
  // made in the Library, where no book names a direction.
  if (dir) settingsSet(GLOBAL_DIR_KEY, dir).catch(console.error);
  // The RAW row is what is remembered; the direction only ever moves FORWARD to a real one, so a
  // caller that passes none reads what it asked for without changing what anything else sees.
  const remember = (row: Partial<ReadingStyle>): void => {
    cached = { row, dir: dir ?? cached?.dir };
  };
  if (!raw) { remember({}); return { ...base }; }
  try {
    const s = JSON.parse(raw) as Partial<ReadingStyle>;
    // RAWY-23 migration: pageWidth used to be an absolute px (480..1040) → a 0..1 fraction.
    if (typeof s.pageWidth === "number" && s.pageWidth > 1.5) {
      s.pageWidth = Math.max(0, Math.min(1, (s.pageWidth - 480) / 560));
    }
    // The withdrawn `dim`. A row saved while the third chip existed still says so, and nothing in a
    // JSON row is type-checked — so it would arrive as a value no control can show and no rule can
    // paint, leaving the segmented control with nothing selected. It reads as `show`, which is what
    // the page already looked like once the rule for it was gone. `remember` is given the CORRECTED
    // row so the next write persists the migration rather than re-reading the old answer for ever.
    if ((s.diacritics as string) === "dim") s.diacritics = "show";
    remember(s);
    return { ...base, ...s };
  } catch {
    remember({});
    return { ...base };
  }
}

/** Persist the reading style. The reader's own drawer and Profiles both write this one row. */
export function saveGlobalStyle(style: ReadingStyle): void {
  // A saved style is fully resolved — every field explicit — so it is a sound raw row, and caching it
  // keeps `peekGlobalStyle` in step with the write without a re-read.
  cached = { row: style, dir: cached?.dir };
  settingsSet(GLOBAL_KEY, JSON.stringify(style)).catch(console.error);
}
