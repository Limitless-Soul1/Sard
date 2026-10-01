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
  /** The element the press began on — captured only once the drag starts. */
  container: Element | null;
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
   * THE ONE CLICK A DRAG PRODUCES, AND NOT A CLICK MORE.
   *
   * A shelf row is also a link: pressing it navigates. So the click a finished drag leaves behind has
   * to be eaten, or every drag ends by opening whatever the row pointed at — the defect
   * `useBookPickup` records for the press-and-hold.
   *
   * This was a flag, set when a drag ended and cleared by the next click to reach a row. That is not
   * the same thing. A click is dispatched to the COMMON ANCESTOR of the press and the release, so a
   * drag that ends over a different row — which is the ordinary case — produces no click on the row
   * that was dragged at all. The flag then stayed armed and ate a later, unrelated click: one dead
   * click on a shelf after every drag.
   *
   * So the suppression is bound to the pointer interaction instead of left lying about. Ending a drag
   * arms ONE capture-phase listener on the window, which eats the next click and immediately removes
   * itself; and any new `pointerdown` disarms it, because a fresh press means the click it was
   * waiting for is never coming. Nothing accumulates, and nothing survives into the next interaction.
   */
  const swallow = useRef<((e: MouseEvent) => void) | null>(null);
  /**
   * The settle's belt-and-braces timer, held so it can be cancelled.
   *
   * NOT a workaround for anything: a row whose transform was ALREADY `translateY(0)` fires no
   * `transitionend`, so without a second way to finish, its inline styles would never be cleared.
   * Holding the handle is what keeps it from firing into a component that has since unmounted.
   */
  const settleTimer = useRef<number | null>(null);
  const disarmClick = useCallback(() => {
    if (!swallow.current) return;
    window.removeEventListener("click", swallow.current, true);
    swallow.current = null;
  }, []);
  const armClickSwallow = useCallback(() => {
    disarmClick();
    const fn = (e: MouseEvent) => {
      disarmClick(); // one click, whatever it turns out to be
      e.stopPropagation();
      e.preventDefault();
    };
    swallow.current = fn;
    window.addEventListener("click", fn, true);
  }, [disarmClick]);
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
    document.body.style.userSelect = "";
    if (settleTimer.current != null) { window.clearTimeout(settleTimer.current); settleTimer.current = null; }
    // THE CAPTURE IS GIVEN BACK EXPLICITLY. The browser releases it implicitly on pointerup, but a
    // drag ended by Escape is finished while the pointer is still down — and holding another
    // element's pointer after the gesture is over is not ours to do.
    if (st?.container) {
      try { (st.container as HTMLElement).releasePointerCapture?.(st.pointerId); } catch { /* already gone */ }
    }
    if (!st) return;
    if (!st.moved) { setDraggingId(null); return; }
    armClickSwallow(); // the click this drag leaves behind is not a navigation

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
        settleTimer.current = window.setTimeout(done, SETTLE_MS + 80);
      } else {
        clearAll(st.ids);
      }
    }
    setDraggingId(null);
  }, [clearAll, armClickSwallow]);

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
    // NOTHING IS PREVENTED HERE, and nothing is captured. A press is only RECORDED; until it has
    // travelled it is an ordinary press and must behave like one.
    //
    // THE DEFECT THIS FIXES. `preventDefault()` used to run on every pointerdown on a row. Cancelling
    // `pointerdown` suppresses the compatibility mouse sequence, and the CLICK goes with it — so a
    // shelf row, whose navigation is an `onClick` on the button inside it, stopped opening at all.
    // The case grip never showed it: it has no `onClick`, and the case's name is a different button
    // the gesture never touches. Everything that alters the press now waits for the threshold.

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
      container: null,
      moved: false,
      at: from,
      pointerId: e.pointerId,
    };
    live.current.container = e.currentTarget as Element;
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
        // FROM HERE IT IS A DRAG, so from here the press may be taken over: the pointer is captured
        // so leaving the row cannot end it, selection is suppressed so the list does not highlight
        // as it moves, and the move itself is cancelled to stop the browser starting a selection.
        e.preventDefault();
        scroller.setContainer(st.container ?? null);
        try { (st.container as HTMLElement | null)?.setPointerCapture?.(st.pointerId); } catch { /* unsupported */ }
        document.body.style.userSelect = "none";
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
    // ANY new press ends the wait. The click a finished drag was holding a listener for either
    // arrives before this, or never arrives at all — and a fresh interaction proves it was the latter.
    const down = () => disarmClick();

    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      // UNMOUNTING DURING A DRAG must leave nothing behind: the page keeps the body it was given,
      // and no timer fires into a component that is gone.
      scroller.stop();
      document.body.style.userSelect = "";
      if (settleTimer.current != null) { window.clearTimeout(settleTimer.current); settleTimer.current = null; }
      window.removeEventListener("pointerdown", down, true);
      disarmClick();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [paint, finish, disarmClick]);

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
   * Is a drag actually under way? Read from the ref rather than from state, because a row's own
   * `pointerup` runs before the window's and must be able to tell a drag from a click there.
   */
  const isDragging = useCallback(() => live.current?.moved === true, []);

  return { begin, register, draggingId, isDragging };
}
