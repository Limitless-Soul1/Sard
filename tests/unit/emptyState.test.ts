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

// ==================================================================================================
// A FORMAT THAT MATCHES NOTHING — the dead end
// ==================================================================================================
//
// REPRODUCED, then fixed. An EPUB-only library with «PDF» chosen showed zero books; `bare` removes
// search, sort, THE FORMAT FILTER, Select, arrange and the view tabs; so the control that made the
// choice was gone and the choice could not be undone. The format is React state with no settings row
// behind it, so there was no way back at all short of restarting Sard.
//
// The cause is one input: `totalBooks` is documented as the library's whole size, and the Library
// passes `props.books.length` — the list `libraryListBooks` has already filtered by format in SQL.
// A query was exempt from `bare` for exactly this reason; the format chooser is the same kind of
// thing and was simply never named.
describe("a filter that matched nothing is not an empty library", () => {
  it("keeps the toolbar, so the choice can be undone", () => {
    // The reported scenario: books in the library, none of the chosen format.
    expect(libraryIsBare({ query: "", totalBooks: 0, filtered: true })).toBe(false);
  });

  it("still puts the toolbar away for a library that really is empty", () => {
    // The state `bare` was written for must be untouched — a new reader still gets the calm screen.
    expect(libraryIsBare({ query: "", totalBooks: 0, filtered: false })).toBe(true);
    expect(libraryIsBare({ query: "", totalBooks: 0 })).toBe(true);
  });

  it("does not tell a reader with books that their library is waiting for them", () => {
    // «مكتبتك في انتظارك» is the welcome for someone who owns nothing. With a filter on, the count
    // is the filtered one and says zero, so this used to be the message a reader with thirty-nine
    // books was shown.
    expect(emptyKind({ query: "", totalBooks: 0, scoped: false, filtered: true })).toBe("search");
    expect(emptyKind({ query: "", totalBooks: 0, scoped: true, filtered: true })).toBe("search");
  });

  it("still welcomes a genuinely new reader", () => {
    expect(emptyKind({ query: "", totalBooks: 0, scoped: false, filtered: false })).toBe("library");
    expect(emptyKind({ query: "", totalBooks: 0, scoped: false })).toBe("library");
  });

  it("leaves every unfiltered answer exactly as it was", () => {
    // The parameter is optional and defaults to absent, so no existing call site changes meaning.
    for (const scoped of [true, false]) {
      for (const totalBooks of [0, 1, 44]) {
        for (const query of ["", "  ", "زرافة"]) {
          expect(emptyKind({ query, totalBooks, scoped }), `${query}/${totalBooks}/${scoped}`)
            .toBe(emptyKind({ query, totalBooks, scoped, filtered: false }));
          expect(libraryIsBare({ query, totalBooks }))
            .toBe(libraryIsBare({ query, totalBooks, filtered: false }));
        }
      }
    }
  });

  it("a search still wins over a filter, because the reader typed it", () => {
    // Ordered, not a set of conditions: someone who typed something is told about what they typed.
    expect(emptyKind({ query: "زرافة", totalBooks: 0, scoped: false, filtered: true })).toBe("search");
    expect(libraryIsBare({ query: "زرافة", totalBooks: 0, filtered: true })).toBe(false);
  });

  it("is format-agnostic — it is about a filter being on, not about which one", () => {
    // EPUB-only → PDF, and PDF-only → EPUB, are the same state as far as this rule is concerned.
    for (const _ of ["epub", "pdf", "djvu"]) {
      expect(libraryIsBare({ query: "", totalBooks: 0, filtered: true })).toBe(false);
    }
  });
});
