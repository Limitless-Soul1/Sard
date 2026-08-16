// What a manual drag has to do to the database.
//
// Arrange used to call the destination's placement and stop, which adds a membership without
// removing the one the book came from — so a drag from shelf A to shelf B left the book on BOTH.
// `book_collections` is many-to-many, so nothing underneath was going to object. The decision is
// pure, the source is known at pick-up, and this is where it is pinned down.
//
// The matching database assertions live in `src-tauri/src/library/structure.rs`, which proves the
// two calls this plan implies actually produce the state the reader expects, on a real SQLite.

import { describe, it, expect } from "vitest";
import { LOOSE_SHELF_ID, placementPlan } from "../../src/features/library/design/model";

describe("what a manual placement does", () => {
  it("shelf to shelf is a move: join the destination, leave the source", () => {
    expect(placementPlan("a", "b")).toEqual({ kind: "move", shelfId: "b", removeFrom: "a" });
  });

  it("never leaves the book on both shelves", () => {
    const plan = placementPlan("a", "b");
    // The whole bug in one assertion: a plan that does not name a source to leave is a copy.
    expect(plan.kind).toBe("move");
    expect("removeFrom" in plan && plan.removeFrom).toBe("a");
  });

  it("the same shelf is a reorder, with nothing removed", () => {
    // Removing first would delete and re-add a membership the book never lost — and a category
    // move within one shelf goes through here too.
    expect(placementPlan("a", "a")).toEqual({ kind: "reorder", shelfId: "a" });
  });

  it("a book that was on no shelf simply joins one", () => {
    // The unshelved run is a render-time set, not a collection: there is no membership to remove.
    expect(placementPlan(LOOSE_SHELF_ID, "b")).toEqual({ kind: "add", shelfId: "b" });
  });

  it("dropping onto the unshelved run takes the book off its shelf", () => {
    expect(placementPlan("a", LOOSE_SHELF_ID)).toEqual({ kind: "unshelve", removeFrom: "a" });
  });

  it("dropping an already-unshelved book onto the unshelved run does nothing", () => {
    expect(placementPlan(LOOSE_SHELF_ID, LOOSE_SHELF_ID)).toEqual({ kind: "none" });
  });

  it("treats two shelves in different cases the same as any other two shelves", () => {
    // A shelf id is a shelf id; which case holds it is not part of the placement decision.
    expect(placementPlan("shelf-in-case-1", "shelf-in-case-2")).toEqual({
      kind: "move",
      shelfId: "shelf-in-case-2",
      removeFrom: "shelf-in-case-1",
    });
  });

  it("names a source to leave for every plan that adds a membership elsewhere", () => {
    // A guard against the bug returning under a new plan kind: any plan that joins a real shelf
    // must either have come from nowhere, or say what it is leaving.
    const cases: [string, string][] = [
      ["a", "b"],
      [LOOSE_SHELF_ID, "b"],
      ["a", "a"],
      ["a", LOOSE_SHELF_ID],
      [LOOSE_SHELF_ID, LOOSE_SHELF_ID],
    ];
    for (const [from, to] of cases) {
      const plan = placementPlan(from, to);
      if (plan.kind === "move") expect(plan.removeFrom).not.toBe(plan.shelfId);
      if (plan.kind === "add") expect(from).toBe(LOOSE_SHELF_ID);
    }
  });
});

describe("a rule shelf is a view, not a location", () => {
  // Its contents are a live query — `auto_sql` — so there are no `book_collections` rows for it.
  // That is why a book cannot "leave" one: there is nothing to delete, and the book goes on
  // appearing there for exactly as long as the rule still describes it.
  it("dragging a book OUT of a rule shelf is an add, not a move", () => {
    expect(placementPlan("reading-shelf", "b", { sourceIsRule: true })).toEqual({
      kind: "add",
      shelfId: "b",
    });
  });

  it("names no source to remove, so nothing can be deleted by mistake", () => {
    const plan = placementPlan("reading-shelf", "b", { sourceIsRule: true });
    expect("removeFrom" in plan).toBe(false);
  });

  it("the same two shelves are a real move when the source is NOT a rule", () => {
    // The asymmetry the reader hit: the source's own kind decided this, and a SORTED shelf was
    // wrongly treated as unable to give a book up. Only a rule shelf is.
    expect(placementPlan("reading-shelf", "b", { sourceIsRule: false })).toEqual({
      kind: "move",
      shelfId: "b",
      removeFrom: "reading-shelf",
    });
    expect(placementPlan("reading-shelf", "b")).toEqual({
      kind: "move",
      shelfId: "b",
      removeFrom: "reading-shelf",
    });
  });

  it("dropping a rule shelf's book on the unshelved run does nothing", () => {
    // There is no membership to take away, so "take it off its shelf" has nothing to act on.
    expect(placementPlan("reading-shelf", LOOSE_SHELF_ID, { sourceIsRule: true })).toEqual({ kind: "none" });
  });

  it("reordering within a rule shelf is still just a reorder", () => {
    expect(placementPlan("r", "r", { sourceIsRule: true })).toEqual({ kind: "reorder", shelfId: "r" });
  });
});
