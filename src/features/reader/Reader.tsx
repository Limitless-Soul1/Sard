import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController } from "../../reader-engine/FoliateController";
import { useReader } from "../../reader-engine/store";
import { appInfo, bookRegister, progressGet, progressSave } from "../../lib/ipc";

// RAWY-09 reading foundation. No themes / typography UI / library yet — a hardcoded
// dev sample (the Hindawi al-Shawqiyyat placed in the app-data dir) is opened via the
// Tauri asset protocol. A stable dev book id is used until real import assigns ids.
const DEV_BOOK_ID = "dev-sample-shawqiyyat";
const SAMPLE_FILE = "sample.epub";
const SAVE_DEBOUNCE_MS = 500;

export function Reader() {
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  const { status, dir, fraction, cfi, error } = useReader();

  useEffect(() => {
    let disposed = false;
    let saveTimer: number | undefined;

    (async () => {
      const set = useReader.getState().set;
      try {
        set({ status: "loading", bookId: DEV_BOOK_ID });

        const info = await appInfo();
        const filePath = `${info.app_data_dir}\\${SAMPLE_FILE}`;
        const url = convertFileSrc(filePath); // asset-protocol URL the WebView can fetch

        // FK bridge + read any saved position before opening.
        await bookRegister(DEV_BOOK_ID, filePath);
        const saved = await progressGet(DEV_BOOK_ID);

        const ctrl = new FoliateController();
        ctrlRef.current = ctrl;

        ctrl.onRelocate(({ cfi, fraction }) => {
          set({ cfi, fraction });
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            if (cfi) progressSave(DEV_BOOK_ID, cfi, fraction).catch(console.error);
          }, SAVE_DEBOUNCE_MS);
        });

        await ctrl.open(url, stageRef.current!, saved?.cfi ?? null);
        if (disposed) return;
        set({ status: "ready", dir: ctrl.dir ?? "?" });
      } catch (e) {
        set({ status: "error", error: String(e) });
      }
    })();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") ctrlRef.current?.next(); // RTL: left advances
      else if (e.key === "ArrowRight") ctrlRef.current?.prev();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      if (saveTimer) clearTimeout(saveTimer);
      window.removeEventListener("keydown", onKey);
      ctrlRef.current?.destroy();
    };
  }, []);

  return (
    <div className="reader-root">
      <div className="reader-bar" dir="rtl">
        <button onClick={() => ctrlRef.current?.prev()}>السابق ▶</button>
        <button onClick={() => ctrlRef.current?.next()}>◀ التالي</button>
        <span className="reader-status" dir="ltr">
          {status} · dir={dir} · {(fraction * 100).toFixed(1)}% · {cfi ? "cfi ✓" : "no-cfi"}
        </span>
      </div>
      <div className="reader-stage" ref={stageRef} />
      {status === "error" && <pre className="reader-error">{error}</pre>}
    </div>
  );
}
