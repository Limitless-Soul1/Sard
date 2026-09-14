// Library navigation: where the reader is, and how they get back.
//
// The reported problem was that "Library" did not mean the library — once a case had been opened
// it stayed opened, so the root button returned to the last case instead of to everything. That
// half is a transition (going to a section goes to its ROOT) and lives in the surface. This file
// pins down the other half: a scope must always name somewhere that still exists, or the pane
// filters against a ghost and renders empty for no visible reason.

import { describe, it, expect } from "vitest";
import type { CaseNode, ShelfNode } from "../../src/lib/ipc";
import {
  isLibraryTree,
  isRootScope,
  isUnfiledScope,
  LOOSE_SHELF_ID,
  closedGroups,
  openGroups,
  reconcileScope,
  ROOT_SCOPE,
  UNFILED_CASE_ID,
  UNFILED_SCOPE,
} from "../../src/features/library/design/model";

const shelf = (id: string, case_id: string | null = null): ShelfNode => ({
  id,
  name: id,
  ink: null,
  case_id,
  order_rule: "hand",
  auto_rule: null,
  collapsed: false,
  count: 0,
  categories: [],
});

const kase = (id: string, shelves: ShelfNode[]): CaseNode => ({
  id,
  name: id,
  ink: null,
  count: 0,
  shelves,
});

describe("the library's navigation state", () => {
  it("treats both-null as the root, and nothing else", () => {
    expect(isRootScope(ROOT_SCOPE)).toBe(true);
    expect(isRootScope({ caseId: "a", shelfId: null, categoryId: null })).toBe(false);
    expect(isRootScope({ caseId: null, shelfId: "s", categoryId: null })).toBe(false);
  });

  it("leaves a valid case scope alone", () => {
    const cases = [kase("a", [shelf("s1", "a")])];
    const s = { caseId: "a", shelfId: null, categoryId: null };
    expect(reconcileScope(s, cases, [])).toBe(s);
  });

  it("leaves a valid shelf scope alone", () => {
    const cases = [kase("a", [shelf("s1", "a")])];
    const s = { caseId: "a", shelfId: "s1", categoryId: null };
    expect(reconcileScope(s, cases, [])).toBe(s);
  });

  it("returns to the ROOT when the focused case is deleted", () => {
    // The reported empty library: the filter kept naming a case that had gone, so nothing matched
    // and the pane went blank while the breadcrumb still said "Library".
    expect(reconcileScope({ caseId: "gone", shelfId: null, categoryId: null }, [], [])).toEqual(ROOT_SCOPE);
  });

  it("falls back to the case when the focused shelf is deleted", () => {
    // One step up, not all the way out — the case the reader was working in still exists.
    const cases = [kase("a", [])];
    expect(reconcileScope({ caseId: "a", shelfId: "gone", categoryId: null }, cases, [])).toEqual({
      caseId: "a",
      shelfId: null,
      categoryId: null,
    });
  });

  it("returns to the root when both the shelf and its case are gone", () => {
    expect(reconcileScope({ caseId: "gone", shelfId: "alsoGone", categoryId: null }, [], [])).toEqual(ROOT_SCOPE);
  });

  it("FOLLOWS a shelf that has been filed into another case", () => {
    // Otherwise the case and the shelf disagree: the pane shows case A while displaying a shelf
    // that now lives in case B, and the sidebar highlights two unrelated rows.
    const cases = [kase("a", []), kase("b", [shelf("s1", "b")])];
    expect(reconcileScope({ caseId: "a", shelfId: "s1", categoryId: null }, cases, [])).toEqual({
      caseId: "b",
      shelfId: "s1",
      categoryId: null,
    });
  });

  it("follows a shelf that has been moved OUT of every case", () => {
    // Its parent becomes "not in a case" — a place, not the root and not a case.
    const cases = [kase("a", [])];
    expect(reconcileScope({ caseId: "a", shelfId: "s1", categoryId: null }, cases, [shelf("s1")])).toEqual({
      caseId: UNFILED_CASE_ID,
      shelfId: "s1",
      categoryId: null,
    });
  });

  it("names the unfiled group as a loose shelf's parent, rather than leaving it orphaned", () => {
    // Reached from the root, a loose shelf used to report no parent at all, so the breadcrumb
    // read Library › Shelf and skipped the group the shelf actually sits in.
    expect(reconcileScope({ caseId: null, shelfId: "s1", categoryId: null }, [], [shelf("s1")])).toEqual({
      caseId: UNFILED_CASE_ID,
      shelfId: "s1",
      categoryId: null,
    });
  });

  it("never discards the unshelved run, which no tree can vouch for", () => {
    // It is a render-time set, not a row, so looking it up in the tree would always fail and
    // reconciling would throw the reader out of a place they legitimately stand in.
    const s = { caseId: null, shelfId: LOOSE_SHELF_ID, categoryId: null };
    expect(reconcileScope(s, [], [])).toBe(s);
  });

  it("drops a stale case while the reader is in the unshelved run", () => {
    expect(reconcileScope({ caseId: "gone", shelfId: LOOSE_SHELF_ID, categoryId: null }, [], [])).toEqual({
      caseId: null,
      shelfId: LOOSE_SHELF_ID,
      categoryId: null,
    });
  });

  it("is idempotent — reconciling a reconciled scope changes nothing", () => {
    const cases = [kase("b", [shelf("s1", "b")])];
    const once = reconcileScope({ caseId: "a", shelfId: "s1", categoryId: null }, cases, []);
    expect(reconcileScope(once, cases, [])).toEqual(once);
  });

  it("costs nothing at the root, whatever the tree looks like", () => {
    expect(reconcileScope(ROOT_SCOPE, [kase("a", [shelf("s1", "a")])], [shelf("s2")])).toBe(ROOT_SCOPE);
  });
});

describe('"not in a case" as a place to stand', () => {
  it("is a scope of its own, distinct from the root", () => {
    // Root means everything; this means everything WITHOUT a case. They are different answers.
    expect(isUnfiledScope(UNFILED_SCOPE)).toBe(true);
    expect(isUnfiledScope(ROOT_SCOPE)).toBe(false);
    expect(isRootScope(UNFILED_SCOPE)).toBe(false);
  });

  it("survives reconciling, because no tree can vouch for it", () => {
    // It names no row. Looking it up among the cases would always fail and throw the reader out.
    const cases = [kase("a", [shelf("s1", "a")])];
    expect(reconcileScope(UNFILED_SCOPE, cases, [])).toBe(UNFILED_SCOPE);
    expect(reconcileScope(UNFILED_SCOPE, [], [])).toBe(UNFILED_SCOPE);
  });

  it("is the parent of a loose shelf, so opening one keeps the context", () => {
    const s = { caseId: UNFILED_CASE_ID, shelfId: "s1", categoryId: null };
    expect(reconcileScope(s, [], [shelf("s1")])).toBe(s);
  });

  it("adopts a shelf that has been taken OUT of a case", () => {
    // Move the shelf you are looking at out of its case and the breadcrumb follows it here,
    // rather than going on naming a case that no longer holds it.
    expect(reconcileScope({ caseId: "a", shelfId: "s1", categoryId: null }, [kase("a", [])], [shelf("s1")])).toEqual({
      caseId: UNFILED_CASE_ID,
      shelfId: "s1",
      categoryId: null,
    });
  });

  it("hands a shelf over when it is filed INTO a case", () => {
    expect(reconcileScope({ caseId: UNFILED_CASE_ID, shelfId: "s1", categoryId: null }, [kase("b", [shelf("s1", "b")])], [])).toEqual({
      caseId: "b",
      shelfId: "s1",
      categoryId: null,
    });
  });

  it("stays in the group when a loose shelf is deleted, rather than falling to the root", () => {
    expect(reconcileScope({ caseId: UNFILED_CASE_ID, shelfId: "gone", categoryId: null }, [], [])).toEqual({
      caseId: UNFILED_CASE_ID,
      shelfId: null,
      categoryId: null,
    });
  });

  it("uses the id the rest of the library already uses for this concept", () => {
    // One name for one thing: the open set, the management panel and the scope all agree.
    expect(UNFILED_SCOPE.caseId).toBe(UNFILED_CASE_ID);
  });

  it("is not an id any real case could have", () => {
    // Nothing writes it to `collections.case_id`; the sentinel is deliberately not a row id.
    expect(UNFILED_CASE_ID.startsWith("__")).toBe(true);
  });
});

describe("which groups are open", () => {
  it("opens a case that has never been closed", () => {
    // The reported symptom: a case created after the first load belonged to no set and drew
    // collapsed, so "New shelf" from its own menu had nowhere to put its input.
    expect(openGroups(["a", "b"], new Set())).toEqual(new Set(["a", "b", UNFILED_CASE_ID]));
  });

  it("keeps a case the reader deliberately closed", () => {
    expect(openGroups(["a", "b"], new Set(["a"]))).toEqual(new Set(["b", UNFILED_CASE_ID]));
  });

  it("opens a NEW case even while others are closed", () => {
    const closed = new Set(["old"]);
    expect(openGroups(["old", "brandNew"], closed).has("brandNew")).toBe(true);
    expect(openGroups(["old", "brandNew"], closed).has("old")).toBe(false);
  });

  it("treats the unfiled group exactly like a case", () => {
    expect(openGroups([], new Set()).has(UNFILED_CASE_ID)).toBe(true);
    expect(openGroups([], new Set([UNFILED_CASE_ID])).has(UNFILED_CASE_ID)).toBe(false);
  });

  it("is idempotent, so repeated loads do not flap", () => {
    const closed = new Set(["a"]);
    const once = openGroups(["a", "b"], closed);
    expect(openGroups(["a", "b"], closed)).toEqual(once);
  });
});

describe("which groups are stored as closed", () => {
  it("round-trips: what openGroups opened is not written back as closed", () => {
    const stored = ["a"];
    const ids = ["a", "b", "c"];
    const open = openGroups(ids, new Set(stored));
    expect(closedGroups(ids, open).sort()).toEqual(stored.sort());
  });

  it("stores nothing when nothing is closed", () => {
    const ids = ["a", "b"];
    expect(closedGroups(ids, openGroups(ids, new Set()))).toEqual([]);
  });

  it("does NOT record a case the open set predates", () => {
    // The measured bug: `write()` set the tree alone, so this effect ran with a tree carrying a
    // case the open set was computed before. It read that pair as a deliberate collapse and stored
    // it, and the brand-new case came up folded — with no shelf list, so "New shelf" did nothing.
    // Reconciling the pair in one batch is what makes this hold.
    const before = ["a"];
    const after = ["a", "fresh"];
    const stale = openGroups(before, new Set());
    expect(closedGroups(after, stale)).toContain("fresh"); // what the bug did
    const reconciled = openGroups(after, new Set());
    expect(closedGroups(after, reconciled)).toEqual([]); // what applyTree guarantees
  });

  it("keeps the unfiled group in the record like any case", () => {
    expect(closedGroups(["a"], new Set(["a"]))).toEqual([UNFILED_CASE_ID]);
  });

  it("drops a deleted case from the record rather than carrying it forever", () => {
    const open = openGroups(["a", "b"], new Set(["a", "gone"]));
    expect(closedGroups(["a", "b"], open)).toEqual(["a"]);
  });
});

describe("what may be accepted as the structure", () => {
  it("accepts a tree, including an empty one", () => {
    expect(isLibraryTree({ cases: [], loose: [] })).toBe(true);
    expect(isLibraryTree({ cases: [kase("a", [shelf("s1", "a")])], loose: [shelf("s2")] })).toBe(true);
  });

  it("REJECTS the collection rows one rename command answers with", () => {
    // The measured crash: `collection_rename` answers with the rows, not the tree, and a cast let
    // that array reach the code that reads `.cases`. `[].cases` is undefined, `.map` of undefined
    // throws during render, and the window went blank — empty root, no sidebar, no message.
    expect(isLibraryTree([{ id: "s1", name: "Shelf" }])).toBe(false);
    expect(isLibraryTree([])).toBe(false);
  });

  it("rejects nothing at all, rather than letting it through as an empty library", () => {
    expect(isLibraryTree(undefined)).toBe(false);
    expect(isLibraryTree(null)).toBe(false);
  });

  it("rejects a half tree, which would render one side and lose the other", () => {
    expect(isLibraryTree({ cases: [] })).toBe(false);
    expect(isLibraryTree({ loose: [] })).toBe(false);
    expect(isLibraryTree({ cases: [], loose: "no" })).toBe(false);
  });

  it("rejects a string, which is what an error message arrives as", () => {
    expect(isLibraryTree("that category belongs to a different shelf")).toBe(false);
    expect(isLibraryTree(42)).toBe(false);
  });
});
