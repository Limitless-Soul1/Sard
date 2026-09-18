// ROW WINDOWING — render the rows a reader can see, not the rows a library contains.
//
// THE DEFECT THIS ADDRESSES, measured on synthetic libraries of 40 / 300 / 1,203 / 3,000 books: the flat
// views mount every book. At 3,000 that is 39,700 DOM nodes and 18,400 listeners in Grid, a first paint of
// 1.1 s with 0.5 s of single long tasks (the window is frozen for them), and a worst scroll frame of
// 504 ms. The grouped Covers view, which has always drawn a bounded preview per shelf, costs 30-100 ms at
// every library size. The cost is the mounted tiles, not the books.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. It decides WHICH SLICE of a run is mounted, and how much
// empty space stands before and after it. It does not own the run, does not reorder it, and does not know
// what an item is. Every index a card carries is its index in the caller's own array, exactly as before,
// so ordering, drop destinations, shelf membership and selection are computed from the same values they
// always were.
//
// ROWS ARE NOT A FIXED HEIGHT, AND THE ARITHMETIC ALONE IS NOT ENOUGH. A card's caption wraps, so a row
// with a long title is taller than one without — measured: 225 px near the top of a library and ~264 px
// further down. A window derived only from `scrollTop / rowHeight` therefore drifts with depth (measured:
// 8 rows out at half scroll, 18 rows at ninety percent), and a drifted window is a blank band on screen.
// So the arithmetic only PROPOSES a window; after every render the rendered band is measured against the
// viewport and the window is corrected until it genuinely covers it.
//
// THE ESTIMATE IS LATCHED, NOT TRACKED. A run's scroll height is `rows x rowH`, so refining `rowH` while
// the reader scrolls rescales the scrollbar under their hand. Measured while refining freely, at 3,000
// books: 21 refinements during an ordinary scroll, and during a fling a single step of 5,753 px - 5.6% of
// the run, which moves the thumb visibly. So the height is measured once per run and then held.
//
// SMALL RUNS ARE UNTOUCHED. Below `WINDOW_MIN_ITEMS` the window is the whole run: the common case keeps
// today's behaviour exactly, including every interaction that reads the DOM.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Below this many items a run renders in full, as it always has. */
export const WINDOW_MIN_ITEMS = 240;
/** Rows kept mounted beyond each edge of the viewport, so a fast scroll never shows an empty band and a
/** Rows kept mounted beyond each edge of the viewport. MEASURED: four rows was not enough — a fling and
 * a scrollbar drag both outran the window and left a visible blank band (worst: 2,659 px on a fling,
 * a whole empty viewport on a drag). The buffer is now a VIEWPORT on each side, which is what a reader
 * can cross between two frames, with four rows as the floor for a short list. Even at three viewports
 * mounted, a 3,000-book run keeps ~1% of its cards in the DOM. */
const OVERSCAN_MIN_ROWS = 4;
/** What is rendered before anything has been measured: enough to fill any first screen Sard can draw. */
const INITIAL_ITEMS = 120;
/** A row height to start from, replaced by the first real measurement. */
const ROW_GUESS = 240;
/** A measurement is only worth latching once the band spans this many rows: one row is a title, not an
 * average, and the run's whole height is about to be derived from it. */
const LATCH_MIN_ROWS = 3;
/** ...and a latched height is only re-taken when the band disagrees with it by this much, which is a real
 * layout change (covers arriving, a density step) rather than the ordinary spread of caption lengths -
 * measured: the tallest and shortest rows of a library differ by about 17%. */
const RELATCH_RATIO = 0.25;

export interface RowWindow {
  /** first item index to render (inclusive) */
  start: number;
  /** last item index to render (exclusive) */
  end: number;
  /** pixels standing in for the rows before `start` */
  topPx: number;
  /** pixels standing in for the rows after `end` */
  bottomPx: number;
  /** columns per row, as measured */
  cols: number;
  /** false while the whole run is rendered (a small run, or windowing switched off) */
  windowed: boolean;
}

const FULL = (n: number): RowWindow => ({ start: 0, end: n, topPx: 0, bottomPx: 0, cols: 1, windowed: false });

/**
 * The slice of `count` items to mount inside `scrollerRef`, for the current scroll position.
 *
 * `itemSelector` must match a mounted item. The hook re-measures on resize, recomputes on scroll through
 * one `requestAnimationFrame` (the scroll handler itself only stores a number), and corrects itself from
 * the DOM after each render so a variable row height cannot leave a blank band.
 */
export function useRowWindow(
  scrollerRef: React.RefObject<HTMLElement | null>,
  count: number,
  opts: {
    itemSelector: string;
    columns?: number | null;
    enabled?: boolean;
    deps?: unknown[];
    /**
     * RENDER THE WHOLE RUN, for as long as this is true — a book is in hand.
     *
     * While a book is carried, a landing place is drawn before every item, so each item takes two cells
     * of the grid and the arithmetic below is wrong by exactly that: measured with the window left on
     * through a drag, the book under the reader moved 2,123 px in Grid and 1,003 px in Details, and
     * neither came back to where it was when the book was put down (the fully rendered views: 263 px and
     * 64 px, and an exact return). So a drag renders every item, as it always did, and the two
     * transitions are ANCHORED: the item at the top of the viewport before the switch is put back at the
     * same offset after it, whichever way the switch went.
     */
    whole?: boolean;
  },
): RowWindow {
  const { itemSelector, enabled = true } = opts;
  const whole = !!opts.whole;
  /** A list passes 1 and skips the horizontal arithmetic; a grid measures its own columns. */
  const fixedCols = opts.columns ?? null;
  const active = enabled && count >= WINDOW_MIN_ITEMS && !whole;
  const [win, setWin] = useState<{ start: number; end: number }>({ start: 0, end: Math.min(count, INITIAL_ITEMS) });
  // Geometry is STATE, not a ref, because the spacers are rendered from it — but it is written only
  // when it has really changed. An unconditional write from the layout effect below is an infinite
  // render loop (measured: React #185, the library came up with 11 DOM nodes and nothing else).
  const [geom, setGeom] = useState({ cols: 1, rowH: ROW_GUESS });
  // Mirrors, so the scroll handler can propose without reading state React has not committed yet.
  const geomRef = useRef({ cols: 1, rowH: ROW_GUESS, locked: false });
  const winRef = useRef(win);
  const lastTop = useRef(0);
  winRef.current = win;
  /**
   * THE ITEM UNDER THE READER, taken the moment `whole` flips — during render, while the DOM still shows
   * the state before the switch — and put back after the commit. `index` is the item's place in the run;
   * `offset` is where its top sat below the viewport's top edge.
   */
  const anchor = useRef<{ index: number; offset: number } | null>(null);
  const lastWhole = useRef(whole);
  if (lastWhole.current !== whole) {
    // Everything is mounted while the run is whole, so a card's place in the DOM is its place in the run;
    // windowed, it is offset by where the window starts.
    const base = lastWhole.current ? 0 : winRef.current.start;
    lastWhole.current = whole;
    const el = scrollerRef.current;
    if (el && enabled && count >= WINDOW_MIN_ITEMS) {
      const sr = el.getBoundingClientRect();
      const cards = el.querySelectorAll<HTMLElement>(itemSelector);
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (r.bottom > sr.top + 1) { anchor.current = { index: base + i, offset: r.top - sr.top }; break; }
      }
    }
  }
  /**
   * Take the row height, or keep the one already taken.
   *
   * A latched estimate that is slightly wrong is harmless: the proposal and the spacers use the SAME
   * number, so the virtual coordinate system stays self-consistent, and the measured correction below
   * still guarantees that the band covers the viewport. An estimate that keeps moving is not harmless -
   * it is the scrollbar changing length while the reader is holding it. It is re-taken only when the
   * layout really changed, and the offset is then rescaled so the row under the reader stays there.
   */
  const applyGeom = useCallback((cols: number, rowH: number, rowsInBand: number) => {
    const cur = geomRef.current;
    const sameCols = cur.cols === cols;
    if (sameCols && cur.locked && Math.abs(rowH - cur.rowH) < cur.rowH * RELATCH_RATIO) return;
    const el = scrollerRef.current;
    if (el && cur.locked && el.scrollTop > 0 && rowH !== cur.rowH) {
      const t = Math.round(el.scrollTop * (rowH / cur.rowH));
      lastTop.current = t;
      el.scrollTop = t;
    }
    geomRef.current = { cols, rowH, locked: rowsInBand >= LATCH_MIN_ROWS || (sameCols && cur.locked) };
    setGeom((g) => (g.cols === cols && Math.abs(g.rowH - rowH) < 1 ? g : { cols, rowH }));
  }, [scrollerRef]);
  /** The layout changed under the run: measure it again rather than holding a height that described the
   * shape it used to have. */
  const unlatch = useCallback(() => { geomRef.current = { ...geomRef.current, locked: false }; }, []);

  /** Measure the mounted band: how wide a row is, how tall a row is, and where the band sits. */
  const read = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return null;
    const cards = el.querySelectorAll<HTMLElement>(itemSelector);
    if (!cards.length) return null;
    const first = cards[0];
    const last = cards[cards.length - 1];
    const holder = first.parentElement ?? el;
    const cs = getComputedStyle(holder);
    const rowGap = parseFloat(cs.rowGap) || 0;
    const colGap = parseFloat(cs.columnGap) || 0;
    const fr = first.getBoundingClientRect();
    const lr = last.getBoundingClientRect();
    const sr = el.getBoundingClientRect();
    // POSITIONS RELATIVE TO THE SCROLLER’S CONTENT, from rectangles rather than `offsetTop`: the items
    // are direct children of the scroller in Grid but not in Details, where a sticky rail and a padded
    // wrapper stand between them, and `offsetParent` would then measure against the wrong box.
    const bandTop = fr.top - sr.top + el.scrollTop;
    const bandBottom = lr.bottom - sr.top + el.scrollTop;
    const cols = fixedCols ?? Math.max(1, Math.round((holder.clientWidth + colGap) / Math.max(1, fr.width + colGap)));
    const rowsInBand = Math.max(1, Math.ceil(cards.length / cols));
    const rowH = rowsInBand > 1 ? (bandBottom - bandTop) / rowsInBand : fr.height + rowGap;
    return { el, cols, rowH: Math.max(1, rowH), rowsInBand, bandTop, bandBottom, scrollTop: el.scrollTop, viewH: el.clientHeight };
  }, [scrollerRef, itemSelector, fixedCols]);

  /**
   * Propose a window for the current offset.
   *
   * It uses the CACHED geometry rather than reading the DOM, so a scroll event costs arithmetic and
   * nothing else, and it runs SYNCHRONOUSLY on the scroll event rather than in a later frame. Deferring
   * to `requestAnimationFrame` guarantees at least one painted frame in which the new region has not been
   * rendered — which is exactly the blank band a reader sees when they fling or drag the scrollbar
   * (measured before this: 34 blank frames in a normal scroll, a 2,659 px gap on a fling, a whole empty
   * viewport on a drag). For a jump longer than one viewport the render is flushed before paint, because
   * that is the one case no buffer can cover.
   */
  const propose = useCallback((fromScroll: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    const { cols, rowH } = geomRef.current;
    const viewH = el.clientHeight;
    const over = Math.max(OVERSCAN_MIN_ROWS, Math.ceil(viewH / Math.max(1, rowH)));
    const rows = Math.ceil(count / cols);
    const firstRow = Math.max(0, Math.floor(el.scrollTop / rowH) - over);
    // THE TAIL OF A RUN IS NEVER WINDOWED. An estimated row height makes the virtual run slightly
    // shorter than the real one, and at the very bottom that difference is the last row or two: measured
    // during a slow scrollbar drag, 23 frames of 1,339 showed a 22 px strip of spacer under the last card,
    // every one of them inside the final 300 px of the library and nowhere else. Mounting the last rows
    // outright costs two rows of cards at the one place a reader has stopped travelling.
    const TAIL_ROWS = 2;
    const proposedLast = Math.ceil((el.scrollTop + viewH) / rowH) + over;
    const lastRow = proposedLast >= rows - TAIL_ROWS ? rows : Math.min(rows, proposedLast);
    const next = { start: firstRow * cols, end: Math.min(count, lastRow * cols) };
    if (next.start === winRef.current.start && next.end === winRef.current.end) return;
    const jumped = Math.abs(el.scrollTop - lastTop.current) > viewH;
    lastTop.current = el.scrollTop;
    winRef.current = next;
    if (fromScroll && jumped) flushSync(() => setWin(next));
    else setWin(next);
  }, [scrollerRef, count]);

  // scroll + resize
  useEffect(() => {
    if (!active) return;
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => propose(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => { unlatch(); propose(false); });
    ro.observe(el);
    propose(false);
    return () => { el.removeEventListener("scroll", onScroll); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, propose, unlatch, ...(opts.deps ?? [])]);

  // A run change (a shelf, a search, a sort) is a different list under the same scroller: start again at
  // the top of it rather than keeping an offset that belonged to the run before.
  useEffect(() => {
    setWin({ start: 0, end: Math.min(count, INITIAL_ITEMS) });
    unlatch();
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  // A change of BOX — a density step, a cover size, selection mode coming on — is the same run in a
  // different shape: the height is measured again, and the reader stays where they are. This used to share
  // the effect above, so turning selection on in Details or changing the cover size in Grid threw the
  // reader back to the top of the library.
  useEffect(() => {
    unlatch();
    // Measure the new shape now rather than on the next scroll: the band is already laid out in it, and a
    // spacer still sized for the old shape is a scrollbar that is wrong until the reader happens to move.
    const m = read();
    if (m) applyGeom(m.cols, m.rowH, m.rowsInBand);
    propose(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...(opts.deps ?? [])]);

  // THE OTHER SIDE OF THE SWITCH. Everything is mounted now (a book was picked up), or the window is back
  // (it was put down): find the anchored item and scroll so its top is where it was. On the way back the
  // window is first proposed around the anchor from the latched geometry, so the item is mounted at all.
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollerRef.current;
    if (!a || !el) return;
    if (!whole && active) {
      const { cols, rowH } = geomRef.current;
      const target = Math.max(0, Math.round(Math.floor(a.index / cols) * rowH - a.offset));
      lastTop.current = target;
      el.scrollTop = target;
      propose(false);
      return; // the fine adjustment happens below, once the item is really mounted
    }
    const cards = el.querySelectorAll<HTMLElement>(itemSelector);
    const card = cards[a.index];
    anchor.current = null;
    if (!card) return;
    const sr = el.getBoundingClientRect();
    const delta = card.getBoundingClientRect().top - sr.top - a.offset;
    if (Math.abs(delta) > 1) { el.scrollTop += delta; lastTop.current = el.scrollTop; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whole]);

  // THE CORRECTION. After the browser has laid the band out, check that it really covers the viewport and
  // move the window until it does. This is what makes a variable row height harmless: the arithmetic may
  // be wrong, the measured band cannot be.
  useLayoutEffect(() => {
    if (!active) return;
    const m = read();
    if (!m) return;
    const a = anchor.current;
    if (a && a.index >= win.start && a.index < win.end) {
      const card = m.el.querySelectorAll<HTMLElement>(itemSelector)[a.index - win.start];
      anchor.current = null;
      if (card) {
        const sr = m.el.getBoundingClientRect();
        const delta = card.getBoundingClientRect().top - sr.top - a.offset;
        if (Math.abs(delta) > 1) { m.el.scrollTop += delta; lastTop.current = m.el.scrollTop; return; }
      }
    }
    applyGeom(m.cols, m.rowH, m.rowsInBand);
    const top = m.scrollTop;
    const bottom = m.scrollTop + m.viewH;
    const perRow = m.cols;
    // The same viewport-sized buffer the proposal uses, so a correction lands with room to spare
    // instead of exactly on the edge it was short of.
    const over = Math.max(OVERSCAN_MIN_ROWS, Math.ceil(m.viewH / Math.max(1, m.rowH)));
    let { start, end } = win;
    if (m.bandTop > top && start > 0) {
      const rowsShort = Math.ceil((m.bandTop - top) / m.rowH) + over;
      start = Math.max(0, start - rowsShort * perRow);
    }
    if (m.bandBottom < bottom && end < count) {
      const rowsShort = Math.ceil((bottom - m.bandBottom) / m.rowH) + over;
      end = Math.min(count, end + rowsShort * perRow);
    }
    // Conditional, always: this effect runs after EVERY render, so an unconditional write here would
    // never stop rendering.
    if (start !== win.start || end !== win.end) setWin({ start, end });
  });

  if (!active) return FULL(count);
  const { cols, rowH } = geom;
  const totalRows = Math.ceil(count / cols);
  const startRow = Math.floor(win.start / cols);
  const endRow = Math.ceil(win.end / cols);
  return {
    start: win.start,
    end: Math.min(count, win.end),
    topPx: Math.round(startRow * rowH),
    bottomPx: Math.round(Math.max(0, (totalRows - endRow) * rowH)),
    cols,
    windowed: true,
  };
}

/**
 * THE GRID, WINDOWED.
 *
 * It exists so the window is computed over the RUN THAT IS RENDERED. The grid draws the whole library in
 * one place and a single shelf's run in another; a window measured against the library while a shelf is on
 * screen would mount a slice of the wrong list — measured, before this existed: switching to a shelf left
 * the scroll height of the whole library behind.
 */
export function WindowedGrid<T>(props: {
  rows: readonly T[];
  keyOf: (row: T) => string;
  renderRow: (row: T, index: number) => React.ReactNode;
  className: string;
  itemSelector: string;
  style?: React.CSSProperties;
  /** anything that changes an item's box (a density step, a cover size, a view swap) */
  deps?: unknown[];
  /** true while a book is in hand — the whole run renders, see `useRowWindow` */
  whole?: boolean;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const win = useRowWindow(ref, props.rows.length, { itemSelector: props.itemSelector, deps: props.deps, whole: props.whole });
  return (
    <div ref={ref} className={props.className} style={props.style}>
      {/* The rows above the window, as height rather than as cards. `grid-column: 1 / -1` makes the spacer a
          full row of the grid instead of one cell, so the columns below line up exactly as they would if
          every card were mounted. */}
      {win.topPx > 0 && <div aria-hidden style={{ gridColumn: "1 / -1", height: win.topPx }} />}
      {props.rows.slice(win.start, win.end).map((row, i) => (
        <Fragment key={props.keyOf(row)}>{props.renderRow(row, win.start + i)}</Fragment>
      ))}
      {win.bottomPx > 0 && <div aria-hidden style={{ gridColumn: "1 / -1", height: win.bottomPx }} />}
    </div>
  );
}
