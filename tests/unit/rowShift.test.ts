// HOW FAR EACH ROW MOVES ASIDE while another is dragged past it.
//
// `dropIndex` says WHERE the dragged row lands; this says what the list does in the meantime. The
// two have to agree exactly, because the gap that opens IS the drop indicator — if the gap is one
// slot away from where the row actually lands, the list lies about its own outcome, which is the
// defect `dropIndex`'s own tests were written for, arriving from the other side.
//
// `dropIndex` returns an index into the list WITHOUT the dragged row. These tests drive `rowShift`
// with exactly the values `dropIndex` produces, so the pair is tested as it is used rather than as
// it is written.

import { describe, it, expect } from "vitest";

import { dropIndex } from "../../src/features/library/design/model";
import { rowShift, DRAG_THRESHOLD_PX, SETTLE_MS } from "../../src/features/library/design/rowDrag";

const H = 40;
// Four rows, 40px tall, stacked from y=100 — the same shape `dropIndex.test.ts` uses.
const MIDS = [120, 160, 200, 240];
/** What the whole list does, as a readable row of offsets in units of H. */
const shifts = (from: number, at: number) =>
  MIDS.map((_, i) => rowShift(i, from, at, H) / H);

describe("the gap a dragged row opens", () => {
  it("leaves every row alone when nothing has moved", () => {
    const at = dropIndex(205, MIDS, 2); // row 2 still over its own slot
    expect(at).toBe(2);
    expect(shifts(2, at)).toEqual([0, 0, 0, 0]);
  });

  it("moves the rows it passes UP when a row is dragged down", () => {
    // Row 0 dragged just past row 1's midpoint: one step down.
    const at = dropIndex(161, MIDS, 0);
    expect(at).toBe(1);
    expect(shifts(0, at)).toEqual([0, -1, 0, 0]);
  });

  it("moves the rows it passes DOWN when a row is dragged up", () => {
    // Row 3 dragged above row 1's midpoint: it lands at index 1.
    const at = dropIndex(159, MIDS, 3);
    expect(at).toBe(1);
    expect(shifts(3, at)).toEqual([0, 1, 1, 0]);
  });

  it("opens the top slot when a row is dragged above everything", () => {
    const at = dropIndex(0, MIDS, 2);
    expect(at).toBe(0);
    expect(shifts(2, at)).toEqual([1, 1, 0, 0]);
  });

  it("opens the last slot when a row is dragged below everything", () => {
    const at = dropIndex(9999, MIDS, 0);
    expect(at).toBe(3);
    expect(shifts(0, at)).toEqual([0, -1, -1, -1]);
  });

  it("never moves the dragged row itself — the pointer is carrying it", () => {
    for (let from = 0; from < MIDS.length; from++) {
      for (let at = 0; at < MIDS.length; at++) {
        expect(rowShift(from, from, at, H)).toBe(0);
      }
    }
  });

  it("moves each row by at most one slot, and only ever in one direction", () => {
    // A row either makes room or it does not; nothing in a single drag moves two places.
    for (let from = 0; from < MIDS.length; from++) {
      for (let at = 0; at < MIDS.length; at++) {
        const s = shifts(from, at);
        expect(s.every((v) => v === -1 || v === 0 || v === 1)).toBe(true);
        const dirs = new Set(s.filter((v) => v !== 0));
        expect(dirs.size).toBeLessThanOrEqual(1);
      }
    }
  });

  it("closes the list up by exactly the distance the row travelled", () => {
    // Every row the dragged one passes moves one slot the other way, so the displacements sum to
    // the distance travelled, negated. A smaller total would leave the gap in the wrong place; a
    // larger one would move a row that the drag never passed.
    for (let from = 0; from < MIDS.length; from++) {
      for (let at = 0; at < MIDS.length; at++) {
        const total = shifts(from, at).reduce((a, b) => a + b, 0);
        expect(total).toBe(from - at);
      }
    }
  });

  it("moves exactly the rows between the row's old and new places, and no others", () => {
    // from=0 -> at=2 passes rows 1 and 2, so both make way; row 3 is not involved at all.
    expect(shifts(0, 2)).toEqual([0, -1, -1, 0]);
    expect(shifts(3, 0)).toEqual([1, 1, 1, 0]);
  });

  it("keeps the interaction's two constants where the rest of Sard can see them", () => {
    // The threshold is the grip's own, and the settle matches the basket tray's. Both are shared on
    // purpose; a copy of either would drift.
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(SETTLE_MS).toBe(190);
  });
});
