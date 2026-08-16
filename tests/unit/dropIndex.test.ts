// Where a dragged case lands.
//
// The grip looked like a drag handle and was not one — a click merely highlighted the case, and
// the reader was left guessing what the control meant. Making it a real drag needs one piece of
// arithmetic to be right: the insertion bar has to sit where the case will actually end up, or
// the drag lies about its own outcome.
//
// The correction below (`at > from ? at - 1 : at`) is the reference's own, and it is what stops a
// case appearing to refuse to move down by a single position.

import { describe, it, expect } from "vitest";
import { dropIndex } from "../../src/features/library/design/model";

// Four rows, 40px tall, stacked from y=100: midpoints at 120, 160, 200, 240.
const MIDS = [120, 160, 200, 240];

describe("the insertion point of a vertical drag", () => {
  it("drops at the top when the pointer is above every row", () => {
    expect(dropIndex(0, MIDS, 2)).toBe(0);
    expect(dropIndex(119, MIDS, 2)).toBe(0);
  });

  it("drops at the end when the pointer is below every row", () => {
    // Carrying row 0 out of four leaves three others, so the last index is 3.
    expect(dropIndex(9999, MIDS, 0)).toBe(3);
  });

  it("crosses into the next slot at a row's midpoint, not at its edge", () => {
    // A midpoint is what lets the bar track the pointer instead of flickering at a boundary.
    expect(dropIndex(159, MIDS, 3)).toBe(1);
    expect(dropIndex(161, MIDS, 3)).toBe(2);
  });

  it("moving DOWN by one is a real move, not a no-op", () => {
    // Row 0 dropped just past row 1's midpoint. Without the correction this yields 2 and the case
    // jumps two places; with it, 1 — exactly one step down.
    expect(dropIndex(161, MIDS, 0)).toBe(1);
  });

  it("moving UP by one needs no correction", () => {
    // Row 2 dropped above row 1's midpoint lands at 1.
    expect(dropIndex(159, MIDS, 2)).toBe(1);
  });

  it("dropping a row back on itself leaves it where it was", () => {
    // Row 1 released over its own slot: 1 in, 1 out.
    expect(dropIndex(159, MIDS, 1)).toBe(1);
    expect(dropIndex(199, MIDS, 1)).toBe(1);
  });

  it("takes the first row to the last position", () => {
    expect(dropIndex(241, MIDS, 0)).toBe(3);
  });

  it("takes the last row to the first position", () => {
    expect(dropIndex(0, MIDS, 3)).toBe(0);
  });

  it("never returns an index outside the list", () => {
    for (const from of [0, 1, 2, 3]) {
      for (const y of [-500, 0, 120, 160, 200, 240, 5000]) {
        const at = dropIndex(y, MIDS, from);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThanOrEqual(MIDS.length - 1);
      }
    }
  });

  it("handles a single row, which can only stay put", () => {
    expect(dropIndex(0, [100], 0)).toBe(0);
    expect(dropIndex(999, [100], 0)).toBe(0);
  });

  it("ignores rows it could not measure", () => {
    // A row that is not on screen reports Infinity, which must not swallow the whole list: the
    // pointer is past the first midpoint, so the bar belongs after the first row.
    expect(dropIndex(130, [120, Number.POSITIVE_INFINITY, 200], 2)).toBe(1);
  });
});
