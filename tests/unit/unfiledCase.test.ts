// The synthesised case that makes an unfiled shelf manageable.
//
// A shelf outside every case must never become an object the reader can see and cannot manage.
// The management panel reaches those shelves by being handed a case node that does not exist in
// the database, so the rules that node has to obey are worth pinning down: it carries exactly the
// loose shelves, it counts DISTINCT books, and it is recognisable as the synthesised one.

import { describe, it, expect } from "vitest";
import type { ShelfItem, ShelfNode } from "../../src/lib/ipc";
import { unfiledCase, UNFILED_CASE_ID } from "../../src/features/library/design/model";

const shelf = (id: string, name: string, over: Partial<ShelfNode> = {}): ShelfNode => ({
  id,
  name,
  ink: null,
  case_id: null,
  order_rule: "hand",
  auto_rule: null,
  collapsed: false,
  count: 0,
  categories: [],
  ...over,
});

const item = (book_id: string): ShelfItem =>
  ({ book_id, category_id: null, position: 0 }) as unknown as ShelfItem;

describe("the unfiled group as a case", () => {
  it("carries exactly the loose shelves, in the order given", () => {
    const loose = [shelf("a", "Poetry"), shelf("b", "Essays")];
    const node = unfiledCase("Not in a case", loose, {});
    expect(node.shelves.map((s) => s.id)).toEqual(["a", "b"]);
    expect(node.name).toBe("Not in a case");
  });

  it("counts a book once even when it sits on two unfiled shelves", () => {
    // The 42-reported-as-43 mistake: summing the shelf totals instead of counting books.
    const loose = [shelf("a", "Poetry"), shelf("b", "Essays")];
    const items = { a: [item("b1"), item("b2")], b: [item("b2"), item("b3")] };
    expect(unfiledCase("x", loose, items).count).toBe(3);
  });

  it("counts nothing when the shelves are empty, rather than guessing from shelf.count", () => {
    // `shelf.count` is the backend's number for a real shelf; the synthesised node must not
    // inherit a stale one, or an emptied shelf keeps reporting its old total.
    const loose = [shelf("a", "Poetry", { count: 9 })];
    expect(unfiledCase("x", loose, {}).count).toBe(0);
  });

  it("survives a shelf with no membership loaded yet", () => {
    // `items` is filled asynchronously, so the first render legitimately has no entry.
    const node = unfiledCase("x", [shelf("a", "Poetry"), shelf("b", "Essays")], { a: [item("b1")] });
    expect(node.count).toBe(1);
    expect(node.shelves).toHaveLength(2);
  });

  it("is empty and inert when there are no loose shelves at all", () => {
    const node = unfiledCase("x", [], {});
    expect(node.count).toBe(0);
    expect(node.shelves).toEqual([]);
  });

  it("is identifiable as synthesised, and carries no colour of its own", () => {
    // The panel keys the case-specific controls — rename, ink, delete — off this identity.
    const node = unfiledCase("x", [shelf("a", "Poetry")], {});
    expect(node.id).toBe(UNFILED_CASE_ID);
    expect(node.ink).toBeNull();
  });

  it("does not collide with a real case id", () => {
    // Real ids come from the database; the sentinel is deliberately not a valid one.
    expect(UNFILED_CASE_ID.startsWith("__")).toBe(true);
  });
});
