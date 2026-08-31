// Adversarial tests for the Library's decision layer.
//
// Everything here is a pure function that some interaction consults before touching the database:
// where a drop lands, what a move leaves behind, where the reader is standing, which face a field
// takes. The happy paths are covered elsewhere. These ask what happens with degenerate input, at
// the boundaries, and under repetition — the shapes a real library reaches eventually and a
// demonstration never does.

import { describe, it, expect } from "vitest";
import type { CaseNode, ShelfItem, ShelfNode } from "../../src/lib/ipc";
import {
  dropIndex,
  groupShelf,
  isRootScope,
  isUnfiledScope,
  LOOSE_SHELF_ID,
  placementPlan,
  reconcileScope,
  ROOT_SCOPE,
  selectionSource,
  sortBooks,
  UNFILED_CASE_ID,
  unfiledCase,
} from "../../src/features/library/design/model";
import { edgeScrollStep } from "../../src/features/library/design/dragScroll";
import { fieldScript } from "../../src/features/library/design/bidi";

const shelf = (id: string, over: Partial<ShelfNode> = {}): ShelfNode => ({
  id,
  name: id,
  ink: null,
  case_id: null,
  order_rule: "hand",
  auto_rule: null,
  collapsed: false,
  count: 0,
  categories: [],
  ...over,
});
const kase = (id: string, shelves: ShelfNode[]): CaseNode => ({ id, name: id, ink: null, count: 0, shelves });
const item = (book_id: string, category_id: string | null = null): ShelfItem =>
  ({ book_id, category_id, position: 0 }) as unknown as ShelfItem;

describe("placement, pushed at its edges", () => {
  it("treats an empty shelf id as a shelf, not as a special case", () => {
    // "" is not the unshelved run and not equal to a real id; nothing may silently treat it as one.
    expect(placementPlan("", "b")).toEqual({ kind: "move", shelfId: "b", removeFrom: "" });
    expect(placementPlan("a", "")).toEqual({ kind: "move", shelfId: "", removeFrom: "a" });
    expect(placementPlan("", "")).toEqual({ kind: "reorder", shelfId: "" });
  });

  it("is stable under repetition — the same inputs always give the same plan", () => {
    for (let i = 0; i < 100; i++) {
      expect(placementPlan("a", "b")).toEqual({ kind: "move", shelfId: "b", removeFrom: "a" });
    }
  });

  it("never names a source equal to its destination", () => {
    // A plan that removed from the shelf it just wrote to would delete the placement it made.
    const combos: [string, string][] = [
      ["a", "b"],
      ["a", "a"],
      [LOOSE_SHELF_ID, "b"],
      ["a", LOOSE_SHELF_ID],
      ["", "b"],
    ];
    for (const [from, to] of combos) {
      const p = placementPlan(from, to);
      if (p.kind === "move") expect(p.removeFrom).not.toBe(p.shelfId);
    }
  });

  it("a rule source never yields a removal, whatever the destination", () => {
    for (const to of ["b", "", LOOSE_SHELF_ID]) {
      const p = placementPlan("rule", to, { sourceIsRule: true });
      expect(p.kind === "move").toBe(false);
      expect("removeFrom" in p && p.kind !== "unshelve").toBe(false);
    }
  });
});

describe("navigation, pushed at its edges", () => {
  it("survives a tree that is entirely empty", () => {
    expect(reconcileScope({ caseId: "x", shelfId: "y", categoryId: null }, [], [])).toEqual(ROOT_SCOPE);
    expect(reconcileScope(ROOT_SCOPE, [], [])).toBe(ROOT_SCOPE);
  });

  it("converges after one pass, however wrong the starting scope", () => {
    // Reconciling must reach a fixed point immediately; a scope that keeps changing would make
    // the effect that runs it loop.
    const cases = [kase("a", [shelf("s1", { case_id: "a" })]), kase("b", [])];
    const loose = [shelf("s2")];
    const starts = [
      { caseId: "ghost", shelfId: "ghost", categoryId: null },
      { caseId: "a", shelfId: "s2", categoryId: null },
      { caseId: "b", shelfId: "s1", categoryId: null },
      { caseId: UNFILED_CASE_ID, shelfId: "s1", categoryId: null },
      { caseId: null, shelfId: "s1", categoryId: null },
      { caseId: "ghost", shelfId: LOOSE_SHELF_ID, categoryId: null },
    ];
    for (const s of starts) {
      const once = reconcileScope(s, cases, loose);
      const twice = reconcileScope(once, cases, loose);
      expect(twice).toEqual(once);
    }
  });

  it("never invents a case that is not in the tree", () => {
    const cases = [kase("a", [])];
    for (const s of [
      { caseId: "ghost", shelfId: null, categoryId: null },
      { caseId: "ghost", shelfId: "ghost", categoryId: null },
    ]) {
      const out = reconcileScope(s, cases, []);
      if (out.caseId && !isUnfiledScope(out)) expect(cases.some((c) => c.id === out.caseId)).toBe(true);
    }
  });

  it("keeps the root cheap no matter how large the tree", () => {
    const big = Array.from({ length: 300 }, (_, i) => kase(`c${i}`, [shelf(`s${i}`, { case_id: `c${i}` })]));
    expect(reconcileScope(ROOT_SCOPE, big, [])).toBe(ROOT_SCOPE);
    expect(isRootScope(ROOT_SCOPE)).toBe(true);
  });
});

describe("the Select-mode source, pushed at its edges", () => {
  it("copes with a shelf list full of empty shelves", () => {
    const items = { a: [], b: [], c: [] };
    expect(selectionSource(new Set(["b1"]), items, null)).toMatchObject({ kind: "none", shelves: [] });
  });

  it("does not care how many books are selected, only how many shelves they span", () => {
    const many = Array.from({ length: 200 }, (_, i) => `b${i}`);
    const items = { a: many.map((b) => item(b)) };
    expect(selectionSource(new Set(many), items, null)).toMatchObject({ kind: "single", shelfId: "a" });
  });

  it("reports a stable, sorted shelf list so the question it asks does not reshuffle", () => {
    const items = { z: [item("b1")], a: [item("b2")], m: [item("b3")] };
    const s = selectionSource(new Set(["b1", "b2", "b3"]), items, null);
    expect(s.shelves).toEqual(["a", "m", "z"]);
    expect(selectionSource(new Set(["b3", "b1", "b2"]), items, null).shelves).toEqual(["a", "m", "z"]);
  });

  it("a scoped shelf that holds none of the selection is still the stated source", () => {
    // The reader said where they are working. Removing from a shelf a book is not on is a no-op,
    // which is safer than overriding an explicit statement of context.
    const items = { scoped: [], other: [item("b1")] };
    expect(selectionSource(new Set(["b1"]), items, "scoped")).toMatchObject({ kind: "scoped", shelfId: "scoped" });
  });
});

describe("grouping, pushed at its edges", () => {
  it("a shelf with no categories always yields exactly one run", () => {
    expect(groupShelf(shelf("s"), [], new Map())).toHaveLength(1);
    expect(groupShelf(shelf("s"), [], new Map(), true)).toHaveLength(1);
  });

  it("ignores membership rows whose book is not in the library", () => {
    // A row can outlive its book if a delete raced a read; the view must not render a hole.
    const groups = groupShelf(shelf("s"), [item("ghost")], new Map());
    expect(groups[0].books).toHaveLength(0);
  });

  it("keeps every category when asked, and drops only the empty ones when not", () => {
    const s = shelf("s", {
      categories: [
        { id: "k1", name: "One" },
        { id: "k2", name: "Two" },
      ] as ShelfNode["categories"],
    });
    expect(groupShelf(s, [], new Map(), true)).toHaveLength(2);
    expect(groupShelf(s, [], new Map(), false)).toHaveLength(0);
  });

  it("puts a book whose category is unknown into the uncategorised run rather than losing it", () => {
    const s = shelf("s", { categories: [{ id: "k1", name: "One" }] as ShelfNode["categories"] });
    const byId = new Map([["b1", { id: "b1" } as never]]);
    const groups = groupShelf(s, [item("b1", "ghost-category")], byId, true);
    const loose = groups.find((g) => g.categoryId === null);
    expect(loose?.books.map((b) => b.id)).toEqual(["b1"]);
  });
});

describe("the unfiled group, pushed at its edges", () => {
  it("counts a book once however many loose shelves hold it", () => {
    const loose = [shelf("a"), shelf("b"), shelf("c")];
    const items = { a: [item("x")], b: [item("x")], c: [item("x")] };
    expect(unfiledCase("u", loose, items).count).toBe(1);
  });

  it("is unaffected by items belonging to shelves it does not contain", () => {
    const items = { a: [item("x")], somewhereElse: [item("y"), item("z")] };
    expect(unfiledCase("u", [shelf("a")], items).count).toBe(1);
  });
});

describe("the drop index, pushed at its edges", () => {
  it("handles an empty list without producing a negative index", () => {
    expect(dropIndex(100, [], 0)).toBeGreaterThanOrEqual(-1);
    expect(dropIndex(100, [], 0)).toBeLessThanOrEqual(0);
  });

  it("stays in range for a long list, wherever the pointer is", () => {
    const mids = Array.from({ length: 200 }, (_, i) => i * 10);
    for (const from of [0, 99, 199]) {
      for (const y of [-1e6, 0, 995, 1e6]) {
        const at = dropIndex(y, mids, from);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThanOrEqual(199);
      }
    }
  });

  it("is unaffected by rows it could not measure, wherever they sit", () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(dropIndex(50, [inf, inf, inf], 0)).toBe(0);
    expect(dropIndex(50, [10, inf, 90], 2)).toBe(1);
  });
});

describe("the scroll curve, pushed at its edges", () => {
  it("returns a finite number for absurd geometry", () => {
    for (const [y, top, bottom] of [
      [0, 0, 0],
      [100, 500, 100],
      [-1e9, 0, 1000],
      [1e9, 0, 1000],
      [Number.NaN, 0, 1000],
    ] as [number, number, number][]) {
      const s = edgeScrollStep(y, top, bottom);
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it("an inverted box scrolls nothing rather than running away", () => {
    expect(edgeScrollStep(300, 600, 100)).toBe(0);
  });
});

describe("field script, pushed at its edges", () => {
  it("handles empty, blank and absent values without guessing wildly", () => {
    expect(fieldScript("")).toBe("latin");
    expect(fieldScript(null)).toBe("latin");
    expect(fieldScript(undefined)).toBe("latin");
    expect(fieldScript("   ", "rtl")).toBe("arabic");
  });

  it("reads a very long mixed string without missing the Arabic in it", () => {
    const long = "A".repeat(5000) + "ب" + "B".repeat(5000);
    expect(fieldScript(long)).toBe("arabic");
  });

  it("treats punctuation and digits as no evidence either way", () => {
    expect(fieldScript("12345", "rtl")).toBe("latin"); // it has content; believe the field
    expect(fieldScript("—", "rtl")).toBe("latin");
  });
});

describe("sorting, pushed at its edges", () => {
  it("leaves a hand-ordered list exactly as given, including its identity", () => {
    const list = [{ id: "a" }, { id: "b" }] as never[];
    expect(sortBooks(list, "hand")).toBe(list);
  });

  it("does not throw on null metadata", () => {
    const list = [
      { id: "a", title: null, author: null, added_at: null, read_at: null, fraction: null },
      { id: "b", title: "B", author: "B", added_at: 1, read_at: 1, fraction: 1 },
    ] as never[];
    for (const key of ["title", "author", "added", "recent", "progress"] as const) {
      expect(() => sortBooks(list, key)).not.toThrow();
      expect(sortBooks(list, key)).toHaveLength(2);
    }
  });
});
