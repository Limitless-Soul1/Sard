import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import { ARABIC_DEFAULTS, defaultsForDir, type ReadingStyle } from "../../reader-engine/injectedCss";
import { appInfo, bookRegister, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
import { TypographyBar } from "./TypographyBar";

// RAWY-10: typography controls on top of the RAWY-09 engine. Still no themes/library.
const DEV_BOOK_ID = "dev-sample-shawqiyyat";
const SAMPLE_FILE = "sample.epub";
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
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new FoliateController(); // one instance across StrictMode re-invokes
  const { status, dir, fraction, cfi, error, style } = useReader();

  useEffect(() => {
    let disposed = false;
    let progressTimer: number | undefined;

    (async () => {
      const set = useReader.getState().set;
      try {
        set({ status: "loading", bookId: DEV_BOOK_ID });

        const info = await appInfo();
        const filePath = `${info.app_data_dir}\\${SAMPLE_FILE}`;
        const url = convertFileSrc(filePath);

        await bookRegister(DEV_BOOK_ID, filePath);
        const [saved, persisted] = await Promise.all([progressGet(DEV_BOOK_ID), loadStyle()]);

        const ctrl = ctrlRef.current!;
        ctrl.onRelocate(({ cfi, fraction }) => {
          set({ cfi, fraction });
          if (progressTimer) clearTimeout(progressTimer);
          progressTimer = window.setTimeout(() => {
            if (cfi) progressSave(DEV_BOOK_ID, cfi, fraction).catch(console.error);
          }, SAVE_DEBOUNCE_MS);
        });

        // Provisional style for first render; corrected to per-script defaults once dir known.
        const initialStyle = persisted ?? defaultsForDir(undefined);
        await ctrl.open(url, stageRef.current!, { resumeCfi: saved?.cfi ?? null, style: initialStyle });
        if (disposed) return;

        const finalStyle = persisted ?? defaultsForDir(ctrl.dir);
        if (!persisted) ctrl.applyStyle(finalStyle);
        set({ status: "ready", dir: ctrl.dir ?? "?", style: finalStyle });
      } catch (e) {
        set({ status: "error", error: String(e) });
      }
    })();

    return () => {
      disposed = true;
      if (progressTimer) clearTimeout(progressTimer);
      ctrlRef.current?.dispose();
    };
  }, []);

  // Apply + persist a style change (debounced write through the core).
  const styleTimer = useRef<number | undefined>(undefined);
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

  const statusText = `${status} · dir=${dir} · ${(fraction * 100).toFixed(1)}% · ${cfi ? "cfi✓" : "—"}`;

  return (
    <div className="reader-root">
      <TypographyBar
        style={style ?? ARABIC_DEFAULTS}
        update={update}
        onPrev={() => ctrlRef.current?.prev()}
        onNext={() => ctrlRef.current?.next()}
        status={statusText}
      />

      <div className="reader-stage" ref={stageRef} />
      {status === "error" && <pre className="reader-error">{error}</pre>}
    </div>
  );
}
