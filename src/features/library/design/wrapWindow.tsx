// WRAP-BAND WINDOWING — for a shelf of spines, which is not a grid and cannot be windowed like one.
//
// WHY THE FLAT VIEWS' WINDOW DOES NOT FIT HERE. Grid and Details are one column count and one row height:
// the row a reader is looking at is `scrollTop / rowHeight`, and a row height that is only an estimate is
// corrected afterwards from the rendered band. A shelf of spines is a `flex-wrap` run of items of
// DIFFERENT widths — measured on a 3,000-book library: 31 distinct spine widths between 16 and 46 px, 34
// spines on a full row and as few as 4 on the row that ends a band. There is no column count to divide by,
// and a window that assumed one would mount the wrong books.
//
// WHAT MAKES IT POSSIBLE ANYWAY: THE WRAP IS KNOWN BEFORE IT IS LAID OUT. A spine's width does not depend
// on layout — `spineWidth` is a pure function of the book and the density — so the run can be packed in
// advance exactly as the browser will wrap it. That claim was checked against the browser rather than
// assumed: on the same library, a greedy first-fit pack of one 1,530-spine band produced 81 rows against
// the browser's 81, with 0 of 1,530 spines landing on a different row from the one it was modelled onto.
// Every wrap row is the same height, so once the pack is known the row at any offset is arithmetic — and
// because the model is exact rather than estimated, the band's height never moves under the reader.
//
// AND WHEN THE MODEL IS WRONG, NOTHING IS. After each render the mounted rows are compared with the model.
// If they disagree, the band stops windowing and mounts its whole run — which is exactly what it did before
// this file existed. A wrong model can cost frames; it cannot show a reader an empty band.
//
// A BOOK IN HAND MOUNTS THE WHOLE RUN. While a book is being carried, a landing place is drawn before every
// spine, so the run being packed is no longer the run being rendered. Rather than model two interleaved
// sequences, the band renders in full for the length of the drag: every landing place exists, and the cost
// is the cost the view has always had at that moment.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Below this many items a band renders in full, as it always has. Matches the flat views' threshold,
 * for the same reason: an ordinary shelf should behave exactly as it did. */
export const WRAP_MIN_ITEMS = 240;
/** Rows kept mounted beyond each edge of the viewport. A viewport on each side is what a reader can cross
 * between two frames; two rows is the floor for a short band. */
const OVERSCAN_MIN_ROWS = 2;
/** Rendered before the band's width is known, which is one layout pass. */
const INITIAL_ITEMS = 180;

/**
 * The first item index of each wrap row, for `widths` laid out into `inner` px with `gap` between.
 *
 * First-fit, in order, breaking when the next item cannot fit — which is what `flex-wrap` does. The half
 * pixel is the browser's own rounding: a row that fills its line to the last fraction must not be read as
 * one that overflows it.
 */
export function packRows(widths: readonly number[], inner: number, gap: number): number[] {
  const starts: number[] = [];
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    if (used === 0) {
      starts.push(i);
      used = w;
      continue;
    }
    if (used + gap + w > inner + 0.5) {
      starts.push(i);
      used = w;
    } else {
      used += gap + w;
    }
  }
  return starts;
}

export function WrapBand<T>(props: {
  /** The element this band scrolls inside — the stage, which every band shares. */
  scrollerRef: React.RefObject<HTMLElement | null>;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The item's width in pixels, known without laying it out. */
  widthOf: (item: T) => number;
  /** Every wrap row is this tall. */
  rowHeight: number;
  /** The flex `gap`, which applies on both axes. */
  gap: number;
  /** True while a book is in hand: the band then renders in full (see the note at the top). */
  carrying: boolean;
  renderItem: (item: T) => React.ReactNode;
  /** The landing place that closes the run, drawn only while carrying. */
  trailing?: React.ReactNode;
  style?: React.CSSProperties;
  /** Anything that changes an item's box — a density step, a cover size. */
  deps?: unknown[];
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const count = props.items.length;
  // The band's content width, measured once per layout rather than assumed from the pane: the stage has
  // padding, a scrollbar gutter and, inside a case, an indent.
  const [inner, setInner] = useState(0);
  const [rowWin, setRowWin] = useState<{ startRow: number; endRow: number } | null>(null);
  // One-way, and deliberately so: a band that has caught its own model out does not try again until the
  // thing that could have made the model wrong — its width, its density, its run — has changed.
  const [bail, setBail] = useState(false);

  /** Whether this band windows at all — a short shelf, or a book in hand, renders as it always did. */
  const windowable = !bail && !props.carrying && count >= WRAP_MIN_ITEMS;
  /** ...and whether it can yet, which needs the one measurement the pack cannot do without. */
  const active = windowable && inner > 0;
  const step = props.rowHeight + props.gap;

  // THE PACK, recomputed each render rather than cached. It is two arithmetic operations per item, against
  // the cost of mounting even one spine, and a cache would have to be invalidated by every reorder,
  // rename and density change — a stale pack is the one thing this must never hold.
  const widths = active ? props.items.map(props.widthOf) : null;
  const rows = widths ? packRows(widths, inner, props.gap) : null;
  const rowsRef = useRef<number[] | null>(null);
  rowsRef.current = rows;
  const totalRows = rows ? rows.length : 0;

  const winRef = useRef(rowWin);
  winRef.current = rowWin;
  const lastTop = useRef(0);

  /** Which rows of this band the viewport can reach, in the scroller's own coordinates. */
  const propose = useCallback((fromScroll: boolean) => {
    const el = props.scrollerRef.current;
    const band = ref.current;
    const packed = rowsRef.current;
    if (!el || !band || !packed) return;
    const viewH = el.clientHeight;
    const bandTop = band.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const over = Math.max(OVERSCAN_MIN_ROWS, Math.ceil(viewH / step));
    const clamp = (r: number) => Math.max(0, Math.min(packed.length, r));
    const startRow = clamp(Math.floor((el.scrollTop - bandTop) / step) - over);
    const endRow = clamp(Math.ceil((el.scrollTop + viewH - bandTop) / step) + over);
    const cur = winRef.current;
    if (cur && cur.startRow === startRow && cur.endRow === endRow) return;
    // A jump longer than a viewport is the one case no buffer can cover, so that render is flushed before
    // the frame is painted rather than left for the next one — but ONLY by a band the reader is arriving
    // at. A shelf they have just left is rendering its way down to nothing, and forcing that synchronously
    // in the same frame spends the fling's budget on work nobody is looking at: measured across a fling,
    // four bands flushing against one.
    const jumped = Math.abs(el.scrollTop - lastTop.current) > viewH;
    const onScreen = endRow > startRow;
    lastTop.current = el.scrollTop;
    winRef.current = { startRow, endRow };
    if (fromScroll && jumped && onScreen) flushSync(() => setRowWin({ startRow, endRow }));
    else setRowWin({ startRow, endRow });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollerRef, step]);

  // the band's own width, and the scroll that moves through it
  useEffect(() => {
    const band = ref.current;
    if (!band) return;
    const measure = () => {
      const cs = getComputedStyle(band);
      const w = band.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      setInner((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(band);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;
    const el = props.scrollerRef.current;
    if (!el) return;
    const onScroll = () => propose(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => propose(false));
    ro.observe(el);
    propose(false);
    return () => { el.removeEventListener("scroll", onScroll); ro.disconnect(); };
  }, [active, propose, props.scrollerRef]);

  // A different run, a different width or a different density is a different pack: the band is entitled to
  // its model again, and to a window measured for the run it is actually showing.
  //
  // IT MUST PROPOSE ONE HERE, not merely forget the old one. Effects run in the order they are declared, so
  // clearing the window after the effect above has just proposed one left the band with no window at all —
  // and a band with no window renders its opening slice without the spacers that stand for the rest, which
  // collapses the whole view. Measured, the moment a drag ended: a page 25,524 px tall became 4,844 px, and
  // stayed that way until the reader happened to scroll. That is the scrollbar jumping under their hand.
  useEffect(() => {
    setBail(false);
    winRef.current = null;
    setRowWin(null);
    propose(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, inner, props.rowHeight, props.gap, props.carrying, propose, ...(props.deps ?? [])]);

  // THE MODEL, CHECKED AGAINST THE BROWSER. The mounted rows must be where the pack says they are; if they
  // are not, this band gives up windowing rather than show a reader a band that does not line up.
  //
  // BUT NOT ON ONE READING. This effect also runs from inside a scroll event, where a render has been
  // flushed mid-gesture and the scroller's own anchoring may still be settling — and a band that gave up on
  // a single disagreement stayed given up for the rest of the session, mounting its whole run: measured, a
  // view that had windowed correctly all afternoon came up with all 4,230 spines mounted. A model that is
  // genuinely wrong is wrong every time it is asked, so it is asked three times in a row.
  const mismatches = useRef(0);
  useLayoutEffect(() => {
    if (!active || !rows || !rowWin) return;
    const band = ref.current;
    if (!band) return;
    const mounted = band.querySelectorAll<HTMLElement>("[data-book]");
    if (!mounted.length) return;
    const expectedRows = Math.max(1, rowWin.endRow - rowWin.startRow);
    const tops = new Set<number>();
    for (const el of mounted) tops.add(Math.round(el.getBoundingClientRect().top));
    // Rows are a fixed height, so the count of distinct tops IS the count of rows on screen. One row of
    // slack absorbs sub-pixel rounding at a band edge.
    if (Math.abs(tops.size - expectedRows) > 1) {
      mismatches.current += 1;
      if (mismatches.current >= 3) setBail(true);
    } else {
      mismatches.current = 0;
    }
  });

  // Three states, in the order a band passes through them: a run that does not window renders whole; one
  // that has not been measured yet renders a screenful, for the single layout pass that takes; one that
  // has been packed renders the rows its reader can reach.
  const slice = !windowable
    ? props.items.slice(0, count)
    : active && rows && rowWin
      ? props.items.slice(rows[rowWin.startRow] ?? count, rowWin.endRow >= totalRows ? count : rows[rowWin.endRow])
      : props.items.slice(0, INITIAL_ITEMS);
  const startRow = active && rowWin ? rowWin.startRow : 0;
  const endRow = active && rowWin ? rowWin.endRow : totalRows;
  // A spacer stands in for the rows it replaces AND for the gaps between them, less the one gap the
  // browser puts between the spacer and the row that follows it.
  const topPx = active && startRow > 0 ? startRow * step - props.gap : 0;
  const bottomPx = active && rows && endRow < totalRows ? (totalRows - endRow) * step - props.gap : 0;

  return (
    // SCROLL ANCHORING OFF. The spacers above the reader change height every time the window moves, and the
    // browser's anchoring answers a height change above the fold by adjusting the scroll offset to hold the
    // view still — which is the right instinct for a document and the wrong one here, where the content has
    // not actually moved. Left on, it fights the window for the scroll position.
    <div ref={ref} style={{ overflowAnchor: "none", ...props.style }}>
      {/* `width: 100%` is what takes a whole line in a wrapping run — the equivalent of a grid spacer
          spanning every column, and the reason the rows below it land exactly where they would have. */}
      {topPx > 0 && <div aria-hidden style={{ width: "100%", flexBasis: "100%", height: topPx }} />}
      {slice.map((item) => <Fragment key={props.keyOf(item)}>{props.renderItem(item)}</Fragment>)}
      {props.trailing}
      {bottomPx > 0 && <div aria-hidden style={{ width: "100%", flexBasis: "100%", height: bottomPx }} />}
    </div>
  );
}
