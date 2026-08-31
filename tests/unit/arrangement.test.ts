import { describe, expect, it } from "vitest";
import {
  buildArrangement,
  gapsFor,
  inArrangementOrder,
  isNoMove,
  UNFILED,
} from "../../src/features/library/design/arrangement";
import { spread } from "../../src/features/library/design/rank";
import type { Placement } from "../../src/lib/ipc";

/**
 * These are the invariants the redesign exists to make true. Each one names the symptom it makes
 * unrepresentable, because a test that only describes the happy path would not have caught any of
 * the faults that were reported.
 */

/** A small library shaped like the reader's: a couple of shelves, an empty one, a long unfiled run. */
function library() {
  const placements: Placement[] = [];
  const put = (container: string, ids: string[]) => {
    const ranks = spread(ids.length);
    ids.forEach((id, i) => placements.push({ book_id: id, container, rank: ranks[i], category_id: null }));
  };
  put("shelfA", ["a1", "a2", "a3"]);
  put("shelfB", ["b1", "b2"]);
  put(UNFILED, ["u1", "u2", "u3", "u4"]);
  // «empty» holds nothing and must still be a destination.
  return buildArrangement(placements, ["shelfA", "shelfB", "empty", UNFILED]);
}

const WRITABLE = ["shelfA", "shelfB", "empty", UNFILED];

describe("one answer to where a book is", () => {
  it("gives every placed book exactly one container", () => {
    const a = library();
    expect(a.containerOf("a2")).toBe("shelfA");
    expect(a.containerOf("u1")).toBe(UNFILED);
    expect(a.containerOf("nobody")).toBe(null);
  });

  it("does not depend on who is asking", () => {
    // The whole fault in one assertion: the answer is a property of the book, so there is no
    // parameter a view could pass that would change it.
    const a = library();
    const asked = [a.containerOf("a2"), a.containerOf("a2"), a.containerOf("a2")];
    expect(new Set(asked).size).toBe(1);
  });

  it("keeps each container in rank order", () => {
    const a = library();
    expect(a.orderOf("shelfA").map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(a.orderOf(UNFILED).map((p) => p.id)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("knows an empty container exists", () => {
    // A container that holds nothing is still a place. Forgetting it is how empty shelves became
    // unreachable: there was no book to hang a landing place off.
    const a = library();
    expect(a.orderOf("empty")).toEqual([]);
    expect(a.containers).toContain("empty");
  });

  it("orders a container by rank even when handed the placements shuffled", () => {
    const ranks = spread(4);
    const shuffled: Placement[] = [
      { book_id: "c", container: "S", rank: ranks[2], category_id: null },
      { book_id: "a", container: "S", rank: ranks[0], category_id: null },
      { book_id: "d", container: "S", rank: ranks[3], category_id: null },
      { book_id: "b", container: "S", rank: ranks[1], category_id: null },
    ];
    expect(buildArrangement(shuffled).orderOf("S").map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("every book is offered the same places", () => {
  it("offers the IDENTICAL destinations whichever book is picked up", () => {
    // THE REPORTED FAULT: one book could go almost anywhere and another had two places, because
    // the offer was built from the carried book's own shelf.
    //
    // The set is now a property of the library and of nothing else — not even of the book in hand.
    // An earlier pass left out the one or two places that would not move a given book, and that
    // brought the fault back in miniature: the count then depended on which book was carried, and
    // the flat views hid them while the grouped views did not. Releasing into such a place writes
    // nothing; that is decided at the release, not by hiding the target.
    const a = library();
    const shape = (id: string) =>
      gapsFor(a, id, WRITABLE)
        .map((g) => g.container + ">" + (g.before ?? "END"))
        .sort();

    const every = [shape("a2"), shape("u1"), shape("b1"), shape("nobody")];
    for (const s of every) expect(s).toEqual(every[0]);
  });

  it("offers exactly N + 1 places for a container of N books", () => {
    const a = library();
    const gaps = gapsFor(a, "u1", WRITABLE);
    for (const container of WRITABLE) {
      const n = a.orderOf(container).length;
      const here = gaps.filter((g) => g.container === container);
      expect(here.length).toBe(n + 1);
      expect(here.filter((g) => g.before === null).length).toBe(1);
    }
    // shelfA 3 + shelfB 2 + empty 0 + unfiled 4, each with one end
    expect(gaps.length).toBe(3 + 2 + 0 + 4 + WRITABLE.length);
  });

  it("never names one destination twice", () => {
    const a = library();
    for (const who of ["a1", "u2", "b2", "nobody"]) {
      const gaps = gapsFor(a, who, WRITABLE).map((g) => g.container + ">" + (g.before ?? "END"));
      expect(new Set(gaps).size).toBe(gaps.length);
    }
  });

  it("offers the empty container", () => {
    const a = library();
    const empty = gapsFor(a, "a1", WRITABLE).filter((g) => g.container === "empty");
    expect(empty).toEqual([{ container: "empty", before: null }]);
  });

  it("offers another shelf's every position, not just its end", () => {
    // «between two books on another shelf» — impossible in the old model, which only ever drew
    // positions belonging to the shelf the book came from.
    const a = library();
    const onB = gapsFor(a, "a1", WRITABLE).filter((g) => g.container === "shelfB");
    expect(onB).toEqual([
      { container: "shelfB", before: "b1" },
      { container: "shelfB", before: "b2" },
      { container: "shelfB", before: null },
    ]);
  });

  it("never offers a lens as a destination", () => {
    // A rule shelf is not in the writable list, and so cannot be reached at all.
    const a = library();
    expect(gapsFor(a, "a1", WRITABLE).some((g) => g.container === "readingLens")).toBe(false);
  });
});

describe("a release that would change nothing", () => {
  it("knows its own place and the place after it", () => {
    const a = library();
    expect(isNoMove(a, "a1", { container: "shelfA", before: "a1" })).toBe(true);
    expect(isNoMove(a, "a1", { container: "shelfA", before: "a2" })).toBe(true);
    expect(isNoMove(a, "a3", { container: "shelfA", before: null })).toBe(true);
  });

  it("does not mistake a real move for one", () => {
    const a = library();
    expect(isNoMove(a, "a1", { container: "shelfA", before: "a3" })).toBe(false);
    expect(isNoMove(a, "a1", { container: "shelfA", before: null })).toBe(false);
    expect(isNoMove(a, "a1", { container: "shelfB", before: "b1" })).toBe(false);
    // Moving to the end of ANOTHER container is always a move, even from the end of this one.
    expect(isNoMove(a, "a3", { container: "shelfB", before: null })).toBe(false);
  });
});

describe("the order a flat list shows", () => {
  const rank = (c: string) => ["shelfA", "shelfB", "empty", UNFILED].indexOf(c);

  it("follows the arrangement, container by container", () => {
    const a = library();
    const books = ["u3", "a2", "b2", "a1", "u1", "b1", "a3", "u2", "u4"].map((id) => ({ id }));
    expect(inArrangementOrder(books, a, rank).map((b) => b.id)).toEqual([
      "a1", "a2", "a3", "b1", "b2", "u1", "u2", "u3", "u4",
    ]);
  });

  it("puts a book the arrangement has never heard of with the unfiled, not first", () => {
    const a = library();
    const books = [{ id: "stranger" }, { id: "a1" }];
    const out = inArrangementOrder(books, a, rank).map((b) => b.id);
    expect(out[0]).toBe("a1");
    expect(out).toContain("stranger");
  });

  it("is stable, so equal books keep the order they arrived in", () => {
    const a = buildArrangement([]);
    const books = ["z", "y", "x"].map((id) => ({ id }));
    expect(inArrangementOrder(books, a, () => 0).map((b) => b.id)).toEqual(["z", "y", "x"]);
  });
});
