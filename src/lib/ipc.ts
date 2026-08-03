// Typed bindings over Tauri's invoke — the single Rust↔JS boundary (RAWY-08).
// Shapes mirror the serde structs in src-tauri/src/commands/mod.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

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


// ---- TTS (RAWY-105): bundled piper sidecar + on-demand voice download ----
/** Is the voice model present on disk (both .onnx + .onnx.json)? */
export const ttsVoicePresent = (id: string): Promise<boolean> =>
  invoke<boolean>("tts_voice_present", { id });
/** Download a voice's model into app-data, reporting a 0–1 progress fraction (RAWY-106). */
export const ttsDownloadVoice = (id: string, onProgress?: (frac: number) => void): Promise<void> => {
  const ch = new Channel<number>();
  if (onProgress) ch.onmessage = onProgress;
  return invoke<void>("tts_download_voice", { id, onProgress: ch });
};
/** Synthesize one sentence with the given engine → raw audio bytes (WebAudio decodes them).
 *  RAWY-110: engine-dispatched ("piper" WAV; "edge" MP3). */
export const ttsSynthesize = (engine: string, id: string, text: string): Promise<ArrayBuffer> =>
  invoke<ArrayBuffer>("tts_synthesize", { engine, id, text });

/** A selectable Edge (engine #2) neural voice. */
export interface EdgeVoiceInfo {
  id: string; // short_name, e.g. "ar-EG-SalmaNeural"
  lang: string; // locale, e.g. "ar-EG"
  gender: string;
  label: string; // friendly name, e.g. "Salma"
}
/** List the free Edge Read-Aloud voices (Arabic + English), for the picker (RAWY-111). */
export const ttsEdgeVoices = (): Promise<EdgeVoiceInfo[]> => invoke<EdgeVoiceInfo[]>("tts_edge_voices");
/** Stop + drop the persistent piper process. */
export const ttsStop = (): Promise<void> => invoke<void>("tts_stop");

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

// ---- Backgrounds (RAWY-265): managed user background images. ----
// Mirrors `backgrounds::Background`. `derivative_path` is null for the overwhelming majority of
// images and means "render the original" — nothing was resampled. See `lib/background.ts` for which
// of the two paths is actually loaded, and src-tauri/src/backgrounds/mod.rs for why a derivative
// exists at all (render ceiling + EXIF baking), always losslessly.
export interface BackgroundRow {
  id: string;
  original_path: string;
  derivative_path: string | null;
  source_name: string | null;
  width: number;
  height: number;
  /** 0..1 mean relative luminance, sampled at import — drives the "arrive correct" first paint. */
  mean_luma: number | null;
  added_at: number;
}

/** Import an image AND bind it to a surface, atomically. Rejects with a `bg.err.*` code the UI
 *  localises. NOT two calls: a bare import leaves the row unreferenced, and the GC that runs on any
 *  surface bind would collect the image the user just chose (verified in `tests/backgrounds.rs`). */
export const backgroundChoose = (surface: "library" | "reading", path: string): Promise<BackgroundRow> =>
  invoke<BackgroundRow>("background_choose", { surface, path });

export const backgroundsList = (): Promise<BackgroundRow[]> =>
  invoke<BackgroundRow[]>("backgrounds_list");

/** Bind a surface to a background id, or clear it with `null`. Orphan collection happens inside
 *  this call (D31 — zero orphans is structural, not a follow-up the caller must remember). */
export const backgroundSetSurface = (surface: "library" | "reading", id: string | null): Promise<boolean> =>
  invoke<boolean>("background_set_surface", { surface, id });

// ---- Bookmarks (RAWY-41): a saved CFI location, toggled at the current spot. ----
export interface BookmarkRow {
  id: string;
  book_id: string;
  cfi: string;
  chapter_label: string | null;
  fraction: number | null;
  label: string | null;
  created_at: number | null;
}
export interface BookmarkItem extends BookmarkRow {
  book_title: string | null;
  file_path: string;
  book_dir: string | null;
}

export const bookmarkCreate = (args: {
  bookId: string;
  cfi: string;
  chapterLabel?: string | null;
  fraction?: number | null;
  label?: string | null;
}): Promise<BookmarkRow | null> =>
  invoke<BookmarkRow | null>("bookmark_create", {
    bookId: args.bookId,
    cfi: args.cfi,
    chapterLabel: args.chapterLabel ?? null,
    fraction: args.fraction ?? null,
    label: args.label ?? null,
  });

export const bookmarkDelete = (id: string): Promise<boolean> => invoke<boolean>("bookmark_delete", { id });
export const bookmarksForBook = (bookId: string): Promise<BookmarkRow[]> =>
  invoke<BookmarkRow[]>("bookmarks_for_book", { bookId });
export const bookmarksAll = (): Promise<BookmarkItem[]> => invoke<BookmarkItem[]>("bookmarks_all");

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

/** RAWY-80 — import every EPUB inside a chosen folder (recursive). One result per EPUB found. */
export const importFolder = (dir: string): Promise<ImportResult[]> =>
  invoke<ImportResult[]>("import_folder", { dir });

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

/** RAWY-177 (AUD-4): hand PNG bytes to Rust as a RAW ipc body (octet-stream) instead of a JSON
 * number-array serialised on the UI thread — Rust spills them to a temp file and returns its path,
 * which the photo-card / cover commands then consume. A 2–4 MB PNG no longer hitches Save/Export. */
export const stagePng = (bytes: ArrayBuffer): Promise<string> =>
  invoke<string>("stage_png", bytes);

/** RAWY-49 — write a rendered photo-card PNG to a user-chosen path (bytes staged, not JSON'd). */
export const savePhotoCardFile = async (path: string, bytes: ArrayBuffer): Promise<void> => {
  const srcPath = await stagePng(bytes);
  await invoke("save_photo_card", { path, srcPath });
};

/** RAWY-85 — set a PDF's page-1 cover from PNG bytes (the reader extracts it on first open). */
export const bookSetCoverPng = async (id: string, bytes: ArrayBuffer): Promise<boolean> => {
  const pngPath = await stagePng(bytes);
  return invoke<boolean>("book_set_cover_png", { id, pngPath });
};

/** RAWY-76 — delete a book and cascade ALL related rows + files (zero orphans). `true` if it existed. */
export const bookDelete = (id: string): Promise<boolean> => invoke<boolean>("book_delete", { id });

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
  // RAWY-259: this highlight's OWN ink density (the editor's «كثافة الحبر»). `null` = follow the theme's
  // default, which is what every highlight created before the feature does — so old marks are unchanged.
  alpha: number | null;
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
  /** RAWY-282: optional heading, independent of `body`. `null` = no title (every pre-migration note). */
  title: string | null;
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
  note_id: string | null; // RAWY-203: the underlying note's id (null for a note-less highlight)
  tags: string[]; // RAWY-203: the note's tag names (empty when untagged / no note)
  note_title: string | null; // RAWY-282: the attached note's title (null when untitled / no note)
}

/**
 * RAWY-282 — the SINGLE definition of "this row is a note", used by every surface that splits the two
 * collections (the reader's Annotations panel and the library Inbox). Defined here, beside `AnnoItem`,
 * so the two lists can never drift into disagreeing about what an item is.
 *
 * `kind` alone is not the answer, and that was the bug: `annotations_all` folds a highlight's note INTO
 * the highlight row (its note branch is `highlight_id IS NULL`), so a highlighted passage that carries a
 * note arrives as `kind: "highlight"` WITH a body. Classifying on `kind` therefore listed that one
 * passage twice — once under Highlights and once under Notes.
 *
 * A row is a note if it IS a standalone note, or if it carries note content — body or title. Content,
 * not the mere existence of a note row: a highlight can own an empty-body note that exists only to hold
 * tags (RAWY-205), and that highlight must stay in Highlights rather than fall out of both lists.
 * `annoIsHighlight` is its exact complement, so the two collections are complementary and total.
 */
export const annoIsNote = (it: AnnoItem): boolean =>
  it.kind === "note" || (it.note ?? "").trim() !== "" || (it.note_title ?? "").trim() !== "";
export const annoIsHighlight = (it: AnnoItem): boolean => it.kind === "highlight" && !annoIsNote(it);

/** Every highlight + standalone note across all books, newest first. */
export const annotationsAll = (): Promise<AnnoItem[]> => invoke<AnnoItem[]>("annotations_all");

// Note tags (RAWY-203): user-defined categories, shared across books, many-to-many.
export interface Tag {
  id: string;
  name: string;
  created_at: number | null;
}
export const tagsList = (): Promise<Tag[]> => invoke<Tag[]>("tags_list");
export const tagCreate = (name: string): Promise<Tag | null> => invoke<Tag | null>("tag_create", { name });
export const tagDelete = (id: string): Promise<boolean> => invoke<boolean>("tag_delete", { id });
export const noteTagsFor = (noteId: string): Promise<Tag[]> => invoke<Tag[]>("note_tags_for", { noteId });
export const noteTagsSet = (noteId: string, tagIds: string[]): Promise<boolean> =>
  invoke<boolean>("note_tags_set", { noteId, tagIds });

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

/** RAWY-259: set this highlight's own ink density; `null` restores "follow the theme default". */
export const highlightSetAlpha = (id: string, alpha: number | null): Promise<HighlightRow | null> =>
  invoke<HighlightRow | null>("highlight_set_alpha", { id, alpha });

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
  /** RAWY-282. Omitted = untitled, which is what every existing caller means. */
  title?: string | null;
}): Promise<NoteRow | null> =>
  invoke<NoteRow | null>("note_create", {
    bookId: args.bookId,
    highlightId: args.highlightId ?? null,
    cfi: args.cfi ?? null,
    color: args.color ?? null,
    body: args.body,
    chapterLabel: args.chapterLabel ?? null,
    title: args.title ?? null,
  });

/** RAWY-282: `title` is written unconditionally (see `note_update` in Rust) — passing `null` CLEARS it,
 *  which is the only way an erased title can actually be erased. `color` still means "leave it alone". */
export const noteUpdate = (
  id: string,
  body: string,
  color?: string | null,
  title?: string | null,
): Promise<NoteRow | null> =>
  invoke<NoteRow | null>("note_update", { id, body, color: color ?? null, title: title ?? null });

export const noteDelete = (id: string): Promise<boolean> =>
  invoke<boolean>("note_delete", { id });

// Saved photo cards + gallery (RAWY-52, Photo Mode part 2a).
export interface PhotoCardRow {
  id: string;
  book_id: string | null;
  book_title: string | null;
  author: string | null;
  chapter_label: string | null;
  cfi: string | null;
  format: string | null;
  theme_id: string | null;
  quote: string | null;
  passages: string | null; // JSON array of { text, chapterLabel } for a multi-passage card (RAWY-60)
  quote_font: string | null; // RAWY-81 — the quote's own font key; null = follow the book font
  created_at: number;
  image_path: string; // absolute path to the stored PNG (load via convertFileSrc)
}

export const photocardSave = async (args: {
  id: string;
  bookId?: string | null;
  bookTitle?: string | null;
  author?: string | null;
  chapterLabel?: string | null;
  cfi?: string | null;
  format?: string | null;
  themeId?: string | null;
  quote?: string | null;
  passages?: string | null;
  quoteFont?: string | null;
  createdAt: number;
  png: ArrayBuffer; // RAWY-177 (AUD-4): the card PNG, staged as a raw ipc body (not a JSON array)
}): Promise<PhotoCardRow> => {
  const pngPath = await stagePng(args.png);
  return invoke<PhotoCardRow>("photocard_save", {
    id: args.id,
    bookId: args.bookId ?? null,
    bookTitle: args.bookTitle ?? null,
    author: args.author ?? null,
    chapterLabel: args.chapterLabel ?? null,
    cfi: args.cfi ?? null,
    format: args.format ?? null,
    themeId: args.themeId ?? null,
    quote: args.quote ?? null,
    passages: args.passages ?? null,
    quoteFont: args.quoteFont ?? null,
    createdAt: args.createdAt,
    pngPath,
  });
};

export const photocardsList = (): Promise<PhotoCardRow[]> => invoke<PhotoCardRow[]>("photocards_list");
export const photocardDelete = (id: string): Promise<boolean> => invoke<boolean>("photocard_delete", { id });

// RAWY-260 — REFERENCES: a note bound to a PHRASE (word or short phrase), scoped to one book.
// Not a highlight/note/bookmark: there is no CFI, because a reference belongs to the term itself and
// marks EVERY occurrence of it in the book — including passages read long after it was created.
export interface RefRow {
  id: string;
  book_id: string;
  /** Exactly as the reader selected it — shown verbatim in the dialog and popup (tashkīl preserved). */
  phrase: string;
  /** The folded MATCHING key (see foldPhrase) — never displayed. */
  phrase_fold: string;
  /** Token count, so section matching can skip the multi-token scan for single-word references. */
  word_count: number;
  note: string;
  created_at: number | null;
  updated_at: number | null;
}

export const refsForBook = (bookId: string): Promise<RefRow[]> =>
  invoke<RefRow[]>("refs_for_book", { bookId });

/** Create OR update in one call — the dialog uses a single path for both, so re-referencing edits. */
export const refSave = (
  bookId: string,
  phrase: string,
  phraseFold: string,
  wordCount: number,
  note: string,
): Promise<RefRow | null> =>
  invoke<RefRow | null>("ref_save", { bookId, phrase, phraseFold, wordCount, note });

export const refDelete = (id: string): Promise<boolean> => invoke<boolean>("ref_delete", { id });
