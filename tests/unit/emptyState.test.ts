// THE THREE KINDS OF NOTHING — and the proof that they cannot be confused for one another.
//
// The defect this replaces was not a wrong string, it was a missing distinction: one branch,
// `flatBooks.length === 0`, drew the search message for a reader who had never searched.

import { describe, expect, it } from "vitest";

import { emptyKind, libraryIsBare, type EmptyKind } from "../../src/features/library/design/emptyState";

const QUERIES = ["", "   ", "زرافة", "a"];
const TOTALS = [0, 1, 44];
const SCOPES = [false, true];

describe("which kind of empty the library is showing", () => {
  it("gives exactly one answer for every combination of the three inputs", () => {
    const seen = new Set<EmptyKind>();
    for (const query of QUERIES) {
      for (const totalBooks of TOTALS) {
        for (const scoped of SCOPES) {
          const k = emptyKind({ query, totalBooks, scoped });
          expect(["library", "shelf", "search"]).toContain(k);
          seen.add(k);
        }
      }
    }
    // and all three are actually reachable
    expect([...seen].sort()).toEqual(["library", "search", "shelf"]);
  });

  it("a reader who typed something is always told about what they typed", () => {
    for (const totalBooks of TOTALS) {
      for (const scoped of SCOPES) {
        expect(emptyKind({ query: "زرافة", totalBooks, scoped })).toBe("search");
      }
    }
  });

  it("a library with no books is a welcome, never a failed search", () => {
    expect(emptyKind({ query: "", totalBooks: 0, scoped: false })).toBe("library");
    expect(emptyKind({ query: "   ", totalBooks: 0, scoped: false })).toBe("library");
    // even standing inside a shelf: with no books anywhere, the thing to say is the welcome
    expect(emptyKind({ query: "", totalBooks: 0, scoped: true })).toBe("library");
  });

  it("an empty shelf in a library that has books is a shelf, not a search", () => {
    expect(emptyKind({ query: "", totalBooks: 44, scoped: true })).toBe("shelf");
    expect(emptyKind({ query: "  ", totalBooks: 1, scoped: true })).toBe("shelf");
  });

  it("whitespace is not a search", () => {
    expect(emptyKind({ query: "   ", totalBooks: 44, scoped: true })).toBe("shelf");
    expect(emptyKind({ query: "   ", totalBooks: 0, scoped: false })).toBe("library");
  });
});

describe("when the toolbar has nothing to operate on", () => {
  it("is bare only for a library with no books and no search", () => {
    expect(libraryIsBare({ query: "", totalBooks: 0 })).toBe(true);
    expect(libraryIsBare({ query: "  ", totalBooks: 0 })).toBe(true);
  });

  it("comes back the moment there is a book, or a search to clear", () => {
    expect(libraryIsBare({ query: "", totalBooks: 1 })).toBe(false);
    expect(libraryIsBare({ query: "زرافة", totalBooks: 0 })).toBe(false);
    expect(libraryIsBare({ query: "زرافة", totalBooks: 44 })).toBe(false);
  });

  it("is never bare where the empty state is a shelf — those readers have books to move", () => {
    for (const totalBooks of [1, 44]) {
      expect(libraryIsBare({ query: "", totalBooks })).toBe(false);
    }
  });
});
