// Vista — The Casement: the shaping.
//
// `vistaView` decides what stands on the stage at every level, and the states that matter most are
// the ones a real library rarely has all at once: two shelves of the same name in two different
// cases, a category with nothing in it, a book that is on more than one shelf, a computed shelf,
// and books that are on no shelf at all. Those are asserted here rather than by making rows in
// somebody's library to look at.

import { describe, expect, it } from "vitest";
import type { BookRow, CaseNode, ShelfNode } from "../../src/lib/ipc";
import {
  LOOSE_SHELF_ID,
  UNFILED_CASE_ID,
  makeLooseShelf,
  vistaView,
  type ShelfRuns,
  type VistaInput,
} from "../../src/features/library/design/model";

const book = (id: string): BookRow =>
  ({
    id,
    file_path: "/" + id,
    format: "epub",
    title: id,
    author: null,
    language: null,
    dir: null,
    cover_path: null,
    added_at: 1,
    last_opened_at: null,
    fraction: null,
    read_at: null,
    cover_fit: null,
    meta_provenance: null,
    script_detected: null,
    toc_degenerate: null,
  }) as unknown as BookRow;

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
const kase = (id: string, shelves: ShelfNode[], ink: string | null = null): CaseNode =>
  ({ id, name: id, ink, count: 0, shelves });

const runs = (s: ShelfNode, books: BookRow[]): ShelfRuns => ({
  shelf: s,
  groups: [{ categoryId: null, name: null, books }],
});

const view = (over: Partial<VistaInput>) =>
  vistaView({
    rendered: [],
    allCases: [],
    scope: { caseId: null, shelfId: null, categoryId: null },
    shelfBooks: () => [],
    librarySort: "hand",
    filtered: false,
    ...over,
  });

describe("the root: three classes of thing, and one of them is an absence", () => {
  const arabic = shelf("s-ar", { name: "العربية", case_id: "c1", count: 6 });
  const c1 = kase("c1", [arabic], "#C08A3E");
  const loose = shelf("s-loose", { name: "To read", count: 2 });
  const unshelved = makeLooseShelf("خارج الأرفف", 3);
  const base = {
    allCases: [c1],
    rendered: [
      { node: c1, shelves: [runs(arabic, [book("a"), book("b")])] },
      {
        node: null,
        shelves: [
          runs(loose, [book("c")]),
          runs(unshelved, [book("d"), book("e"), book("f")]),
        ],
      },
    ],
    shelfBooks: (s: ShelfNode) => (s.id === arabic.id ? [book("a"), book("b")] : [book("c")]),
  };

  it("puts cases in their own band, above the line", () => {
    const v = view(base);
    expect(v.cases.map((x) => x.kind)).toEqual(["case"]);
    expect(v.cases[0].children).toBe(1);
    expect(v.cases[0].ink).toBe("#C08A3E");
  });

  it("puts loose shelves below the line, and never among the cases", () => {
    const v = view(base);
    expect(v.children.map((x) => x.name)).toEqual(["To read", "خارج الأرفف"]);
    expect(v.cases.some((x) => x.kind !== "case")).toBe(false);
  });

  it("draws the unshelved books as a CONTAINER, always last, and never as loose books", () => {
    const v = view(base);
    // The whole point: it is a child of its own kind, not a pile of `book` children.
    const last = v.children[v.children.length - 1];
    expect(last.kind).toBe("unshelved");
    expect(last.total).toBe(3);
    expect(last.name).toBe("خارج الأرفف");
    expect(v.books).toEqual([]);
    expect(v.children.some((x) => (x.kind as string) === "book")).toBe(false);
  });

  it("refuses a drop on a case, and offers one on a shelf", () => {
    const v = view(base);
    expect(v.cases[0].drop).toBeNull();
    expect(v.cases[0].dropKind).toBeNull();
    const shelf = v.children.find((x) => x.kind === "shelf")!;
    expect(shelf.drop).toEqual({ shelfId: "s-loose", categoryId: null });
    expect(shelf.dropKind).toBe("file");
  });

  it("lets the unshelved container take a book OFF a shelf, and never take one onto it", () => {
    // The two directions are not the same operation, and an earlier pass collapsed them by refusing
    // خارج الأرفف any drop at all — which left no way to unfile a book by dragging.
    const v = view(base);
    const loose = v.children.find((x) => x.kind === "unshelved")!;
    expect(loose.drop).toEqual({ shelfId: LOOSE_SHELF_ID, categoryId: null });
    expect(loose.dropKind).toBe("unfile");
    // Nothing on the stage claims to FILE into it.
    expect(v.children.filter((x) => x.dropKind === "file").map((x) => x.kind)).not.toContain("unshelved");
  });

  it("gives the unshelved container the room to show itself, whatever it holds", () => {
    const v = view({
      ...base,
      rendered: [{ node: null, shelves: [runs(makeLooseShelf("خارج الأرفف", 1), [book("z")])] }],
      allCases: [],
    });
    expect(v.children[0].wide).toBe(true);
  });

  it("keeps a case the reader made and never filled, but drops one a SEARCH emptied", () => {
    const empty = kase("c-empty", []);
    const kept = view({ ...base, allCases: [c1, empty], filtered: false });
    expect(kept.cases.map((x) => x.key)).toContain("c-empty");
    const searched = view({ ...base, allCases: [c1, empty], filtered: true });
    expect(searched.cases.map((x) => x.key)).not.toContain("c-empty");
  });

  it("marks a computed shelf as one, and takes no drop on it", () => {
    const rule = shelf("s-rule", { name: "أقرأ الآن", auto_rule: "reading", count: 2 });
    const v = view({
      rendered: [{ node: null, shelves: [runs(rule, [book("a"), book("b")])] }],
      shelfBooks: () => [book("a"), book("b")],
    });
    expect(v.children[0].kind).toBe("rule");
    expect(v.children[0].drop).toBeNull();
  });
});

describe("two shelves of the same name, in two different cases", () => {
  const ar1 = shelf("ar-1", { name: "العربية", case_id: "novels", count: 6 });
  const ar2 = shelf("ar-2", { name: "العربية", case_id: "refs", count: 5 });
  const novels = kase("novels", [ar1], "#C08A3E");
  const refs = kase("refs", [ar2], "#4E8C7A");

  const inCase = (id: string, node: CaseNode, s: ShelfNode) =>
    view({
      allCases: [novels, refs],
      rendered: [{ node, shelves: [runs(s, [book(id + "-a")])] }],
      shelfBooks: () => [book(id + "-a")],
      scope: { caseId: id, shelfId: null, categoryId: null },
    });

  it("keeps their identities apart by KEY, never by decorating the name", () => {
    const a = inCase("novels", novels, ar1);
    const b = inCase("refs", refs, ar2);
    expect(a.children[0].key).not.toBe(b.children[0].key);
    // The name is the reader's, untouched — no "الروايات · العربية" prefix anywhere.
    expect(a.children[0].name).toBe("العربية");
    expect(b.children[0].name).toBe("العربية");
  });

  it("hands the stage the OWNING case's ink at every depth, which is what tells them apart", () => {
    expect(inCase("novels", novels, ar1).caseInk).toBe("#C08A3E");
    expect(inCase("refs", refs, ar2).caseInk).toBe("#4E8C7A");

    const deeper = view({
      allCases: [novels, refs],
      rendered: [{ node: refs, shelves: [runs(ar2, [book("x")])] }],
      shelfBooks: () => [book("x")],
      scope: { caseId: "refs", shelfId: "ar-2", categoryId: null },
    });
    expect(deeper.here?.name).toBe("العربية");
    expect(deeper.caseInk).toBe("#4E8C7A");
  });

  it("carries no ink at the root, where no case owns the stage", () => {
    expect(view({ allCases: [novels, refs] }).caseInk).toBeNull();
  });
});

describe("inside a shelf", () => {
  const withCats = shelf("s1", {
    name: "test1",
    case_id: "c1",
    count: 7,
    categories: [
      { id: "cat-1", name: "روايات" },
      { id: "cat-empty", name: "مسرح" },
    ] as ShelfNode["categories"],
  });
  const grouped: ShelfRuns = {
    shelf: withCats,
    groups: [
      { categoryId: "cat-1", name: "روايات", books: [book("a"), book("b")] },
      { categoryId: "cat-empty", name: "مسرح", books: [] },
      { categoryId: null, name: null, books: [book("c")] },
    ],
  };
  const at = (scope: { caseId: string | null; shelfId: string | null; categoryId: string | null }) =>
    view({
      allCases: [kase("c1", [withCats], "#9b3b98")],
      rendered: [{ node: kase("c1", [withCats], "#9b3b98"), shelves: [grouped] }],
      shelfBooks: () => [book("a"), book("b"), book("c")],
      scope,
    });

  it("shows categories as trays, including the one with nothing in it", () => {
    const v = at({ caseId: "c1", shelfId: "s1", categoryId: null });
    expect(v.children.map((x) => x.kind)).toEqual(["category", "category", "category"]);
    expect(v.children[1].total).toBe(0);
    expect(v.books).toEqual([]);
  });

  it("gives the uncategorised run no name of its own, so the view can mark it as an absence", () => {
    const v = at({ caseId: "c1", shelfId: "s1", categoryId: null });
    const loose = v.children[v.children.length - 1];
    expect(loose.name).toBe("");
    expect(loose.enter).toEqual({ caseId: "c1", shelfId: "s1", categoryId: null });
  });

  it("shows the books themselves when the shelf has no categories at all", () => {
    const plain = shelf("s2", { name: "To read", count: 2 });
    const v = view({
      rendered: [{ node: null, shelves: [runs(plain, [book("a"), book("b")])] }],
      shelfBooks: () => [book("a"), book("b")],
      scope: { caseId: null, shelfId: "s2", categoryId: null },
    });
    expect(v.children).toEqual([]);
    expect(v.books.map((b) => b.id)).toEqual(["a", "b"]);
    expect(v.bookDrop).toEqual({ shelfId: "s2", categoryId: null });
  });

  it("reports an empty category as empty rather than as a shelf that lost its books", () => {
    const v = at({ caseId: "c1", shelfId: "s1", categoryId: "cat-empty" });
    expect(v.here).toEqual({ kind: "category", name: "مسرح", ink: null, books: 0, children: 0 });
    expect(v.books).toEqual([]);
    expect(v.children).toEqual([]);
  });

  it("takes no drop inside a shelf that fills itself", () => {
    // A lens owns nothing — its contents are a query — so there is no position in it to offer.
    const rule = shelf("s-rule", { name: "أقرأ الآن", auto_rule: "reading", count: 1 });
    const v = view({
      rendered: [{ node: null, shelves: [runs(rule, [book("a")])] }],
      shelfBooks: () => [book("a")],
      scope: { caseId: null, shelfId: "s-rule", categoryId: null },
    });
    expect(v.bookDrop).toBeNull();
  });

  it("DOES take a drop inside the books on no shelf", () => {
    // This asserted the opposite, from a time when that run was synthesised for each render and
    // had nowhere to write an order to. It is an ordinary container now, and refusing it here was
    // the whole of «Vista shows my unshelved books and offers nowhere to put them»: the canonical
    // places existed — forty-two of them on the reader's library, one end, all distinct — and the
    // projection threw them away before Vista could draw a single one.
    const loose = makeLooseShelf("خارج الأرفف", 1);
    const u = view({
      rendered: [{ node: null, shelves: [runs(loose, [book("a")])] }],
      scope: { caseId: UNFILED_CASE_ID, shelfId: LOOSE_SHELF_ID, categoryId: null },
    });
    expect(u.bookDrop).toEqual({ shelfId: LOOSE_SHELF_ID, categoryId: null });
    expect(u.books.map((b) => b.id)).toEqual(["a"]);
  });
});

describe("a book on more than one shelf", () => {
  const s1 = shelf("s1", { name: "العربية", case_id: "c1", count: 2 });
  const s2 = shelf("s2", { name: "To read", case_id: "c1", count: 2 });
  const shared = book("shared");
  const c1 = kase("c1", [s1, s2]);

  it("appears on both shelves, because it is on both", () => {
    const v = view({
      allCases: [c1],
      rendered: [{ node: c1, shelves: [runs(s1, [shared, book("x")]), runs(s2, [shared, book("y")])] }],
      shelfBooks: (s) => (s.id === "s1" ? [shared, book("x")] : [shared, book("y")]),
      scope: { caseId: "c1", shelfId: null, categoryId: null },
    });
    expect(v.children.map((x) => x.total)).toEqual([2, 2]);
  });

  it("is counted ONCE by the case that holds both shelves", () => {
    // A case's line promises distinct books; summing its shelves would say four where there are
    // three, and a count that disagrees with what opening the case shows is a lie.
    const v = view({
      allCases: [c1],
      rendered: [{ node: c1, shelves: [runs(s1, [shared, book("x")]), runs(s2, [shared, book("y")])] }],
      shelfBooks: (s) => (s.id === "s1" ? [shared, book("x")] : [shared, book("y")]),
    });
    expect(v.cases[0].total).toBe(3);
  });
});

describe("a case's two numbers", () => {
  // A case can SHOW books it does not HOLD. A rule shelf inside it fills itself, and its books
  // carry no membership in the case, so the library counts none of them. Measured on the real
  // library: the sidebar, Covers and Spines all said «Test 0» while Vista said 19 — one case,
  // two numbers, and nothing on screen saying why.
  //
  // Both are kept. `total` is what the shelves show, and drives the sample and its "+n"; `filed`
  // is what the library counts, and is what the plate states. Vista names the difference.
  const ruleShelf = shelf("s-rule", { name: "قيد القراءة", case_id: "k", auto_rule: "reading", count: 3 });
  const handShelf = shelf("s-hand", { name: "test1", case_id: "k", count: 0 });
  const computed = [book("r1"), book("r2"), book("r3")];

  const rootWith = (caseCount: number) => {
    const node: CaseNode = { id: "k", name: "Test", ink: null, count: caseCount,
      shelves: [handShelf, ruleShelf] };
    return view({
      rendered: [{ node, shelves: [runs(handShelf, []), runs(ruleShelf, computed)] }],
      allCases: [node],
      shelfBooks: (sh) => (sh.id === "s-rule" ? computed : []),
    });
  };

  it("states what is FILED, not what merely shows through", () => {
    const c = rootWith(0).cases[0];
    expect(c.filed).toBe(0);
    expect(c.total).toBe(3);
  });

  it("still shows the covers, which is exactly what needs explaining", () => {
    // A plate with no covers would hide the discrepancy instead of stating it.
    expect(rootWith(0).cases[0].books.map((b) => b.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("says nothing extra when the two agree", () => {
    // The ordinary case: every book on the case's shelves is filed there. `filed === total`, so
    // the surface has no difference to name and reads exactly as it always did.
    const c = rootWith(3).cases[0];
    expect(c.filed).toBe(3);
    expect(c.total).toBe(3);
  });

  it("carries the same pair into the case's own heading", () => {
    const node: CaseNode = { id: "k", name: "Test", ink: null, count: 0, shelves: [handShelf, ruleShelf] };
    const v = view({
      rendered: [{ node, shelves: [runs(handShelf, []), runs(ruleShelf, computed)] }],
      allCases: [node],
      scope: { caseId: "k", shelfId: null, categoryId: null },
      shelfBooks: (sh) => (sh.id === "s-rule" ? computed : []),
    });
    expect(v.here).toMatchObject({ kind: "case", books: 3, filed: 0 });
  });

  it("never claims a shelf has a filed count of its own", () => {
    // The distinction belongs to cases alone: a shelf's count is its own, computed or not.
    const c = rootWith(0);
    for (const child of c.cases) expect(typeof child.filed).toBe("number");
    const inside = view({
      rendered: [{ node: { id: "k", name: "Test", ink: null, count: 0, shelves: [ruleShelf] },
        shelves: [runs(ruleShelf, computed)] }],
      allCases: [{ id: "k", name: "Test", ink: null, count: 0, shelves: [ruleShelf] }],
      scope: { caseId: "k", shelfId: null, categoryId: null },
      shelfBooks: () => computed,
    });
    expect(inside.children[0].filed).toBeUndefined();
  });
});
