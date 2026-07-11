// Per-book reading settings (RAWY-40, decision extends D11/D26). The two-level model: GLOBAL
// reading defaults (RAWY-39, the `reading_style` row) are the baseline; each book stores a PARTIAL
// override under `book_style:<bookId>` in the settings table (the RAWY-19 COALESCE pattern, as a
// JSON blob). Effective = { ...globalDefaults, ...override.style } field-by-field; the per-book
// theme = override.themeId ?? globalThemeId. So changing a setting WHILE READING affects only that
// book, untouched fields keep following the global default, and "Reset to app default" deletes the
// row → the book follows global entirely.

import { settingsGet, settingsSet } from "../../lib/ipc";
import { defaultsForDir, type ReadingStyle } from "../../reader-engine/injectedCss";
import type { ThemeId } from "../../theme";

const GLOBAL_KEY = "reading_style";
const bookKey = (bookId: string) => `book_style:${bookId}`;

export interface BookOverride {
  style?: Partial<ReadingStyle>; // only the typography/textColor fields the user changed for this book
  themeId?: ThemeId; // per-book paper + ink (RAWY-40)
}

/** The GLOBAL reading defaults (RAWY-39) — the baseline a book uses with no override. RAWY-176
 * (AUD-6): the per-script fallback is DIRECTION-AWARE. Pass the book's `dir` so any field the saved
 * global row lacks falls back to the Arabic baseline for an RTL book (zoom 1.15 / line-height 1.9 /
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

/** Persist the GLOBAL reading style (RAWY-43 unified mode writes here, like Global Settings). */
export function saveGlobalStyle(style: ReadingStyle): void {
  settingsSet(GLOBAL_KEY, JSON.stringify(style)).catch(console.error);
}

export async function loadBookOverride(bookId: string): Promise<BookOverride> {
  const raw = await settingsGet(bookKey(bookId)).catch(() => null);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as BookOverride;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

export function saveBookOverride(bookId: string, override: BookOverride): void {
  // An empty override is the same as none → clear the row so the book follows global again.
  const isEmpty = (!override.style || Object.keys(override.style).length === 0) && !override.themeId;
  settingsSet(bookKey(bookId), isEmpty ? "" : JSON.stringify(override)).catch(console.error);
}

export function clearBookOverride(bookId: string): void {
  settingsSet(bookKey(bookId), "").catch(console.error);
}

/** Effective reading style = global defaults with the book's partial override applied on top. */
export function effectiveStyle(global: ReadingStyle, override: BookOverride): ReadingStyle {
  return { ...global, ...(override.style ?? {}) };
}

export function hasOverride(o: BookOverride): boolean {
  return !!(o.themeId || (o.style && Object.keys(o.style).length > 0));
}
