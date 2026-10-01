// REORDERING A SIDEBAR ROW BY DRAGGING THE ROW ITSELF.
//
// The case grip already dragged, but what followed the pointer was a detached GHOST while the row
// stayed where it was and a bar marked the target. That reads as a generic drag: the thing under the
// pointer is not the thing being moved, and the list gives no sign of making room until the release.
// `PhotoBasketTray` already had the interaction this wants — the row itself carried on a transform,
// the grab offset recorded so it does not jump, and one short settle on release — so this brings the
// sidebar to that same idiom rather than inventing a third.
//
// WHAT THIS DOES NOT OWN. Where a row lands is `dropIndex`, which the case drag already used and
// which has its own tests; the auto-scroll at the edges is `createEdgeScroller`; and the move itself
// is the existing `case_reorder` / `shelf_reorder`. This file adds the gesture and the motion, and
// nothing else — no ordering of its own, and no opinion about what a list contains.
//
// WHY TRANSFORMS AND NOT STATE. A pointermove that set React state would re-render the tree on every
// frame of a drag. Every position written here is an inline `transform` on an element this hook
// already holds, so a drag costs two renders in total: one when it starts and one when it ends.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { dropIndex } from "./model";
import { createEdgeScroller, scrollableAncestor, type EdgeScroller } from "./dragScroll";

/** The settle, shared with `PhotoBasketTray` so two sortable lists cannot drift apart. */
export const SETTLE_MS = 190;
export const SETTLE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * The same four pixels the grip used before this, and for the same reason: the grip is also a click
 * — it lifts the case for the rail-clicking route — so a press that never travels must stay a click.
 */
export const DRAG_THRESHOLD_PX = 4;

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false; // a shim without matchMedia is not a reason to refuse to animate
  }
}

/**
 * How far row `i` must move aside to open the gap the dragged row will land in.
 *
 * `at` is `dropIndex`'s answer, which is an index into the list WITHOUT the dragged row. Turning it
 * back into an insertion point among the rows as they are drawn is the whole of the arithmetic, and
 * getting it wrong is what makes a list appear to open the gap one slot away from where the row
 * actually lands.
 *
 * Returns pixels: negative moves a row up, positive moves it down, 0 leaves it alone.
 */
export function rowShift(i: number, from: number, at: number, height: number): number {
  if (i === from) return 0;
  const insertAt = at >= from ? at + 1 : at;
  if (from < insertAt && i > from && i < insertAt) return -height;
  if (from > insertAt && i >= insertAt && i < from) return height;
  return 0;
}

interface Live {
  id: string;
  ids: string[];
  from: number;
  startY: number;
  /** Where in the row it was taken hold of, so it does not jump under the pointer on the first move. */
  grabOffset: number;
  /** Client-space tops and heights, measured once when the drag began. */
  tops: number[];
  heights: number[];
  /** The scroll position those tops were measured at, so an auto-scroll can be corrected for. */
  scrollTop: number;
  scroller: HTMLElement | null;
  moved: boolean;
  at: number;
  pointerId: number;
}

export interface RowDragOptions {
  /**
   * Move `id` to `toIndex` among the siblings it was dragged within. The existing reorder command,
   * unchanged — this hook never writes an order of its own.
   */
  onCommit: (id: string, toIndex: number) => void;
  /**
   * A value that changes whenever the drawn order changes. When it does, every registered row is
   * animated from where it was to where it now is, which is what turns the commit into a settle
   * instead of a jump.
   */
  orderKey: string;
}

export function useRowDrag(opts: RowDragOptions) {
  const rows = useRef(new Map<string, HTMLElement>());
  const live = useRef<Live | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const scrollerRef = useRef<EdgeScroller | null>(null);
  if (!scrollerRef.current) scrollerRef.current = createEdgeScroller();
  /** Where every row sat just before a commit, for the FLIP that follows it. */
  const lastTops = useRef<Map<string, number> | null>(null);
  /**
   * Set the moment a press turns out to have been a drag, and cleared by the click it then eats.
   *
   * A shelf row is also a link: pressing it navigates. Without this, every drag ended by opening
   * whatever the row pointed at — the same defect `useBookPickup` records for the press-and-hold,
   * and it takes the same answer.
   */
  const spent = useRef(false);
  const commit = useRef(opts.onCommit);
  commit.current = opts.onCommit;

  /**
   * ONE ref callback per row, kept.
   *
   * Returning a fresh closure each render would make React detach and re-attach every row's ref on
   * every render — including the two a drag causes — so the map the carry reads would be emptied and
   * refilled underneath it. Handing back the same function for the same id leaves the refs alone.
   */
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const register = useCallback((id: string) => {
    let fn = refs.current.get(id);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        if (el) rows.current.set(id, el);
        else rows.current.delete(id);
      };
      refs.current.set(id, fn);
    }
    return fn;
  }, []);

  /** Clear every inline style this hook wrote. */
  const clearAll = useCallback((ids?: string[]) => {
    const each = (el: HTMLElement) => {
      el.style.transition = "";
      el.style.transform = "";
      el.style.zIndex = "";
      el.style.position = "";
      el.style.pointerEvents = "";
    };
    if (ids) ids.forEach((id) => { const el = rows.current.get(id); if (el) each(el); });
    else rows.current.forEach(each);
  }, []);

  /** Paint the dragged row and its neighbours for the current pointer position. */
  const paint = useCallback((clientY: number) => {
    const st = live.current;
    if (!st) return;
    const scrolled = st.scroller ? st.scrollTop - st.scroller.scrollTop : 0;
    const mids = st.tops.map((top, i) => top + scrolled + st.heights[i] / 2);
    const at = dropIndex(clientY, mids, st.from);
    const h = st.heights[st.from];

    const self = rows.current.get(st.id);
    if (self) {
      // The row follows the pointer directly — no easing on the thing the hand is holding, or the
      // movement lags behind it, which is the one thing a drag must never do.
      const dy = clientY - st.grabOffset - (st.tops[st.from] + scrolled);
      self.style.transform = `translateY(${dy}px)`;
    }

    if (at === st.at) return;
    st.at = at;
    const animate = !prefersReducedMotion();
    st.ids.forEach((id, i) => {
      if (i === st.from) return;
      const el = rows.current.get(id);
      if (!el) return;
      const shift = rowShift(i, st.from, at, h);
      el.style.transition = animate ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : "";
      el.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }, []);

  const finish = useCallback((commitIt: boolean) => {
    const st = live.current;
    live.current = null;
    scrollerRef.current?.stop();
    if (!st) return;
    if (!st.moved) { setDraggingId(null); return; }
    spent.current = true; // the press is spent; the click that follows is not a navigation

    if (commitIt && st.at !== st.from) {
      // Remember where everything is NOW, so the re-render that follows can be animated from here
      // rather than cutting to the new order.
      const m = new Map<string, number>();
      rows.current.forEach((el, id) => m.set(id, el.getBoundingClientRect().top));
      lastTops.current = m;
      clearAll();
      commit.current(st.id, st.at);
    } else {
      // Nothing moved — settle the row back to where it started.
      const animate = !prefersReducedMotion();
      st.ids.forEach((id) => {
        const el = rows.current.get(id);
        if (!el) return;
        el.style.transition = animate ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : "";
        el.style.transform = "";
      });
      const self = rows.current.get(st.id);
      if (self && animate) {
        const done = () => { clearAll(st.ids); self.removeEventListener("transitionend", done); };
        self.addEventListener("transitionend", done);
        window.setTimeout(done, SETTLE_MS + 80); // a transform that was already 0 fires no event
      } else {
        clearAll(st.ids);
      }
    }
    setDraggingId(null);
  }, [clearAll]);

  /**
   * Begin a drag from a grip. The press is only RECORDED here; it becomes a drag once the pointer
   * has actually travelled, which is what leaves a click a click.
   */
  const begin = useCallback((e: React.PointerEvent, id: string, ids: string[]) => {
    if (e.button !== 0) return;
    const from = ids.indexOf(id);
    if (from < 0) return;
    const self = rows.current.get(id);
    if (!self) return;
    e.preventDefault();
    e.stopPropagation();

    const tops: number[] = [];
    const heights: number[] = [];
    for (const rid of ids) {
      const el = rows.current.get(rid);
      const r = el?.getBoundingClientRect();
      tops.push(r ? r.top : Number.POSITIVE_INFINITY);
      heights.push(r ? r.height : 0);
    }
    const scroller = scrollableAncestor(self);
    live.current = {
      id, ids, from,
      startY: e.clientY,
      grabOffset: e.clientY - tops[from],
      tops, heights,
      scrollTop: scroller ? scroller.scrollTop : 0,
      scroller,
      moved: false,
      at: from,
      pointerId: e.pointerId,
    };
    scrollerRef.current?.setContainer(e.currentTarget as Element);
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* not supported */ }
  }, []);

  // ── the carry, bound to the window so leaving the grip does not end it ──────────────────────────
  useEffect(() => {
    const scroller = scrollerRef.current!;
    scroller.onScrolled = (_x, y) => { if (live.current?.moved) paint(y); };

    const move = (e: PointerEvent) => {
      const st = live.current;
      if (!st) return;
      if (!st.moved) {
        if (Math.abs(e.clientY - st.startY) < DRAG_THRESHOLD_PX) return;
        st.moved = true;
        const self = rows.current.get(st.id);
        if (self) {
          self.style.transition = "none";
          self.style.position = "relative";
          self.style.zIndex = "2";
          self.style.pointerEvents = "none"; // the row must not hit-test against itself
        }
        setDraggingId(st.id);
      }
      paint(e.clientY);
      scroller.update(e.clientX, e.clientY);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") finish(false); };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      scroller.stop();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [paint, finish]);

  // ── THE SETTLE. FLIP: invert to where the rows were, then release them to where they now are ────
  useLayoutEffect(() => {
    const prev = lastTops.current;
    if (!prev || !prev.size) return;
    lastTops.current = null;
    if (prefersReducedMotion()) { clearAll(); return; }

    const moved: HTMLElement[] = [];
    rows.current.forEach((el, id) => {
      const before = prev.get(id);
      if (before == null) return;
      const delta = before - el.getBoundingClientRect().top;
      if (!delta) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      moved.push(el);
    });
    if (!moved.length) return;
    const raf = requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASE}`;
        el.style.transform = "";
      }
    });
    const done = window.setTimeout(() => {
      for (const el of moved) { el.style.transition = ""; el.style.transform = ""; }
    }, SETTLE_MS + 60);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(done); };
  }, [opts.orderKey, clearAll]);

  useEffect(() => () => { scrollerRef.current?.stop(); }, []);

  /**
   * Put on any row that is also a link. It runs in the CAPTURE phase, so the click is stopped
   * before it reaches the name inside the row rather than after.
   */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!spent.current) return;
    spent.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /**
   * Is a drag actually under way? Read from the ref rather than from state, because a row's own
   * `pointerup` runs before the window's and must be able to tell a drag from a click there.
   */
  const isDragging = useCallback(() => live.current?.moved === true, []);

  return { begin, register, draggingId, onClickCapture, isDragging };
}
