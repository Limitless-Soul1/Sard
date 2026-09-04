// ASKING FOR A BOOK'S DETAILS, FROM ANYWHERE.
//
// `BookDetails` is Sard's one book-information sheet, and it is mounted inside the library's design
// surface — where every view that opens a book already reaches it. Anything OUTSIDE that surface used
// to have no way to say "show me this book", so it reached for the older `EditBook` dialog instead:
// that is how a second, superseded editor stayed alive after the design views had all moved on.
//
// This is the one line between them. A caller names a book id; the surface answers by opening the same
// sheet a reader gets from the ⋯ menu, and clears the request once it has. No second dialog, no
// duplicated save and delete handling, and one place to change if the sheet is ever replaced again.
import { create } from "zustand";

interface BookDetailsRequest {
  /** The book to show, by id. Null when nothing is waiting. */
  wanted: string | null;
  /** Ask the library to open this book's details. */
  ask: (bookId: string) => void;
  /** Called by whoever honoured it. */
  shown: () => void;
}

export const useBookDetailsRequest = create<BookDetailsRequest>((set) => ({
  wanted: null,
  ask: (bookId) => set({ wanted: bookId }),
  shown: () => set({ wanted: null }),
}));
