import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import { ARABIC_DEFAULTS, defaultsForDir, type ReadingStyle } from "../../reader-engine/injectedCss";
import { appInfo, bookRegister, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import { THEMES, useTheme } from "../../theme";
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
    return JSON.parse(raw) as ReadingStyle;
  } catch {
    return null;
  }
}

export function Reader({ book: initial, onExit }: { book: OpenTarget; onExit: () => void }) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new FoliateController();

  const bookRef = useRef<string>(initial.id);
  const [book, setBook] = useState<BookKey>(initial.dir === "rtl" ? "ar" : "en");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
  const appDataDir = useRef<string>("");

  const { status, dir, fraction, chapterLabel, error, style } = useReader();
  const { themeId, overrideBookColor, hideChapterTitles } = useTheme();
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
      ctrl.onRelocate(({ cfi, fraction, chapterLabel }) => {
        set({ cfi, fraction, chapterLabel });
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
      });

      const finalStyle = persisted ?? defaultsForDir(ctrl.dir);
      if (!persisted) ctrl.applyStyle(finalStyle);
      set({ status: "ready", dir: ctrl.dir ?? "?", style: finalStyle });
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

  // Pin chrome open while the settings panel is open.
  useEffect(() => setHold(settingsOpen), [settingsOpen, setHold]);

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

  const chapter = chapterLabel || t("reader.chapterFallback");
  const isRtlBook = dir === "rtl";

  return (
    <div className="reader-root">
      {/* desk + centered page sheet (the book) + page-turn affordances */}
      <div className="reader-desk">
        <button
          className="page-chevron page-chevron-left"
          onClick={() => ctrlRef.current?.next()}
          title={t("reader.prev")}
        >
          ‹
        </button>
        <div className={`page-sheet${isRtlBook ? " rtl" : ""}`}>
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

      <ReaderChrome
        visible={chromeVisible || settingsOpen}
        chapter={chapter}
        fraction={fraction}
        bookDir={dir}
        onBack={onExit}
        onContents={wake}
        onTypography={() => setSettingsOpen(true)}
        onTheme={() => setSettingsOpen(true)}
        onBookmark={wake}
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
      />

      {status === "error" && <pre className="reader-error">{t("status.error")}: {error}</pre>}
    </div>
  );
}
