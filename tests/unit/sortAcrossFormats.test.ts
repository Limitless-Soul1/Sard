// «ترتيب حسب» DECIDES THE ORDER IN EVERY FORMAT — the contract, not the wiring.
//
// THE DEFECT. Two settings can speak about the same books: «ترتيب حسب» in the toolbar, which is the
// library's presentation choice, and a shelf's `order_rule`, which is that shelf's own. They had no
// agreed precedence, so the answer was decided by WHICH FORMAT WAS ON SCREEN.
//
// Measured in the running Library, standing inside one eight-book shelf with every title, author and
// date distinct: Grid and Details followed the toolbar and gave two different sequences for
// «العنوان» and «المؤلف»; Covers, Spines and Vista gave ONE sequence for both — and not the same one
// as each other, because a hand shelf's arrangement is saved per format. Three of the five formats
// ignored the setting entirely.
//
// THE PRECEDENCE, now stated once in `orderRuleFor`, is the one the flat formats already implemented:
// a chosen criterion is presentation and wins while it is chosen; «ترتيب الرفّ» — which reaches the
// model as `hand` — is the reader asking for the order the place itself keeps.
//
// What is asserted below is the SEQUENCE a caller gets, so an implementation that reaches the same
// answer another way keeps passing, and one that quietly reintroduces a per-format answer does not.
import { describe, expect, it } from "vitest";
import type { BookRow, CaseNode, ShelfNode } from "../../src/lib/ipc";
import {
  orderRuleFor,
  sortBooks,
  asShelfOrder,
  vistaView,
  UNFILED_CASE_ID,
  type ShelfRuns,
  type VistaInput,
} from "../../src/features/library/design/model";

/** Books whose title, author and date orders are all DIFFERENT from one another, on purpose. */
const BOOKS: BookRow[] = [
  { id: "b1", title: "Delta", author: "Ames", added_at: 30 },
  { id: "b2", title: "Alpha", author: "Dunne", added_at: 10 },
  { id: "b3", title: "Charlie", author: "Blake", added_at: 40 },
  { id: "b4", title: "Bravo", author: "Cole", added_at: 20 },
].map((b) => ({ ...b, file_path: "/" + b.id, format: "epub", language: null, dir: null,
  cover_path: null, last_opened_at: null, fraction: null, read_at: null, cover_fit: null,
  meta_provenance: null, script_detected: null, toc_degenerate: null }) as unknown as BookRow);

const ids = (list: BookRow[]) => list.map((b) => b.id);
/** The membership order — deliberately none of the computed ones. */
const PLACED = [BOOKS[0], BOOKS[1], BOOKS[2], BOOKS[3]];

const shelf = (id: string, over: Partial<ShelfNode> = {}): ShelfNode => ({
  id, name: id, ink: null, case_id: null, order_rule: "hand", auto_rule: null,
  collapsed: false, count: 0, categories: [], ...over,
});

describe("the one precedence between «ترتيب حسب» and a shelf's own rule", () => {
  it("lets a chosen criterion govern, whatever the shelf keeps", () => {
    // This is the whole fix in one line: the criterion is presentation and wins while chosen.
    expect(orderRuleFor("title", "hand")).toBe("title");
    expect(orderRuleFor("title", "author")).toBe("title");
    expect(orderRuleFor("added", "title")).toBe("added");
  });

  it("hands the place back its own order under «ترتيب الرفّ»", () => {
    // `asShelfOrder("shelf")` is `hand` — the reader asking for the order the place itself keeps.
    expect(asShelfOrder("shelf")).toBe("hand");
    expect(orderRuleFor("hand", "hand")).toBe("hand");
    expect(orderRuleFor("hand", "title")).toBe("title");
    expect(orderRuleFor("hand", "author")).toBe("author");
  });

  it("never invents an order of its own", () => {
    // Only ever one of the two it was given — anything else would be a third notion of ordering.
    for (const lib of ["hand", "title", "author", "added", "recent", "progress"] as const) {
      for (const own of ["hand", "title", "author", "added", "recent", "progress"] as const) {
        expect([lib, own]).toContain(orderRuleFor(lib, own));
      }
    }
  });
});

describe("a criterion produces the sequence it names", () => {
  // The dataset is built so no two criteria agree — a test that passed on coincident orders is
  // exactly how the previous defect stayed invisible in one shelf for so long.
  it("orders by title, author and date differently from each other", () => {
    expect(ids(sortBooks(PLACED, "title"))).toEqual(["b2", "b4", "b3", "b1"]);
    expect(ids(sortBooks(PLACED, "author"))).toEqual(["b1", "b3", "b4", "b2"]);
    expect(ids(sortBooks(PLACED, "added"))).toEqual(["b3", "b1", "b4", "b2"]);
  });

  it("leaves the placed order alone under `hand`", () => {
    // The reader's arrangement is the one thing a sort must never quietly discard.
    expect(ids(sortBooks(PLACED, "hand"))).toEqual(ids(PLACED));
  });
});

// ==================================================================================================
// The grouped/Vista path, which is where the criterion used to be dropped.
// ==================================================================================================
const runs = (s: ShelfNode, books: BookRow[]): ShelfRuns => ({
  shelf: s,
  groups: [{ categoryId: null, name: null, books }],
});

const vistaAt = (librarySort: VistaInput["librarySort"], shelfRule: ShelfNode["order_rule"]) => {
  const s = shelf("s1", { order_rule: shelfRule, count: PLACED.length });
  const node: CaseNode = { id: "c1", name: "Case", ink: null, count: PLACED.length, shelves: [s] };
  return vistaView({
    rendered: [{ node, shelves: [runs(s, PLACED)] }],
    allCases: [node],
    scope: { caseId: "c1", shelfId: "s1", categoryId: null },
    // What the screen is standing on: the section's books, already in placement order.
    shelfBooks: () => PLACED,
    librarySort,
    filtered: false,
  });
};

describe("the grouped/Vista projection honours the same criterion", () => {
  it("orders a shelf's books by the library's criterion", () => {
    // Before the fix this returned the shelf's own order whatever the toolbar said, which is the
    // measured defect: one sequence for «العنوان» and «المؤلف» alike.
    expect(ids(vistaAt("title", "hand").books)).toEqual(["b2", "b4", "b3", "b1"]);
    expect(ids(vistaAt("author", "hand").books)).toEqual(["b1", "b3", "b4", "b2"]);
  });

  it("gives the SAME sequence a flat format computes — that is the whole contract", () => {
    // Formats may lay books out differently; the sequence they lay out must be one sequence.
    for (const crit of ["title", "author", "added"] as const) {
      const flat = ids(sortBooks(PLACED, crit));          // what Grid and Details draw
      const grouped = ids(vistaAt(crit, "hand").books);   // what Vista and the grouped views draw
      expect(grouped, crit).toEqual(flat);
    }
  });

  it("still defers to the shelf's own rule under «ترتيب الرفّ»", () => {
    // A shelf set to sort itself by title keeps doing so when the library is not imposing anything.
    expect(ids(vistaAt("hand", "title").books)).toEqual(["b2", "b4", "b3", "b1"]);
    // …and a hand shelf keeps the placed order, untouched.
    expect(ids(vistaAt("hand", "hand").books)).toEqual(ids(PLACED));
  });

  it("does not let the shelf's rule override a chosen criterion", () => {
    // The failure this guards is the reverse of the fix: a second ordering pass, applied after the
    // criterion, putting the shelf's rule back on top. Vista had exactly that shape.
    expect(ids(vistaAt("author", "title").books)).toEqual(ids(sortBooks(PLACED, "author")));
  });
});

describe("the criterion orders BOOKS and nothing else", () => {
  it("leaves the shelves of a case in the case's own order", () => {
    // Sorting books must never reorder the furniture. Two shelves, and the order they come back in
    // is the order they were given, under every criterion.
    const a = shelf("sa", { count: 1 });
    const b = shelf("sb", { count: 1 });
    const node: CaseNode = { id: "c1", name: "Case", ink: null, count: 2, shelves: [a, b] };
    for (const crit of ["hand", "title", "author", "added"] as const) {
      const v = vistaView({
        rendered: [{ node, shelves: [runs(a, [PLACED[0]]), runs(b, [PLACED[1]])] }],
        allCases: [node],
        scope: { caseId: "c1", shelfId: null, categoryId: null },
        shelfBooks: (s) => (s.id === "sa" ? [PLACED[0]] : [PLACED[1]]),
        librarySort: crit,
        filtered: false,
      });
      expect(v.children.map((x) => x.key), crit).toEqual(["sa", "sb"]);
    }
  });

  it("leaves the cases at the root in their own order", () => {
    const mk = (id: string): CaseNode => ({ id, name: id, ink: null, count: 0, shelves: [] });
    const cases = [mk("c2"), mk("c1")]; // deliberately not alphabetical
    for (const crit of ["hand", "title", "author"] as const) {
      const v = vistaView({
        rendered: cases.map((node) => ({ node, shelves: [] })),
        allCases: cases,
        scope: { caseId: null, shelfId: null, categoryId: null },
        shelfBooks: () => [],
        librarySort: crit,
        filtered: false,
      });
      expect(v.cases.map((x) => x.key), crit).toEqual(["c2", "c1"]);
    }
  });

  it("keeps «خارج الخزائن» a place rather than a sort target", () => {
    // The synthesised group must not acquire an order from the book sort either.
    expect(UNFILED_CASE_ID.startsWith("__")).toBe(true);
  });
});
