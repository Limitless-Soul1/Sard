// Typed bindings over Tauri's invoke — the single Rust↔JS boundary (RAWY-08).
// Shapes mirror the serde structs in src-tauri/src/commands/mod.rs.

import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  app_data_dir: string;
  db_path: string;
  schema_version: number;
}

export interface DbHealth {
  ok: boolean;
  schema_version: number;
  tables: string[];
}

/** Resolved app-data dir, DB path, and current schema version. */
export const appInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");

/** Liveness + schema version + the list of tables from sqlite_master. */
export const dbHealth = (): Promise<DbHealth> => invoke<DbHealth>("db_health");

/** Read a persisted setting (null if absent). */
export const settingsGet = (key: string): Promise<string | null> =>
  invoke<string | null>("settings_get", { key });

/** Persist a setting; resolves true on success. */
export const settingsSet = (key: string, value: string): Promise<boolean> =>
  invoke<boolean>("settings_set", { key, value });

// ---- Fonts (RAWY-39): import + list user fonts (stored under app-data/fonts, served via asset). ----
export interface CustomFont {
  id: string;
  family_name: string;
  file_path: string;
  script: string | null;
}

/** Copy a font file into the app + record it; returns the new row. */
export const fontImport = (path: string): Promise<CustomFont> =>
  invoke<CustomFont>("font_import", { path });

/** List imported fonts (newest first). */
export const fontsList = (): Promise<CustomFont[]> => invoke<CustomFont[]>("fonts_list");

/** Remove an imported font (row + managed file). */
export const fontRemove = (id: string): Promise<boolean> => invoke<boolean>("font_remove", { id });

export interface Progress {
  cfi: string | null;
  fraction: number;
}

/** Ensure a minimal books row exists (FK bridge until real import). */
export const bookRegister = (bookId: string, filePath: string): Promise<boolean> =>
  invoke<boolean>("book_register", { bookId, filePath });

/** Upsert reading position (CFI + fraction) for a book. */
export const progressSave = (
  bookId: string,
  cfi: string,
  fraction: number,
): Promise<boolean> => invoke<boolean>("progress_save", { bookId, cfi, fraction });

/** Read saved reading position, or null if never opened. */
export const progressGet = (bookId: string): Promise<Progress | null> =>
  invoke<Progress | null>("progress_get", { bookId });

// ---- Library (RAWY-15) ----------------------------------------------------

export interface BookRow {
  id: string;
  file_path: string;
  format: string | null;
  title: string | null;
  author: string | null;
  language: string | null;
  dir: string | null;
  cover_path: string | null;
  added_at: number | null;
  last_opened_at: number | null;
  fraction: number | null;
  read_at: number | null;
  cover_fit: string | null; // per-book crop/fit override (RAWY-19)
}

export type SortKey = "title" | "author" | "format" | "date_read" | "date_added";
export type SortOrder = "asc" | "desc";

export interface ListQuery {
  sort: SortKey;
  order: SortOrder;
  format?: string | null;
  collection?: string | null;
  search?: string | null;
}

/** List Library books (metadata joined with progress), sorted + filtered in SQL. */
export const libraryListBooks = (q: ListQuery): Promise<BookRow[]> =>
  invoke<BookRow[]>("library_list_books", {
    sort: q.sort,
    order: q.order,
    format: q.format ?? null,
    collection: q.collection ?? null,
    search: q.search ?? null,
  });

export interface CollectionRow {
  id: string;
  name: string;
  count: number;
}

/** List shelves (collections) with live book counts. */
export const collectionsList = (): Promise<CollectionRow[]> =>
  invoke<CollectionRow[]>("collections_list");

// RAWY-31 — shelf writes. Each returns the refreshed shelf list (names + live counts).
export const collectionCreate = (name: string): Promise<CollectionRow[]> =>
  invoke<CollectionRow[]>("collection_create", { name });
export const collectionRename = (id: string, name: string): Promise<CollectionRow[]> =>
  invoke<CollectionRow[]>("collection_rename", { id, name });
export const collectionDelete = (id: string): Promise<CollectionRow[]> =>
  invoke<CollectionRow[]>("collection_delete", { id });
export const collectionAddBook = (collectionId: string, bookId: string): Promise<CollectionRow[]> =>
  invoke<CollectionRow[]>("collection_add_book", { collectionId, bookId });
export const collectionRemoveBook = (collectionId: string, bookId: string): Promise<CollectionRow[]> =>
  invoke<CollectionRow[]>("collection_remove_book", { collectionId, bookId });
/** The shelf ids a book currently belongs to (for the edit-dialog chips). */
export const collectionsForBook = (bookId: string): Promise<string[]> =>
  invoke<string[]>("collections_for_book", { bookId });

export type ImportStatus = "imported" | "duplicate" | "unsupported" | "error";

export interface ImportResult {
  id: string;
  title: string;
  status: ImportStatus;
  message: string | null;
}

/** Import EPUB files (copy-in, hash/dedup, extract metadata + cover). One result per path. */
export const importBooks = (paths: string[]): Promise<ImportResult[]> =>
  invoke<ImportResult[]>("import_books", { paths });

export interface BookPatch {
  title?: string;
  author?: string;
  language?: string;
  dir?: string;
  coverFit?: string; // "crop" | "fit" | "" (clear)
}

/** Edit a book's metadata as overrides (never rewrites the source EPUB). Returns the book. */
export const bookUpdate = (id: string, patch: BookPatch): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_update", { id, patch });

/** Replace a book's cover with a copied-in image. Returns the updated book. */
export const bookSetCover = (id: string, imagePath: string): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_set_cover", { id, imagePath });

/** Revert to the extracted/auto cover. Returns the updated book. */
export const bookRevertCover = (id: string): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_revert_cover", { id });

// ---- Highlights + notes (RAWY-20) -----------------------------------------

// A highlight colour is a semantic slot name (adapts per theme) OR a literal #hex (custom).
// Stored as TEXT in SQLite either way; resolveColor / colorValue handle both (RAWY-20/22).
export type HighlightColor = string;

export interface HighlightRow {
  id: string;
  book_id: string;
  cfi: string; // the range CFI
  color: HighlightColor;
  text_excerpt: string | null;
  chapter_label: string | null;
  created_at: number | null;
}

export interface NoteRow {
  id: string;
  book_id: string;
  highlight_id: string | null;
  cfi: string | null;
  color: string | null;
  body: string | null;
  chapter_label: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export const highlightsForBook = (bookId: string): Promise<HighlightRow[]> =>
  invoke<HighlightRow[]>("highlights_for_book", { bookId });

// ---- Cross-book Highlights & Notes inbox (RAWY-27) ------------------------

export interface AnnoItem {
  id: string;
  kind: "highlight" | "note";
  book_id: string;
  book_title: string | null;
  file_path: string;
  book_dir: string | null;
  chapter_label: string | null;
  color: string | null;
  text: string | null; // highlight excerpt OR note body
  note: string | null; // a highlight's attached note body (if any)
  cfi: string | null; // jump target
  created_at: number | null;
}

/** Every highlight + standalone note across all books, newest first. */
export const annotationsAll = (): Promise<AnnoItem[]> => invoke<AnnoItem[]>("annotations_all");

export const highlightCreate = (
  bookId: string,
  cfi: string,
  color: HighlightColor,
  excerpt?: string | null,
  chapterLabel?: string | null,
): Promise<HighlightRow | null> =>
  invoke<HighlightRow | null>("highlight_create", { bookId, cfi, color, excerpt: excerpt ?? null, chapterLabel: chapterLabel ?? null });

export const highlightSetColor = (id: string, color: HighlightColor): Promise<HighlightRow | null> =>
  invoke<HighlightRow | null>("highlight_set_color", { id, color });

export const highlightDelete = (id: string): Promise<boolean> =>
  invoke<boolean>("highlight_delete", { id });

export const notesForBook = (bookId: string): Promise<NoteRow[]> =>
  invoke<NoteRow[]>("notes_for_book", { bookId });

export const noteCreate = (args: {
  bookId: string;
  highlightId?: string | null;
  cfi?: string | null;
  color?: string | null;
  body: string;
  chapterLabel?: string | null;
}): Promise<NoteRow | null> =>
  invoke<NoteRow | null>("note_create", {
    bookId: args.bookId,
    highlightId: args.highlightId ?? null,
    cfi: args.cfi ?? null,
    color: args.color ?? null,
    body: args.body,
    chapterLabel: args.chapterLabel ?? null,
  });

export const noteUpdate = (id: string, body: string, color?: string | null): Promise<NoteRow | null> =>
  invoke<NoteRow | null>("note_update", { id, body, color: color ?? null });

export const noteDelete = (id: string): Promise<boolean> =>
  invoke<boolean>("note_delete", { id });
