import { describe, expect, it } from "vitest";
import {
  buildArrangement,
  gapsFor,
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

/**
 * THE SHAPE THIS MODEL EXISTS FOR: one canonical book on three shelves at once, two of them under
 * different cabinets, each with its own position and its own category.
 *
 * Every assertion below that matters is made against THIS, not against a single-membership mock.
 * A fixture where each book has one placement cannot fail the way the old model failed.
 */
function shared() {
  const ranks = spread(4);
  const placements: Placement[] = [
    // shelfA (cabinet 1): x sits second, in category «classics»
    { book_id: "p", container: "shelfA", rank: ranks[0], category_id: null },
    { book_id: "x", container: "shelfA", rank: ranks[1], category_id: "classics" },
    { book_id: "q", container: "shelfA", rank: ranks[2], category_id: null },
    // shelfB (cabinet 1): x sits first, uncategorised
    { book_id: "x", container: "shelfB", rank: ranks[0], category_id: null },
    { book_id: "p", container: "shelfB", rank: ranks[1], category_id: null },
    // weekly (cabinet 2): x sits last, in a category of that shelf's own
    { book_id: "r", container: "weekly", rank: ranks[0], category_id: null },
    { book_id: "x", container: "weekly", rank: ranks[1], category_id: "now" },
    // and a book that is on no shelf at all
    { book_id: "lonely", container: UNFILED, rank: ranks[0], category_id: null },
  ];
  return buildArrangement(placements, ["shelfA", "shelfB", "weekly", "empty", UNFILED]);
}

const WRITABLE = ["shelfA", "shelfB", "empty", UNFILED];

describe("a book's memberships", () => {
  it("resolves the one membership of an ordinary book", () => {
    const a = library();
    expect(a.membershipsOf("a2").map((m) => m.container)).toEqual(["shelfA"]);
    expect(a.soleContainerOf("a2")).toBe("shelfA");
    expect(a.soleContainerOf("u1")).toBe(UNFILED);
    expect(a.membershipsOf("nobody")).toEqual([]);
    expect(a.soleContainerOf("nobody")).toBe(null);
  });

  it("resolves ALL memberships of a shared book", () => {
    const a = shared();
    expect(a.membershipsOf("x").map((m) => m.container)).toEqual(["shelfA", "shelfB", "weekly"]);
  });

  it("gives each shelf only its own membership", () => {
    const a = shared();
    expect(a.membershipIn("shelfA", "x")?.container).toBe("shelfA");
    expect(a.membershipIn("shelfB", "x")?.container).toBe("shelfB");
    expect(a.membershipIn("empty", "x")).toBe(null);
    expect(a.holds("shelfA", "x")).toBe(true);
    expect(a.holds("shelfB", "x")).toBe(true);
    expect(a.holds("weekly", "x")).toBe(true);
    expect(a.holds("empty", "x")).toBe(false);
  });

  it("shows the same canonical book in every shelf that holds it, at once", () => {
    // THE CENTRAL REQUIREMENT. Three appearances, one id — the shelves do not collapse into a home
    // and the book is not hidden from one because it is visible in another.
    const a = shared();
    const inA = a.orderOf("shelfA").map((p) => p.id);
    const inB = a.orderOf("shelfB").map((p) => p.id);
    const inW = a.orderOf("weekly").map((p) => p.id);
    expect(inA).toContain("x");
    expect(inB).toContain("x");
    expect(inW).toContain("x");
    // …and they are the same book, not three.
    expect(new Set([...inA, ...inB, ...inW].filter((id) => id === "x")).size).toBe(1);
  });

  it("refuses to hand back an arbitrary home", () => {
    // The fault the old `containerOf` had: a Map keyed on the book, so the LAST row read won. There
    // is now no call that can return one of several memberships without naming which.
    const a = shared();
    expect(a.soleContainerOf("x")).toBe(null);
    expect(a.soleContainerOf("lonely")).toBe(UNFILED);
    // The API surface itself carries no book-only container accessor any more.
    const surface = a as unknown as Record<string, unknown>;
    expect(surface.containerOf).toBeUndefined();
    expect(surface.categoryOf).toBeUndefined();
  });

  it("keeps rank local to each shelf", () => {
    const a = shared();
    expect(a.indexIn("shelfA", "x")).toBe(1);
    expect(a.indexIn("shelfB", "x")).toBe(0);
    expect(a.indexIn("weekly", "x")).toBe(1);
    // Three different positions for one book, and none of them is "the" position.
    const ranks = a.membershipsOf("x").map((m) => m.rank);
    expect(new Set(ranks).size).toBeGreaterThan(1);
  });

  it("keeps category local to each shelf", () => {
    // A category belongs to a shelf, never to a book. Reading it off the book would carry one
    // shelf's grouping into another's bands.
    const a = shared();
    expect(a.membershipIn("shelfA", "x")?.categoryId).toBe("classics");
    expect(a.membershipIn("shelfB", "x")?.categoryId).toBe(null);
    expect(a.membershipIn("weekly", "x")?.categoryId).toBe("now");
  });

  it("keeps the unfiled run working alongside all of it", () => {
    const a = shared();
    expect(a.orderOf(UNFILED).map((p) => p.id)).toEqual(["lonely"]);
    expect(a.membershipsOf("lonely").map((m) => m.container)).toEqual([UNFILED]);
    // A shared book is on no unfiled run — that invariant is the model's, and the projection agrees.
    expect(a.holds(UNFILED, "x")).toBe(false);
  });

  it("counts canonical books once across the whole arrangement", () => {
    // The root projection's arithmetic: three memberships, one book. A count that added the
    // containers up would say five books in a library that holds four.
    const a = shared();
    const everywhere = a.containers.flatMap((c) => a.orderOf(c).map((p) => p.id));
    expect(everywhere.length).toBe(8);
    expect(new Set(everywhere).size).toBe(5);
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

/*
 * "THE ORDER A FLAT LIST SHOWS" USED TO BE TESTED HERE, against `inArrangementOrder`.
 *
 * Both the function and its tests are gone, and deliberately. It ordered a flat list by "which
 * container each book lives in, then its index there" — a rule that needs every book to live in
 * exactly one place, which is the assumption this model removes. It was already dead in the
 * application: the root run takes its sequence from `view_orders` via `runOf(list, WHOLE_RUN)`,
 * because ordering the root by containers put an invisible seam inside a list with no shelf on
 * screen and made the last visible slot the end of whichever container sorted last — a book dragged
 * there was FILED there. `viewOrder.test.ts` covers the run ordering that replaced it.
 *
 * Keeping these passing would have meant keeping a function whose only remaining purpose was to
 * satisfy them, and whose name would have invited the next caller to reintroduce the fault.
 */
