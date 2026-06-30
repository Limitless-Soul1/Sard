import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController, type TocEntry } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import {
  ARABIC_DEFAULTS,
  defaultsForDir,
  PAGE_WIDTH_DEFAULT,
  pageWidthVw,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { bookRegister, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { applyTheme, THEMES, useTheme, type ThemeId } from "../../theme";
import {
  clearBookOverride,
  effectiveStyle,
  hasOverride as calcHasOverride,
  loadBookOverride,
  loadGlobalStyle,
  saveBookOverride,
  type BookOverride,
} from "./perBookSettings";
import { AnnotationLayer } from "./AnnotationLayer";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { ChaptersPanel } from "./ChaptersPanel";
import { PageBookmark } from "./PageBookmark";
import { useAnnotations } from "./annotationsStore";
import { MARKER_WINDOW, useBookmarks } from "./bookmarksStore";
import { ReaderChrome, type SettingsSection } from "./ReaderChrome";
import { SettingsPanel } from "./SettingsPanel";
import { useChromeOnIntent } from "./useChromeOnIntent";

// The book to open: id (for progress) + absolute file path (for the asset protocol).
export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
  cfi?: string | null; // jump-to location (RAWY-27 inbox); else resume saved progress
}

const SAVE_DEBOUNCE_MS = 500;

export function Reader({ book: initial, onExit }: { book: OpenTarget; onExit: () => void }) {
  const { t, lang } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new FoliateController();

  const bookRef = useRef<string>(initial.id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("text");
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [annoOpen, setAnnoOpen] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [annoTab, setAnnoTab] = useState<import("./AnnotationsPanel").AnnoTab>("notes");
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
  // Per-book settings (RAWY-40): the global reading defaults (baseline), this book's PARTIAL
  // override, and the global theme captured on entry (restored to the chrome on exit).
  const globalStyleRef = useRef<ReadingStyle | null>(null);
  const overrideRef = useRef<BookOverride>({});
  const globalThemeRef = useRef<ThemeId>(useTheme.getState().themeId);
  const [bookThemeId, setBookThemeId] = useState<ThemeId>(useTheme.getState().themeId);
  const [hasOv, setHasOv] = useState(false);

  const { status, dir, fraction, chapterLabel, chapterHref, error, style, bookTitle } = useReader();
  // RAWY-41: the current book's bookmarks; the marker shows ONLY when one is at the visible spot.
  const bookmarks = useBookmarks((s) => s.bookmarks);
  const activeBm = bookmarks.find((b) => b.fraction != null && Math.abs(b.fraction - fraction) <= MARKER_WINDOW) ?? null;
  // THEME is per-book (RAWY-40) — read from `bookThemeId`, not the global store. Override-book-
  // colour + hide-chapter-titles stay GLOBAL flags (set in Global Settings / chapters panel).
  const { overrideBookColor, hideChapterTitles, setHideTitles } = useTheme();
  const { visible: chromeVisible, setHold } = useChromeOnIntent();

  const openBook = useCallback(async (target: OpenTarget) => {
    const set = useReader.getState().set;
    try {
      bookRef.current = target.id;
      set({ status: "loading", bookId: target.id });

      const url = convertFileSrc(target.filePath);

      await bookRegister(target.id, target.filePath);
      const saved = await progressGet(target.id);
      // RAWY-27: an inbox item passes a jump CFI that wins over the saved reading position.
      const resumeCfi = target.cfi ?? saved?.cfi ?? null;

      // RAWY-40: effective style = GLOBAL defaults with THIS book's PARTIAL override on top; the
      // theme is the book's override theme else the global default. Per-script defaults still
      // back-fill anything the global row lacks (RTL books get the Arabic baseline).
      const ts = useTheme.getState();
      globalThemeRef.current = ts.themeId;
      const global = await loadGlobalStyle();
      const override = await loadBookOverride(target.id);
      globalStyleRef.current = global;
      overrideRef.current = override;
      const effTheme = override.themeId ?? ts.themeId;
      const initialStyle = effectiveStyle(global, override);

      const ctrl = ctrlRef.current!;
      ctrl.onRelocate(({ cfi, fraction, chapterLabel, chapterHref }) => {
        set({ cfi, fraction, chapterLabel, chapterHref });
        if (progressTimer.current) clearTimeout(progressTimer.current);
        progressTimer.current = window.setTimeout(() => {
          if (cfi) progressSave(bookRef.current, cfi, fraction).catch(console.error);
        }, SAVE_DEBOUNCE_MS);
      });

      // The whole reader (chrome + page) takes the book's effective theme while reading; the
      // Library keeps the global default (restored on exit). The global store is NOT mutated.
      applyTheme(THEMES[effTheme]);
      await ctrl.open(url, stageRef.current!, {
        resumeCfi,
        style: initialStyle,
        theme: THEMES[effTheme],
        flags: { overrideBookColor: ts.overrideBookColor, hideChapterTitles: ts.hideChapterTitles },
        dir: target.dir ?? undefined,
        flow: initialStyle.flowMode, // scrolled (default) or paged — RAWY-25
      });

      setBookThemeId(effTheme);
      setHasOv(calcHasOverride(override));
      set({ status: "ready", dir: ctrl.dir ?? "?", style: initialStyle, bookTitle: ctrl.title ?? null });
      setToc(ctrl.getToc()); // chapters panel (RAWY-21)
      // Load this book's highlights/notes into the shared store (in-context layer + panel).
      useAnnotations.getState().bind(ctrl, target.id);
      await useAnnotations.getState().load();
      useBookmarks.getState().load(target.id); // RAWY-41 — this book's saved locations
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  }, []);

  useEffect(() => {
    openBook(initial);
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
      ctrlRef.current?.dispose();
      // Restore the GLOBAL theme to the chrome on exit (RAWY-40) — the per-book theme was only
      // for this reading session; the Library shows the app default again.
      applyTheme(THEMES[globalThemeRef.current]);
    };
    // Open the book the Library handed us; re-open if the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  // GLOBAL flags (override-book-colour, hide-chapter-titles) → re-inject the book at its PER-BOOK
  // theme (RAWY-40). Theme itself is per-book and handled by setBookTheme, not here.
  useEffect(() => {
    if (status !== "ready") return;
    ctrlRef.current?.applyTheme(THEMES[bookThemeId], { overrideBookColor, hideChapterTitles });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideBookColor, hideChapterTitles]);

  // Pin chrome open while any panel is open.
  useEffect(() => setHold(settingsOpen || chaptersOpen || annoOpen), [settingsOpen, chaptersOpen, annoOpen, setHold]);

  // Chapters panel is OPEN BY DEFAULT (RAWY-22); the user's choice persists per `chapters_open`.
  useEffect(() => {
    if (status !== "ready") return;
    settingsGet("chapters_open").then((v) => setChaptersOpen(v !== "0"));
  }, [status]);

  // Placement model (RAWY-32 — supersedes the RAWY-30/D20 follow-direction model): reading panels
  // are PINNED to FIXED PHYSICAL sides that DO NOT move when the UI language flips. Chapters sits
  // on the physical LEFT; annotations and the settings slide-over both sit on the physical RIGHT —
  // each on the SAME physical side as the toolbar button that opens it (the top bar is pinned to
  // match). Chapters (left) COEXISTS with either right panel; annotations and settings share the
  // right edge, so opening one closes the other. Only panel CONTENT/labels translate with the UI
  // language; the reading TEXT stays book-directed (foliate, isolated — RAWY-12).
  const toggleChapters = useCallback(() => {
    setChaptersOpen((v) => {
      const next = !v;
      settingsSet("chapters_open", next ? "1" : "0").catch(console.error);
      return next;
    });
  }, []);

  // DEV: deterministically open a panel for screenshots (settings `dev_panel`: chapters |
  // notes | highlights). Mirrors the dev_open hook; no effect in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV || status !== "ready") return;
    settingsGet("dev_panel").then((p) => {
      if (p === "chapters") setChaptersOpen(true);
      else if (p === "notes") { setAnnoTab("notes"); setAnnoOpen(true); }
      else if (p === "highlights") { setAnnoTab("highlights"); setAnnoOpen(true); }
      else if (p === "settings") setSettingsOpen(true);
    });
    settingsGet("dev_seek").then((s) => {
      if (!s) return;
      setTimeout(async () => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        if (s === "toc:last") await ctrl.goToTocEntry("last");
        else if (s.startsWith("toc:")) await ctrl.goToTocEntry(Number(s.slice(4)));
        else if (!Number.isNaN(Number(s))) await ctrl.goToFraction(Number(s));
        setTimeout(() => settingsSet("dev_diag", ctrl.diagnose()).catch(() => {}), 500);
      }, 350);
    });
  }, [status]);

  // RAWY-40: a reading-setting change WHILE READING writes a PER-BOOK override (the global
  // `reading_style` defaults are only touched by Global Settings). Effective = global ∪ override;
  // the override accumulates exactly the fields the user changed for THIS book.
  const update = (patch: Partial<ReadingStyle>) => {
    const current = useReader.getState().style;
    const global = globalStyleRef.current;
    if (!current || !global) return;
    const next = { ...current, ...patch };
    useReader.getState().set({ style: next });

    // Fold the patch into this book's partial override: a field back at the global default drops
    // out of the override (so it keeps following global), otherwise it's recorded.
    const ovStyle: Partial<ReadingStyle> = { ...(overrideRef.current.style ?? {}) };
    for (const k of Object.keys(patch) as (keyof ReadingStyle)[]) {
      if (next[k] === global[k]) delete ovStyle[k];
      else (ovStyle as Record<string, unknown>)[k] = next[k];
    }
    overrideRef.current = { ...overrideRef.current, style: ovStyle };
    setHasOv(calcHasOverride(overrideRef.current));

    // flowMode is a renderer attribute set at open() — switching it re-opens at the current CFI
    // (preserves position); every other field is the live injected-CSS funnel.
    const flowChanged = patch.flowMode != null && patch.flowMode !== current.flowMode;
    if (flowChanged) {
      const cfi = useReader.getState().cfi;
      ctrlRef.current?.open(convertFileSrc(initial.filePath), stageRef.current!, {
        resumeCfi: cfi,
        style: next,
        theme: THEMES[bookThemeId],
        flags: {
          overrideBookColor: useTheme.getState().overrideBookColor,
          hideChapterTitles: useTheme.getState().hideChapterTitles,
        },
        dir: initial.dir ?? undefined,
        flow: next.flowMode,
      }).then(() => useAnnotations.getState().load()).catch(console.error);
    } else {
      ctrlRef.current?.applyStyle(next);
    }
    if (styleTimer.current) clearTimeout(styleTimer.current);
    styleTimer.current = window.setTimeout(() => {
      saveBookOverride(bookRef.current, overrideRef.current);
    }, SAVE_DEBOUNCE_MS);
  };

  // Per-book THEME (RAWY-40): change ONLY this book's paper + ink — the global store/Library are
  // untouched. Applies to the chrome (:root) + the page injection; persists in the book override.
  const setBookTheme = (id: ThemeId) => {
    setBookThemeId(id);
    overrideRef.current = { ...overrideRef.current, themeId: id === globalThemeRef.current ? undefined : id };
    setHasOv(calcHasOverride(overrideRef.current));
    applyTheme(THEMES[id]);
    ctrlRef.current?.applyTheme(THEMES[id], { overrideBookColor, hideChapterTitles });
    saveBookOverride(bookRef.current, overrideRef.current);
  };

  // Reset this book to the app defaults (RAWY-40, Band I "↻ Reset"): drop the whole override.
  const resetBook = () => {
    overrideRef.current = {};
    setHasOv(false);
    clearBookOverride(bookRef.current);
    const global = globalStyleRef.current ?? defaultsForDir(dir);
    useReader.getState().set({ style: global });
    setBookThemeId(globalThemeRef.current);
    applyTheme(THEMES[globalThemeRef.current]);
    ctrlRef.current?.applyTheme(THEMES[globalThemeRef.current], { overrideBookColor, hideChapterTitles });
    ctrlRef.current?.applyStyle(global);
  };

  // RAWY-41: toggle a bookmark at the CURRENT reading location (CFI + fraction + chapter). If the
  // visible spot is already bookmarked, remove it; else add. The button reflects bookmarked state.
  const onBookmark = () => {
    const st = useReader.getState();
    if (!st.cfi) return;
    useBookmarks.getState().toggle(st.cfi, st.chapterLabel, st.fraction);
  };

  const isRtlBook = dir === "rtl";
  // When chapter titles are hidden (anti-spoiler), the chrome shows a neutral "Chapter N".
  const tocIndex = toc.findIndex((c) => c.href && c.href === chapterHref);
  const chapter = hideChapterTitles
    ? t("panel.chapter", { n: localeNum((tocIndex >= 0 ? tocIndex : 0) + 1, lang) })
    : chapterLabel || t("reader.chapterFallback");

  // Responsive page width (RAWY-23): the slider fraction → a window-relative preferred width
  // (vw), clamped to a readable range in CSS; "match window" fills it.
  const pageFraction = style?.pageWidth ?? PAGE_WIDTH_DEFAULT;
  const fitWindow = style?.pageFitWindow ?? false;

  const jumpHref = (href: string) => ctrlRef.current?.goToHref(href);
  const jumpCfi = (cfi: string) => ctrlRef.current?.goToLocator(cfi);

  // RAWY-34: Text / Theme / Layout each select a distinct TAB of the ONE settings drawer
  // (Text · Page · Theme — the design's band I), reusing the RAWY-24 controls. Pressing the
  // button whose tab is already showing toggles the drawer closed. Settings and Notes share the
  // right edge → opening Settings closes Notes; Contents (left) coexists with either.
  const openSettings = (section: SettingsSection) => {
    if (settingsOpen && settingsSection === section) {
      setSettingsOpen(false);
      return;
    }
    setSettingsSection(section);
    setSettingsOpen(true);
    setAnnoOpen(false);
  };

  // Shift the desk so an open edge panel sits BESIDE the page, never over it (RAWY-22). Panels are
  // PINNED to fixed PHYSICAL sides (RAWY-32 — supersedes the RAWY-30/D20 follow-direction model):
  // chapters on the physical LEFT, annotations on the physical RIGHT — they do NOT move with the
  // UI language. Physical paddingLeft/Right match those fixed sides regardless of <html dir>.
  // The three right-edge drawers (Settings 384 / Notes 300) are mutually exclusive; Contents
  // (left) coexists. Shift the desk by whichever right drawer is open so the page recenters.
  const PANEL = 300;
  const leftPad = chaptersOpen ? PANEL : 0;
  // The Notes drawer pushes the desk so the page sits beside it. The SETTINGS drawer does NOT
  // (RAWY-36): it overlays the page's edge, so the page keeps its full width and the Page-width
  // control shows its real effect live while you adjust it (pushing the desk capped the sheet to
  // the narrowed space → "page width does nothing"). The top cluster stays clickable above both.
  const rightPad = annoOpen ? PANEL : 0;
  const deskStyle = {
    "--page-pref": `${pageWidthVw(pageFraction)}vw`,
    // Page margin insets the foliate host within the sheet (RAWY-36) — reliable across flow modes
    // (foliate's !important html padding can't be beaten from injected CSS).
    "--page-margin": `${style?.marginPx ?? 56}px`,
    paddingLeft: leftPad,
    paddingRight: rightPad,
  } as CSSProperties;

  return (
    <div className="reader-root">
      {/* desk + centered page sheet (the book) + page-turn affordances */}
      <div className="reader-desk" style={deskStyle}>
        <button
          className="page-chevron page-chevron-left"
          onClick={() => ctrlRef.current?.next()}
          title={t("reader.prev")}
        >
          ‹
        </button>
        <div className={`page-sheet${isRtlBook ? " rtl" : ""}${fitWindow ? " fitw" : ""}`}>
          {/* RAWY-41: the bookmark marker shows ONLY where a saved bookmark is visible (not the
              old always-on ribbon). Fixed physical position; draggable along the top edge. */}
          {activeBm && <PageBookmark title={t("bookmark.here")} />}
          <div className="page-host" ref={stageRef} dir="ltr" />
          <div className="page-grain" />
        </div>
        <button
          className="page-chevron page-chevron-right"
          onClick={() => ctrlRef.current?.prev()}
          title={t("reader.next")}
        >
          ›
        </button>
      </div>

      <ChaptersPanel
        open={chaptersOpen}
        onClose={() => setChaptersOpen(false)}
        toc={toc}
        currentHref={chapterHref}
        hideTitles={hideChapterTitles}
        onToggleHideTitles={() => setHideTitles(!hideChapterTitles)}
        onJump={jumpHref}
        fraction={fraction}
      />

      <AnnotationsPanel
        open={annoOpen}
        onClose={() => setAnnoOpen(false)}
        onJump={jumpCfi}
        initialTab={annoTab}
      />

      <ReaderChrome
        visible={chromeVisible || settingsOpen || chaptersOpen || annoOpen}
        bookTitle={bookTitle}
        chapter={chapter}
        fraction={fraction}
        onBack={onExit}
        onContents={toggleChapters}
        onText={() => openSettings("text")}
        onTheme={() => openSettings("theme")}
        onLayout={() => openSettings("page")}
        onAnnotations={() => { setAnnoOpen((v) => !v); setSettingsOpen(false); }}
        onBookmark={onBookmark}
        bookmarked={!!activeBm}
        chaptersOpen={chaptersOpen}
        annoOpen={annoOpen}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        style={style ?? ARABIC_DEFAULTS}
        update={update}
        isRtlBook={isRtlBook}
        section={settingsSection}
        onSection={setSettingsSection}
        bookThemeId={bookThemeId}
        onPickTheme={setBookTheme}
        bookTitle={bookTitle}
        hasOverride={hasOv}
        onReset={resetBook}
      />

      <AnnotationLayer ctrlRef={ctrlRef} />

      {status === "error" && <pre className="reader-error">{t("status.error")}: {error}</pre>}
    </div>
  );
}
