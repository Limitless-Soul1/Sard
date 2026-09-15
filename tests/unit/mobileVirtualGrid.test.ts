// The library grid's windowing arithmetic.
//
// This is the one library surface where a phone genuinely differs from a desktop: every cover is an
// `<img>` decoded to W×H×4 bytes whatever the file weighs, so rendering a whole library is a memory
// decision, not a rendering one. The arithmetic is pure so the window can be checked exactly rather
// than eyeballed on a device.

import { describe, it, expect } from "vitest";
import { metricsFor, windowFor } from "../../src/features-mobile/library/useVirtualGrid";

const M = { columns: 2, rowHeight: 100 };

describe("windowFor", () => {
  it("renders nothing for an empty library, without producing a negative range", () => {
    const w = windowFor(0, 0, 800, M);
    expect(w).toEqual({ first: 0, last: -1, padTop: 0, padBottom: 0, rows: 0 });
    // `slice(first, last + 1)` on this must be empty rather than the whole array.
    expect([1, 2, 3].slice(w.first, w.last + 1)).toEqual([]);
  });

  it("covers the viewport plus overscan, and starts at the top when the scroll is at the top", () => {
    // 400px of viewport over 100px rows is 4 visible rows. One row of overscan each side would be 6,
    // and the window spans firstRow..firstRow+6 — seven rows — because the count is added to the
    // first row rather than to the last visible one. At 2 columns that is items 0..13.
    const w = windowFor(100, 0, 400, M);
    expect(w.first).toBe(0);
    expect(w.last).toBe(13);
    expect(w.padTop).toBe(0); // nothing above row 0 to account for
  });

  it("moves the window as the reader scrolls, and keeps the spacers honest", () => {
    const w = windowFor(100, 1000, 400, M); // row 10 at the top
    expect(w.first).toBe(18); // (10 - 1 overscan) * 2 columns
    expect(w.padTop).toBe(900); // 9 rows above are not rendered
    // The spacers plus the rendered rows must always add up to the full scroll height.
    const renderedRows = (w.last - w.first + 1) / M.columns;
    expect(w.padTop + renderedRows * M.rowHeight + w.padBottom).toBe(w.rows * M.rowHeight);
  });

  it("never runs past the end of the library", () => {
    const w = windowFor(7, 100000, 400, M);
    expect(w.last).toBe(6);
    expect(w.padBottom).toBe(0);
  });

  it("clamps to one column rather than dividing by zero", () => {
    const w = windowFor(5, 0, 400, { columns: 0, rowHeight: 0 });
    expect(w.first).toBe(0);
    expect(w.last).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(w.padBottom)).toBe(true);
  });

  it("renders far fewer items than the library holds — the whole point", () => {
    const w = windowFor(2000, 0, 800, M);
    expect(w.last - w.first + 1).toBeLessThan(40);
  });
});

describe("metricsFor", () => {
  it("fits two columns on a phone and more on a tablet", () => {
    expect(metricsFor(390).columns).toBe(2);
    expect(metricsFor(820).columns).toBeGreaterThanOrEqual(4);
  });

  it("never returns zero columns, however narrow the window", () => {
    for (const w of [0, 50, 120]) expect(metricsFor(w).columns).toBeGreaterThanOrEqual(1);
  });

  it("derives row height from column width, so covers keep a book's 2:3 shape", () => {
    const narrow = metricsFor(390);
    const wide = metricsFor(820);
    // More columns on a wider screen means narrower cards, so rows get SHORTER, not taller.
    expect(wide.rowHeight).toBeLessThan(narrow.rowHeight);
    expect(narrow.rowHeight).toBeGreaterThan(100);
  });
});
