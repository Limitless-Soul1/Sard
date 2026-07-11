import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import {
  bookDelete,
  bookRevertCover,
  bookSetCover,
  bookUpdate,
  collectionAddBook,
  collectionCreate,
  collectionDelete,
  collectionRemoveBook,
  collectionRename,
  collectionsForBook,
  collectionsList,
  importBooks,
  importFolder,
  libraryListBooks,
  settingsGet,
  settingsSet,
  type BookRow,
  type CollectionRow,
  type ImportResult,
  type SortKey,
  type SortOrder,
} from "../../lib/ipc";
import { AutoCover } from "./AutoCover";
import { GlobalSettings } from "../settings/GlobalSettings";
import { UpdateRosette } from "../updater/UpdateRosette";
import { Hoopoe } from "./Hoopoe";
import { Inbox } from "./Inbox";
import { PhotoGallery } from "../photo/PhotoGallery";

// Detect Arabic from the TITLE TEXT itself, so a caption renders in Amiri even when the
// book's metadata mislabels its language (RAWY-17: e.g. an Arabic book tagged lang=en).
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
  cfi?: string | null; // jump-to location (RAWY-27 inbox); else resume saved progress
  format?: string | null; // RAWY-85 — 'pdf' opens read-only (no themes/annotations); else EPUB
}

type View = "grid" | "list" | "rows";
type CoverMode = "crop" | "fit";

const SORTS: SortKey[] = ["title", "author", "format", "date_read", "date_added"];
const SORT_KEY = { title: "lib.sort.title", author: "lib.sort.author", format: "lib.sort.format", date_read: "lib.sort.dateRead", date_added: "lib.sort.dateAdded" } as const;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const toArabic = (s: string) => s.replace(/[0-9]/g, (d) => AR_DIGITS[+d]);
const num = (n: number, lang: string) => (lang === "ar" ? toArabic(String(n)) : String(n));

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// RAWY-82 (#16): search input → book-list reload delay. Short enough to stay snappy, long enough
// that a fast typist fires ONE query at the end rather than one per keystroke.
const SEARCH_DEBOUNCE_MS = 250;

function summarize(results: ImportResult[], t: TFn, lang: string): string {
  const c = { imported: 0, duplicate: 0, unsupported: 0, error: 0 };
  for (const r of results) c[r.status]++;
  const parts: string[] = [];
  if (c.imported) parts.push(t("lib.import.imported", { n: localeNum(c.imported, lang) }));
  if (c.duplicate) parts.push(t("lib.import.duplicate", { n: localeNum(c.duplicate, lang) }));
  if (c.unsupported) parts.push(t("lib.import.unsupported", { n: localeNum(c.unsupported, lang) }));
  if (c.error) parts.push(t("lib.import.error", { n: localeNum(c.error, lang) }));
  return parts.join(" · ") || t("lib.import.none");
}

export function Library({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang } = useI18n();

  const [section, setSection] = useState<"library" | "inbox" | "cards">("library");
  const [settingsOpen, setSettingsOpen] = useState(false); // RAWY-39 global settings
  const [books, setBooks] = useState<BookRow[]>([]);
  const [editing, setEditing] = useState<BookRow | null>(null);
  const [shelves, setShelves] = useState<CollectionRow[]>([]);
  const [view, setView] = useState<View>("grid");
  const [coverMode, setCoverMode] = useState<CoverMode>("crop");
  const [sort, setSort] = useState<SortKey>("date_read");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [format, setFormat] = useState<string | null>(null);
  const [shelf, setShelf] = useState<string | null>(null);
  // Shelf management (RAWY-31): inline create + rename, driven from the sidebar.
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  // RAWY-76: shelf delete now takes a two-step confirm (was instant — #6). Holds the shelf id
  // awaiting confirmation; the ✕ morphs into a small "Delete?" prompt for that row only.
  const [confirmShelf, setConfirmShelf] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<null | "sort" | "format">(null);
  const [drag, setDrag] = useState<{ count: number } | null>(null);
  const [forceEmpty, setForceEmpty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // Remember the reader's view/sort/cover/shelf choices across sessions (persisted via
  // the settings IPC). Gate the first paint on hydration so we don't flash defaults.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    (async () => {
      const [v, s, o, c, sh] = await Promise.all([
        settingsGet("lib_view"), settingsGet("lib_sort"), settingsGet("lib_order"),
        settingsGet("lib_cover"), settingsGet("lib_shelf"),
      ]);
      if (v === "list" || v === "grid" || v === "rows") setView(v);
      if (s && (SORTS as string[]).includes(s)) setSort(s as SortKey);
      if (o === "asc" || o === "desc") setOrder(o);
      if (c === "crop" || c === "fit") setCoverMode(c);
      if (sh) setShelf(sh);
      if (import.meta.env.DEV) {
        if ((await settingsGet("lib_force_empty")) === "1") setForceEmpty(true);
        if ((await settingsGet("lib_force_drop")) === "1") setDrag({ count: 3 });
        if ((await settingsGet("dev_section")) === "inbox") setSection("inbox"); // RAWY-27 screenshots
      }
      setHydrated(true);
    })().catch(() => setHydrated(true));
  }, []);
  useEffect(() => { if (hydrated) settingsSet("lib_view", view).catch(console.error); }, [view, hydrated]);
  useEffect(() => { if (hydrated) settingsSet("lib_sort", sort).catch(console.error); }, [sort, hydrated]);
  useEffect(() => { if (hydrated) settingsSet("lib_order", order).catch(console.error); }, [order, hydrated]);
  useEffect(() => { if (hydrated) settingsSet("lib_cover", coverMode).catch(console.error); }, [coverMode, hydrated]);
  useEffect(() => { if (hydrated) settingsSet("lib_shelf", shelf ?? "").catch(console.error); }, [shelf, hydrated]);

  // Shelves + books load on mount and re-load on import; books also re-query on sort/filter.
  const loadShelves = useCallback(() => {
    collectionsList().then(setShelves).catch(console.error);
  }, []);
  // RAWY-82 (#16): every load is request-ordered — a monotonic seq means a slower, STALER response
  // (e.g. a shorter earlier query) can't overwrite a fresher one; the latest request always wins.
  const loadSeqRef = useRef(0);
  const loadBooks = useCallback(() => {
    const seq = ++loadSeqRef.current;
    libraryListBooks({ sort, order, format, collection: shelf, search })
      .then((rows) => { if (seq === loadSeqRef.current) setBooks(rows); })
      .catch(console.error);
  }, [sort, order, format, shelf, search]);

  // Pick a sort column with a sensible default order (RAWY-30): date columns default to
  // DESCENDING (newest first) so the most-recent book is the FIRST item — which the grid then
  // places where the reading eye starts (top-right in an Arabic RTL UI, top-left in LTR). Text
  // columns default to ascending (A→Z). Clicking the already-active column toggles the order.
  const pickSort = useCallback((k: SortKey) => {
    if (k === sort) { setOrder((o) => (o === "asc" ? "desc" : "asc")); return; }
    setSort(k);
    setOrder(k === "date_read" || k === "date_added" ? "desc" : "asc");
  }, [sort]);
  useEffect(() => loadShelves(), [loadShelves]);
  // Discrete filter/sort picks reload IMMEDIATELY (they're single clicks, not typing).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadBooks(); }, [sort, order, format, shelf]);
  // RAWY-82 (#16): search is DEBOUNCED (~250ms) so a fast typist doesn't fire an IPC per keystroke;
  // the trailing timer means the final query always runs, and `loadBooks`' seq-ordering means its
  // result wins even if an earlier in-flight query resolves later. Skip the mount tick — the
  // immediate effect above already did the initial load.
  const searchMounted = useRef(false);
  useEffect(() => {
    if (!searchMounted.current) { searchMounted.current = true; return; }
    const id = window.setTimeout(() => loadBooks(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // The drop listener is subscribed once; reach the latest import handler through a ref.
  const runImportRef = useRef<(paths: string[]) => void>(() => {});

  // Real drag-and-drop import (band E · E5): the hover overlay shows on enter/over and a
  // drop runs the real importer. Dev-only keyboard aids force the drop / empty states for
  // capture, since PrintWindow can't screenshot a live OS drag.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === "enter") setDrag({ count: p.paths.length });
          else if (p.type === "over") setDrag((d) => d ?? { count: 0 });
          else if (p.type === "leave") setDrag(null);
          else if (p.type === "drop") {
            setDrag(null);
            runImportRef.current(p.paths);
          }
        });
      } catch {
        /* not in a tauri webview (e.g. plain vite) — drag-drop simply inert */
      }
    })();
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "D") setDrag((d) => (d ? null : { count: 3 }));
      if (e.shiftKey && e.key === "E") setForceEmpty((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  // RAWY-81 (#3): after a SINGLE new book is imported, surface its Edit dialog (rename / cover) so
  // the user can fix it up right away — a dismissible modal, never forced. A batch (>1 imported) or
  // a pure-duplicate import is left alone (just the summary toast): a bulk add isn't a moment to
  // focus on one book. Fetched unfiltered so the new book is found regardless of the active filter.
  const surfaceEditForNew = useCallback(async (results: ImportResult[]) => {
    const imported = results.filter((r) => r.status === "imported");
    if (imported.length !== 1) return;
    const all = await libraryListBooks({ sort: "date_added", order: "desc" }).catch(() => [] as BookRow[]);
    const row = all.find((b) => b.id === imported[0].id);
    if (row) setEditing(row);
  }, []);

  // Import a batch of paths through the real Rust pipeline, then refresh + summarise.
  const runImport = useCallback(
    async (paths: string[]) => {
      if (!paths.length || importing) return;
      setImporting(true);
      try {
        const results = await importBooks(paths);
        loadBooks();
        loadShelves();
        flashToast(summarize(results, t, lang));
        await surfaceEditForNew(results);
      } catch (e) {
        flashToast(String(e));
      } finally {
        setImporting(false);
      }
    },
    [importing, loadBooks, loadShelves, flashToast, t, lang, surfaceEditForNew],
  );
  useEffect(() => {
    runImportRef.current = (paths) => void runImport(paths);
  }, [runImport]);

  // "Browse files…" → native file picker (EPUB only), then import the chosen files.
  const addBooks = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ multiple: true, filters: [{ name: "EPUB", extensions: ["epub"] }] });
      if (!sel) return;
      runImport(Array.isArray(sel) ? sel : [sel]);
    } catch (e) {
      flashToast(String(e));
    }
  }, [runImport, flashToast]);

  // "Import a folder" → native DIRECTORY picker, then import every EPUB inside it (RAWY-80,
  // audit #7 — this button used to open the same file picker as "Browse files"). Same pipeline
  // (dedup, format-detect, managed copy); an empty folder just reports "no books added".
  const addFolder = useCallback(async () => {
    if (importing) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return;
      setImporting(true);
      try {
        const results = await importFolder(dir);
        loadBooks();
        loadShelves();
        flashToast(summarize(results, t, lang));
        await surfaceEditForNew(results);
      } finally {
        setImporting(false);
      }
    } catch (e) {
      flashToast(String(e));
    }
  }, [importing, loadBooks, loadShelves, flashToast, t, lang, surfaceEditForNew]);

  // DEV: import a `;`-separated path list from the `dev_import` setting once (for capture/
  // verification, since PrintWindow can't drive a live OS drag), then clear it. RAWY-80 adds
  // `dev_import_folder` — a single directory path routed through the REAL `import_folder` command
  // (the folder picker can't be driven headless either), so the end-to-end folder import is
  // testable without a click.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (async () => {
      const di = await settingsGet("dev_import");
      if (di) {
        await settingsSet("dev_import", "");
        runImportRef.current(di.split(";").map((s) => s.trim()).filter(Boolean));
      }
      const df = await settingsGet("dev_import_folder");
      if (df) {
        await settingsSet("dev_import_folder", "");
        const results = await importFolder(df.trim());
        loadBooks();
        loadShelves();
        flashToast(summarize(results, t, lang));
      }
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hydrated) return null; // brief: settings loading (avoids a grid→list flash)

  const isEmpty = forceEmpty || (books.length === 0 && !search && !format && !shelf);
  const count = books.length;

  const pickShelf = (id: string | null) => {
    setShelf(id);
    setMenu(null);
    setConfirmShelf(null); // RAWY-76: navigating away backs out of a pending shelf-delete confirm
  };
  const open = (b: BookRow) => onOpen({ id: b.id, filePath: b.file_path, dir: b.dir, format: b.format });

  // Shelf writes (RAWY-31): each returns the refreshed shelf list (names + counts).
  const commitCreate = async () => {
    const name = draftName.trim();
    setCreating(false);
    setDraftName("");
    if (!name) return;
    setShelves(await collectionCreate(name).catch((e) => { console.error(e); return shelves; }));
  };
  const commitRename = async (id: string) => {
    const name = draftName.trim();
    setRenaming(null);
    setDraftName("");
    if (!name) return;
    setShelves(await collectionRename(id, name).catch((e) => { console.error(e); return shelves; }));
  };
  const removeShelf = async (s: CollectionRow) => {
    setConfirmShelf(null);
    if (shelf === s.id) pickShelf(null); // leave a filtered view we're about to delete
    setShelves(await collectionDelete(s.id).catch((e) => { console.error(e); return shelves; }));
    flashToast(t("lib.shelf.deleted", { name: s.name }));
  };
  const activeShelf = shelf ? shelves.find((s) => s.id === shelf) ?? null : null;

  return (
    <div className="lib-root">
      <aside className="lib-sidebar">
        {/* RAWY-95 — app wordmark, design variant 2b (D34): a FIXED IBM-Plex lockup —
            hoopoe · "Sard" · quiet ink bar · "سَرْد" (with tashkīl), fully monochrome (the bird
            carries the only colour). LTR-pinned so the internal order never mirrors in the RTL UI. */}
        <div className="lib-brand">
          <span className="lib-lockup">
            <Hoopoe size={28} className="lib-brand-bird" />
            <span className="lib-wordmark">
              <span className="lib-word-latin">Sard</span>
              <span className="lib-word-sep" aria-hidden />
              <span className="lib-word-ar">سَرْد</span>
            </span>
          </span>
        </div>

        <nav className="lib-nav">
          <button
            className={`lib-nav-item${section === "library" ? " active" : ""}`}
            onClick={() => { setSection("library"); pickShelf(null); }}
          >
            <span className="lib-nav-ico lib-ico-library" />
            {t("lib.nav.library")}
          </button>
          <button
            className={`lib-nav-item${section === "inbox" ? " active" : ""}`}
            onClick={() => setSection("inbox")}
          >
            <span className="lib-nav-ico lib-ico-highlights" />
            {t("lib.nav.highlights")}
          </button>
          <button
            className={`lib-nav-item${section === "cards" ? " active" : ""}`}
            onClick={() => setSection("cards")}
          >
            <span className="lib-nav-ico lib-ico-cards" />
            {t("lib.nav.cards")}
          </button>
          <button className="lib-nav-item" disabled>
            <span className="lib-nav-ico lib-ico-reading" />
            {t("lib.nav.readingNow")}
          </button>
        </nav>

        <div className="lib-shelves-label">{t("lib.shelves")}</div>
        <div className="lib-shelves">
          {shelves.length === 0 && !creating && <div className="lib-shelf-empty">{t("lib.noShelves")}</div>}
          {shelves.map((s) =>
            renaming === s.id ? (
              <input
                key={s.id}
                className="lib-shelf-input"
                autoFocus
                value={draftName}
                dir="auto"
                placeholder={t("lib.shelf.namePlaceholder")}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(s.id);
                  else if (e.key === "Escape") { setRenaming(null); setDraftName(""); }
                }}
                onBlur={() => commitRename(s.id)}
              />
            ) : (
              <div key={s.id} className={`lib-shelf${shelf === s.id ? " active" : ""}`}>
                <button className="lib-shelf-main" onClick={() => pickShelf(shelf === s.id ? null : s.id)}>
                  <span className="lib-shelf-name" dir="auto">{s.name}</span>
                </button>
                <span className="lib-shelf-count">{num(s.count, lang)}</span>
                <span className="lib-shelf-actions">
                  <button
                    className="lib-shelf-act"
                    title={t("lib.shelf.rename")}
                    aria-label={t("lib.shelf.rename")}
                    onClick={() => { setRenaming(s.id); setDraftName(s.name); }}
                  >
                    ✎
                  </button>
                  {confirmShelf === s.id ? (
                    <button
                      className="lib-shelf-act danger"
                      title={t("lib.shelf.deleteConfirm")}
                      onClick={() => removeShelf(s)}
                    >
                      {t("lib.shelf.deleteYes")}
                    </button>
                  ) : (
                    <button
                      className="lib-shelf-act"
                      title={t("lib.shelf.delete")}
                      aria-label={t("lib.shelf.delete")}
                      onClick={() => setConfirmShelf(s.id)}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </div>
            )
          )}
          {creating ? (
            <input
              className="lib-shelf-input"
              autoFocus
              value={draftName}
              dir="auto"
              placeholder={t("lib.shelf.namePlaceholder")}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                else if (e.key === "Escape") { setCreating(false); setDraftName(""); }
              }}
              onBlur={commitCreate}
            />
          ) : (
            <button
              className="lib-shelf-new"
              onClick={() => { setRenaming(null); setDraftName(""); setCreating(true); }}
            >
              {t("lib.newShelf")}
            </button>
          )}
        </div>

        {/* RAWY-39: the Library foot opens GLOBAL app settings (theme, UI font, reading
            defaults, language). The single language control now lives there (D22). */}
        <div className="lib-sidefoot">
          <button className="lib-settings-btn" onClick={() => setSettingsOpen(true)} title={t("gs.open")}>
            <span className="lib-settings-ico" aria-hidden>⚙</span>
            <span>{t("gs.open")}</span>
          </button>
        </div>
      </aside>

      <main className="lib-main">
        {section === "cards" ? (
          <PhotoGallery />
        ) : section === "inbox" ? (
          <Inbox onOpen={onOpen} />
        ) : isEmpty ? (
          <EmptyState onBrowse={addBooks} onFolder={addFolder} />
        ) : (
          <>
            <header className="lib-head">
              <div className="lib-head-top">
                <div className="lib-title-wrap">
                  <h1 className="lib-title" dir="auto">{activeShelf ? activeShelf.name : t("lib.title")}</h1>
                  <span className="lib-title-count">{t("lib.count", { n: num(count, lang) })}</span>
                </div>
                <label className="lib-search">
                  <span className="lib-search-ico" aria-hidden>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("lib.search")}
                  />
                </label>
              </div>

              <div className="lib-toolbar">
                <div className="lib-pills">
                  <button className={`lib-pill${shelf === null ? " active" : ""}`} onClick={() => pickShelf(null)}>
                    {t("lib.all")}
                  </button>
                  {shelves.slice(0, 3).map((s) => (
                    <button
                      key={s.id}
                      className={`lib-pill${shelf === s.id ? " active" : ""}`}
                      onClick={() => pickShelf(shelf === s.id ? null : s.id)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>

                <div className="lib-controls">
                  <button className="lib-add" onClick={addBooks} disabled={importing}>
                    + {t(importing ? "lib.importing" : "lib.add")}
                  </button>
                  <div className="lib-viewtoggle" role="tablist">
                    <button
                      className={view === "grid" ? "active" : ""}
                      onClick={() => setView("grid")}
                      title={t("lib.view.grid")}
                      aria-label={t("lib.view.grid")}
                    >
                      <span className="ico-grid" />
                    </button>
                    <button
                      className={view === "list" ? "active" : ""}
                      onClick={() => setView("list")}
                      title={t("lib.view.list")}
                      aria-label={t("lib.view.list")}
                    >
                      <span className="ico-list" />
                    </button>
                    <button
                      className={view === "rows" ? "active" : ""}
                      onClick={() => setView("rows")}
                      title={t("lib.view.rows")}
                      aria-label={t("lib.view.rows")}
                    >
                      <span className="ico-rows"><span /><span /></span>
                    </button>
                  </div>

                  {view === "grid" && (
                    <button
                      className="lib-ctl"
                      onClick={() => setCoverMode((m) => (m === "crop" ? "fit" : "crop"))}
                    >
                      {t(coverMode === "crop" ? "lib.cover.crop" : "lib.cover.fit")} ▾
                    </button>
                  )}

                  <div className="lib-ctl-wrap">
                    <button className="lib-ctl" onClick={() => setMenu(menu === "sort" ? null : "sort")}>
                      {t(SORT_KEY[sort])}{" "}
                      <span
                        className="lib-order"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOrder((o) => (o === "asc" ? "desc" : "asc"));
                        }}
                      >
                        {order === "asc" ? "↑" : "↓"}
                      </span>
                    </button>
                    {menu === "sort" && (
                      <div className="lib-menu">
                        {SORTS.map((k) => (
                          <button
                            key={k}
                            className={k === sort ? "active" : ""}
                            onClick={() => {
                              pickSort(k);
                              setMenu(null);
                            }}
                          >
                            {t(SORT_KEY[k])}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="lib-ctl-wrap">
                    <button
                      className={`lib-ctl lib-ctl-ico${format ? " active" : ""}`}
                      onClick={() => setMenu(menu === "format" ? null : "format")}
                      title={t("lib.filter")}
                    >
                      ⛛
                    </button>
                    {menu === "format" && (
                      <div className="lib-menu lib-menu-end">
                        {[null, "epub", "pdf"].map((f) => (
                          <button
                            key={f ?? "all"}
                            className={format === f ? "active" : ""}
                            onClick={() => {
                              setFormat(f);
                              setMenu(null);
                            }}
                          >
                            {f ? f.toUpperCase() : t("lib.filter.all")}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </header>

            {menu && <div className="lib-clickaway" onClick={() => setMenu(null)} />}

            {/* ROWS is checked FIRST so the toggle always switches to it (RAWY-51): ShelfRows has
                its own per-shelf "empty" handling, so it must NOT be pre-empted by the flat
                empty-shelf state below — otherwise, with an empty shelf/filter selected, clicking
                Rows appeared to do nothing (the empty-state stayed). The empty-state now guards
                only the flat grid/list. */}
            {view === "rows" ? (
              <ShelfRows
                shelves={shelves}
                activeShelf={shelf}
                sort={sort}
                order={order}
                coverMode={coverMode}
                lang={lang}
                t={t}
                onOpen={open}
                onEdit={setEditing}
                onSeeAll={(id) => { pickShelf(id); setView("grid"); }}
                onAddBooks={addBooks}
              />
            ) : activeShelf && count === 0 && !search ? (
              <div className="lib-shelf-empty-state">
                <div className="lib-shelf-empty-title">{t("lib.shelfEmpty.title")}</div>
                <div className="lib-shelf-empty-hint">{t("lib.shelfEmpty.hint")}</div>
              </div>
            ) : view === "grid" ? (
              <div className="lib-grid">
                {books.map((b) => (
                  <BookCard
                    key={b.id}
                    book={b}
                    coverMode={coverMode}
                    onOpen={() => open(b)}
                    onEdit={() => setEditing(b)}
                  />
                ))}
              </div>
            ) : (
              <div className="lib-list">
                <div className="lib-list-head">
                  <span aria-hidden />
                  <button className={`ll-title sortable${sort === "title" ? " active" : ""}`} onClick={() => pickSort("title")}>
                    {t("lib.col.title")} {sort === "title" && (order === "asc" ? "↑" : "↓")}
                  </button>
                  <button className={`ll-author sortable${sort === "author" ? " active" : ""}`} onClick={() => pickSort("author")}>
                    {t("lib.col.author")} {sort === "author" && (order === "asc" ? "↑" : "↓")}
                  </button>
                  <button className={`ll-format sortable${sort === "format" ? " active" : ""}`} onClick={() => pickSort("format")}>
                    {t("lib.col.format")} {sort === "format" && (order === "asc" ? "↑" : "↓")}
                  </button>
                  <span className="ll-progress">{t("lib.col.progress")}</span>
                  <button className={`ll-read sortable${sort === "date_read" ? " active" : ""}`} onClick={() => pickSort("date_read")}>
                    {t("lib.col.read")} {sort === "date_read" && (order === "asc" ? "↑" : "↓")}
                  </button>
                </div>
                {books.map((b) => (
                  <ListRow key={b.id} book={b} onOpen={() => open(b)} lang={lang} t={t} />
                ))}
              </div>
            )}
          </>
        )}

        {drag && <DropOverlay count={drag.count} t={t} lang={lang} />}
      </main>

      {editing && (
        <EditBook
          book={editing}
          shelves={shelves}
          onShelves={(rows) => {
            setShelves(rows);
            loadBooks(); // a chip toggle can add/remove the open book from the active shelf filter
          }}
          onClose={() => setEditing(null)}
          onSaved={(b) => {
            loadBooks();
            loadShelves();
            if (b) setEditing(b); // keep open with refreshed cover after replace/revert
          }}
          onDeleted={() => {
            const title = editing.title ?? "—"; // capture before we clear `editing`
            setEditing(null); // RAWY-76: close the dialog and refresh the library + shelf counts
            loadBooks();
            loadShelves();
            flashToast(t("lib.book.deleted", { title }));
          }}
        />
      )}
      {toast && <div className="lib-toast">{toast}</div>}
      <GlobalSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UpdateRosette />
    </div>
  );
}

type TFn = ReturnType<typeof useI18n>["t"];

// Shelf-rows view (RAWY-46, design Band E-II): the Library as bookstore/streaming-style horizontal
// shelf rows — a built-in "Currently Reading" row + one row per user shelf. Reuses the existing
// shelves (collections_list) + per-shelf book query + the BookCard; a third option beside Grid/List.
// Rows read + scroll sideways and mirror in RTL (the container inherits the UI direction). "See all"
// hands off to the flat grid filtered to that shelf (the best all-books view — the design's note).
function ShelfRows({
  shelves,
  activeShelf,
  sort,
  order,
  coverMode,
  lang,
  t,
  onOpen,
  onEdit,
  onSeeAll,
  onAddBooks,
}: {
  shelves: CollectionRow[];
  activeShelf: string | null;
  sort: SortKey;
  order: SortOrder;
  coverMode: CoverMode;
  lang: string;
  t: TFn;
  onOpen: (b: BookRow) => void;
  onEdit: (b: BookRow) => void;
  onSeeAll: (id: string) => void;
  onAddBooks: () => void;
}) {
  const [reading, setReading] = useState<BookRow[]>([]);
  const [shelfBooks, setShelfBooks] = useState<Record<string, BookRow[]>>({});

  useEffect(() => {
    let cancel = false;
    (async () => {
      // "Currently Reading" is a DERIVED row (books with in-progress reading) — not a new shelf.
      const all = await libraryListBooks({ sort: "date_read", order: "desc" }).catch(() => [] as BookRow[]);
      const inProgress = all.filter((b) => {
        const f = b.fraction ?? 0;
        return f > 0 && f < 0.999;
      });
      const targets = activeShelf ? shelves.filter((s) => s.id === activeShelf) : shelves;
      const lists = await Promise.all(
        targets.map((s) => libraryListBooks({ sort, order, collection: s.id }).catch(() => [] as BookRow[])),
      );
      if (cancel) return;
      setReading(inProgress);
      const map: Record<string, BookRow[]> = {};
      targets.forEach((s, i) => (map[s.id] = lists[i]));
      setShelfBooks(map);
    })();
    return () => {
      cancel = true;
    };
  }, [shelves, activeShelf, sort, order]);

  const rowShelves = activeShelf ? shelves.filter((s) => s.id === activeShelf) : shelves;
  const showReading = !activeShelf && reading.length > 0;

  return (
    <div className="lib-rows">
      {showReading && (
        <ShelfRow title={t("lib.row.reading")} count={reading.length} books={reading} coverMode={coverMode} lang={lang} t={t} onOpen={onOpen} onEdit={onEdit} />
      )}
      {rowShelves.map((s) => (
        <ShelfRow
          key={s.id}
          title={s.name}
          count={s.count}
          books={shelfBooks[s.id] ?? []}
          coverMode={coverMode}
          lang={lang}
          t={t}
          onOpen={onOpen}
          onEdit={onEdit}
          onSeeAll={() => onSeeAll(s.id)}
          emptyMsg={t("lib.shelfRow.empty")}
        />
      ))}
      {shelves.length === 0 && (
        <div className="lib-rows-noshelves">
          <div className="lib-rows-noshelves-title">{t("lib.rows.noShelvesTitle")}</div>
          <div className="lib-rows-noshelves-hint">{t("lib.rows.noShelvesHint")}</div>
          <button className="lib-btn-primary" onClick={onAddBooks}>+ {t("lib.add")}</button>
        </div>
      )}
    </div>
  );
}

function ShelfRow({
  title,
  count,
  books,
  coverMode,
  lang,
  t,
  onOpen,
  onEdit,
  onSeeAll,
  emptyMsg,
}: {
  title: string;
  count: number;
  books: BookRow[];
  coverMode: CoverMode;
  lang: string;
  t: TFn;
  onOpen: (b: BookRow) => void;
  onEdit: (b: BookRow) => void;
  onSeeAll?: () => void;
  emptyMsg?: string;
}) {
  return (
    <section className="lib-shelfrow">
      <div className="lib-shelfrow-head">
        <div className="lib-shelfrow-title">
          <span className="lib-shelfrow-name" dir="auto">{title}</span>
          <span className="lib-shelfrow-count">{num(count, lang)}</span>
        </div>
        {onSeeAll && (
          <button className="lib-shelfrow-seeall" onClick={onSeeAll}>
            {t("lib.seeAll")} <span className="lib-seeall-arrow" aria-hidden>→</span>
          </button>
        )}
      </div>
      {books.length ? (
        <div className="lib-shelfrow-scroll">
          {books.map((b) => (
            <div key={b.id} className="lib-rowitem">
              <BookCard book={b} coverMode={coverMode} onOpen={() => onOpen(b)} onEdit={() => onEdit(b)} />
            </div>
          ))}
        </div>
      ) : (
        <div className="lib-shelfrow-empty">{emptyMsg}</div>
      )}
    </section>
  );
}

function progressInfo(b: BookRow) {
  const f = b.fraction ?? 0;
  if (f >= 0.999) return { state: "done" as const, pct: 100 };
  if (f <= 0) return { state: "none" as const, pct: 0 };
  return { state: "reading" as const, pct: Math.round(f * 100) };
}

function BookCard({
  book,
  coverMode,
  onOpen,
  onEdit,
}: {
  book: BookRow;
  coverMode: CoverMode;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const p = progressInfo(book);
  const [failed, setFailed] = useState(false); // cover image absent or failed to load
  const title = book.title ?? "—";
  const arabic = ARABIC.test(title);
  const showImg = !!book.cover_path && !failed;
  // A per-book Crop/Fit override (RAWY-19) wins over the library-wide mode.
  const mode = book.cover_fit === "crop" || book.cover_fit === "fit" ? book.cover_fit : coverMode;
  return (
    <div
      className="lib-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={title}
    >
      <div className="lib-cover" data-mode={mode}>
        {showImg ? (
          <img className="real" src={convertFileSrc(book.cover_path!)} alt="" onError={() => setFailed(true)} />
        ) : (
          <AutoCover title={title} author={book.author} dir={book.dir} />
        )}
        {p.state === "reading" && <span className="lib-card-bar" style={{ width: `${p.pct}%` }} />}
        <button
          className="lib-card-edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title={t("edit.edit")}
          aria-label={t("edit.edit")}
        >
          ⋯
        </button>
      </div>
      <div className="lib-cap" dir={arabic ? "rtl" : "ltr"}>
        <div className={`lib-cap-title${arabic ? " ar" : ""}`}>{title}</div>
        {book.author && <div className={`lib-cap-author${arabic ? " ar" : ""}`}>{book.author}</div>}
      </div>
    </div>
  );
}

function EditBook({
  book,
  shelves,
  onShelves,
  onSaved,
  onDeleted,
  onClose,
}: {
  book: BookRow;
  shelves: CollectionRow[];
  onShelves: (rows: CollectionRow[]) => void;
  onSaved: (b: BookRow | null) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Shelf membership (RAWY-31): toggling a chip persists immediately (separate from the
  // metadata Save) and refreshes the sidebar counts via onShelves.
  const [member, setMember] = useState<Set<string>>(new Set());
  useEffect(() => {
    collectionsForBook(book.id).then((ids) => setMember(new Set(ids))).catch(console.error);
  }, [book.id]);
  const toggleShelf = async (id: string) => {
    const has = member.has(id);
    // optimistic
    setMember((prev) => {
      const next = new Set(prev);
      if (has) next.delete(id); else next.add(id);
      return next;
    });
    const rows = await (has ? collectionRemoveBook(id, book.id) : collectionAddBook(id, book.id))
      .catch((e) => { console.error(e); return null; });
    if (rows) onShelves(rows);
  };
  const [title, setTitle] = useState(book.title ?? "");
  const [author, setAuthor] = useState(book.author ?? "");
  const [language, setLanguage] = useState(book.language ?? "");
  const [dir, setDir] = useState<"ltr" | "rtl">(book.dir === "rtl" ? "rtl" : "ltr");
  const initialFit = book.cover_fit === "crop" || book.cover_fit === "fit" ? book.cover_fit : "";
  const [coverFit, setCoverFit] = useState<"" | "crop" | "fit">(initialFit);
  const [busy, setBusy] = useState(false);
  // RAWY-76: a deliberate two-step delete (matches the photo-card confirm pattern) — the footer
  // swaps to a confirm row so a stray click can't cascade-delete a book and all its data.
  const [confirmDel, setConfirmDel] = useState(false);
  const arabicTitle = ARABIC.test(title);

  const del = async () => {
    setBusy(true);
    try {
      await bookDelete(book.id);
      onDeleted();
    } catch (e) {
      console.error(e);
      setBusy(false);
      setConfirmDel(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const updated = await bookUpdate(book.id, { title, author, language, dir, coverFit });
      onSaved(updated);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };
  const replaceCover = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
      });
      if (!sel || Array.isArray(sel)) return;
      onSaved(await bookSetCover(book.id, sel));
    } catch (e) {
      console.error(e);
    }
  };
  const revertCover = async () => {
    try {
      onSaved(await bookRevertCover(book.id));
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <>
      <div className="panel-scrim show" onClick={onClose} />
      <div className="edit-dialog" role="dialog" aria-modal="true">
        <div className="edit-head">
          <span className="edit-title">{t("edit.title")}</span>
          <button className="rc-icon" onClick={onClose} aria-label={t("edit.cancel")}>✕</button>
        </div>
        <div className="edit-body">
          <div className="edit-cover">
            <div className="lib-cover" data-mode={coverFit || "crop"}>
              {book.cover_path ? (
                <img className="real" src={convertFileSrc(book.cover_path)} alt="" />
              ) : (
                <AutoCover title={book.title ?? "—"} author={book.author} dir={book.dir} />
              )}
            </div>
            <button className="edit-btn" onClick={replaceCover}>{t("edit.replaceCover")}</button>
            <button className="edit-link" onClick={revertCover}>{t("edit.revertCover")}</button>
          </div>

          <div className="edit-fields">
            <label className="edit-field">
              <span>{t("edit.fieldTitle")}</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={arabicTitle ? "ar" : ""}
                dir={arabicTitle ? "rtl" : "ltr"}
              />
            </label>
            <label className="edit-field">
              <span>{t("edit.author")}</span>
              <input value={author} onChange={(e) => setAuthor(e.target.value)} />
            </label>
            <div className="edit-row">
              <label className="edit-field">
                <span>{t("edit.language")}</span>
                <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en · ar · …" />
              </label>
              <div className="edit-field">
                <span>{t("edit.direction")}</span>
                <div className="edit-seg">
                  <button className={dir === "ltr" ? "active" : ""} onClick={() => setDir("ltr")}>{t("edit.ltr")}</button>
                  <button className={dir === "rtl" ? "active" : ""} onClick={() => setDir("rtl")}>{t("edit.rtl")}</button>
                </div>
              </div>
            </div>
            <div className="edit-field">
              <span>{t("edit.coverFit")}</span>
              <div className="edit-seg">
                <button className={coverFit === "" ? "active" : ""} onClick={() => setCoverFit("")}>{t("edit.fitDefault")}</button>
                <button className={coverFit === "crop" ? "active" : ""} onClick={() => setCoverFit("crop")}>{t("lib.cover.crop")}</button>
                <button className={coverFit === "fit" ? "active" : ""} onClick={() => setCoverFit("fit")}>{t("lib.cover.fit")}</button>
              </div>
            </div>
            <div className="edit-field">
              <span>{t("edit.shelves")}</span>
              {shelves.length === 0 ? (
                <div className="edit-shelves-hint">{t("edit.shelvesHint")}</div>
              ) : (
                <div className="edit-chips">
                  {shelves.map((s) => (
                    <button
                      key={s.id}
                      className={`edit-chip${member.has(s.id) ? " on" : ""}`}
                      onClick={() => toggleShelf(s.id)}
                      dir="auto"
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {confirmDel ? (
          <div className="edit-foot edit-foot-confirm">
            <span className="edit-del-warn" dir="auto">{t("edit.deleteConfirm")}</span>
            <div className="edit-foot-actions">
              <button className="edit-cancel" onClick={() => setConfirmDel(false)} disabled={busy}>{t("edit.deleteKeep")}</button>
              <button className="edit-del confirm" onClick={del} disabled={busy}>{t("edit.deleteYes")}</button>
            </div>
          </div>
        ) : (
          <div className="edit-foot">
            <button className="edit-del" onClick={() => setConfirmDel(true)} disabled={busy}>{t("edit.delete")}</button>
            <div className="edit-foot-actions">
              <button className="edit-cancel" onClick={onClose}>{t("edit.cancel")}</button>
              <button className="edit-save" onClick={save} disabled={busy}>{t("edit.save")}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ListRow({ book, onOpen, lang, t }: { book: BookRow; onOpen: () => void; lang: string; t: TFn }) {
  const p = progressInfo(book);
  const rtl = book.dir === "rtl";
  const readLabel = (() => {
    if (!book.read_at) return t("lib.date.none");
    const d = new Date(book.read_at * 1000);
    if (sameDay(d, new Date())) return t("lib.date.today");
    return new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", { month: "short", day: "numeric" }).format(d);
  })();
  return (
    <button className="lib-row" onClick={onOpen}>
      <span className="ll-thumb">
        <AutoCover title={book.title ?? "—"} dir={book.dir} variant="mini" />
      </span>
      {/* dir="auto" so a mixed AR title / Latin author each render + ellipsis-truncate on the
          correct side (design "Sard Library List Row"); block alignment follows the view direction. */}
      <span className={`ll-title${rtl ? " ar" : ""}`} dir="auto">
        {book.title}
      </span>
      <span className={`ll-author${rtl ? " ar" : ""}`} dir="auto">
        {book.author}
      </span>
      <span className="ll-format">
        {book.format && <span className="ll-badge">{book.format.toUpperCase()}</span>}
      </span>
      <span className="ll-progress">
        <span className="ll-bar">
          <span
            className={`ll-bar-fill${p.state === "done" ? " done" : ""}`}
            style={{ width: `${p.state === "none" ? 0 : p.pct}%` }}
          />
        </span>
        <span className={`ll-pct${p.state === "done" ? " done" : ""}`}>
          {p.state === "done" ? t("lib.progress.done") : p.state === "none" ? t("lib.progress.none") : localeDigits(`${p.pct}%`, lang)}
        </span>
      </span>
      <span className="ll-read">{readLabel}</span>
    </button>
  );
}

function EmptyState({ onBrowse, onFolder }: { onBrowse: () => void; onFolder: () => void }) {
  const { t } = useI18n();
  const [bird, setBird] = useState(true);
  return (
    <div className="lib-empty">
      <div className="page-grain lib-empty-grain" />
      {bird ? (
        // The hoopoe is the focal point (band K · KEEP). Falls back to the four faint
        // spines (band E) until assets/sard-bird.png is dropped in.
        <img
          src="/assets/sard-bird.png"
          alt=""
          aria-hidden="true"
          className="hoopoe lib-empty-bird"
          onError={() => setBird(false)}
        />
      ) : (
        <div className="lib-empty-spines" aria-hidden>
          <span style={{ height: 120 }} />
          <span style={{ height: 150 }} />
          <span style={{ height: 134 }} />
          <span style={{ height: 110 }} />
        </div>
      )}
      <div className="lib-empty-title">{t("lib.empty.title")}</div>
      <div className="lib-empty-sub">{t("lib.empty.sub")}</div>
      <div className="lib-empty-actions">
        <button className="lib-btn-primary" onClick={onBrowse}>
          {t("lib.empty.browse")}
        </button>
        <button className="lib-btn-ghost" onClick={onFolder}>
          {t("lib.empty.folder")}
        </button>
      </div>
    </div>
  );
}

function DropOverlay({ count, t, lang }: { count: number; t: TFn; lang: string }) {
  return (
    <div className="lib-drop">
      <div className="lib-drop-card">
        <div className="lib-drop-stack" aria-hidden>
          <span className="lib-drop-a" />
          <span className="lib-drop-b" />
          {count > 0 && <span className="lib-drop-badge">{localeNum(count, lang)}</span>}
        </div>
        <div className="lib-drop-title">
          {count === 1 ? t("lib.drop.titleOne") : t("lib.drop.title", { n: localeDigits(String(count || ""), lang) }).replace("  ", " ")}
        </div>
        <div className="lib-drop-formats">{t("lib.drop.formats")}</div>
      </div>
    </div>
  );
}
