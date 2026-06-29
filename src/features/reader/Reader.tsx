import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController, type TocEntry } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import {
  ARABIC_DEFAULTS,
  defaultsForDir,
  LATIN_DEFAULTS,
  PAGE_WIDTH_DEFAULT,
  pageWidthVw,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { appInfo, bookRegister, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { THEMES, useTheme } from "../../theme";
import { AnnotationLayer } from "./AnnotationLayer";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { ChaptersPanel } from "./ChaptersPanel";
import { useAnnotations } from "./annotationsStore";
import { ReaderChrome } from "./ReaderChrome";
import { SettingsPanel } from "./SettingsPanel";
import { useChromeOnIntent } from "./useChromeOnIntent";

// The book to open: id (for progress) + absolute file path (for the asset protocol).
export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
}

// Dev sample switcher (kept as a convenience inside the reader): the two bundled EPUBs.
const BOOKS = {
  ar: { id: "dev-sample-shawqiyyat", file: "sample.epub" },
  en: { id: "dev-sample-alice", file: "sample-en.epub" },
} as const;
type BookKey = keyof typeof BOOKS;

const STYLE_KEY = "reading_style";
const SAVE_DEBOUNCE_MS = 500;

async function loadStyle(): Promise<ReadingStyle | null> {
  const raw = await settingsGet(STYLE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<ReadingStyle>;
    // RAWY-23 migration: pageWidth used to be an absolute px (480..1040); it is now a 0..1
    // Narrow→Wide fraction. Convert any old px value; backfill the new typography fields.
    if (typeof s.pageWidth === "number" && s.pageWidth > 1.5) {
      s.pageWidth = Math.max(0, Math.min(1, (s.pageWidth - 480) / 560));
    }
    return {
      ...LATIN_DEFAULTS,
      ...s,
    } as ReadingStyle;
  } catch {
    return null;
  }
}

export function Reader({ book: initial, onExit }: { book: OpenTarget; onExit: () => void }) {
  const { t, lang } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new FoliateController();

  const bookRef = useRef<string>(initial.id);
  const [book, setBook] = useState<BookKey>(initial.dir === "rtl" ? "ar" : "en");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [annoOpen, setAnnoOpen] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [annoTab, setAnnoTab] = useState<"notes" | "highlights">("notes");
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
  const appDataDir = useRef<string>("");

  const { status, dir, fraction, chapterLabel, chapterHref, error, style } = useReader();
  const { themeId, overrideBookColor, hideChapterTitles, setHideTitles } = useTheme();
  const { visible: chromeVisible, wake, setHold } = useChromeOnIntent();

  const openBook = useCallback(async (target: OpenTarget) => {
    const set = useReader.getState().set;
    try {
      bookRef.current = target.id;
      set({ status: "loading", bookId: target.id });

      const url = convertFileSrc(target.filePath);

      await bookRegister(target.id, target.filePath);
      const saved = await progressGet(target.id);
      const persisted = useReader.getState().style ?? (await loadStyle());

      const ctrl = ctrlRef.current!;
      ctrl.onRelocate(({ cfi, fraction, chapterLabel, chapterHref }) => {
        set({ cfi, fraction, chapterLabel, chapterHref });
        if (progressTimer.current) clearTimeout(progressTimer.current);
        progressTimer.current = window.setTimeout(() => {
          if (cfi) progressSave(bookRef.current, cfi, fraction).catch(console.error);
        }, SAVE_DEBOUNCE_MS);
      });

      const initialStyle = persisted ?? defaultsForDir(undefined);
      const ts = useTheme.getState();
      await ctrl.open(url, stageRef.current!, {
        resumeCfi: saved?.cfi ?? null,
        style: initialStyle,
        theme: THEMES[ts.themeId],
        flags: { overrideBookColor: ts.overrideBookColor, hideChapterTitles: ts.hideChapterTitles },
        dir: target.dir ?? undefined,
      });

      const finalStyle = persisted ?? defaultsForDir(ctrl.dir);
      if (!persisted) ctrl.applyStyle(finalStyle);
      set({ status: "ready", dir: ctrl.dir ?? "?", style: finalStyle });
      setToc(ctrl.getToc()); // chapters panel (RAWY-21)
      // Load this book's highlights/notes into the shared store (in-context layer + panel).
      useAnnotations.getState().bind(ctrl, target.id);
      await useAnnotations.getState().load();
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  }, []);

  useEffect(() => {
    openBook(initial);
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
      ctrlRef.current?.dispose();
    };
    // Open the book the Library handed us; re-open if the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  // App-wide theme → book.
  useEffect(() => {
    ctrlRef.current?.applyTheme(THEMES[themeId], { overrideBookColor, hideChapterTitles });
  }, [themeId, overrideBookColor, hideChapterTitles]);

  // Pin chrome open while any panel is open.
  useEffect(() => setHold(settingsOpen || chaptersOpen || annoOpen), [settingsOpen, chaptersOpen, annoOpen, setHold]);

  // Chapters panel is OPEN BY DEFAULT (RAWY-22); the user's choice persists per `chapters_open`.
  useEffect(() => {
    if (status !== "ready") return;
    settingsGet("chapters_open").then((v) => setChaptersOpen(v !== "0"));
  }, [status]);

  const toggleChapters = useCallback(() => {
    setChaptersOpen((v) => {
      const next = !v;
      settingsSet("chapters_open", next ? "1" : "0").catch(console.error);
      return next;
    });
    setAnnoOpen(false);
  }, []);

  // DEV: deterministically open a panel for screenshots (settings `dev_panel`: chapters |
  // notes | highlights). Mirrors the dev_open hook; no effect in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV || status !== "ready") return;
    settingsGet("dev_panel").then((p) => {
      if (p === "chapters") setChaptersOpen(true);
      else if (p === "notes") { setAnnoTab("notes"); setAnnoOpen(true); }
      else if (p === "highlights") { setAnnoTab("highlights"); setAnnoOpen(true); }
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

  const switchBook = async (which: BookKey) => {
    if (BOOKS[which].id === bookRef.current) return;
    setBook(which);
    if (!appDataDir.current) appDataDir.current = (await appInfo()).app_data_dir;
    openBook({
      id: BOOKS[which].id,
      filePath: `${appDataDir.current}\\${BOOKS[which].file}`,
      dir: which === "ar" ? "rtl" : "ltr",
    });
  };

  const update = (patch: Partial<ReadingStyle>) => {
    const current = useReader.getState().style;
    if (!current) return;
    const next = { ...current, ...patch };
    useReader.getState().set({ style: next });
    ctrlRef.current?.applyStyle(next);
    if (styleTimer.current) clearTimeout(styleTimer.current);
    styleTimer.current = window.setTimeout(() => {
      settingsSet(STYLE_KEY, JSON.stringify(next)).catch(console.error);
    }, SAVE_DEBOUNCE_MS);
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

  // Shift the desk so an open edge panel sits BESIDE the page, never over it (RAWY-22). The
  // chapters panel is on the book-leading side, annotations on the trailing side.
  const PANEL = 300;
  const lead = chaptersOpen ? PANEL : 0;
  const trail = annoOpen ? PANEL : 0;
  // Physical sides (panels are placed by BOOK direction, independent of the UI direction).
  const deskStyle = {
    "--page-pref": `${pageWidthVw(pageFraction)}vw`,
    paddingLeft: isRtlBook ? trail : lead,
    paddingRight: isRtlBook ? lead : trail,
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
          <div className="page-ribbon" />
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
        isRtlBook={isRtlBook}
        fraction={fraction}
      />

      <AnnotationsPanel
        open={annoOpen}
        onClose={() => setAnnoOpen(false)}
        onJump={jumpCfi}
        isRtlBook={isRtlBook}
        initialTab={annoTab}
      />

      <ReaderChrome
        visible={chromeVisible || settingsOpen || chaptersOpen || annoOpen}
        chapter={chapter}
        fraction={fraction}
        bookDir={dir}
        onBack={onExit}
        onContents={toggleChapters}
        onAnnotations={() => { setAnnoOpen((v) => !v); setChaptersOpen(false); }}
        onTypography={() => setSettingsOpen(true)}
        onTheme={() => setSettingsOpen(true)}
        onBookmark={wake}
        chaptersOpen={chaptersOpen}
        annoOpen={annoOpen}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        style={style ?? ARABIC_DEFAULTS}
        update={update}
        onPrev={() => ctrlRef.current?.prev()}
        onNext={() => ctrlRef.current?.next()}
        status={`${status} · ${themeId}`}
        book={book}
        onBook={switchBook}
        isRtlBook={isRtlBook}
      />

      <AnnotationLayer ctrlRef={ctrlRef} />

      {status === "error" && <pre className="reader-error">{t("status.error")}: {error}</pre>}
    </div>
  );
}
