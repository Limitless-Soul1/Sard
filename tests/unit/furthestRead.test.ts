// The furthest-point mark: what advances it, what must never advance it, and what it survives.
//
// The rule under test is small on purpose — the mark is the running maximum of the reading position —
// so these tests are mostly about the cases where "maximum" is not obvious: a missing comparator, a
// book that reports no fraction, stored values written by an older build, and the one that the whole
// feature turns on, going backwards.
import { describe, expect, it } from "vitest";

import {
  advanceFurthest,
  boundaryHasParted,
  markFromResume,
  movedOnFrom,
  offerReturn,
  isBeyond,
  parseFurthest,
  serialiseFurthest,
  type FurthestMark,
} from "../../src/features/reader/furthestRead";

/** What the engine would answer for two of these "ch<N>" cfis: their document order. */
const order = (a: string, b: string) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""));

const at = (n: number, extra: Partial<FurthestMark> = {}): FurthestMark => ({
  cfi: `ch${n}`,
  fraction: n / 1000,
  label: `الفصل ${n}`,
  href: `ch${n}.xhtml`,
  sec: n,
  ...extra,
});

describe("what the mark counts as further", () => {
  it("anything is further than no mark at all", () => {
    expect(isBeyond({ cfi: "ch1", fraction: 0.001 }, null, null)).toBe(true);
  });

  it("a later position is further", () => {
    expect(isBeyond({ cfi: "ch489", fraction: 0.489 }, at(488), order("ch489", "ch488"))).toBe(true);
  });

  it("an earlier position is NOT further — this is the whole feature", () => {
    expect(isBeyond({ cfi: "ch320", fraction: 0.32 }, at(488), order("ch320", "ch488"))).toBe(false);
    expect(isBeyond({ cfi: "ch150", fraction: 0.15 }, at(488), order("ch150", "ch488"))).toBe(false);
  });

  it("the same position is not further, so re-reading a page rewrites nothing", () => {
    expect(isBeyond({ cfi: "ch488", fraction: 0.488 }, at(488), order("ch488", "ch488"))).toBe(false);
  });

  it("an empty cfi is never further — a PDF has no cfi and must not disturb the mark", () => {
    expect(isBeyond({ cfi: "", fraction: 0.99 }, at(488), 1)).toBe(false);
    expect(isBeyond({ cfi: "", fraction: 0.99 }, null, null)).toBe(false);
  });

  it("the comparator decides, not the fraction, when the two disagree", () => {
    // A book whose fractions are coarse can report a LOWER fraction for a genuinely later position.
    expect(isBeyond({ cfi: "ch500", fraction: 0.1 }, at(488), order("ch500", "ch488"))).toBe(true);
    expect(isBeyond({ cfi: "ch400", fraction: 0.9 }, at(488), order("ch400", "ch488"))).toBe(false);
  });

  it("falls back to the fraction when the engine could not order the two", () => {
    expect(isBeyond({ cfi: "x", fraction: 0.6 }, at(488), null)).toBe(true);
    expect(isBeyond({ cfi: "x", fraction: 0.3 }, at(488), null)).toBe(false);
  });

  it("falls back to the fraction when the engine answers with nonsense", () => {
    expect(isBeyond({ cfi: "x", fraction: 0.6 }, at(488), NaN)).toBe(true);
    expect(isBeyond({ cfi: "x", fraction: 0.3 }, at(488), NaN)).toBe(false);
  });

  it("without a comparator, a book that reports no fraction lags rather than overshoots", () => {
    // Failing this way sends the reader somewhere real; the other way sends them ahead of themselves.
    expect(isBeyond({ cfi: "ch900", fraction: 0 }, at(0, { fraction: 0 }), null)).toBe(false);
  });
});

describe("advancing the mark", () => {
  it("returns the new mark when it grew", () => {
    expect(advanceFurthest(at(488), at(530), order("ch530", "ch488"))).toEqual(at(530));
  });

  it("returns null when it did not, so nothing is persisted", () => {
    expect(advanceFurthest(at(488), at(320), order("ch320", "ch488"))).toBeNull();
    expect(advanceFurthest(at(488), at(488), order("ch488", "ch488"))).toBeNull();
  });

  it("the owner's sequence: 488 → 320 → 150 keeps 488, then 520 takes it", () => {
    let held: FurthestMark | null = null;
    let writes = 0;
    for (const n of [1, 100, 488, 320, 150, 300, 520]) {
      const grown = advanceFurthest(held, at(n), held ? order(`ch${n}`, held.cfi) : null);
      if (grown) {
        held = grown;
        writes++;
      }
    }
    expect(held?.sec).toBe(520);
    // 1, 100, 488, 520 — the three backward moves and the one that stayed behind wrote nothing.
    expect(writes).toBe(4);
  });

  it("carries the label, href and section of the position that set it", () => {
    const grown = advanceFurthest(at(488), at(530), order("ch530", "ch488"));
    expect(grown).toMatchObject({ cfi: "ch530", label: "الفصل 530", href: "ch530.xhtml", sec: 530 });
  });
});

describe("storing and restoring it", () => {
  it("round-trips", () => {
    expect(parseFurthest(serialiseFurthest(at(488)))).toEqual(at(488));
  });

  it("nothing stored means no mark", () => {
    expect(parseFurthest(null)).toBeNull();
    expect(parseFurthest(undefined)).toBeNull();
    expect(parseFurthest("")).toBeNull();
  });

  it("a malformed row means no mark, never a throw — this runs on the open path", () => {
    expect(parseFurthest("{not json")).toBeNull();
    expect(parseFurthest("[]")).toBeNull();
    expect(parseFurthest("{}")).toBeNull();
    expect(parseFurthest('{"cfi":""}')).toBeNull();
    expect(parseFurthest('{"cfi":42}')).toBeNull();
    expect(parseFurthest("null")).toBeNull();
  });

  it("a value from an older build keeps its cfi and defaults the rest", () => {
    expect(parseFurthest('{"cfi":"ch488"}')).toEqual({ cfi: "ch488", fraction: 0, label: null, href: null, sec: -1 });
  });

  it("a non-finite fraction cannot poison the ordering", () => {
    expect(parseFurthest('{"cfi":"ch488","fraction":null}')?.fraction).toBe(0);
  });
});

describe("whether the way back is offered at all", () => {
  // The comparison is by CONTENTS ROW, not by cfi: navigating to the mark lands on the page that
  // contains it, whose reported cfi is a shade behind the stored one, so a cfi test left the control
  // permanently on screen pointing at the chapter the reader was already standing in (measured in the
  // running reader). The control names a chapter, so a chapter is the unit.
  it("not offered when there is no mark to point at", () => {
    expect(offerReturn(-1, 0)).toBe(false);
    expect(offerReturn(-1, -1)).toBe(false);
  });

  it("not offered in the chapter the reader got to", () => {
    expect(offerReturn(9, 9)).toBe(false);
  });

  it("not offered past it — the mark is about to advance anyway", () => {
    expect(offerReturn(9, 12)).toBe(false);
  });

  it("offered from any earlier chapter, near or far", () => {
    expect(offerReturn(9, 8)).toBe(true);
    expect(offerReturn(488, 320)).toBe(true);
    expect(offerReturn(488, 0)).toBe(true);
  });

  it("offered when the reader is inside no listed chapter at all", () => {
    expect(offerReturn(9, -1)).toBe(true);
  });

  it("a reader who has only read chapter 1 and stayed there is offered nothing", () => {
    expect(offerReturn(0, 0)).toBe(false);
  });
});

describe("the mark a book opens with", () => {
  it("uses the stored mark when there is one", () => {
    expect(markFromResume(at(488), { cfi: "ch2", fraction: 0.002 })).toEqual(at(488));
  });

  it("adopts the saved reading position when there is no stored mark", () => {
    // Every book read before the mark existed arrives here. Treating it as "reached nowhere" would
    // seal nothing, and a search would hand back the whole book.
    expect(markFromResume(null, { cfi: "ch320", fraction: 0.32 })).toEqual({
      cfi: "ch320", fraction: 0.32, label: null, href: null, sec: -1,
    });
  });

  it("a brand-new book, never opened, still has no mark", () => {
    expect(markFromResume(null, null)).toBeNull();
    expect(markFromResume(null, undefined)).toBeNull();
    expect(markFromResume(null, { cfi: null, fraction: 0 })).toBeNull();
    expect(markFromResume(null, {})).toBeNull();
  });

  it("a saved position with no usable fraction still yields a mark", () => {
    expect(markFromResume(null, { cfi: "ch7" })?.fraction).toBe(0);
    expect(markFromResume(null, { cfi: "ch7", fraction: NaN })?.fraction).toBe(0);
  });

  it("never lets the saved position overwrite a stored mark that is further on", () => {
    expect(markFromResume(at(592), { cfi: "ch320", fraction: 0.32 })?.cfi).toBe("ch592");
  });
});

describe("whether the boundary has parted from the reader's position", () => {
  it("no mark means the boundary is simply where they are", () => {
    expect(boundaryHasParted(null, -1, 3, 0.1)).toBe(false);
  });

  it("standing at the furthest chapter, it has not parted", () => {
    expect(boundaryHasParted(at(592, { href: "ch592.xhtml" }), 592, 592, 0.592)).toBe(false);
  });

  it("having moved back, it has", () => {
    expect(boundaryHasParted(at(592, { href: "ch592.xhtml" }), 592, 320, 0.32)).toBe(true);
  });

  it("reading past it, it has not — the mark is about to catch up", () => {
    expect(boundaryHasParted(at(592, { href: "ch592.xhtml" }), 592, 600, 0.6)).toBe(false);
  });

  it("a mark with no contents row of its own falls back to the whole-book fraction", () => {
    const seeded = { cfi: "ch592", fraction: 0.592, label: null, href: null, sec: -1 };
    expect(boundaryHasParted(seeded, -1, 320, 0.32)).toBe(true);
    expect(boundaryHasParted(seeded, -1, 592, 0.592)).toBe(false);
    expect(boundaryHasParted(seeded, -1, 600, 0.7)).toBe(false);
  });

  it("agrees with offerReturn wherever the row is known — one answer, two controls", () => {
    for (const [f, a] of [[592, 320], [592, 592], [592, 600], [0, 0], [9, -1]] as const) {
      expect(boundaryHasParted(at(f, { href: "x" }), f, a, 0)).toBe(offerReturn(f, a));
    }
  });
});

describe("moving on from where the contents list put you", () => {
  it("nothing pending means the reader was not sent anywhere", () => {
    expect(movedOnFrom(null, { loc: 5, frac: 0.1 })).toBe(true);
  });

  it("the landing itself is not moving on", () => {
    expect(movedOnFrom({ loc: 900, frac: 0.9 }, { loc: 900, frac: 0.9 })).toBe(false);
  });

  it("a RE-LAYOUT at the same place is not moving on — this is the case a timer got wrong", () => {
    // Opening the Contents panel re-lays out the reading area and emits a relocate at the same
    // position, arbitrarily long after the jump. Measured: with a time window it advanced the mark.
    expect(movedOnFrom({ loc: 900, frac: 0.9 }, { loc: 900, frac: 0.9001 })).toBe(false);
  });

  it("a page turn forward IS moving on", () => {
    expect(movedOnFrom({ loc: 900, frac: 0.9 }, { loc: 901, frac: 0.901 })).toBe(true);
  });

  it("paging back from the landing is not", () => {
    expect(movedOnFrom({ loc: 900, frac: 0.9 }, { loc: 899, frac: 0.899 })).toBe(false);
  });

  it("falls back to the fraction when the book reports no locations", () => {
    expect(movedOnFrom({ loc: null, frac: 0.9 }, { loc: null, frac: 0.91 })).toBe(true);
    expect(movedOnFrom({ loc: null, frac: 0.9 }, { loc: null, frac: 0.9 })).toBe(false);
    expect(movedOnFrom({ loc: null, frac: 0.9 }, { loc: null, frac: 0.89 })).toBe(false);
  });

  it("uses the fraction when only one side knows its location", () => {
    expect(movedOnFrom({ loc: 900, frac: 0.9 }, { loc: null, frac: 0.95 })).toBe(true);
    expect(movedOnFrom({ loc: null, frac: 0.9 }, { loc: 901, frac: 0.9 })).toBe(false);
  });
});
