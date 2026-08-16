import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import {
  bookCommitCover,
  bookDelete,
  bookDiscardCover,
  bookRevertCover,
  bookStageCover,
  bookUpdate,
  collectionAddBook,
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
// RESILIENCE-1 / WP-1
import { buildImportReport, isCleanImport, splitByCapability, type ImportReport } from "./importReport";
import { classifyBookError } from "../../lib/bookErrors";
import { recordDiagnostic, toDiagnostic } from "../../lib/errors";
import { canRender } from "../../lib/runtime";
import { openWebView2Help } from "../../lib/webview2";
import { AutoCover } from "./AutoCover";
import { coverSrc } from "./coverSrc";

// What the picker OFFERS. Deliberately not an acceptance rule: Rust decodes what it can and anything
// else is put to the renderer, so this list only spares the reader from browsing to a file that was
// never going to be an image. Adding a format here costs nothing and rejects nothing.
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "svg", "bmp", "ico"];
import { GlobalSettings } from "../settings/GlobalSettings";
import { UpdateRosette } from "../updater/UpdateRosette";
import { UpdateDialog } from "../updater/UpdateDialog";
import { LibraryDesign } from "./design/LibraryDesign";
import "../../styles/library-design.css";
import { displayTitle, resolveBookMeta, titleIsGuess, titleProvenanceKey } from "../../lib/bookMeta"; // WP-3
import { Inbox } from "./Inbox";
import { routeDroppedPaths } from "../profiles/dropRoute";
import { BookmarksShelf } from "./BookmarksShelf";
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
  // RESILIENCE-1 / WP-3 — a HINT, not the source. The reader re-reads the row by id; these only
  // stand in if that read fails, so a launching surface never becomes an authority on the name.
  title?: string | null;
  author?: string | null;
}

type View = "grid" | "list" | "rows";
type CoverMode = "crop" | "fit";
type Section = "library" | "inbox" | "cards" | "bookmarks";

const SORTS: SortKey[] = ["title", "author", "format", "date_read", "date_added"];

// RAWY-82 (#16): search input → book-list reload delay. Short enough to stay snappy, long enough
// that a fast typist fires ONE query at the end rather than one per keystroke.
const SEARCH_DEBOUNCE_MS = 250;

// RAWY-269 (2) — the persisted library prefs, cached for the LIFE OF THE PROCESS.
// `Library` gates its entire render on `hydrated` and re-mounts on every return from the reader, so
// those five `settingsGet` round-trips used to render `null` — a genuinely EMPTY document — between
// the book and the library. Measured on the release build: whole-window luminance 18.2 -> 5.99 ->
// 39.4, i.e. ~37 ms of a near-black window, every single time.
// The FIRST mount still awaits the IPC (there is nothing to read yet); every later mount seeds its
// initial state from here SYNCHRONOUSLY, so `hydrated` starts true and no empty frame can exist.
// The cache is written back by the same effects that persist each pref, so it never goes stale.
interface LibPrefs {
  view: View;
  sort: SortKey;
  order: SortOrder;
  cover: CoverMode;
  shelf: string | null;
}
let prefsCache: LibPrefs | null = null;

// RAWY-269 (2) — the last library CONTENTS, cached for the same reason and with the same lifetime.
// `books`/`shelves` used to start empty on every re-mount, so returning from the reader rendered the
// library's own EMPTY STATE — "your library is waiting", with Browse/Import buttons — for ~190 ms
// before the query landed. (That was always true; it was simply hidden behind the near-black frame
// that fix (2) removed. Exposing it is not a regression, and it is not something to leave standing:
// telling a reader their library is empty, twice a session, is the worst frame in the app.)
// `booksCache === null` means NO query has completed in this process yet — which is what makes the
// empty state honest on a genuinely empty library and impossible before the first answer arrives.
let booksCache: BookRow[] | null = null;
let shelvesCache: CollectionRow[] = [];

// RAWY-269 (1) — the longest a section swap may wait for the incoming pane before it is shown
// anyway. This is a SAFETY CAP, not a delay: a healthy section reports ready in 15-160 ms. Its only
// job is to guarantee that a section which never becomes ready (an unreadable image, a failed
// query) can never strand navigation.
const SECTION_SWAP_MAX_MS = 700;

// RAWY-269 (5) — the longest `warmCovers` may hold a book list back.
const COVER_WARM_MAX_MS = 220;

// RAWY-269 (1) — how many LIBRARY-pane data loads are in flight, counted across the flat views
// (`loadBooks`) and the rows view (`ShelfRows`), which is why it is module-level rather than a ref.
//
// "The pane has content" is not enough to call the LIBRARY ready: clicking the Library nav also
// clears the shelf filter, so the preloaded pane renders with the PREVIOUS shelf's books and only
// then re-queries. Committing on content alone showed the library holding one book and repopulating
// ~140 ms later (measured: pane luma 64.85 -> 25.01 -> 45.09), which is the same instability the
// swap exists to remove, arriving one step later. The swap waits for this to reach zero.
const libLoads = { inFlight: 0 };

/**
 * RAWY-269 (5) — decode a list's covers BEFORE the list is published to React.
 *
 * A shelf change replaces `books` wholesale, so every cover the new shelf does not share with the
 * old one arrives as a brand-new `<img>` with no pixels yet. Measured pre-fix, the grid laid out
 * first and the images landed 2-3 frames later: whole-window luminance 32.71 -> 24.09 (DARKER than
 * either endpoint - the cover cells were empty) -> 62.50. Warming the decode first turns that into
 * one atomic swap.
 *
 * Bounded and failure-tolerant by construction: a cover that cannot be decoded is simply not waited
 * for, and the whole wait gives up at `COVER_WARM_MAX_MS`. A broken or slow image must never be able
 * to hold the library back — that would trade a flash for a freeze.
 */
function warmCovers(rows: readonly BookRow[]): Promise<void> {
  const urls = [...new Set(rows.map((r) => r.cover_path).filter((p): p is string => !!p))];
  if (!urls.length) return Promise.resolve();
  const all = Promise.all(
    urls.map((p) => {
      const img = new Image();
      img.src = convertFileSrc(p);
      return img.decode().catch(() => undefined);
    }),
  ).then(() => undefined);
  return Promise.race([all, new Promise<void>((res) => window.setTimeout(res, COVER_WARM_MAX_MS))]);
}

/** The quiet one-line summary — used ONLY when every file was handled without a problem. */
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

/**
 * RESILIENCE-1 / WP-1 — the per-file import result panel.
 *
 * Shown only when something did NOT get added; a clean import keeps the unobtrusive toast. Each
 * problem names the file and states the reason in one sentence. Rust's own message is kept behind
 * Details, never in the list — the same rule the reader's error card follows.
 */
function ImportResultsPanel({
  report,
  onDismiss,
  t,
  lang,
}: {
  report: ImportReport;
  onDismiss: () => void;
  t: TFn;
  lang: string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const hasRuntimeBlocked = report.runtimeBlocked.length > 0;
  return (
    <div className="import-report" role="alert">
      <div className="import-report-head">
        <span className="import-report-title">{t("lib.import.resultsTitle")}</span>
        <button className="rp-x" onClick={onDismiss} aria-label={t("lib.import.dismiss")}>
          ✕
        </button>
      </div>
      <div className="import-report-counts">
        {report.added > 0 && <span>{t("lib.import.okCount", { n: localeNum(report.added, lang) })}</span>}
        {report.duplicates > 0 && <span>{t("lib.import.duplicate", { n: localeNum(report.duplicates, lang) })}</span>}
        <span className="import-report-bad">
          {t("lib.import.problemCount", { n: localeNum(report.problems.length, lang) })}
        </span>
      </div>

      {hasRuntimeBlocked && (
        <p className="import-report-runtime">
          {t(report.runtimeBlocked.length === 1 ? "err.pdfBlocked.one" : "err.pdfBlocked.many", {
            n: localeNum(report.runtimeBlocked.length, lang),
          })}{" "}
          <button className="import-report-link" onClick={() => void openWebView2Help()}>
            {t("err.act.updateRuntime")}
          </button>
        </p>
      )}

      <ul className="import-report-list">
        {report.problems.map((p, i) => (
          <li key={`${p.name}-${i}`} data-fault={p.fault}>
            <span className="import-report-name" dir="auto">
              {p.name}
            </span>
            <span className="import-report-reason">{t(p.reasonKey)}</span>
          </li>
        ))}
      </ul>

      <button className="reader-error-btn err-btn-quiet" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
        {t(showDetails ? "err.act.hideDetails" : "err.act.details")}
      </button>
      {showDetails && (
        <div className="err-details">
          <div className="err-details-note">{t("err.detailsNote")}</div>
          {/* The ONLY place Rust's raw message is rendered. */}
          <pre className="reader-error-detail">
            {report.problems.map((p) => `${p.name}\n  ${p.status}: ${p.raw ?? "(no message)"}`).join("\n\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

export function Library({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang } = useI18n();

  // RAWY-269 (1): `section` is the pane ON SCREEN; `wanted` is the one the user asked for that is
  // still preparing off-screen. The sidebar highlights `wanted ?? section`, so the click still
  // registers instantly — only the PANE waits, and it waits by staying on the old content rather
  // than by going blank.
  const [section, setSection] = useState<Section>("library");
  const [wanted, setWanted] = useState<Section | null>(null);
  const preloadRef = useRef<HTMLDivElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // RAWY-39 global settings
  // RAWY-269 (2): seeded from the process-lifetime caches, and every write goes back into them.
  const [books, setBooksState] = useState<BookRow[]>(() => booksCache ?? []);
  const [booksLoaded, setBooksLoaded] = useState(() => booksCache !== null);
  const setBooks = useCallback((rows: BookRow[]) => {
    booksCache = rows;
    setBooksState(rows);
    setBooksLoaded(true);
  }, []);
  const [editing, setEditing] = useState<BookRow | null>(null);
  const [shelves, setShelvesState] = useState<CollectionRow[]>(() => shelvesCache);
  const setShelves = useCallback((rows: CollectionRow[]) => {
    shelvesCache = rows;
    setShelvesState(rows);
  }, []);
  // RAWY-269 (2): seeded from the process-lifetime cache, so a re-mount is already correct.
  const [view, setView] = useState<View>(() => prefsCache?.view ?? "grid");
  const [coverMode, setCoverMode] = useState<CoverMode>(() => prefsCache?.cover ?? "crop");
  const [sort, setSort] = useState<SortKey>(() => prefsCache?.sort ?? "date_read");
  const [order, setOrder] = useState<SortOrder>(() => prefsCache?.order ?? "desc");
  // RAWY-15's format filter. It drives `library_list_books` in SQL, so it must stay a real piece
  // of state rather than a constant — dropping its control left this pinned at null and the filter
  // unreachable.
  const [format, setFormat] = useState<string | null>(null);
  const [shelf, setShelf] = useState<string | null>(() => prefsCache?.shelf ?? null);
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<{ count: number } | null>(null);
  const [forceEmpty, setForceEmpty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // RESILIENCE-1 / WP-1: the per-file result panel. Non-null only when something wasn't added — a
  // clean import keeps the quiet toast it has always had.
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // Remember the reader's view/sort/cover/shelf choices across sessions (persisted via
  // the settings IPC). Gate the first paint on hydration so we don't flash defaults.
  // RAWY-269 (2): only the FIRST mount of the process is ever un-hydrated — see `prefsCache`.
  const [hydrated, setHydrated] = useState(() => prefsCache !== null);
  useEffect(() => {
    (async () => {
      if (!prefsCache) {
        const [v, s, o, c, sh] = await Promise.all([
          settingsGet("lib_view"), settingsGet("lib_sort"), settingsGet("lib_order"),
          settingsGet("lib_cover"), settingsGet("lib_shelf"),
        ]);
        prefsCache = {
          view: v === "list" || v === "grid" || v === "rows" ? v : "grid",
          sort: s && (SORTS as string[]).includes(s) ? (s as SortKey) : "date_read",
          order: o === "asc" || o === "desc" ? o : "desc",
          cover: c === "crop" || c === "fit" ? c : "crop",
          shelf: sh || null,
        };
        setView(prefsCache.view);
        setSort(prefsCache.sort);
        setOrder(prefsCache.order);
        setCoverMode(prefsCache.cover);
        setShelf(prefsCache.shelf);
      }
      if (import.meta.env.DEV) {
        if ((await settingsGet("lib_force_empty")) === "1") setForceEmpty(true);
        if ((await settingsGet("lib_force_drop")) === "1") setDrag({ count: 3 });
        if ((await settingsGet("dev_section")) === "inbox") setSection("inbox"); // RAWY-27 screenshots
      }
      setHydrated(true);
    })().catch(() => setHydrated(true));
  }, []);
  // Each pref is persisted AND written back into the cache, so the cache can never go stale.
  useEffect(() => { if (hydrated) { if (prefsCache) prefsCache.view = view; settingsSet("lib_view", view).catch(console.error); } }, [view, hydrated]);
  useEffect(() => { if (hydrated) { if (prefsCache) prefsCache.sort = sort; settingsSet("lib_sort", sort).catch(console.error); } }, [sort, hydrated]);
  useEffect(() => { if (hydrated) { if (prefsCache) prefsCache.order = order; settingsSet("lib_order", order).catch(console.error); } }, [order, hydrated]);
  useEffect(() => { if (hydrated) { if (prefsCache) prefsCache.cover = coverMode; settingsSet("lib_cover", coverMode).catch(console.error); } }, [coverMode, hydrated]);
  useEffect(() => { if (hydrated) { if (prefsCache) prefsCache.shelf = shelf; settingsSet("lib_shelf", shelf ?? "").catch(console.error); } }, [shelf, hydrated]);

  // Shelves + books load on mount and re-load on import; books also re-query on sort/filter.
  const loadShelves = useCallback(() => {
    collectionsList().then(setShelves).catch(console.error);
  }, [setShelves]);
  // RAWY-82 (#16): every load is request-ordered — a monotonic seq means a slower, STALER response
  // (e.g. a shorter earlier query) can't overwrite a fresher one; the latest request always wins.
  const loadSeqRef = useRef(0);
  const loadBooks = useCallback(() => {
    const seq = ++loadSeqRef.current;
    libLoads.inFlight++; // RAWY-269 (1)
    libraryListBooks({ sort, order, format, collection: shelf, search })
      .then(async (rows) => {
        // RAWY-269 (5): decode the incoming covers before publishing, so the swap is atomic.
        // The seq guard is re-checked AFTER the await — the warm is another place a stale response
        // could overtake a fresher one, and RAWY-82's "the latest request always wins" must hold
        // across it too.
        if (seq !== loadSeqRef.current) return;
        await warmCovers(rows);
        if (seq === loadSeqRef.current) setBooks(rows);
      })
      .catch(console.error)
      .finally(() => { libLoads.inFlight--; });
  }, [sort, order, format, shelf, search, setBooks]);

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
            void routeDroppedPaths(p.paths, runImportRef.current);
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
    // RAWY-196: `e.code` (physical key), not `e.key` — on a non-Latin layout `e.key` is the Arabic
    // letter, so these dev aids never fired on the owner's keyboard. Dev-only, but same defect class.
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.code === "KeyD") setDrag((d) => (d ? null : { count: 3 }));
      if (e.shiftKey && e.code === "KeyE") setForceEmpty((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // RAWY-269 (1) — SECTION NAVIGATION IS AN ATOMIC SWAP.
  //
  // The three section components each render nothing while their own IPC is in flight (`Inbox` and
  // `BookmarksShelf` return `null`, `PhotoGallery` returns an empty shell), so `.lib-main` used to
  // drop to ZERO children. On a library whose ground is the reader's own photograph that is not a
  // neutral pause — you see straight through to the wallpaper. Measured pane luminance:
  // Highlights 45.10 -> 22.69 (158 ms), Bookmarks 56.29 -> 22.69, Cards 29.76 -> 22.69 -> 12.59
  // (~95 ms through TWO blank tones), Library 64.90 -> 25.04 (134 ms).
  //
  // Fix: mount the incoming section in `.lib-pane-preload` — `visibility:hidden`, which is
  // LOAD-BEARING and not interchangeable with `display:none`: a `display:none` subtree is not laid
  // out, so its images would never load and it could never become ready. Readiness is judged from
  // the OUTSIDE (the pane has content, and every in-viewport image has decoded), which is why not
  // one section component needed a new prop or a new contract.
  const goSection = useCallback((s: Section) => {
    setWanted((w) => (s === section ? null : s === w ? w : s));
  }, [section]);

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    let raf = 0;
    const started = performance.now();
    const commit = () => {
      if (!alive) return;
      alive = false;
      setSection(wanted);
      setWanted(null);
    };
    // Only images that would actually be ON SCREEN can hold the swap: `loading="lazy"` thumbnails
    // below the fold never load, and waiting on them would turn every visit to Cards into a
    // `SECTION_SWAP_MAX_MS` stall.
    const onScreen = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
    };
    const poll = () => {
      if (!alive) return;
      const node = preloadRef.current;
      const late = performance.now() - started >= SECTION_SWAP_MAX_MS;
      // `textContent`, never `innerText` — `innerText` is layout-aware and returns "" for a
      // `visibility:hidden` subtree, so it would report every preloaded pane as empty forever.
      const hasContent = !!node && (node.textContent!.trim().length > 0 || !!node.querySelector("img"));
      // The library pane must also have no query in flight — see `libLoads`. The other three
      // sections render nothing at all until their own load lands, so `hasContent` already says it.
      const settled = wanted !== "library" || libLoads.inFlight === 0;
      if (node && hasContent && settled) {
        const imgs = [...node.querySelectorAll("img")].filter(onScreen);
        if (late || imgs.every((i) => i.complete)) {
          // Decode before committing, then let one frame pass, so the pane becomes visible on a
          // subtree that is already rastered rather than one that still has to be.
          void Promise.all(imgs.map((i) => i.decode().catch(() => undefined))).then(() =>
            requestAnimationFrame(() => requestAnimationFrame(commit)),
          );
          return;
        }
      }
      if (late) { commit(); return; }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [wanted]);

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
        // RESILIENCE-1 / WP-1: refuse formats this runtime cannot render BEFORE importing them.
        // The library should represent usable content — an entry guaranteed to fail on open is
        // worse than an honest refusal that names the fix.
        const { accepted, blocked } = splitByCapability(paths, canRender("pdf"));
        const results = accepted.length ? await importBooks(accepted) : [];
        loadBooks();
        loadShelves();
        const report = buildImportReport(results, blocked);
        // Every refused file is recorded, so a compatibility problem stays diagnosable later
        // without asking the user to reproduce it (principle 5).
        for (const p of report.problems) {
          recordDiagnostic({
            at: Date.now(),
            scope: "import",
            kind: p.status,
            fault: p.fault,
            raw: p.raw ?? "(no message from the import pipeline)",
            context: { file: p.name },
          });
        }
        if (isCleanImport(report)) flashToast(summarize(results, t, lang));
        else setImportReport(report);
        await surfaceEditForNew(results);
      } catch (e) {
        // The batch itself failed (not one file) — classify it rather than printing the throwable.
        const c = classifyBookError(e, { stage: "import-batch" });
        recordDiagnostic(toDiagnostic("import", c));
        flashToast(t(c.presentation.titleKey));
      } finally {
        setImporting(false);
      }
    },
    [importing, loadBooks, loadShelves, flashToast, t, lang, surfaceEditForNew],
  );
  useEffect(() => {
    runImportRef.current = (paths) => void runImport(paths);
  }, [runImport]);

  // "Browse files…" → native file picker (EPUB + PDF — RAWY-176/AUD-5; was EPUB-only, so a PDF could
  // only be added by drag-drop), then import the chosen files.
  const addBooks = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      // RESILIENCE-1 / WP-1: don't offer a format this runtime cannot render. Drag-drop and folder
      // import can still deliver a PDF, and `splitByCapability` refuses those with an explanation —
      // this just stops the picker inviting the mistake in the first place.
      const extensions = canRender("pdf") ? ["epub", "pdf"] : ["epub"];
      const sel = await open({ multiple: true, filters: [{ name: "Books", extensions }] });
      if (!sel) return;
      runImport(Array.isArray(sel) ? sel : [sel]);
    } catch (e) {
      flashToast(String(e));
    }
  }, [runImport, flashToast]);

  // "Import a folder" → native DIRECTORY picker, then import every EPUB and PDF inside it (RAWY-80,
  // audit #7 — this button used to open the same file picker as "Browse files"; RAWY-176/AUD-5 adds
  // PDF so a folder import matches drag-drop). Same pipeline (dedup, format-detect, managed copy); an
  // empty folder just reports "no books added".
  const addFolder = useCallback(async () => {
    if (importing) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return;
      setImporting(true);
      try {
        // RESILIENCE-1 / WP-1: a folder import walks the tree Rust-side, so a PDF cannot be filtered
        // out before the call — it is reported afterwards instead, through the same panel. Same
        // outcome, same explanation, one code path for the user.
        const results = await importFolder(dir);
        loadBooks();
        loadShelves();
        const report = buildImportReport(results);
        for (const p of report.problems) {
          recordDiagnostic({
            at: Date.now(),
            scope: "import",
            kind: p.status,
            fault: p.fault,
            raw: p.raw ?? "(no message from the import pipeline)",
            context: { file: p.name, source: "folder" },
          });
        }
        if (isCleanImport(report)) flashToast(summarize(results, t, lang));
        else setImportReport(report);
        await surfaceEditForNew(results);
      } finally {
        setImporting(false);
      }
    } catch (e) {
      const c = classifyBookError(e, { stage: "import-folder" });
      recordDiagnostic(toDiagnostic("import", c));
      flashToast(t(c.presentation.titleKey));
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

  // RAWY-269 (2): `booksLoaded` is what stops the empty state being shown before the first query has
  // ever answered — "I have not looked yet" is not the same claim as "there is nothing here".
  const isEmpty = forceEmpty || (booksLoaded && books.length === 0 && !search && !format && !shelf);

  const pickShelf = (id: string | null) => setShelf(id);
  // WP-3: the card passes what it is displaying as a hint, so a failed row read still shows the same
  // name the reader just clicked — never as the authority (the reader re-reads the row by id).
  const open = (b: BookRow) =>
    onOpen({ id: b.id, filePath: b.file_path, dir: b.dir, format: b.format, title: b.title, author: b.author });

  // Shelf writes (RAWY-31): still the only Rust↔JS path for renaming and deleting a shelf. The
  // design's sidebar drives them now instead of the old shelf row, but the calls — and the rule
  // that deleting a shelf leaves its BOOKS alone — are unchanged.
  const renameShelf = async (id: string, name: string) => {
    if (!name.trim()) return;
    setShelves(await collectionRename(id, name.trim()).catch((e) => { console.error(e); return shelves; }));
  };
  const removeShelf = async (id: string) => {
    const s = shelves.find((x) => x.id === id);
    if (shelf === id) pickShelf(null); // leave a filtered view we're about to delete
    setShelves(await collectionDelete(id).catch((e) => { console.error(e); return shelves; }));
    if (s) flashToast(t("lib.shelf.deleted", { name: s.name }));
  };
  const navSection: Section = wanted ?? section;

  // The library design owns the chrome and the view switcher. Everything below it — the
  // import path, the edit dialog, the toast, the settings and update surfaces, and the GRID
  // renderer itself — is the existing Library, handed in rather than reimplemented.
  return (
    <>
      <LibraryDesign
        books={books}
        section={navSection}
        onSection={goSection}
        renderSection={(s) => paneFor(s)}
        // GRID — the original Library grid, unchanged: the same `.lib-grid` container (which owns
        // its own scroll and RAWY-170's bottom padding), the same `BookCard`, the same cover mode,
        // and the same empty state it has always shown.
        renderGrid={() =>
          isEmpty ? (
            <EmptyState onBrowse={addBooks} onFolder={addFolder} />
          ) : (
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
          )
        }
        coverMode={coverMode}
        onCoverMode={() => setCoverMode((m) => (m === "crop" ? "fit" : "crop"))}
        format={format}
        onFormat={setFormat}
        onOpenBook={open}
        onEditBook={setEditing}
        onAddBooks={addBooks}
        importing={importing}
        onSettings={() => setSettingsOpen(true)}
        onReloadBooks={loadBooks}
        query={search}
        onQuery={setSearch}
        onRenameShelf={renameShelf}
        onDeleteShelf={removeShelf}
      />
      {editing && (
        <EditBook
          book={editing}
          shelves={shelves}
          onShelves={(rows) => {
            setShelves(rows);
            loadBooks();
          }}
          onClose={() => setEditing(null)}
          onSaved={(b) => {
            loadBooks();
            loadShelves();
            if (b) setEditing(b);
          }}
          onDeleted={() => {
            const title = displayTitle(resolveBookMeta(editing), t);
            setEditing(null);
            loadBooks();
            loadShelves();
            flashToast(t("lib.book.deleted", { title }));
          }}
        />
      )}
      {drag && <DropOverlay count={drag.count} t={t} lang={lang} />}
      {toast && <div className="lib-toast">{toast}</div>}
      {importReport && (
        <ImportResultsPanel report={importReport} onDismiss={() => setImportReport(null)} t={t} lang={lang} />
      )}
      <GlobalSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UpdateRosette />
      <UpdateDialog />
    </>
  );


  // RAWY-269 (1): one pane per section, so the visible slot and the preload slot render through the
  // SAME code path — a preloaded pane is byte-for-byte the pane that will be shown, never a
  // lookalike. Declared after the return as a hoisted function so the JSX above stays in reading
  // order; it closes over the render's own values, like the JSX does.
  //
  // The LIBRARY section is no longer one of these: the design surface renders it, and the Grid view
  // inside it is the same `BookCard` grid this used to draw.
  function paneFor(s: Section) {
    if (s === "cards") return <PhotoGallery />;
    if (s === "inbox") return <Inbox onOpen={onOpen} />;
    if (s === "bookmarks") return <BookmarksShelf onOpen={onOpen} />;
    if (isEmpty) return <EmptyState onBrowse={addBooks} onFolder={addFolder} />;
    return null;
  }
}

type TFn = ReturnType<typeof useI18n>["t"];

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
  const title = displayTitle(resolveBookMeta(book), t); // WP-3: the same chrome every surface uses
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
          // RAWY-269 (5): `decoding="sync"` asks the frame that first shows the card to show its
          // cover too, instead of presenting the plate and landing the image 2-3 frames later.
          <img className="real" src={coverSrc(book)!} alt="" decoding="sync" onError={() => setFailed(true)} />
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
  const initialFit = book.cover_fit === "crop" || book.cover_fit === "fit" ? book.cover_fit : "";
  const [coverFit, setCoverFit] = useState<"" | "crop" | "fit">(initialFit);
  const [busy, setBusy] = useState(false);
  // Why a message and not a silent no-op: the reported complaint was that replacing a cover simply
  // did nothing, leaving the reader to guess. A refusal must say why.
  const [coverError, setCoverError] = useState<string | null>(null);
  // RAWY-76: a deliberate two-step delete (matches the photo-card confirm pattern) — the footer
  // swaps to a confirm row so a stray click can't cascade-delete a book and all its data.
  const [confirmDel, setConfirmDel] = useState(false);
  const arabicTitle = ARABIC.test(title);
  const editMeta = resolveBookMeta(book); // WP-3: where this book's stored name actually came from

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
      // RAWY-271: `dir` is deliberately ABSENT from the patch. Reading direction is decided
      // automatically (books/mod.rs: the EPUB's page-progression, then the language, then a
      // content sniff of the Arabic script — plus migration 8's backfill), so there is no user
      // control for it any more. Omitting the field makes `update_book` leave the stored value
      // untouched, which keeps the override an INTERNAL capability (`BookPatch.dir` still exists
      // end-to-end) rather than exposing it as a preference.
      const updated = await bookUpdate(book.id, { title, author, language, coverFit });
      onSaved(updated);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };
  // The renderer's half of the two-stage validation. Rust has already copied the file in under its
  // content-addressed name and told us whether IT could decode it; a `verified: false` is not a
  // rejection, it means "we have no decoder for this" — AVIF is one Chromium displays today. So the
  // engine that will actually paint the cover is asked, which is the only answer that means "this
  // will display", and it needs no format list that would rot as new formats ship.
  const rendererAccepts = async (rel: string): Promise<boolean> => {
    try {
      const url = convertFileSrc(await join(await appDataDir(), rel));
      const img = new Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth > 0 && img.naturalHeight > 0;
    } catch {
      return false;
    }
  };

  const replaceCover = async () => {
    setCoverError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ multiple: false, filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }] });
      if (!sel || Array.isArray(sel)) return;
      const staged = await bookStageCover(book.id, sel);
      if (!staged.verified && !(await rendererAccepts(staged.rel))) {
        // Nothing was adopted, so nothing needs undoing — only the staged bytes are dropped. The
        // reader is TOLD, rather than left looking at the previous cover wondering what happened,
        // which was the original complaint about this feature.
        await bookDiscardCover(staged.rel).catch(() => {});
        setCoverError(t("edit.coverUnreadable"));
        return;
      }
      onSaved(await bookCommitCover(book.id, staged.rel));
    } catch (e) {
      // Rust refuses an unreadable, empty or absurdly large file with a specific reason; show it
      // rather than a generic failure.
      setCoverError(String((e as Error)?.message ?? e));
    }
  };
  const revertCover = async () => {
    setCoverError(null);
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
                <img className="real" src={coverSrc(book)!} alt="" />
              ) : (
                <AutoCover title={displayTitle(resolveBookMeta(book), t)} author={book.author} dir={book.dir} />
              )}
            </div>
            <button className="edit-btn" onClick={replaceCover}>{t("edit.replaceCover")}</button>
            <button className="edit-link" onClick={revertCover}>{t("edit.revertCover")}</button>
            {coverError && <p className="edit-cover-error" role="alert">{coverError}</p>}
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
              {/* RESILIENCE-1 / WP-3: when WP-2 had to fall past a placeholder (a Calibre "Unknown",
                  an empty <dc:title>), say so HERE — where the reader can act on it — instead of
                  presenting a guessed name as though the book had claimed it. */}
              {titleIsGuess(editMeta) && (
                <span className="edit-hint">
                  {t("meta.titleGuess")} {titleProvenanceKey(editMeta) && t(titleProvenanceKey(editMeta)!)}
                </span>
              )}
            </label>
            <label className="edit-field">
              <span>{t("edit.author")}</span>
              <input value={author} onChange={(e) => setAuthor(e.target.value)} />
            </label>
            <label className="edit-field">
              <span>{t("edit.language")}</span>
              <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en · ar · …" />
            </label>
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
