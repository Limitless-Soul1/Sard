// Windowing for the book grid.
//
// WHY THIS EXISTS AT ALL, rather than rendering the library and trusting the browser. A cover is an
// `<img>` decoded to `W × H × 4` bytes whatever the file weighs, and the mobile plan's own measurements
// put the memory ceiling on a 4 GB device well inside reach of a library of a few hundred books. The
// desktop grid renders every card because a desktop has the headroom to be careless; a phone does not,
// and this is the one library surface where that difference is not theoretical.
//
// DELIBERATELY NOT A LIBRARY. The whole behaviour is "which rows intersect the viewport", which is
// twenty lines of arithmetic over a fixed row height. A dependency here would buy virtualisation
// features Sard does not use — variable heights, horizontal windows, sticky groups — and would put a
// third party between the reader and their shelf.
//
// Pure arithmetic, so the window it computes is testable without a DOM.

export interface GridMetrics {
  /** How many cards fit across, at least one. */
  columns: number;
  /** Row pitch in px: card height plus the gap beneath it. */
  rowHeight: number;
}

export interface Window {
  /** First and last item index to render, inclusive. */
  first: number;
  last: number;
  /** Spacer heights, so the scrollbar and scroll position stay honest. */
  padTop: number;
  padBottom: number;
  rows: number;
}

/**
 * Which items to render for a scroll position.
 *
 * `overscan` is in ROWS, not pixels: a row is the unit that enters and leaves the viewport, and one
 * row above and below is enough that a flick never shows a hole while still bounding how many covers
 * are decoded at once.
 */
export function windowFor(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  { columns, rowHeight }: GridMetrics,
  overscan = 1,
): Window {
  const cols = Math.max(1, Math.floor(columns));
  const pitch = Math.max(1, rowHeight);
  const rows = Math.ceil(count / cols);

  if (count === 0) return { first: 0, last: -1, padTop: 0, padBottom: 0, rows: 0 };

  const firstRow = Math.max(0, Math.floor(scrollTop / pitch) - overscan);
  const visibleRows = Math.ceil(viewportHeight / pitch) + overscan * 2;
  const lastRow = Math.min(rows - 1, firstRow + visibleRows);

  return {
    first: firstRow * cols,
    last: Math.min(count - 1, (lastRow + 1) * cols - 1),
    padTop: firstRow * pitch,
    padBottom: Math.max(0, (rows - 1 - lastRow) * pitch),
    rows,
  };
}

/**
 * How many columns fit, and how tall a row is.
 *
 * Covers keep a 2:3 portrait ratio — the shape a book is — so the row height follows from the column
 * width rather than being chosen separately and drifting away from it.
 */
export function metricsFor(containerWidth: number, minCard = 132, gap = 14, labelHeight = 46): GridMetrics {
  const usable = Math.max(0, containerWidth - gap);
  const columns = Math.max(1, Math.floor(usable / (minCard + gap)));
  const cardWidth = Math.max(1, (containerWidth - gap * (columns + 1)) / columns);
  return { columns, rowHeight: Math.round(cardWidth * 1.5) + labelHeight + gap };
}
