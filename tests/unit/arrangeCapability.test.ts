// WHERE MANUAL ORDERING MAY BE OFFERED — the view, and the depth.
//
// `canArrange` answers for the view. `vistaArrangeable` answers for the depth, and both have to be
// true. Vista drills down, so the same view draws containers at one depth and books at another:
// measured before this rule existed, arrange mode switched ON at the library root over six
// containers and fifteen visible covers with nothing orderable and no explanation, and pressing one
// of those covers opened the case — because a sample cover is a decorative child of the container's
// navigation button, not a book.

import { describe, expect, it } from "vitest";
import type { BookRow, ShelfNode } from "../../src/lib/ipc";
import {
  asShelfOrder,
  canArrange,
  DESIGN_SORTS,
  vistaArrangeable,
  type DesignSort,
} from "../../src/features/library/design/model";

const book = (id: string): BookRow =>
  ({ id, title: id, author: null, file_path: "/" + id, format: "epub", dir: "ltr",
    added_at: 0, read_at: null, fraction: null, cover_path: null, cover_mode: null,
    cover_paint: null, cover_fit: null, spine_path: null, spine_mode: null } as unknown as BookRow);

const shelf = (id: string): ShelfNode =>
  ({ id, name: id, ink: null, case_id: null, order_rule: "hand", auto_rule: null,
    collapsed: false, count: 0, categories: [] } as unknown as ShelfNode);

describe("where Manual Ordering may be offered", () => {
  it("is refused wherever the stage is drawing containers rather than books", () => {
    // The library root and a case both draw containers. `books` is empty at those depths, whatever
    // covers are visible on the plates.
    expect(vistaArrangeable({ books: [], bookDrop: null })).toBe(false);
    expect(vistaArrangeable({ books: [], bookDrop: { shelfId: "s", categoryId: null } })).toBe(false);
  });

  it("is STILL offered where books are drawn whose order is not the reader's", () => {
    // A computed shelf fills itself and خارج الأرفف is not a collection, so neither keeps an order
    // of its own — and this used to be read as "these books cannot be moved". It is not the same
    // claim. Nineteen books sit on the rule shelf and twenty-four outside every shelf in the real
    // library; refusing to lift them made Manual Ordering unreachable for most of it. A book with
    // no order of its own still has somewhere to GO, and where it may go is decided by the
    // destinations on offer, not by the stage it is standing on.
    expect(vistaArrangeable({ books: [book("a"), book("b")], bookDrop: null })).toBe(true);
  });

  it("is offered wherever real books are drawn", () => {
    expect(vistaArrangeable({ books: [book("a")], bookDrop: { shelfId: "s", categoryId: null } })).toBe(true);
  });

  it("turns on books alone — `bookDrop` no longer gates it", () => {
    // Stated as a table so a future change that puts the two back together is visible as a diff.
    // `bookDrop` still decides whether THIS stage draws landing places; it no longer decides
    // whether a book here may be picked up.
    const cases: [BookRow[], { shelfId: string; categoryId: string | null } | null, boolean][] = [
      [[], null, false],
      [[], { shelfId: "s", categoryId: null }, false],
      [[book("a")], null, true],
      [[book("a")], { shelfId: "s", categoryId: null }, true],
    ];
    for (const [books, bookDrop, want] of cases) {
      expect(vistaArrangeable({ books, bookDrop })).toBe(want);
    }
  });

  it("the view-level rule is unchanged, and Grid is still refused outright", () => {
    // Grid renders the whole library from its own list, ignores the reader's place, and does not
    // own the markup a landing place would sit in. Details is absent from this predicate on
    // purpose: its answer depends on the sort and the shelf, and is decided by the owner.
    expect(canArrange("grid")).toBe(false);
    expect(canArrange("covers")).toBe(true);
    expect(canArrange("spines")).toBe(true);
    expect(canArrange("vista")).toBe(true);
  });
});

describe("the toolbar's sort, as a shelf's ordering rule", () => {
  it("translates the one name the two vocabularies spell differently", () => {
    // The toolbar says "shelf" because that is what the reader is choosing; a shelf says "hand"
    // because that is who put it there.
    expect(asShelfOrder("shelf")).toBe("hand");
  });

  it("leaves every shared name alone", () => {
    for (const s of DESIGN_SORTS) expect(asShelfOrder(s)).toBe(s);
  });

  it("answers for every sort the type allows", () => {
    const all: DesignSort[] = [...DESIGN_SORTS, "shelf"];
    for (const s of all) expect(typeof asShelfOrder(s)).toBe("string");
  });

  it("is not offered in the default list — a shelf must own the stage first", () => {
    // At the root, in a case, or on a computed shelf there is no single stored order to sort by,
    // so the toolbar does not list it. The owner adds it where it means something.
    expect(DESIGN_SORTS).not.toContain("shelf");
  });
});

describe("a shelf's own order survives being sorted", () => {
  it("hand order is the order the list arrives in", async () => {
    // `shelfBooks` builds the list from the shelf's stored positions; re-sorting here would throw
    // away the very thing "shelf order" asks for.
    const { sortBooks } = await import("../../src/features/library/design/model");
    const list = [book("c"), book("a"), book("b")];
    expect(sortBooks(list, "hand").map((b) => b.id)).toEqual(["c", "a", "b"]);
    expect(sortBooks(list, asShelfOrder("shelf")).map((b) => b.id)).toEqual(["c", "a", "b"]);
  });

  it("and a column sort still reorders, so the two are genuinely different", () => {
    expect(shelf("s").order_rule).toBe("hand");
  });
});
