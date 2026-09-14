// A BOOK THE LIBRARY LISTS AND NO ROW PLACES.
//
// The rule the database enforces is one line: an UNFILED row exists if and only if no real shelf
// holds the book. Read carefully, that makes "no shelf holds it" the FACT and the row the fact's
// written form — somewhere to hang an ordering key, not the thing itself.
//
// The arrangement used to derive the unfiled run from the written form alone, so a book whose row
// was missing belonged to no container at all: drawn by no grouped format, absent from «خارج
// الأرفف», absent from the heading that counts it — while `books` still held it, the header still
// counted it, and de-duplication still recognised it. A book cannot be both in the library and
// nowhere in it, and these tests are what stop that returning.
//
// The state is real, not hypothetical. A beta reader has books in it: rows written by a version of
// the importer that never wrote a placement. They must become ordinary unfiled books without the
// reader deleting anything, re-importing anything, or losing anything.
import { describe, expect, it } from "vitest";
import { buildArrangement, gapsFor, isNoMove, UNFILED } from "../../src/features/library/design/arrangement";
import { spread } from "../../src/features/library/design/rank";
import type { Placement } from "../../src/lib/ipc";

const WRITABLE = ["shelfA", "empty", UNFILED];

/**
 * A library holding an orphan: two filed books, one properly unfiled book with a row, and `orphan`,
 * which the library lists and no row places.
 */
function withOrphan() {
  const ranks = spread(3);
  const placements: Placement[] = [
    { book_id: "a1", container: "shelfA", rank: ranks[0], category_id: null },
    { book_id: "a2", container: "shelfA", rank: ranks[1], category_id: null },
    { book_id: "u1", container: UNFILED, rank: ranks[0], category_id: null },
  ];
  return buildArrangement(placements, WRITABLE, ["a1", "a2", "u1", "orphan"]);
}

describe("a book that no placement row places", () => {
  it("is in the unfiled run, because no shelf holds it", () => {
    expect(withOrphan().orderOf(UNFILED).map((p) => p.id)).toEqual(["u1", "orphan"]);
  });

  it("is reported as being in the unfiled container", () => {
    const a = withOrphan();
    expect(a.holds(UNFILED, "orphan")).toBe(true);
    expect(a.soleContainerOf("orphan")).toBe(UNFILED);
  });

  it("is on no shelf, which is what the unfiled run means", () => {
    // `membershipsOf` answers with the unfiled container and nothing else — so every caller that
    // asks "which shelves is this on" (the details sheet, the move menu) correctly answers "none".
    const mine = withOrphan().membershipsOf("orphan");
    expect(mine.map((m) => m.container)).toEqual([UNFILED]);
  });

  it("sorts after every book that does have an ordering key", () => {
    // Where `settle_unfiled` puts a book that has just lost its last shelf: at the end. A book with
    // no key must not jump in front of books whose order the reader arranged by hand.
    const ranks = spread(3);
    const placements: Placement[] = [
      { book_id: "u1", container: UNFILED, rank: ranks[0], category_id: null },
      { book_id: "u2", container: UNFILED, rank: ranks[1], category_id: null },
    ];
    const a = buildArrangement(placements, WRITABLE, ["orphanA", "u1", "orphanB", "u2"]);
    expect(a.orderOf(UNFILED).map((p) => p.id)).toEqual(["u1", "u2", "orphanA", "orphanB"]);
  });

  it("can be moved onto a shelf like any other book", () => {
    // Every gap of every writable container is offered for it — so the reader can file it, which is
    // the whole point of it being visible.
    const gaps = gapsFor(withOrphan(), "orphan", WRITABLE);
    expect(gaps.some((g) => g.container === "shelfA")).toBe(true);
    expect(gaps.some((g) => g.container === "empty" && g.before === null)).toBe(true);
  });

  it("knows that dropping it where it already is changes nothing", () => {
    // It is last in the unfiled run, so releasing at the end of that run is a no-op — the same
    // answer an ordinary unfiled book gets, which is what stops a pointless write.
    expect(isNoMove(withOrphan(), "orphan", { container: UNFILED, before: null })).toBe(true);
    expect(isNoMove(withOrphan(), "orphan", { container: "shelfA", before: null })).toBe(false);
  });

  it("does not disturb the books that do have rows", () => {
    const a = withOrphan();
    expect(a.orderOf("shelfA").map((p) => p.id)).toEqual(["a1", "a2"]);
    expect(a.holds(UNFILED, "a1")).toBe(false);
    expect(a.membershipsOf("a1").map((m) => m.container)).toEqual(["shelfA"]);
  });

  it("stops being derived the moment a row is written for it", () => {
    // The recovery path: `settle_unfiled` writes the row on the next placement write that touches
    // the book, and from then on the book is an ordinary member with an ordering key of its own.
    const ranks = spread(2);
    const healed = buildArrangement(
      [{ book_id: "orphan", container: UNFILED, rank: ranks[0], category_id: null }],
      WRITABLE,
      ["orphan"],
    );
    expect(healed.orderOf(UNFILED).map((p) => p.id)).toEqual(["orphan"]);
    expect(healed.membershipsOf("orphan")).toHaveLength(1);
    // One membership, not two: deriving must never double a book that already has its row.
    expect(healed.orderOf(UNFILED)).toHaveLength(1);
  });

  it("is not derived for a book that is already on a shelf", () => {
    // The fact is "no SHELF holds it". A filed book has one, so it is not unfiled — deriving from
    // the book list must not put every book in the run.
    const a = withOrphan();
    expect(a.orderOf(UNFILED).map((p) => p.id)).not.toContain("a1");
  });

  it("leaves the arrangement unchanged when the library list is not given", () => {
    // The parameter is optional, and omitting it must behave exactly as before — every existing
    // caller and every existing test depends on that.
    const ranks = spread(1);
    const a = buildArrangement([{ book_id: "u1", container: UNFILED, rank: ranks[0], category_id: null }], WRITABLE);
    expect(a.orderOf(UNFILED).map((p) => p.id)).toEqual(["u1"]);
  });
});

describe("the unfiled run as the reader sees it", () => {
  it("counts an orphan, so the group that stands over it appears", () => {
    // «خارج الخزائن» is drawn when the run beneath it has content. An orphan that was in no
    // container left that run empty, which is how a book could exist and no heading mention it.
    expect(withOrphan().orderOf(UNFILED).length).toBe(2);
  });

  it("shows a library whose books have never been placed at all", () => {
    // The worst version of the reported state: every row missing. The library must still draw every
    // book rather than rendering as empty.
    const a = buildArrangement([], WRITABLE, ["x", "y", "z"]);
    expect(a.orderOf(UNFILED).map((p) => p.id)).toEqual(["x", "y", "z"]);
  });
});
