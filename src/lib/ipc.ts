// Typed bindings over Tauri's invoke — the single Rust↔JS boundary (RAWY-08).
// Shapes mirror the serde structs in src-tauri/src/commands/mod.rs.

import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  /** The build the RUST CORE was compiled as — compare with __SARD_BUILD_ID__ (the frontend bundle). */
  build_id: string;
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


// ---- TTS: synthesis over the Edge Read-Aloud voices ----
/** Synthesize one sentence with the given engine → raw audio bytes (WebAudio decodes them).
 *  RAWY-110: engine-dispatched ("edge" MP3). */
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
/** Stop + drop the warm Edge connection. */
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

/** What a font file says about itself — the drop gate's answer. Rejection is a `font.err.*` key. */
export interface FontFacts {
  family: string;
  style: string | null;
  /** ttf · otf · ttc · woff · woff2 */
  format: string;
  /** True when the family came from the font's own `name` table rather than from the filename. */
  named_by_font: boolean;
  /**
   * Does the font carry Arabic letters? Read from its `cmap`, never from its name.
   *
   * `null` is a real third state, not a "no": a `.woff`/`.woff2` keeps every table deflated, so the
   * scripts cannot be read without a decompressor the core deliberately does not carry. The preview
   * says "could not be determined" for those rather than claiming either answer.
   */
  arabic: boolean | null;
  /** The same question for Latin, from the same source, with the same third state. */
  latin: boolean | null;
}

/** What a dropped font did. */
export interface FontDrop {
  outcome: "imported" | "duplicate";
  family: string;
  style: string | null;
  format: string;
}

/**
 * Read a font file and change NOTHING — the routing gate for a dropped file.
 *
 * Rejects with a `font.err.*` key, which is what lets the drop fall through to the next candidate
 * exactly as a file that is not a deposit does.
 */
export const fontInspect = (path: string): Promise<FontFacts> =>
  invoke<FontFacts>("font_inspect", { path });

/** Import a dropped font under the family the FILE names; says whether it was already here. */
export const fontImportDropped = (path: string): Promise<FontDrop> =>
  invoke<FontDrop>("font_import_dropped", { path });

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

/** Import an image WITHOUT binding a surface — the profile editor's path. Binding is what
 *  `applyProfile` does; a draft must not repaint the running app or write a global binding.
 *  The row is unreferenced until the profile is saved, which is correct: an abandoned draft's
 *  image IS an orphan. See `background_import` for why that direction is the safe one. */
/** PROFILES (stage 6) — write a package to a path the reader chose. Settings only. */
/**
 * A packageable asset, resolved by Rust from the profile's own references.
 *
 * The frontend never builds these: it renders them, lets the reader switch them off, and hands the
 * survivors back to `profileExport`. That is what keeps the share sheet and the archive the same
 * list rather than two lists that can drift.
 */
export interface PlannedAsset {
  kind: "background" | "icon" | "font";
  id: string;
  member: string;
  source: string;
  name: string;
  bytes: number;
  family: string | null;
  /** Which of `library` / `reading` / `icon` this one file serves. */
  surfaces: string[];
}

/** What CAN travel with this profile, with real byte sizes. Resolves nothing the profile does not name. */
export const profileAssetPlan = (
  libraryRef: string | null,
  readingRef: string | null,
  iconRef: string | null,
  families: string[],
): Promise<PlannedAsset[]> =>
  invoke<PlannedAsset[]>("profile_asset_plan", { libraryRef, readingRef, iconRef, families });

export const profileExport = (
  path: string,
  manifestJson: string,
  assets: { member: string; source: string }[] = [],
): Promise<void> => invoke<void>("profile_export", { path, manifestJson, assets });

/**
 * One asset's BYTES from a package, for the import preview to draw.
 *
 * Reads only — nothing is unpacked, so the preview can show the picture and the icon that are
 * arriving without anything entering the reader's installation before they say yes.
 */
export const profilePackageAsset = (path: string, member: string): Promise<number[]> =>
  invoke<number[]>("profile_package_asset", { path, member });

/** Read a package's manifest, changing nothing. Rejects with a `pkg.err.*` code. */
export const profileImportInspect = (path: string): Promise<string> =>
  invoke<string>("profile_import_inspect", { path });

/** Commit an inspected package under a fresh id. Re-checks the manifest rather than trusting it. */
export const profileImportCommit = (
  manifestJson: string,
  newId: string,
  /** The archive the manifest came from — present = register its assets too. */
  path?: string | null,
): Promise<ProfileRow> =>
  invoke<ProfileRow>("profile_import_commit", { manifestJson, newId, path: path ?? null });

export const backgroundImport = (path: string): Promise<BackgroundRow> =>
  invoke<BackgroundRow>("background_import", { path });

/** Import an image for a card that is still being composed, binding it in the same transaction.
 *  Use this rather than `backgroundImport` from the composer: a bare import leaves the row
 *  unreferenced, and the collector runs whenever anyone changes their wallpaper — so an imported
 *  sticker could be deleted before the card was ever saved. */
export const photocardStageImage = (cardId: string, path: string): Promise<BackgroundRow> =>
  invoke<BackgroundRow>("photocard_stage_image", { cardId, path });

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
  /** The opening words of the block this place sits in, captured when it was marked. */
  label: string | null;
  /** The dye it was marked in. `null` for a place saved before the reader could choose one. */
  color: string | null;
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
  color?: string | null;
}): Promise<BookmarkRow | null> =>
  invoke<BookmarkRow | null>("bookmark_create", {
    bookId: args.bookId,
    cfi: args.cfi,
    color: args.color ?? null,
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
  /** RESILIENCE-1 / WP-3: per-field provenance JSON from the WP-2 compatibility layer,
   *  e.g. {"author":"default","title":"filename"}. Read through `lib/bookMeta.ts`. */
  meta_provenance: string | null;
  /** WP-5A: the script sniffed from the book's text at import — "arabic" | "latin" | null.
   *  The TTS pre-flight gates on this rather than on the declared language. */
  script_detected: string | null;
  /** WP-6: 1 when the book has far too few TOC entries for its spine (contents are synthesised). */
  toc_degenerate: number | null;
  /** WP-6: 1 when the spine is many tiny sections (the book defaults to scrolled flow). */
  spine_fragmented: number | null;
  /** Imported file size — the Spines view's only measure of how thick a book is. */
  size_bytes: number | null;
  /** Book Details' jacket controls. Null = Sard's own choice for this book. */
  cover_paint: string | null;
  /** "file" | "typeset" */
  cover_mode: string | null;
  /** "typeset" | "none" */
  spine_mode: string | null;
  /** A chosen spine image, absolute, or null. */
  spine_image: string | null;
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

// ---------------------------------------------------------------------------
// Library structure — cases above shelves, categories inside them, hand order.
// Layered on the SAME `collections`/`book_collections` tables the calls above use, so a
// shelf read here is the shelf read there. Every write returns the refreshed tree, which
// is why none of these need a follow-up read.
// ---------------------------------------------------------------------------

/** How a shelf orders what it shows. `hand` = the reader's own arrangement. */
export type ShelfOrder = "hand" | "title" | "author" | "added" | "recent" | "progress";
/** A shelf that fills itself from the library instead of holding membership. */
export type ShelfRule = "reading" | "finished" | "added";

export interface CategoryNode {
  id: string;
  name: string;
  count: number;
}

export interface ShelfNode {
  id: string;
  name: string;
  /** The shelf's own colour; null = fall back to its case's. */
  ink: string | null;
  case_id: string | null;
  order_rule: ShelfOrder;
  /** Non-null = self-filling; placing a book on it is refused by the backend. */
  auto_rule: ShelfRule | null;
  collapsed: boolean;
  count: number;
  categories: CategoryNode[];
}

export interface CaseNode {
  id: string;
  name: string;
  ink: string | null;
  /** Distinct books across the case's shelves — not the sum of shelf counts. */
  count: number;
  shelves: ShelfNode[];
}

export interface LibraryTree {
  cases: CaseNode[];
  /** Shelves belonging to no case. */
  loose: ShelfNode[];
}

/** One membership row in the shelf's own order. */
export interface ShelfItem {
  book_id: string;
  position: number;
  category_id: string | null;
}

/**
 * WHERE ONE BOOK IS, AND WHERE IT SITS AMONG ITS NEIGHBOURS.
 *
 * `container` is a shelf id or `UNFILED`. `rank` is an opaque ordering key: compare two with `<`,
 * never parse one, never invent one. A book has exactly one of these — the table's primary key is
 * the book — so there is no question of which of its homes counts.
 */
export interface Placement {
  book_id: string;
  container: string;
  rank: string;
  category_id: string | null;
}

/**
 * The container holding every book that is on no shelf. A real place, with an order of its own.
 *
 * `LOOSE_SHELF_ID` in the library model is this same value, imported rather than repeated — the two
 * were written out separately once, disagreed, and gave one container two identities.
 */
export const UNFILED = "__unshelved";

/**
 * The whole arrangement in one read: every placement, and the shelves they hang on.
 *
 * One call rather than one per shelf. Asking shelf by shelf let two answers come from either side
 * of a write, which is how the screen could show a book in two places or in none.
 */
/**
 * What a lens currently matches.
 *
 * A rule shelf owns nothing — its contents are a query — so these ids are a VIEW of the library
 * rather than part of it. They are carried so the reader can still see «قيد القراءة» while none of
 * those books acquires a second home from being listed there.
 */
export interface Lens {
  shelf_id: string;
  book_ids: string[];
}

export interface Arrangement {
  tree: LibraryTree;
  placements: Placement[];
  lenses: Lens[];
  /** The baseline for a run that has never been arranged. */
  view_order_epoch: number;
}

export const libraryArrangement = (): Promise<Arrangement> => invoke<Arrangement>("library_arrangement");

/** What a placement attempt did. `changed` is false when the book was already exactly there. */
export interface Placed {
  changed: boolean;
  container: string;
  rank: string;
}

export interface PlaceResult {
  placed: Placed;
  arrangement: Arrangement;
}

/**
 * MOVE A BOOK IN FRONT OF ANOTHER — the one arrangement write.
 *
 * `before` is the book the release landed in front of, or `null` for the end of the container. A
 * neighbour, not an index: an index has to be corrected for the book's own removal and has to agree
 * with a list drawn some milliseconds ago, and both were sources of silent error.
 *
 * The reply carries the arrangement as it now stands, so the screen is redrawn from what was
 * actually persisted rather than from a guess or a second read that could race the first.
 */
/**
 * Put a book in a container, and leave `from`.
 *
 * `from` names the ONE shelf the move leaves. Omitting it means «here and nowhere else», which
 * deletes every other membership the book has — right while a book could only be in one place, and
 * data loss now that it can be in several. Anything that is a move from somewhere should say where.
 */
export const libraryPlaceBook = (
  bookId: string,
  container: string,
  before: string | null,
  categoryId: string | null = null,
  from: string | null = null,
): Promise<PlaceResult> =>
  invoke<PlaceResult>("library_place_book", { bookId, container, before, categoryId, from });

/**
 * ADD a book to a shelf, keeping every shelf it is already on.
 *
 * The additive counterpart to `libraryPlaceBook`, which means "here and nowhere else". Separate
 * functions rather than a flag, so a reader of the call site can see which one it is. Idempotent:
 * `placed.changed` is false when the book was already on that shelf, and nothing was written.
 */
export const libraryAddBookToShelf = (
  bookId: string,
  container: string,
  categoryId: string | null = null,
): Promise<PlaceResult> =>
  invoke<PlaceResult>("library_add_book_to_shelf", { bookId, container, categoryId });

/**
 * SHOW A FILE WHERE IT IS, in the system's own file manager, with the file selected.
 *
 * The answer to "where did my package go" is the folder it is in, opened — not a path for the
 * reader to copy and paste somewhere else. `showed` says what actually happened: "file" when the
 * package itself was picked out, "folder" when it had gone and its folder was opened instead. A
 * rejection carries a `reveal.err.*` code the interface translates.
 */
export interface Revealed {
  showed: "file" | "folder";
}

export const revealPath = (path: string): Promise<Revealed> =>
  invoke<Revealed>("reveal_path", { path });

export const libraryTree = (): Promise<LibraryTree> => invoke<LibraryTree>("library_tree");
export const libraryShelfItems = (collectionId: string): Promise<ShelfItem[]> =>
  invoke<ShelfItem[]>("library_shelf_items", { collectionId });

export const caseCreate = (name: string, ink?: string | null): Promise<LibraryTree> =>
  invoke<LibraryTree>("case_create", { name, ink: ink ?? null });
export const caseRename = (id: string, name: string): Promise<LibraryTree> =>
  invoke<LibraryTree>("case_rename", { id, name });
/** Deleting a case frees its shelves rather than deleting them. */
export const caseDelete = (id: string): Promise<LibraryTree> =>
  invoke<LibraryTree>("case_delete", { id });
export const caseReorder = (id: string, toIndex: number): Promise<LibraryTree> =>
  invoke<LibraryTree>("case_reorder", { id, toIndex });

export const shelfCreate = (
  name: string,
  caseId?: string | null,
  autoRule?: ShelfRule | null,
): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_create", { name, caseId: caseId ?? null, autoRule: autoRule ?? null });
export const shelfSetCase = (id: string, caseId: string | null): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_set_case", { id, caseId });
export const shelfSetOrder = (id: string, orderRule: ShelfOrder): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_set_order", { id, orderRule });
export const shelfSetCollapsed = (id: string, collapsed: boolean): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_set_collapsed", { id, collapsed });
/** Place a book at `index` on a shelf, optionally inside one of its categories. */
export const shelfPlaceBook = (
  collectionId: string,
  bookId: string,
  categoryId: string | null,
  index: number,
): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_place_book", { collectionId, bookId, categoryId, index });

/** A shelf's own colour. `null` clears it, so it borrows its case's again. */
export const shelfSetInk = (id: string, ink: string | null): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_set_ink", { id, ink });
export const caseSetInk = (id: string, ink: string | null): Promise<LibraryTree> =>
  invoke<LibraryTree>("case_set_ink", { id, ink });
/** Move a shelf among its siblings — the shelves of its case, or the loose ones. */
export const shelfReorder = (id: string, toIndex: number): Promise<LibraryTree> =>
  invoke<LibraryTree>("shelf_reorder", { id, toIndex });
export const categoryReorder = (id: string, toIndex: number): Promise<LibraryTree> =>
  invoke<LibraryTree>("category_reorder", { id, toIndex });

export const categoryCreate = (collectionId: string, name: string): Promise<LibraryTree> =>
  invoke<LibraryTree>("category_create", { collectionId, name });
export const categoryRename = (id: string, name: string): Promise<LibraryTree> =>
  invoke<LibraryTree>("category_rename", { id, name });
/** Deleting a category ungroups its books; they stay on the shelf. */
export const categoryDelete = (id: string): Promise<LibraryTree> =>
  invoke<LibraryTree>("category_delete", { id });

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

/** RESILIENCE-1 / WP-3 — the authoritative row for ONE book (effective title/author).
 *  The reader calls this on open instead of trusting the surface that launched it. */
export const bookGet = (id: string): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_get", { id });

/** RESILIENCE-1 / WP-3 — record metadata EXTRACTED FROM THE FILE (the PDF path, on first open).
 *  Writes the BASE columns, NEVER `metadata_overrides`, so a title the reader set keeps winning.
 *  Use `bookUpdate` for a human edit; this is for what the file itself said. */
export const bookSetExtracted = (id: string, title?: string | null, author?: string | null): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_set_extracted", { id, title: title ?? null, author: author ?? null });

export interface BookPatch {
  title?: string;
  author?: string;
  language?: string;
  dir?: string;
  coverFit?: string; // "crop" | "fit" | "" (clear)
  coverPaint?: string; // "#RRGGBB" | "" (clear — back to the colour derived from the title)
  coverMode?: string; // "file" | "typeset" | "" (clear)
  spineMode?: string; // "typeset" | "none" | "" (clear)
}

/** Edit a book's metadata as overrides (never rewrites the source EPUB). Returns the book. */
export const bookUpdate = (id: string, patch: BookPatch): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_update", { id, patch });

/** A cover copied into managed storage but NOT yet adopted — see `bookStageCover`. */
export interface StagedCover {
  /** App-data-relative path of the staged file, to be committed or discarded. */
  rel: string;
  /** `true` = Rust decoded it, so it is known-good. `false` = only WE could not decode it. */
  verified: boolean;
  /** The format Rust detected, for diagnostics. `null` when it could not decode. */
  format: string | null;
}

/**
 * Stage a replacement cover: copied in under its content-addressed name, validated as far as Rust
 * can, and NOT yet adopted.
 *
 * Two stages because acceptance cannot be decided in one place. Rust decoding catches a damaged file
 * that a browser would silently render half of; the renderer accepts formats Rust has no decoder for
 * — AVIF is one Chromium displays today — and needs no allow-list that would rot as new formats
 * ship. So `verified: false` is not a rejection: ask the renderer, then commit or discard.
 */
export const bookStageCover = (id: string, imagePath: string): Promise<StagedCover> =>
  invoke<StagedCover>("book_stage_cover", { id, imagePath });

/** Adopt a staged cover. Returns the updated book. */
export const bookCommitCover = (id: string, rel: string): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_commit_cover", { id, rel });

/** Abandon a staged cover the renderer refused. Nothing was adopted, so nothing is undone. */
export const bookDiscardCover = (rel: string): Promise<void> =>
  invoke<void>("book_discard_cover", { rel });

// A spine image goes through the same two-stage custody as a cover — validated and
// content-addressed on the way in, adopted only once it is known to render.
export const bookStageSpine = (id: string, imagePath: string): Promise<StagedCover> =>
  invoke<StagedCover>("book_stage_spine", { id, imagePath });
export const bookCommitSpine = (id: string, rel: string): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_commit_spine", { id, rel });
/** Remove a book's spine image and its file. */
export const bookClearSpine = (id: string): Promise<BookRow | null> =>
  invoke<BookRow | null>("book_clear_spine", { id });

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
  /**
   * This highlight's tag NAMES, resolved through the note ATTACHED to it.
   *
   * A highlight has no tags of its own: `note_tags` anchors to `notes.id`, and RAWY-205 made an
   * empty-body note a pure tag ANCHOR precisely so a body-less highlight could be tagged. "The tags on
   * a highlight" therefore already means "the tags on its note" — the same resolution the cross-book
   * Inbox has used since RAWY-203, rather than a second tag relationship.
   *
   * `[]` for an untagged highlight and for one with no note, which is every pre-existing mark.
   */
  tags: string[];
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
  /**
   * This note's tag NAMES (RAWY-203), resolved through the `note_tags` join.
   *
   * Names rather than ids, matching `AnnoItem.tags`, because every consumer either shows a tag or
   * filters by one. An untagged note gets `[]` — which is what every note written before this field
   * existed returns, so nothing had to be migrated and no caller needs a null check.
   */
  tags: string[];
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
  /**
   * Whose mark this is, when it is not the reader's own.
   *
   * A mark that arrived in a reading deposit keeps its sender's name; one the reader made is `null`.
   * It is what lets the archive say «من فلان» beside a slip that came from someone else.
   */
  sender: string | null;
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

/**
 * The outcome of renaming a tag. `status` is a stable token, not a message: the interface owns the
 * wording so it can be translated.
 *
 *   ok        — renamed; `tag` is the row as it now stands
 *   unchanged — the new name equalled the old one; nothing was written, `tag` is returned
 *   empty     — the name was blank or whitespace only
 *   taken     — another tag already has that name; REFUSED rather than merged, because merging would
 *               silently move annotations between tags
 *   missing   — no tag with that id
 */
export interface TagRename {
  status: "ok" | "unchanged" | "empty" | "taken" | "missing";
  tag: Tag | null;
}

/**
 * Rename a tag IN PLACE — an UPDATE of the existing row, so `id` never changes and every note and
 * highlight linked to it keeps its link and simply resolves the new name.
 */
export const tagRename = (id: string, name: string): Promise<TagRename> =>
  invoke<TagRename>("tag_rename", { id, name });
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
  /** The card's composition document. NULL for a card saved before the document existed — the UI
   *  reconstructs that card's composition from the columns above, so it opens exactly as it always
   *  did. See `features/photo/composition.ts`. */
  doc: string | null;
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
  /** The serialised composition. */
  doc?: string | null;
  /** The managed background ids the composition uses, sent so the collector can read them from a
   *  table rather than by parsing `doc`. See `photocards::referenced_backgrounds` (Rust). */
  images?: string[];
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
    doc: args.doc ?? null,
    images: args.images ?? [],
    createdAt: args.createdAt,
    pngPath,
  });
};

// ---- View order (sequence, never membership) ------------------------------------------------
//
// `libraryPlaceBook` above moves a book between shelves and touches no order. These move a book
// within a run and touch no shelf. A `ViewOrderRow` has no container field, so a reorder has
// nowhere to put one — see `src-tauri/src/library/view_order.rs`.

export interface ViewOrderRow {
  section: string;
  book_id: string;
  rank: string;
  /** When this run was last arranged by hand; the baseline promotions are measured against. */
  arranged_at: number;
}

export interface Reordered {
  /** False when the release would have left the run exactly as it stands. Decided in the write. */
  changed: boolean;
  /** The run afterwards, in order, so the screen draws what the write produced. */
  order: string[];
}

/** Every saved order for one place in the library — all its sections, in one statement. */
export const viewOrdersForScope = (format: string, scope: string): Promise<ViewOrderRow[]> =>
  invoke<ViewOrderRow[]>("view_orders_for_scope", { format, scope });

/**
 * Move a book within one run. `before` is the book to land in front of, or null for the end.
 *
 * `present` is the run as the view would draw it with no saved order: used to materialise the run
 * the first time it is arranged, and to take in books that have arrived since.
 */
export const viewOrderReorder = (args: {
  format: string;
  scope: string;
  section: string;
  bookId: string;
  before: string | null;
  present: string[];
}): Promise<Reordered> =>
  invoke<Reordered>("view_order_reorder", {
    format: args.format,
    scope: args.scope,
    section: args.section,
    bookId: args.bookId,
    before: args.before,
    present: args.present,
  });

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
  /** Where the reader stood when they made it — `null` when it was not made from a selection. */
  cfi: string | null;
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
  /** The selection's cfi, when the rule is being made from one. Omitted, an existing place is kept. */
  cfi?: string | null,
): Promise<RefRow | null> =>
  invoke<RefRow | null>("ref_save", { bookId, phrase, phraseFold, wordCount, note, cfi: cfi ?? null });

export const refDelete = (id: string): Promise<boolean> => invoke<boolean>("ref_delete", { id });

/** One replacement rule: read `phrase` as `replacement`, in this book only, while `enabled`. */
export interface RepRow {
  id: string;
  book_id: string;
  /** The author's wording, exactly as the reader gave it — shown verbatim in the editor. */
  phrase: string;
  /** The folded MATCHING key (see foldPhrase) — never displayed. */
  phrase_fold: string;
  /** What the reader wants to read instead. Stored verbatim, never folded. */
  replacement: string;
  word_count: number;
  /** A switch, not a delete: off restores the author's wording and keeps the rule. */
  enabled: boolean;
  /** Where the reader stood when they made it — `null` when it was not made from a selection. */
  cfi: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export const repsForBook = (bookId: string): Promise<RepRow[]> =>
  invoke<RepRow[]>("reps_for_book", { bookId });

/** Create OR update in one call — replacing the same phrase twice edits the rule instead of duplicating. */
export const repSave = (
  bookId: string,
  phrase: string,
  phraseFold: string,
  replacement: string,
  wordCount: number,
  /** The selection's cfi, when the rule is being made from one. Omitted, an existing place is kept. */
  cfi?: string | null,
): Promise<RepRow | null> =>
  invoke<RepRow | null>("rep_save", { bookId, phrase, phraseFold, replacement, wordCount, cfi: cfi ?? null });

export const repSetEnabled = (id: string, enabled: boolean): Promise<RepRow | null> =>
  invoke<RepRow | null>("rep_set_enabled", { id, enabled });

export const repDelete = (id: string): Promise<boolean> => invoke<boolean>("rep_delete", { id });

/** The shelf level: every book holding a reference or a replacement, with both counts. */
export interface RefsRepsBook {
  id: string;
  title: string;
  author: string | null;
  refs_count: number;
  reps_count: number;
  touched: number | null;
}

/**
 * THE WHOLE SHELF, IN TWO CALLS RATHER THAN TWO PER BOOK.
 *
 * The shelf previews what the reader made in each book, so it needs the contents and not a count.
 * Asking per book is ~2N round trips: measured on 2,000 books carrying rules, that was ~3,400 calls
 * and 1,121ms of the main thread inside `fetch` on one press.
 *
 * Rows come back ordered by book, then exactly as the per-book query orders them, so grouping by
 * `book_id` reproduces what the per-book calls returned. The per-book calls remain, and remain
 * right, for reloading ONE book after an edit.
 */
export const refsAll = (): Promise<RefRow[]> => invoke<RefRow[]>("refs_all");
export const repsAll = (): Promise<RepRow[]> => invoke<RepRow[]>("reps_all");
export const refsRepsBooks = (): Promise<RefsRepsBook[]> =>
  invoke<RefsRepsBook[]>("refs_reps_books", {});

// ---- Profiles (stage 1): the visual-identity registry. Storage only — no UI reaches these yet. ----
//
// A profile carries how Sard LOOKS: paper and colours, the interface and book faces, both
// backgrounds and their treatment, the bookmark and read-marker, and the interface texture. It does
// NOT carry how the reader READS — line spacing, measure, margins, paragraph spacing, tracking,
// alignment, diacritics and zoom stay in `reading_style` / `book_style:<id>`, are never written from
// a profile, and never travel in a shared package.
//
// Mirrors `profiles::Profile`. `data` is the profile itself as JSON and is OPAQUE to Rust, which is
// what keeps adding a visual field a code change rather than a migration — the same rule the
// background params blob follows. The three asset columns are lifted OUT of that JSON so the
// background collector can see live references without parsing frontend-owned data.
export interface ProfileRow {
  id: string;
  name: string | null;
  description: string | null;
  author: string | null;
  icon_kind: string | null;
  icon_ref: string | null;
  data: string;
  derived_from: string | null;
  created_at: number;
  updated_at: number;
  bg_library: string | null;
  bg_reading: string | null;
  /** When the profile was last WORN. Read-only here: `profile_save` ignores it, and `profileTouch`
   *  is the only thing that writes it — which is why it is optional and why nothing that builds a
   *  row has to carry it forward. */
  last_used_at?: number | null;
}

/** Every profile, MOST RECENTLY WORN first; one never worn keeps its most-recently-edited place. */
// ---------------------------------------------------------------------------
// READING DEPOSITS (phase 1 — the sender)
//
// The PLAN is made in Rust because every answer needs a managed path or a parsed spine: the sheet
// then renders exactly what the writer will write. `deposit_export` copies the book file-to-file, so
// a book's bytes never cross this boundary.
// ---------------------------------------------------------------------------

/** Where one mark falls in the book, as far as its stored cfi can say. */
export interface MarkSection {
  // All four kinds now, because all four can have a place: a reference and a replacement
  // record where the reader stood when they made it. One without a place yields no section
  // at all rather than a guessed one.
  kind: "highlight" | "note" | "reference" | "replacement";
  id: string;
  section: string | null;
  /** Null when the cfi names a document but no position inside it — carried, never guessed. */
  section_index: number | null;
}

export interface DepositPlan {
  book: {
    hash: string;
    format: string | null;
    title: string | null;
    author: string | null;
    language: string | null;
    dir: string | null;
    size_bytes: number;
  };
  /** Sections in the spine. Null when the file could not be parsed — the sheet then offers no map. */
  spine_count: number | null;
  book_bytes: number;
  cover_bytes: number;
  book_source: string | null;
  cover_source: string | null;
  book_member: string | null;
  cover_member: string | null;
  sections: MarkSection[];
  counts: { highlights: number; notes: number; references: number; replacements: number };
}

export const depositPlan = (bookId: string): Promise<DepositPlan> =>
  invoke<DepositPlan>("deposit_plan", { bookId });

export const depositExport = (
  path: string,
  manifestJson: string,
  book: { member: string; source: string } | null,
  cover: { member: string; source: string } | null,
): Promise<void> =>
  invoke<void>("deposit_export", {
    path,
    manifestJson,
    bookMember: book?.member ?? null,
    bookSource: book?.source ?? null,
    coverMember: cover?.member ?? null,
    coverSource: cover?.source ?? null,
  });

/** What the receiver kept — indices into the manifest's own arrays, never ids. */
export interface DepositAcceptance {
  highlights: number[];
  notes: number[];
  references: { index: number; take_theirs: boolean }[];
  replacements: { index: number; take_theirs: boolean }[];
}

export interface DepositCounts {
  highlights: number;
  notes: number;
  references: number;
  replacements: number;
}

export interface DepositOutcome {
  deposit_id: string;
  book_id: string | null;
  book_imported: boolean;
  same_book: boolean;
  applied: DepositCounts;
  skipped_existing: DepositCounts;
  unplaced: DepositCounts;
  kept_mine: DepositCounts;
  already_received: boolean;
}

/** Read the manifest and change NOTHING. */
export const depositInspect = (path: string): Promise<string> =>
  invoke<string>("deposit_inspect", { path });

/** One member's bytes, so a preview can draw an arriving cover rather than name it. Reads only. */
export const depositMember = (path: string, member: string): Promise<number[]> =>
  invoke<number[]>("deposit_member", { path, member });

/** The trust boundary: re-validates, resolves the book, applies what was kept — in one transaction. */
export const depositCommit = (
  path: string,
  manifestJson: string,
  accept: DepositAcceptance,
  /** The reader's own answer to "which of my books is this?", when the hash cannot answer it. */
  bindTo: string | null = null,
): Promise<DepositOutcome> =>
  invoke<DepositOutcome>("deposit_commit", { path, manifestJson, accept, bindTo });

/** A mark a deposit brought that has not yet found its place in this reader's copy. */
export interface PendingMark {
  kind: "highlight" | "note";
  id: string;
  cfi: string | null;
  /** The needle. A note is never given one — its body is the reader's words, not the book's. */
  excerpt: string | null;
  chapter_label: string | null;
  state: string | null;
  target_section: number | null;
  of_highlight: string | null;
}

export interface PlacementVerdict {
  kind: "highlight" | "note";
  id: string;
  state: string;
  target_section: number | null;
  /** Only for `placed`: the cfi minted in the rendered section. */
  cfi: string | null;
}

export const depositPendingMarks = (bookId: string): Promise<PendingMark[]> =>
  invoke<PendingMark[]>("deposit_pending_marks", { bookId });

export const depositPlaceMarks = (verdicts: PlacementVerdict[]): Promise<number> =>
  invoke<number>("deposit_place_marks", { verdicts });

/**
 * Files the operating system handed to Sard — a deposit double-clicked in a file manager, or one named
 * on the command line — drained so each is returned exactly once.
 *
 * The queue is the whole contract: the `sard://opened` event carries nothing and only means "ask again",
 * so a second launch can never deliver a path twice nor lose one because nobody was listening yet.
 */
export const openedFilesTake = (): Promise<string[]> => invoke<string[]>("opened_files_take");

export const profilesList = (): Promise<ProfileRow[]> => invoke<ProfileRow[]>("profiles_list");

/** One profile by id, or null when it does not exist. */
export const profileGet = (id: string): Promise<ProfileRow | null> =>
  invoke<ProfileRow | null>("profile_get", { id });

/** Insert or update. `created_at` is preserved on update; `updated_at` is stamped by the core. */
export const profileSave = (profile: ProfileRow): Promise<boolean> =>
  invoke<boolean>("profile_save", { profile });

/**
 * Stamp a profile as worn, so the list can order by use rather than by edit.
 *
 * It writes that one column and nothing else — not `updated_at` — because wearing a profile is
 * not editing it. Touching one that does not exist is not an error.
 */
export const profileTouch = (id: string): Promise<boolean> =>
  invoke<boolean>("profile_touch", { id });

/** Remove a profile. Deleting one that does not exist is not an error. */
export const profileDelete = (id: string): Promise<boolean> =>
  invoke<boolean>("profile_delete", { id });

/**
 * The settings key naming the active profile.
 *
 * ABSENT MEANS "no profile is active", and that is the state every existing installation is in
 * after this stage: the resolver reads today's individual settings keys exactly as it always has,
 * so nothing changes until the reader creates or edits a profile. Read and written through
 * `settingsGet` / `settingsSet` — it is one value for the installation, which is precisely what the
 * settings table is for, and keeping it there means switching profiles needs no schema change.
 */
export const PROFILE_ACTIVE_KEY = "profile_active";
