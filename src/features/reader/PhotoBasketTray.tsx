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

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { usePhotoBasket } from "./photoBasket";

import { isArabicText } from "../../lib/typography";
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
  // Where the pointer took hold of a row, and which row it is. Up here with the other refs
  // because a hook cannot live below the early return further down - placed with the drag
  // handlers, it ran only on the renders where the tray was open and React threw on opening it.
  const grab = useRef<{ offset: number; el: HTMLElement | null; pointer: number }>({ offset: 0, el: null, pointer: 0 });
  const dir = lang === "ar" ? "rtl" : "ltr";

  // The tray stays MOUNTED across open/close (it just renders null) — reset any in-flight drag
  // state when it closes so a row can't stay visually "lifted" the next time it opens.
  useEffect(() => {
    if (!open) {
      dragId.current = null;
      setDraggingId(null);
    }
  }, [open]);

  /**
   * WHERE THE TRAY HANGS, MEASURED FROM THE CONTROL THAT OPENS IT.
   *
   * It used to be a fixed box in the physical top-right corner, which happened to sit near the
   * control at one window size and drifted from it at every other. Reading the button's own box
   * keeps the two together whichever way the interface runs, and clamping to the window is what
   * guarantees the surface cannot leave the application however small the window gets.
   */
  const [at, setAt] = useState<{ top: number; left: number; room: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = document.querySelector<HTMLElement>(".rc-basket");
      const w = Math.min(348, window.innerWidth - 24);
      const margin = 12;
      const r = btn?.getBoundingClientRect();
      // The control hides itself once the collection is empty. Keep the tray where it already
      // is rather than sending it to a corner: the reader is still looking at it.
      if (!r) return;
      const top = Math.min(r ? r.bottom + 10 : 78, Math.max(margin, window.innerHeight - 200));
      let left = r ? r.left + r.width / 2 - w / 2 : window.innerWidth - w - margin;
      left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
      setAt({ top, left, room: Math.max(180, window.innerHeight - top - margin) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, passages.length]);

  /**
   * A PASSAGE THAT MOVES SHOULD BE SEEN TO MOVE.
   *
   * Reordering swapped two rows between one frame and the next, which is not something the eye can
   * follow: the list simply looked different afterwards. This measures where each row WAS, lets the
   * new order paint, then puts every row that shifted back where it came from and releases it - so
   * the rows travel to their new places instead of appearing in them.
   *
   * Three things it deliberately does not do. It never animates the row under the pointer, which is
   * already following the drag and would fight it. It moves only on the block axis, so it is the
   * same movement whichever way the interface runs. And it stands aside entirely when the reader
   * has asked for less motion.
   */
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const row of list.querySelectorAll<HTMLElement>(".pbt-row")) {
      const id = row.dataset.id;
      if (!id) continue;
      const top = row.offsetTop;
      next.set(id, top);
      const was = tops.current.get(id);
      if (reduce || was === undefined || was === top || id === dragId.current) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${was - top}px)`;
      requestAnimationFrame(() => {
        row.style.transition = "transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1)";
        row.style.transform = "";
      });
    }
    tops.current = next;
    follow();
  });


  if (!open) return null;

  // Start dragging THIS row by its grip (left button only). Capture the pointer on the LIST (a
  // STABLE element — it never moves as rows reorder), so every following pointermove/up targets it
  // reliably; capturing on the grip instead would break, because live reorder moves the grip out
  // from under the pointer and the final pointerup would miss it (leaving the drag state stuck).
  /**
   * PICKING A PASSAGE UP, AND PUTTING IT DOWN.
   *
   * The first version of this never moved anything: it reordered the store as the pointer crossed a
   * midpoint, and the row that had changed places animated into its new slot afterwards. That reads
   * as "the list changed, then something slid" - which is what it was.
   *
   * Here the row the reader took hold of follows the pointer for as long as they hold it. It keeps
   * its place in the flow, so the gap beneath it IS its slot, and the rows it displaces slide into
   * their new positions around it (the layout effect below does that half). On release it glides
   * from wherever the pointer left it into the slot it now owns, rather than snapping.
   *
   * The one thing that must not be read off the screen while this is happening is the dragged row's
   * own rectangle: it is translated to the pointer, so asking where it appears to be would place it
   * under the pointer for ever and it could never pass another row. Every position used to decide
   * ORDER therefore comes from layout (`offsetTop`), which a transform does not touch.
   */

  /**
   * Put the held row where the hand is. Called on every pointer move AND again after every
   * render, because a reorder changes the row's offsetTop — and a transform measured against the
   * old one draws it a whole row out of place until the next move corrects it. Measured before
   * this existed: a 138px jump on a 113px row, once per crossing, and it stayed wrong if the
   * hand stopped moving there.
   */
  const follow = () => {
    const row = grab.current.el;
    if (!row || !dragId.current) return;
    row.style.transform = `translateY(${grab.current.pointer - grab.current.offset - row.offsetTop}px)`;
  };

  const settle = (row: HTMLElement, animate: boolean) => {
    if (!animate) { row.style.transition = ""; row.style.transform = ""; return; }
    row.style.transition = "transform 190ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    row.style.transform = "translateY(0px)";
    const done = () => { row.style.transition = ""; row.style.transform = ""; row.removeEventListener("transitionend", done); };
    row.addEventListener("transitionend", done);
  };

  const onGripDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".pbt-row");
    if (!row || !listRef.current) return;
    try {
      listRef.current.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported - the document still delivers the events */
    }
    // Where in the row it was taken hold of, so it does not jump under the pointer on the first move.
    grab.current = { offset: e.clientY - row.getBoundingClientRect().top, el: row, pointer: 0 };
    row.style.transition = "none";
    dragId.current = id;
    setDraggingId(id);
  };

  const onListMove = (e: React.PointerEvent) => {
    const id = dragId.current;
    const list = listRef.current;
    if (!id || !list) return;
    const row = grab.current.el;
    if (!row) return;

    // Follow the pointer. Both are in the list's own content coordinates, so this survives the row
    // being moved to a different index mid-drag: its `offsetTop` changes and the offset re-derives.
    const box = list.getBoundingClientRect();
    const pointer = e.clientY - box.top + list.scrollTop;
    grab.current.pointer = pointer;
    follow();

    // And decide the order from where the rows actually LIE, not from where they appear.
    const rows = [...list.querySelectorAll<HTMLElement>(".pbt-row")];
    const order = usePhotoBasket.getState().passages;
    const from = order.findIndex((p) => p.id === id);
    if (from < 0) return;
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      if (pointer < rows[i].offsetTop + rows[i].offsetHeight / 2) { to = i; break; }
    }
    if (to !== from) reorder(from, to);
  };

  const onListUp = (e: React.PointerEvent) => {
    if (dragId.current == null) return;
    const row = grab.current.el;
    dragId.current = null;
    setDraggingId(null);
    grab.current = { offset: 0, el: null, pointer: 0 };
    if (row) settle(row, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (listRef.current) {
      try {
        listRef.current.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
  };


  return (
    <div
      className="pc-basket-tray"
      dir={dir}
      style={at ? { top: at.top, left: at.left, maxHeight: at.room } : undefined}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* WHAT THIS IS, AND HOW MUCH OF IT THERE IS. */}
      <div className="pbt-head">
        <div className="pbt-titles">
          <div className="pbt-title">{t("basket.title")}</div>
          <div className="pbt-count">{t("basket.count", { n: localeNum(passages.length, lang) })}</div>
        </div>
        <button className="pbt-close ui-close" onClick={onClose} aria-label={t("photo.close")}>✕</button>
      </div>

      {/* THE PASSAGES THEMSELVES, and they are the point of the surface: set in the book's own face,
          each hanging off its number the way a numbered passage sits in a printed collection. The
          handling — the grip, the removal — stays out of the way until the row is under the pointer,
          because a column of crosses reads as a list of things to delete rather than as a reading. */}
      <div
        className="pbt-list"
        ref={listRef}
        onPointerMove={onListMove}
        onPointerUp={onListUp}
        onPointerCancel={onListUp}
      >
        {passages.length === 0 && (
          <div className="pbt-empty">
            <div className="pbt-empty-title">{t("basket.empty")}</div>
            <div className="pbt-empty-hint">{t("basket.emptyHint")}</div>
          </div>
        )}
        {passages.map((p, i) => (
          <div key={p.id} data-id={p.id} className={`pbt-row${draggingId === p.id ? " dragging" : ""}`}>
            <span className="pbt-n" aria-hidden>{localeNum(i + 1, lang)}</span>
            <div className="pbt-body">
              <div className={`pbt-text${isArabicText(p.text) ? " ar" : ""}`} dir="auto">{p.text}</div>
              {p.chapterLabel && <div className="pbt-chapter" dir="auto">{p.chapterLabel}</div>}
            </div>
            <div className="pbt-tools">
              <span
                className="pbt-grip"
                role="button"
                aria-label={t("basket.reorder")}
                title={t("basket.reorder")}
                onPointerDown={(e) => onGripDown(e, p.id)}
              >
                ⠿
              </span>
              <button className="pbt-remove" onClick={() => remove(p.id)} aria-label={t("basket.remove")} title={t("basket.remove")}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* AND WHAT BECOMES OF THEM. Set apart from the handling above it, and it says what it will
          do rather than only naming itself. */}
      <div className="pbt-foot">
        <div className="pbt-actions">
          <button className="pbt-create" onClick={onCompose} disabled={passages.length === 0}>
            {t("basket.create", { n: localeNum(passages.length, lang) })}
          </button>
          <button className="pbt-clear" onClick={clear} disabled={passages.length === 0}>
            {t("basket.clear")}
          </button>
        </div>
        {passages.length > 0 && <p className="pbt-note">{t("basket.createNote")}</p>}
      </div>
    </div>
  );
}
