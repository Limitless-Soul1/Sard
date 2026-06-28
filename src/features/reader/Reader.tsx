import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import { ARABIC_DEFAULTS, defaultsForDir, type ReadingStyle } from "../../reader-engine/injectedCss";
import { appInfo, bookRegister, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import { TypographyBar } from "./TypographyBar";

// RAWY-12: two dev sample books (Arabic RTL + English LTR) so we can prove that the
// book's direction is independent of the UI language/direction. Real library import later.
const BOOKS = {
  ar: { id: "dev-sample-shawqiyyat", file: "sample.epub" },
  en: { id: "dev-sample-alice", file: "sample-en.epub" },
} as const;
type BookKey = keyof typeof BOOKS;

const STYLE_KEY = "reading_style"; // GLOBAL typography settings (D11)
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

export function Reader() {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new FoliateController(); // one instance across StrictMode re-invokes

  const bookRef = useRef<BookKey>("ar"); // current book id for relocate saves
  const [book, setBook] = useState<BookKey>("ar");
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
  const appDataDir = useRef<string>("");

  const { status, dir, fraction, cfi, error, style } = useReader();

  const openBook = useCallback(async (which: BookKey) => {
    const set = useReader.getState().set;
    try {
      bookRef.current = which;
      set({ status: "loading", bookId: BOOKS[which].id });

      if (!appDataDir.current) appDataDir.current = (await appInfo()).app_data_dir;
      const filePath = `${appDataDir.current}\\${BOOKS[which].file}`;
      const url = convertFileSrc(filePath);

      await bookRegister(BOOKS[which].id, filePath);
      const saved = await progressGet(BOOKS[which].id);
      const current = useReader.getState().style;
      const persisted = current ?? (await loadStyle());

      const ctrl = ctrlRef.current!;
      ctrl.onRelocate(({ cfi, fraction }) => {
        set({ cfi, fraction });
        if (progressTimer.current) clearTimeout(progressTimer.current);
        progressTimer.current = window.setTimeout(() => {
          if (cfi) progressSave(BOOKS[bookRef.current].id, cfi, fraction).catch(console.error);
        }, SAVE_DEBOUNCE_MS);
      });

      const initialStyle = persisted ?? defaultsForDir(undefined);
      await ctrl.open(url, stageRef.current!, { resumeCfi: saved?.cfi ?? null, style: initialStyle });

      const finalStyle = persisted ?? defaultsForDir(ctrl.dir);
      if (!persisted) ctrl.applyStyle(finalStyle);
      set({ status: "ready", dir: ctrl.dir ?? "?", style: finalStyle });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  }, []);

  useEffect(() => {
    openBook("ar");
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
      ctrlRef.current?.dispose();
    };
  }, [openBook]);

  const switchBook = (which: BookKey) => {
    if (which === bookRef.current) return;
    setBook(which);
    openBook(which);
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

  const statusKey = `status.${status}` as TKey;
  const statusText = `${t(statusKey)} · book.dir=${dir} · ${(fraction * 100).toFixed(1)}% · ${cfi ? "cfi✓" : "—"}`;

  return (
    <div className="reader-root">
      <TypographyBar
        style={style ?? ARABIC_DEFAULTS}
        update={update}
        onPrev={() => ctrlRef.current?.prev()}
        onNext={() => ctrlRef.current?.next()}
        status={statusText}
        book={book}
        onBook={switchBook}
      />
      {/* dir="ltr" isolates the reading stage from the UI direction; the book's own
          direction is set by foliate (book.dir) inside its iframe — fully independent. */}
      <div className="reader-stage" ref={stageRef} dir="ltr" />
      {status === "error" && <pre className="reader-error">{t("status.error")}: {error}</pre>}
    </div>
  );
}
