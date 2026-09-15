// The library LIST's windowing arithmetic.
//
// These are the properties the grid failed on a real device, written down so they cannot fail again
// silently. The grid derived its row pitch from a measured column width and got 260px against an
// actual 311–328px; a list row is a declared constant, so the only way this can drift is if someone
// changes `ROW_PITCH` without changing the CSS — which the first test below is here to catch.

import { describe, it, expect } from "vitest";
import { ROW_PITCH, windowRows } from "../../src/features-mobile/library/useVirtualRows";

describe("the pitch is the row's real height", () => {
  it("is 13 + 66 + 13 + 1, the design's own row geometry", () => {
    // Padding, cover, padding, hairline. If the CSS changes, this number must change with it.
    expect(ROW_PITCH).toBe(13 + 66 + 13 + 1);
  });
});

describe("windowRows", () => {
  it("renders nothing for an empty library, without producing a negative range", () => {
    const w = windowRows(0, 0, 800);
    expect(w).toEqual({ first: 0, last: -1, padTop: 0, padBottom: 0 });
    expect([1, 2, 3].slice(w.first, w.last + 1)).toEqual([]);
  });

  it("starts at the top with no padding above when the list has not been scrolled", () => {
    const w = windowRows(100, 0, 800);
    expect(w.first).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("covers the whole viewport at every scroll position", () => {
    // THE DEFECT THIS REPLACES: measured coverage on the grid fell to 66% mid-scroll — a third of the
    // screen blank while books existed below. Every rendered window must span the visible band.
    const count = 400;
    const viewport = 829;
    for (let top = 0; top < count * ROW_PITCH - viewport; top += 37) {
      const w = windowRows(count, top, viewport);
      const renderedTop = w.padTop;
      const renderedBottom = w.padTop + (w.last - w.first + 1) * ROW_PITCH;
      expect(renderedTop).toBeLessThanOrEqual(top);
      expect(renderedBottom).toBeGreaterThanOrEqual(top + viewport);
    }
  });

  it("keeps the total height constant, so the scrollbar cannot lie", () => {
    // The grid's scrollHeight changed as it scrolled (2553 → 2520) because the spacers were computed
    // from a pitch the rows did not honour. Padding plus rendered rows must always equal the whole.
    const count = 137;
    for (const top of [0, 200, 1000, 5000, 12000]) {
      const w = windowRows(count, top, 829);
      const total = w.padTop + (w.last - w.first + 1) * ROW_PITCH + w.padBottom;
      expect(total).toBe(count * ROW_PITCH);
    }
  });

  it("reaches the last item when scrolled to the end", () => {
    // THE DEFECT THIS REPLACES: the seventeenth of seventeen books could never be rendered — the
    // scroller reported it was at the bottom while the final row had never existed.
    for (const count of [1, 2, 17, 18, 100, 999]) {
      const end = Math.max(0, count * ROW_PITCH - 829);
      expect(windowRows(count, end, 829).last).toBe(count - 1);
    }
  });

  it("never renders past the end of the library", () => {
    for (const count of [1, 5, 17]) {
      const w = windowRows(count, 99_999, 829);
      expect(w.last).toBeLessThanOrEqual(count - 1);
      expect(w.padBottom).toBe(0);
    }
  });

  it("treats a negative scrollTop as the top, since content sits above the list", () => {
    // The Continue card and Recent strip scroll above the list, so the caller subtracts their height
    // and may hand us a negative number while they are still on screen.
    expect(windowRows(50, -400, 829)).toEqual(windowRows(50, 0, 829));
  });

  it("still renders rows when the container has not been measured yet", () => {
    // A zero viewport is what an unmeasured container reports. The old grid rendered six cells and
    // stayed there forever; the overscan alone must keep something on screen.
    const w = windowRows(50, 0, 0);
    expect(w.last).toBeGreaterThanOrEqual(0);
  });
});
