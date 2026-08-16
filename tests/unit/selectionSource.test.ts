// Where a Select-mode "Move to…" takes its books OUT of.
//
// The action is labelled Move and behaved like Add: the destination gained the books and every
// source kept them. The naive repair — strip every other membership — would destroy placements a
// reader made on purpose, because a book is allowed to sit on several shelves. So the source is
// derived from context, and "I cannot tell" is a permitted answer that the tray then asks about.

import { describe, it, expect } from "vitest";
import type { ShelfItem } from "../../src/lib/ipc";
import { LOOSE_SHELF_ID, selectionSource } from "../../src/features/library/design/model";

const item = (book_id: string): ShelfItem =>
  ({ book_id, category_id: null, position: 0 }) as unknown as ShelfItem;

const sel = (...ids: string[]) => new Set(ids);

describe("resolving what a Select-mode move leaves", () => {
  it("uses the scoped shelf as the source when the pane is scoped to one", () => {
    // Case 1: working inside shelf A and moving three books to B.
    const items = { a: [item("b1"), item("b2"), item("b3")], b: [] };
    const s = selectionSource(sel("b1", "b2", "b3"), items, "a");
    expect(s.kind).toBe("scoped");
    expect(s.shelfId).toBe("a");
  });

  it("a scope wins even when the selection also sits elsewhere", () => {
    // The reader said which shelf they are working in. That is a statement, not a guess — and the
    // books' other memberships are none of this move's business.
    const items = { a: [item("b1")], other: [item("b1")] };
    const s = selectionSource(sel("b1"), items, "a");
    expect(s).toMatchObject({ kind: "scoped", shelfId: "a" });
    expect(s.shelves).toEqual(["a", "other"]);
  });

  it("unscoped, one common shelf is unambiguous", () => {
    const items = { a: [item("b1"), item("b2")], b: [] };
    expect(selectionSource(sel("b1", "b2"), items, null)).toMatchObject({ kind: "single", shelfId: "a" });
  });

  it("unscoped and spanning several shelves is AMBIGUOUS — nothing is assumed", () => {
    // Case 3. Guessing here is how legitimate memberships get destroyed.
    const items = { a: [item("b1")], b: [item("b2")] };
    const s = selectionSource(sel("b1", "b2"), items, null);
    expect(s.kind).toBe("ambiguous");
    expect(s.shelfId).toBeNull();
    expect(s.shelves).toEqual(["a", "b"]);
  });

  it("one book on two shelves is ambiguous too", () => {
    // The book itself spans sources, so there is still no single answer.
    const items = { a: [item("b1")], b: [item("b1")] };
    expect(selectionSource(sel("b1"), items, null).kind).toBe("ambiguous");
  });

  it("books on no shelf have nothing to leave", () => {
    // Unfiled → Shelf is an ADD, and must not try to remove anything.
    const items = { a: [item("other")] };
    expect(selectionSource(sel("b1"), items, null)).toMatchObject({ kind: "none", shelfId: null });
  });

  it("never treats the unshelved run as a source", () => {
    // It is a render-time set, not a collection: there is no membership row to delete.
    const items = { [LOOSE_SHELF_ID]: [item("b1")] };
    const s = selectionSource(sel("b1"), items, null);
    expect(s.kind).toBe("none");
    expect(s.shelves).toEqual([]);
  });

  it("never treats a scope ON the unshelved run as a source either", () => {
    const items = { [LOOSE_SHELF_ID]: [item("b1")], a: [item("b1")] };
    const s = selectionSource(sel("b1"), items, LOOSE_SHELF_ID);
    expect(s.kind).toBe("single");
    expect(s.shelfId).toBe("a");
  });

  it("lists every occupied shelf so the tray can ask which one to leave", () => {
    const items = { a: [item("b1")], b: [item("b2")], c: [item("b3")], empty: [] };
    expect(selectionSource(sel("b1", "b2", "b3"), items, null).shelves).toEqual(["a", "b", "c"]);
  });

  it("an empty selection resolves to nothing rather than to a shelf", () => {
    const items = { a: [item("b1")] };
    expect(selectionSource(sel(), items, null)).toMatchObject({ kind: "none", shelves: [] });
  });

  it("a selection spanning two cases' shelves is ambiguous, not silently one of them", () => {
    // "Selection across Cases": a shelf id is a shelf id, and two of them is still two.
    const items = { "case1-shelf": [item("b1")], "case2-shelf": [item("b2")] };
    expect(selectionSource(sel("b1", "b2"), items, null).kind).toBe("ambiguous");
  });
});
