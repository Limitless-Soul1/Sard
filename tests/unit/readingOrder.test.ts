import { describe, expect, it } from "vitest";

import {
  applyRunOrder,
  baselineBySection,
  promoteRecent,
} from "../../src/features/library/design/viewOrder";

/**
 * READING-AWARE ORDER — the reader's arrangement, with what they have since read in front of it.
 *
 * Every case below is one the owner specified in prose, transcribed. The two that matter most are
 * the pair that PROVE the baseline cannot be dropped: same manual shape, same set of read books,
 * two different correct answers, told apart only by whether the reading happened before or after
 * the hand last arranged the run.
 */

type B = { id: string; read_at: number | null };
const run = (ids: string, reads: Record<string, number> = {}): B[] =>
  ids.split(" ").map((id) => ({ id, read_at: reads[id] ?? null }));
const ids = (bs: { id: string }[]) => bs.map((b) => b.id).join(" ");

describe("reading-aware order", () => {
  it("promotes every book read since the run was arranged, newest first", () => {
    // Arranged A B C D E at t=100. Then C read, then E, then B.
    const books = run("A B C D E", { C: 110, E: 120, B: 130 });
    expect(ids(promoteRecent(books, 100))).toBe("B E C A D");
  });

  it("promotes only what was read AFTER the hand last arranged the run", () => {
    // The same books, read FIRST and then hand-arranged to D B A E C at t=200; only E read after.
    // If the baseline were ignored, B and C would float too and the reader's arrangement would be
    // undone by their own history. This is the case that makes the stamp necessary.
    const books = run("D B A E C", { B: 130, C: 110, E: 210 });
    expect(ids(promoteRecent(books, 200))).toBe("E D B A C");
  });

  it("walks the owner's whole sequence one read at a time", () => {
    const reads: Record<string, number> = {};
    const at = 100;
    const show = () => ids(promoteRecent(run("A B C D E", reads), at));
    expect(show()).toBe("A B C D E"); // nothing read yet
    reads.C = 110;
    expect(show()).toBe("C A B D E");
    reads.E = 120;
    expect(show()).toBe("E C A B D");
    reads.B = 130;
    expect(show()).toBe("B E C A D");
  });

  it("leaves the relative order of everything else exactly as it was", () => {
    const books = run("A B C D E F G", { D: 500 });
    const after = promoteRecent(books, 100).map((b) => b.id);
    expect(after).toEqual(["D", "A", "B", "C", "E", "F", "G"]);
    // The untouched tail is the original sequence with the promoted book removed — nothing else moved.
    expect(after.slice(1)).toEqual(["A", "B", "C", "E", "F", "G"]);
  });

  it("never duplicates a book, however often it is read", () => {
    const books = run("A B C D", { C: 300 });
    expect(ids(promoteRecent(books, 100))).toBe("C A B D");
    // Read again: a later timestamp, still one row, still one place in the run.
    const again = run("A B C D", { C: 900 });
    const out = promoteRecent(again, 100);
    expect(ids(out)).toBe("C A B D");
    expect(new Set(out.map((b) => b.id)).size).toBe(out.length);
  });

  it("never promotes a book that has never been read", () => {
    const books = run("A B C", {});
    expect(ids(promoteRecent(books, 0))).toBe("A B C");
    // A freshly imported book has no recency and simply keeps its place in the arrangement.
    const withNew = run("A NEW B", { A: 500 });
    expect(ids(promoteRecent(withNew, 100))).toBe("A NEW B");
  });

  it("promotes nothing when every read predates the arrangement", () => {
    const books = run("C A B", { A: 10, B: 20, C: 30 });
    expect(ids(promoteRecent(books, 100))).toBe("C A B");
  });

  it("orders the promoted group by recency and not by the run", () => {
    const books = run("A B C", { A: 300, B: 100, C: 200 });
    expect(ids(promoteRecent(books, 50))).toBe("A C B");
  });

  it("keeps the five formats independent — the projection is per run", () => {
    // Grid holds A B C D, Covers holds D C B A, both arranged at t=100. B is read at t=200.
    const grid = run("A B C D", { B: 200 });
    const covers = run("D C B A", { B: 200 });
    expect(ids(promoteRecent(grid, 100))).toBe("B A C D");
    expect(ids(promoteRecent(covers, 100))).toBe("B D C A");
  });

  it("composes with the saved order: arrangement first, promotion over it", () => {
    // The run arrives in arrival order; the saved arrangement is D C B A; E was read after.
    const books = run("A B C D E", { E: 500 });
    const arranged = applyRunOrder(books, ["D", "C", "B", "A"]);
    expect(ids(arranged)).toBe("D C B A E");
    expect(ids(promoteRecent(arranged, 100))).toBe("E D C B A");
  });

  it("reads one baseline per section off the rows that carry it", () => {
    const m = baselineBySection([
      { section: "*", arranged_at: 700 },
      { section: "*", arranged_at: 700 },
      { section: "shelf-1", arranged_at: 900 },
    ]);
    expect(m.get("*")).toBe(700);
    expect(m.get("shelf-1")).toBe(900);
    // A section with no rows has never been arranged and is absent, so the caller falls back to
    // the library-wide epoch rather than to zero.
    expect(m.has("shelf-2")).toBe(false);
  });

  it("does not mutate the run it is given", () => {
    const books = run("A B C", { C: 500 });
    const copy = books.map((b) => b.id);
    promoteRecent(books, 100);
    expect(books.map((b) => b.id)).toEqual(copy);
  });
});
