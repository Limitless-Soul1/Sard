import { describe, expect, it } from "vitest";

import {
  applyRunOrder,
  bySection,
  gapsForRun,
  isNoMoveInRun,
  scopeKey,
  WHOLE_RUN,
} from "../../src/features/library/design/viewOrder";

/**
 * VIEW ORDER IS NOT MEMBERSHIP, and these are the properties that keep it that way.
 *
 * The fault this replaces: a flat view drew several containers as one sequence and took each gap's
 * container from its NEIGHBOUR, so dragging the first visible book to the last visible slot FILED
 * it. Measured on a real library — «وُضع على خارج الأرفف», persisted, the container genuinely
 * changed — when the reader had asked to reorder.
 */
describe("view order", () => {
  it("offers a destination that cannot name a container", () => {
    const gaps = gapsForRun(["a", "b", "c"]);
    // Four places for three books, and every one of them carries a neighbour and nothing else.
    expect(gaps).toEqual([{ before: "a" }, { before: "b" }, { before: "c" }, { before: null }]);
    for (const g of gaps) expect(Object.keys(g)).toEqual(["before"]);
  });

  it("offers the same number of places whoever is being carried", () => {
    // The old model hid the one or two places that would not move THIS book, which made a book's
    // freedom depend on which book it was — four places against six for the same five-book shelf,
    // and the flat formats disagreeing with the grouped ones about which was right.
    const run = ["a", "b", "c", "d", "e"];
    for (const carried of run) {
      expect(gapsForRun(run)).toHaveLength(run.length + 1);
      expect(isNoMoveInRun(run, carried, { before: carried })).toBe(true);
    }
  });

  it("knows the three releases that change nothing", () => {
    const run = ["a", "b", "c"];
    expect(isNoMoveInRun(run, "b", { before: "b" })).toBe(true); // in front of itself
    expect(isNoMoveInRun(run, "b", { before: "c" })).toBe(true); // in front of what follows it
    expect(isNoMoveInRun(run, "c", { before: null })).toBe(true); // at the end, already last
    expect(isNoMoveInRun(run, "a", { before: null })).toBe(false);
    expect(isNoMoveInRun(run, "c", { before: "a" })).toBe(false);
  });

  it("keys a run by the most specific part of where the reader stands", () => {
    // A shelf's order belongs to the SHELF. Keying on `case|shelf|category` would put it under the
    // cabinet, and moving the shelf to another cabinet would silently orphan every arrangement made
    // inside it — the reader opens it and finds their work gone, with nothing on screen to say why.
    expect(scopeKey({ caseId: "c1", shelfId: "s1", categoryId: "g1" })).toBe("g1");
    expect(scopeKey({ caseId: "c1", shelfId: "s1", categoryId: null })).toBe("s1");
    expect(scopeKey({ caseId: "c1", shelfId: null, categoryId: null })).toBe("c1");
    expect(scopeKey({ caseId: null, shelfId: null, categoryId: null })).toBe("");
    // the same shelf, re-parented: the key does not move with it
    expect(scopeKey({ caseId: "c2", shelfId: "s1", categoryId: null })).toBe("s1");
  });

  it("leaves an unarranged run exactly as it was given", () => {
    const books = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(applyRunOrder(books, []).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("puts a book the saved order has never heard of at the end", () => {
    // The whole rule for new books, and it needs no write: a read that writes is a race waiting to
    // happen. `A B C D` plus a new `E` reads `A B C D E`, and E is folded in for real the next time
    // the reader arranges the run.
    const books = [{ id: "e" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(applyRunOrder(books, ["a", "b", "c", "d"]).map((b) => b.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps newcomers in the order they were given, among themselves", () => {
    const books = [{ id: "y" }, { id: "a" }, { id: "x" }];
    expect(applyRunOrder(books, ["a"]).map((b) => b.id)).toEqual(["a", "y", "x"]);
  });

  it("ignores a saved id that is no longer in the run", () => {
    // A book that left a smart shelf keeps its row on purpose, so that returning puts it back where
    // the reader had it. While it is gone it must simply not appear.
    const books = [{ id: "a" }, { id: "c" }];
    expect(applyRunOrder(books, ["a", "b", "c"]).map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("folds one scope's rows into its sections", () => {
    // One statement per screen, not one per shelf. The rows arrive already in rank order.
    const rows = [
      { section: "s1", book_id: "a" },
      { section: "s1", book_id: "b" },
      { section: WHOLE_RUN, book_id: "z" },
    ];
    const map = bySection(rows);
    expect(map.get("s1")).toEqual(["a", "b"]);
    expect(map.get(WHOLE_RUN)).toEqual(["z"]);
    expect(map.get("nobody")).toBeUndefined();
  });
});
