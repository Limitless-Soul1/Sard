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
  isRootScope,
  LOOSE_SHELF_ID,
  reconcileScope,
  ROOT_SCOPE,
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
    expect(isRootScope({ caseId: "a", shelfId: null })).toBe(false);
    expect(isRootScope({ caseId: null, shelfId: "s" })).toBe(false);
  });

  it("leaves a valid case scope alone", () => {
    const cases = [kase("a", [shelf("s1", "a")])];
    const s = { caseId: "a", shelfId: null };
    expect(reconcileScope(s, cases, [])).toBe(s);
  });

  it("leaves a valid shelf scope alone", () => {
    const cases = [kase("a", [shelf("s1", "a")])];
    const s = { caseId: "a", shelfId: "s1" };
    expect(reconcileScope(s, cases, [])).toBe(s);
  });

  it("returns to the ROOT when the focused case is deleted", () => {
    // The reported empty library: the filter kept naming a case that had gone, so nothing matched
    // and the pane went blank while the breadcrumb still said "Library".
    expect(reconcileScope({ caseId: "gone", shelfId: null }, [], [])).toEqual(ROOT_SCOPE);
  });

  it("falls back to the case when the focused shelf is deleted", () => {
    // One step up, not all the way out — the case the reader was working in still exists.
    const cases = [kase("a", [])];
    expect(reconcileScope({ caseId: "a", shelfId: "gone" }, cases, [])).toEqual({
      caseId: "a",
      shelfId: null,
    });
  });

  it("returns to the root when both the shelf and its case are gone", () => {
    expect(reconcileScope({ caseId: "gone", shelfId: "alsoGone" }, [], [])).toEqual(ROOT_SCOPE);
  });

  it("FOLLOWS a shelf that has been filed into another case", () => {
    // Otherwise the case and the shelf disagree: the pane shows case A while displaying a shelf
    // that now lives in case B, and the sidebar highlights two unrelated rows.
    const cases = [kase("a", []), kase("b", [shelf("s1", "b")])];
    expect(reconcileScope({ caseId: "a", shelfId: "s1" }, cases, [])).toEqual({
      caseId: "b",
      shelfId: "s1",
    });
  });

  it("follows a shelf that has been moved OUT of every case", () => {
    const cases = [kase("a", [])];
    expect(reconcileScope({ caseId: "a", shelfId: "s1" }, cases, [shelf("s1")])).toEqual({
      caseId: null,
      shelfId: "s1",
    });
  });

  it("keeps a loose shelf focused without inventing a case for it", () => {
    const s = { caseId: null, shelfId: "s1" };
    expect(reconcileScope(s, [], [shelf("s1")])).toBe(s);
  });

  it("never discards the unshelved run, which no tree can vouch for", () => {
    // It is a render-time set, not a row, so looking it up in the tree would always fail and
    // reconciling would throw the reader out of a place they legitimately stand in.
    const s = { caseId: null, shelfId: LOOSE_SHELF_ID };
    expect(reconcileScope(s, [], [])).toBe(s);
  });

  it("drops a stale case while the reader is in the unshelved run", () => {
    expect(reconcileScope({ caseId: "gone", shelfId: LOOSE_SHELF_ID }, [], [])).toEqual({
      caseId: null,
      shelfId: LOOSE_SHELF_ID,
    });
  });

  it("is idempotent — reconciling a reconciled scope changes nothing", () => {
    const cases = [kase("b", [shelf("s1", "b")])];
    const once = reconcileScope({ caseId: "a", shelfId: "s1" }, cases, []);
    expect(reconcileScope(once, cases, [])).toEqual(once);
  });

  it("costs nothing at the root, whatever the tree looks like", () => {
    expect(reconcileScope(ROOT_SCOPE, [kase("a", [shelf("s1", "a")])], [shelf("s2")])).toBe(ROOT_SCOPE);
  });
});
