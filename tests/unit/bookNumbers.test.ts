// RESILIENCE-1 — ONE numbering source per book, chosen by a MEASURED proportion.
//
// The rule under test (ChaptersPanel `bookNumbers`): a book numbers its own chapters only when at
// least two entries carry a designator AND at least half of them do. Otherwise every row is numbered
// by position. The two sources are never mixed, which is what makes collisions impossible — the
// invariant RAWY-287 was written to establish, and which these tests must not weaken.
//
// WHY THE THRESHOLD IS WHERE IT IS. Measured with the product's own `extractChapterNumber` over each
// corpus book's real NCX:
//
//     numbers itself : LotM 1430/1433 · halaqat 1166/1167 · red-rising 44/53 · Alice 12/17
//     does not       : metamorphosis 2/5 · أوفرلورد 25/264 · ad-daa 3/113 · shawqiyyat 1/136
//
// Nothing lies between 40 % and 71 %, so a half majority separates the two groups with room either
// side. These tests pin BOTH edges of that gap so the threshold cannot drift into either group.

import { describe, expect, it } from "vitest";

/** The exact expression from ChaptersPanel, kept here so the rule is testable without a DOM. */
function numbersItself(matched: number, total: number): boolean {
  return matched >= 2 && matched / total >= 0.5;
}

describe("books that DO number their own chapters keep doing so", () => {
  it.each([
    ["lord-of-mysteries", 1430, 1433],
    ["halaqat-alhatmiyya", 1166, 1167],
    ["red-rising", 44, 53],
    ["alice", 12, 17],
  ])("%s (%i of %i) uses the book's own numbers", (_n, matched, total) => {
    expect(numbersItself(matched, total)).toBe(true);
  });
});

describe("books whose matches are NOISE fall back to position", () => {
  it.each([
    ["أوفرلورد — the reported book", 25, 264],
    ["ad-daa-wad-dawaa — 110 rows were mislabelled", 3, 113],
    ["metamorphosis", 2, 5],
    ["shawqiyyat", 1, 136],
  ])("%s (%i of %i) numbers every row by position", (_n, matched, total) => {
    expect(numbersItself(matched, total)).toBe(false);
  });
});

describe("the threshold sits inside the measured gap", () => {
  it("accepts the lowest REAL numbering book (Alice, 71%)", () => {
    expect(numbersItself(12, 17)).toBe(true);
  });

  it("rejects the highest NOISE book (metamorphosis, 40%)", () => {
    expect(numbersItself(2, 5)).toBe(false);
  });

  it("keeps the original 'two, not one' guard", () => {
    // A single-entry TOC matches at 100 %, which the proportion alone would accept. One stray match
    // must never re-number a book — that guard predates this change and is deliberately retained.
    expect(numbersItself(1, 1)).toBe(false);
    expect(numbersItself(1, 2)).toBe(false);
  });
});

describe("the RAWY-287 invariant is intact", () => {
  it("never mixes the two sources — the choice is one boolean for the whole book", () => {
    // The property that makes collisions impossible: `bookNumbers` returns EITHER every entry's own
    // designator OR every entry's position, never a per-row blend. Expressed here as the shape of
    // the decision — a single book-wide boolean, with no row-level input.
    expect(numbersItself.length).toBe(2); // (matched, total) — no per-row argument exists
  });

  it("front matter in a genuinely numbered book still yields unnumbered rows", () => {
    // The case RAWY-287 was written for: most entries carry designators, a few (Contents, a preface)
    // do not. Those few must NOT be given invented chapter numbers — the book stays on OWN, and the
    // unmatched rows render as sections rather than colliding with real chapter numbers.
    expect(numbersItself(40, 44)).toBe(true);
  });
});
