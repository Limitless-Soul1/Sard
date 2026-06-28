import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useI18n } from "../../i18n";
import {
  collectionsList,
  importBooks,
  libraryListBooks,
  settingsGet,
  settingsSet,
  type BookRow,
  type CollectionRow,
  type ImportResult,
  type SortKey,
  type SortOrder,
} from "../../lib/ipc";
import { THEME_ORDER, THEMES, useTheme } from "../../theme";
import { AutoCover } from "./AutoCover";
import { Hoopoe } from "./Hoopoe";

// Detect Arabic from the TITLE TEXT itself, so a caption renders in Amiri even when the
// book's metadata mislabels its language (RAWY-17: e.g. an Arabic book tagged lang=en).
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
}

type View = "grid" | "list";
type CoverMode = "crop" | "fit";

const SORTS: SortKey[] = ["title", "author", "format", "date_read", "date_added"];
const SORT_KEY = { title: "lib.sort.title", author: "lib.sort.author", format: "lib.sort.format", date_read: "lib.sort.dateRead", date_added: "lib.sort.dateAdded" } as const;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const toArabic = (s: string) => s.replace(/[0-9]/g, (d) => AR_DIGITS[+d]);
const num = (n: number, lang: string) => (lang === "ar" ? toArabic(String(n)) : String(n));

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function summarize(results: ImportResult[], t: TFn): string {
  const c = { imported: 0, duplicate: 0, unsupported: 0, error: 0 };
  for (const r of results) c[r.status]++;
  const parts: string[] = [];
  if (c.imported) parts.push(t("lib.import.imported", { n: String(c.imported) }));
  if (c.duplicate) parts.push(t("lib.import.duplicate", { n: String(c.duplicate) }));
  if (c.unsupported) parts.push(t("lib.import.unsupported", { n: String(c.unsupported) }));
  if (c.error) parts.push(t("lib.import.error", { n: String(c.error) }));
  return parts.join(" · ") || t("lib.import.none");
}

export function Library({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang, setLang } = useI18n();

  const [books, setBooks] = useState<BookRow[]>([]);
  const [shelves, setShelves] = useState<CollectionRow[]>([]);
  const [view, setView] = useState<View>("grid");
  const [coverMode, setCoverMode] = useState<CoverMode>("crop");
  const [sort, setSort] = useState<SortKey>("date_read");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [format, setFormat] = useState<string | null>(null);
  const [shelf, setShelf] = useState<string | null>(null);
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
      if (v === "list" || v === "grid") setView(v);
      if (s && (SORTS as string[]).includes(s)) setSort(s as SortKey);
      if (o === "asc" || o === "desc") setOrder(o);
      if (c === "crop" || c === "fit") setCoverMode(c);
      if (sh) setShelf(sh);
      if (import.meta.env.DEV) {
        if ((await settingsGet("lib_force_empty")) === "1") setForceEmpty(true);
        if ((await settingsGet("lib_force_drop")) === "1") setDrag({ count: 3 });
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
  const loadBooks = useCallback(() => {
    libraryListBooks({ sort, order, format, collection: shelf, search }).then(setBooks).catch(console.error);
  }, [sort, order, format, shelf, search]);
  useEffect(() => loadShelves(), [loadShelves]);
  useEffect(() => loadBooks(), [loadBooks]);

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

  // Import a batch of paths through the real Rust pipeline, then refresh + summarise.
  const runImport = useCallback(
    async (paths: string[]) => {
      if (!paths.length || importing) return;
      setImporting(true);
      try {
        const results = await importBooks(paths);
        loadBooks();
        loadShelves();
        flashToast(summarize(results, t));
      } catch (e) {
        flashToast(String(e));
      } finally {
        setImporting(false);
      }
    },
    [importing, loadBooks, loadShelves, flashToast, t],
  );
  useEffect(() => {
    runImportRef.current = (paths) => void runImport(paths);
  }, [runImport]);

  // "Add books" → native file picker (EPUB only), then import the chosen files.
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

  // DEV: import a `;`-separated path list from the `dev_import` setting once (for capture/
  // verification, since PrintWindow can't drive a live OS drag), then clear it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (async () => {
      const di = await settingsGet("dev_import");
      if (!di) return;
      await settingsSet("dev_import", "");
      runImportRef.current(di.split(";").map((s) => s.trim()).filter(Boolean));
    })().catch(console.error);
  }, []);

  if (!hydrated) return null; // brief: settings loading (avoids a grid→list flash)

  const isEmpty = forceEmpty || (books.length === 0 && !search && !format && !shelf);
  const count = books.length;

  const pickShelf = (id: string | null) => {
    setShelf(id);
    setMenu(null);
  };
  const open = (b: BookRow) => onOpen({ id: b.id, filePath: b.file_path, dir: b.dir });

  return (
    <div className="lib-root">
      <aside className="lib-sidebar">
        <div className="lib-brand">
          {/* Bird on the leading edge; the script nearest it is the UI's own (band K). */}
          <Hoopoe size={30} className="lib-brand-bird" />
          {lang === "ar" ? (
            <>
              <span className="lib-word-ar">سَرْد</span>
              <span className="lib-word-sep" />
              <span className="lib-word-latin">Sard</span>
            </>
          ) : (
            <>
              <span className="lib-word-latin">Sard</span>
              <span className="lib-word-sep" />
              <span className="lib-word-ar">سَرْد</span>
            </>
          )}
        </div>

        <nav className="lib-nav">
          <button className="lib-nav-item active" onClick={() => pickShelf(null)}>
            <span className="lib-nav-ico lib-ico-library" />
            {t("lib.nav.library")}
          </button>
          <button className="lib-nav-item" disabled title={t("lib.importSoon")}>
            <span className="lib-nav-ico lib-ico-highlights" />
            {t("lib.nav.highlights")}
          </button>
          <button className="lib-nav-item" disabled>
            <span className="lib-nav-ico lib-ico-reading" />
            {t("lib.nav.readingNow")}
          </button>
        </nav>

        <div className="lib-shelves-label">{t("lib.shelves")}</div>
        <div className="lib-shelves">
          {shelves.length === 0 && <div className="lib-shelf-empty">{t("lib.noShelves")}</div>}
          {shelves.map((s) => (
            <button
              key={s.id}
              className={`lib-shelf${shelf === s.id ? " active" : ""}`}
              onClick={() => pickShelf(shelf === s.id ? null : s.id)}
            >
              <span className="lib-shelf-name">{s.name}</span>
              <span className="lib-shelf-count">{num(s.count, lang)}</span>
            </button>
          ))}
          <button className="lib-shelf lib-shelf-new" disabled>
            {t("lib.newShelf")}
          </button>
        </div>

        <div className="lib-sidefoot">
          <button
            className="lib-lang"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            title={t("settings.language")}
          >
            <span className="lib-lang-globe" aria-hidden>◍</span>
            <span className={lang === "ar" ? "lib-lang-ar" : undefined}>
              {lang === "ar" ? "العربية" : "English"}
            </span>
          </button>
          <ThemeSwitcher />
        </div>
      </aside>

      <main className="lib-main">
        {isEmpty ? (
          <EmptyState onBrowse={addBooks} />
        ) : (
          <>
            <header className="lib-head">
              <div className="lib-head-top">
                <div className="lib-title-wrap">
                  <h1 className="lib-title">{t("lib.title")}</h1>
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
                              setSort(k);
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

            {view === "grid" ? (
              <div className="lib-grid">
                {books.map((b) => (
                  <BookCard key={b.id} book={b} coverMode={coverMode} onOpen={() => open(b)} />
                ))}
              </div>
            ) : (
              <div className="lib-list">
                <div className="lib-list-head">
                  <span className="ll-thumb" />
                  <button className={`ll-title sortable${sort === "title" ? " active" : ""}`} onClick={() => setSort("title")}>
                    {t("lib.col.title")} {sort === "title" && (order === "asc" ? "↑" : "↓")}
                  </button>
                  <button className={`ll-author sortable${sort === "author" ? " active" : ""}`} onClick={() => setSort("author")}>
                    {t("lib.col.author")} {sort === "author" && (order === "asc" ? "↑" : "↓")}
                  </button>
                  <button className={`ll-format sortable${sort === "format" ? " active" : ""}`} onClick={() => setSort("format")}>
                    {t("lib.col.format")} {sort === "format" && (order === "asc" ? "↑" : "↓")}
                  </button>
                  <span className="ll-progress">{t("lib.col.progress")}</span>
                  <button className={`ll-read sortable${sort === "date_read" ? " active" : ""}`} onClick={() => setSort("date_read")}>
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

        {drag && <DropOverlay count={drag.count} t={t} />}
      </main>

      {toast && <div className="lib-toast">{toast}</div>}
    </div>
  );
}

type TFn = ReturnType<typeof useI18n>["t"];

function progressInfo(b: BookRow) {
  const f = b.fraction ?? 0;
  if (f >= 0.999) return { state: "done" as const, pct: 100 };
  if (f <= 0) return { state: "none" as const, pct: 0 };
  return { state: "reading" as const, pct: Math.round(f * 100) };
}

function BookCard({ book, coverMode, onOpen }: { book: BookRow; coverMode: CoverMode; onOpen: () => void }) {
  const p = progressInfo(book);
  const [failed, setFailed] = useState(false); // cover image absent or failed to load
  const title = book.title ?? "—";
  const arabic = ARABIC.test(title);
  const showImg = !!book.cover_path && !failed;
  return (
    <button className="lib-card" onClick={onOpen} title={title}>
      <div className="lib-cover" data-mode={coverMode}>
        {showImg ? (
          <img className="real" src={convertFileSrc(book.cover_path!)} alt="" onError={() => setFailed(true)} />
        ) : (
          <AutoCover title={title} author={book.author} dir={book.dir} />
        )}
        {p.state === "reading" && <span className="lib-card-bar" style={{ width: `${p.pct}%` }} />}
      </div>
      <div className="lib-cap" dir={arabic ? "rtl" : "ltr"}>
        <div className={`lib-cap-title${arabic ? " ar" : ""}`}>{title}</div>
        {book.author && <div className={`lib-cap-author${arabic ? " ar" : ""}`}>{book.author}</div>}
      </div>
    </button>
  );
}

function ThemeSwitcher() {
  const { t } = useI18n();
  const themeId = useTheme((s) => s.themeId);
  const setTheme = useTheme((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  return (
    <div className="lib-theme">
      <button
        className="lib-theme-btn"
        onClick={() => setOpen((o) => !o)}
        title={t("theme.label")}
        aria-label={t("theme.label")}
      >
        ◐
      </button>
      {open && (
        <>
          <div className="lib-clickaway" onClick={() => setOpen(false)} />
          <div className="lib-theme-menu">
            {THEME_ORDER.map((id) => {
              const th = THEMES[id];
              return (
                <button
                  key={id}
                  className={`lib-swatch${id === themeId ? " active" : ""}`}
                  style={{ background: th.colors.paperBg, borderColor: th.colors.accent }}
                  onClick={() => {
                    setTheme(id);
                    setOpen(false);
                  }}
                  title={th.name}
                  aria-label={th.name}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
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
      <span className={`ll-title${rtl ? " ar" : ""}`} dir={rtl ? "rtl" : "ltr"}>
        {book.title}
      </span>
      <span className={`ll-author${rtl ? " ar" : ""}`} dir={rtl ? "rtl" : "ltr"}>
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
          {p.state === "done" ? t("lib.progress.done") : p.state === "none" ? t("lib.progress.none") : `${p.pct}%`}
        </span>
      </span>
      <span className="ll-read">{readLabel}</span>
    </button>
  );
}

function EmptyState({ onBrowse }: { onBrowse: () => void }) {
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
        <button className="lib-btn-ghost" onClick={onBrowse}>
          {t("lib.empty.folder")}
        </button>
      </div>
    </div>
  );
}

function DropOverlay({ count, t }: { count: number; t: TFn }) {
  return (
    <div className="lib-drop">
      <div className="lib-drop-card">
        <div className="lib-drop-stack" aria-hidden>
          <span className="lib-drop-a" />
          <span className="lib-drop-b" />
          {count > 0 && <span className="lib-drop-badge">{count}</span>}
        </div>
        <div className="lib-drop-title">
          {count === 1 ? t("lib.drop.titleOne") : t("lib.drop.title", { n: String(count || "") }).replace("  ", " ")}
        </div>
        <div className="lib-drop-formats">{t("lib.drop.formats")}</div>
      </div>
    </div>
  );
}
