/**
 * WHICH KIND OF NOTHING THE LIBRARY IS SHOWING.
 *
 * There are three, and they mean entirely different things to a reader:
 *
 *   library   they have no books at all — this is a new reader, on their first screen
 *   shelf     they are standing in a shelf or a case that holds nothing yet
 *   search    they typed something and it matched nothing
 *
 * MEASURED BEFORE THIS EXISTED: the library drew the SEARCH message for all three. A reader who had
 * just installed Sard, typed nothing and owned no books was told «لا نتائج — لا شيء يطابق هذا
 * البحث. جرّب كلمة أقصر أو خزانة أخرى», under an unfinished grey square. The branch was
 * `flatBooks.length === 0` and nothing else, so it could not tell the three apart.
 *
 * The order below is the whole rule, and it is ORDERED rather than a set of conditions so the three
 * cannot overlap: a query is always a search first — a reader who typed something wants to know
 * about what they typed, whatever else is true — then the whole library, then where they stand.
 * `tests/unit/emptyState.test.ts` exercises every combination of the three inputs and asserts that
 * exactly one kind ever comes back.
 */
export type EmptyKind = "library" | "shelf" | "search";

export function emptyKind(state: {
  /** The search box's text, as typed. */
  query: string;
  /** How many books the library holds ALTOGETHER — not how many survive the current filters. */
  totalBooks: number;
  /** Whether the reader has walked into a case or a shelf. */
  scoped: boolean;
  /**
   * Whether a FILTER is narrowing the view — today that is the format chooser.
   *
   * `totalBooks` is documented above as the library's whole size, and the Library hands it the
   * FILTERED list, because `libraryListBooks` applies the format in SQL. So an EPUB-only library
   * with «PDF» chosen arrives here as `totalBooks: 0` and is told it is a brand-new library —
   * «مكتبتك في انتظارك» — while holding thirty-nine books.
   */
  filtered?: boolean;
}): EmptyKind {
  if (state.query.trim() !== "") return "search";
  // A FILTER THAT MATCHED NOTHING IS NOT AN EMPTY LIBRARY. It is the same kind of nothing a search
  // produces — a choice the reader made, which they can unmake — so it is answered the same way,
  // before the count is consulted at all. Without this the count is the filtered one and lies.
  if (state.filtered) return "search";
  if (state.totalBooks === 0) return "library";
  return state.scoped ? "shelf" : "search";
}

/**
 * Whether the library's toolbar has anything to operate on.
 *
 * Search, sort, the format filter, Select and Manual arrange all act on books. With none in the
 * library they are chrome for content that does not exist, and they crowd out the one thing a new
 * reader needs. They come back the moment a first book does — this is about an empty LIBRARY, never
 * about an empty shelf, where the reader plainly has books to move.
 *
 * NOT DISABLED, ABSENT. A row of greyed controls is a row of controls that says no; nothing at all
 * is calmer and says the same thing.
 */
/*
 * AND A FILTERED-EMPTY VIEW IS NOT A BARE LIBRARY EITHER — this is the dead end.
 *
 * `bare` removes search, sort, THE FORMAT FILTER, Select, arrange and the view tabs. The count it is
 * given is the filtered one, so choosing a format no book has emptied the list, emptied the toolbar,
 * and took away the one control that could undo the choice: an EPUB-only library set to «PDF» could
 * not be returned to «كل الصيغ» from the interface at all.
 *
 * A query was already exempt for exactly this reason — a reader who typed something must keep the
 * box they typed it in. The format chooser is the same kind of thing and was simply never named
 * here. Both now say: while something the reader chose is narrowing the view, the controls that
 * choice is made with stay.
 */
export const libraryIsBare = (state: { query: string; totalBooks: number; filtered?: boolean }): boolean =>
  state.totalBooks === 0 && state.query.trim() === "" && !state.filtered;
