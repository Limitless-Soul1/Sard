// Per-book reading settings (RAWY-40, decision extends D11/D26). The two-level model: GLOBAL
// reading defaults (RAWY-39, the `reading_style` row) are the baseline; each book stores a PARTIAL
// override under `book_style:<bookId>` in the settings table (the RAWY-19 COALESCE pattern, as a
// JSON blob). Effective = { ...globalDefaults, ...override.style } field-by-field; the per-book
// theme = override.themeId ?? globalThemeId. So changing a setting WHILE READING affects only that
// book, untouched fields keep following the global default, and "Reset to app default" deletes the
// row → the book follows global entirely.

import { settingsGet, settingsSet } from "../../lib/ipc";
import { LATIN_DEFAULTS, type ReadingStyle } from "../../reader-engine/injectedCss";
import type { ThemeId } from "../../theme";

const GLOBAL_KEY = "reading_style";
const bookKey = (bookId: string) => `book_style:${bookId}`;

export interface BookOverride {
  style?: Partial<ReadingStyle>; // only the typography/textColor fields the user changed for this book
  themeId?: ThemeId; // per-book paper + ink (RAWY-40)
}

/** The GLOBAL reading defaults (RAWY-39) — the baseline a book uses with no override. */
export async function loadGlobalStyle(): Promise<ReadingStyle> {
  const raw = await settingsGet(GLOBAL_KEY).catch(() => null);
  if (!raw) return { ...LATIN_DEFAULTS };
  try {
    const s = JSON.parse(raw) as Partial<ReadingStyle>;
    // RAWY-23 migration: pageWidth used to be an absolute px (480..1040) → a 0..1 fraction.
    if (typeof s.pageWidth === "number" && s.pageWidth > 1.5) {
      s.pageWidth = Math.max(0, Math.min(1, (s.pageWidth - 480) / 560));
    }
    return { ...LATIN_DEFAULTS, ...s };
  } catch {
    return { ...LATIN_DEFAULTS };
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
