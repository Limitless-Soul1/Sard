// The passages tray (RAWY-60, Photo Mode part 2b, design Band I-IV frame 2) — a floating panel,
// opened from the top-bar basket button, listing every collected passage with its chapter label.
// Reorder by dragging the grip, remove any, then "Create card · N" composes them all into one
// multi-passage photo card (or Clear the basket). Pinned to the FIXED physical side of the top-bar
// cluster (D21): its position never flips with the UI language; only its labels translate.
//
// Reorder uses POINTER events + pointer capture (RAWY-61), NOT HTML5 drag-and-drop: Tauri's webview
// has the OS drag/drop handler enabled (the Library needs it for file-import), and on Windows that
// handler SWALLOWS native HTML5 drag events — so `draggable` + onDragStart/onDrop never fired from a
// real mouse (they only fired for synthetic/CDP events, which is how RAWY-60 wrongly "passed").
// Pointer events are unaffected, and pointer capture keeps them flowing even over the foliate iframe
// (the same reliable approach as the RAWY-41 bookmark drag).

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { usePhotoBasket } from "./photoBasket";

export function PhotoBasketTray({
  open,
  onClose,
  onCompose,
}: {
  open: boolean;
  onClose: () => void;
  onCompose: () => void;
}) {
  const { t, lang } = useI18n();
  const passages = usePhotoBasket((s) => s.passages);
  const remove = usePhotoBasket((s) => s.remove);
  const reorder = usePhotoBasket((s) => s.reorder);
  const clear = usePhotoBasket((s) => s.clear);
  const dragId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dir = lang === "ar" ? "rtl" : "ltr";

  // The tray stays MOUNTED across open/close (it just renders null) — reset any in-flight drag
  // state when it closes so a row can't stay visually "lifted" the next time it opens.
  useEffect(() => {
    if (!open) {
      dragId.current = null;
      setDraggingId(null);
    }
  }, [open]);

  if (!open) return null;

  // Start dragging THIS row by its grip (left button only). Capture the pointer on the LIST (a
  // STABLE element — it never moves as rows reorder), so every following pointermove/up targets it
  // reliably; capturing on the grip instead would break, because live reorder moves the grip out
  // from under the pointer and the final pointerup would miss it (leaving the drag state stuck).
  const onGripDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (listRef.current) {
      try {
        listRef.current.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — the document still delivers the events */
      }
    }
    dragId.current = id;
    setDraggingId(id);
  };

  // Live reorder: as the pointer crosses a row's vertical midpoint, move the dragged item there.
  // Read the CURRENT order from the store (not a render-time closure) so repeated moves compose.
  const onListMove = (e: React.PointerEvent) => {
    const id = dragId.current;
    if (!id || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>(".pbt-row")];
    const list = usePhotoBasket.getState().passages;
    const from = list.findIndex((p) => p.id === id);
    if (from < 0) return;
    const y = e.clientY;
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    if (to !== from) reorder(from, to);
  };

  const onListUp = (e: React.PointerEvent) => {
    if (dragId.current == null) return;
    dragId.current = null;
    setDraggingId(null);
    if (listRef.current) {
      try {
        listRef.current.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
  };

  return (
    <div className="pc-basket-tray" dir={dir} onPointerDown={(e) => e.stopPropagation()}>
      <div className="pbt-head">
        <div className="pbt-titles">
          <div className="pbt-title">{t("basket.title")}</div>
          <div className="pbt-count">{t("basket.count", { n: localeNum(passages.length, lang) })}</div>
        </div>
        <button className="pbt-close" onClick={onClose} aria-label={t("photo.close")}>✕</button>
      </div>

      <div
        className="pbt-list"
        ref={listRef}
        onPointerMove={onListMove}
        onPointerUp={onListUp}
        onPointerCancel={onListUp}
      >
        {passages.length === 0 && <div className="pbt-empty">{t("basket.empty")}</div>}
        {passages.map((p) => (
          <div key={p.id} className={`pbt-row${draggingId === p.id ? " dragging" : ""}`}>
            <span
              className="pbt-grip"
              role="button"
              aria-label={t("basket.reorder")}
              title={t("basket.reorder")}
              onPointerDown={(e) => onGripDown(e, p.id)}
            >
              ⠿
            </span>
            <div className="pbt-body">
              <div className="pbt-text" dir="auto">{p.text}</div>
              {p.chapterLabel && <div className="pbt-chapter" dir="auto">{p.chapterLabel}</div>}
            </div>
            <button className="pbt-remove" onClick={() => remove(p.id)} aria-label={t("basket.remove")}>×</button>
          </div>
        ))}
      </div>

      <div className="pbt-foot">
        <button className="pbt-create" onClick={onCompose} disabled={passages.length === 0}>
          {t("basket.create", { n: localeNum(passages.length, lang) })}
        </button>
        <button className="pbt-clear" onClick={clear} disabled={passages.length === 0}>
          {t("basket.clear")}
        </button>
      </div>
    </div>
  );
}
