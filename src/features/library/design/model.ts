// The library design's own arithmetic — sizes, grouping, ordering, search.
//
// Every number here is the design's, carried over rather than re-chosen: the four density
// steps, the fitted Vista width, the spine thickness curve, the progress thresholds. Where
// the design read a field Sard does not have, the substitution is named at the site.

import type { BookRow, CaseNode, ShelfItem, ShelfNode, ShelfOrder } from "../../../lib/ipc";

/** The five views. `grid` is Sard's original Library grid, kept alongside the four new ones. */
export type DesignView = "grid" | "covers" | "spines" | "details" | "vista";

export const DESIGN_VIEWS: DesignView[] = ["grid", "covers", "spines", "details", "vista"];

/** Covers and Spines share one renderer — the design draws both as cases → shelves → books. */
export const isGroupedView = (v: DesignView) => v === "covers" || v === "spines";

/** The design's four density steps, as authored. */
const DENSITY_WIDTHS = [92, 118, 148, 184];
export const DENSITY_STEPS = DENSITY_WIDTHS.length;

export const baseWidth = (density: number) =>
  DENSITY_WIDTHS[Math.max(0, Math.min(DENSITY_WIDTHS.length - 1, density))];

/**
 * Item width. Covers and Spines use the density step directly; Vista fits whole columns to
 * the pane so its shelves end flush, never with a clipped book at the edge.
 */
export function itemWidth(density: number, view: DesignView, paneWidth: number): number {
  const base = baseWidth(density);
  if (view !== "vista") return base;
  const avail = Math.max(320, (paneWidth || 1180) - 96);
  const n = Math.max(2, Math.floor((avail + 20) / (base + 20)));
  return Math.max(base, Math.floor((avail - (n - 1) * 22) / n));
}

/**
 * How thick a book stands in Spines.
 *
 * The design derived this from a page count. Sard has none — a book has no pages until it
 * has been opened and paginated at the reader's current type size — so the thickness comes
 * from the imported file's size, which is the library's only measure of a book's extent.
 * The curve is the design's: a 16..46px band, widening with density.
 */
export function spineWidth(book: BookRow, density: number): number {
  // ~1.4 KB per page is the median across the corpus of EPUBs Sard imports; the clamp below
  // means the constant only has to be the right order of magnitude.
  const pages = Math.max(40, Math.round((book.size_bytes ?? 400_000) / 1400));
  return Math.max(16, Math.min(46, Math.round(pages / 26) + 12 + density * 3));
}

export const progressPct = (b: BookRow) => Math.round((b.fraction ?? 0) * 100);
export const isFinished = (b: BookRow) => (b.fraction ?? 0) >= 0.995;
export const isStarted = (b: BookRow) => (b.fraction ?? 0) > 0.001;

/** The design's progress label: a percentage, "Finished", or an em dash. */
export function pctText(b: BookRow, finishedLabel: string): string {
  if (isFinished(b)) return finishedLabel;
  const p = progressPct(b);
  return p > 0 ? `${p}%` : "—";
}

/** Days since a unix-second timestamp, or null when there is none. */
export function daysAgo(at: number | null | undefined): number | null {
  if (!at) return null;
  return Math.max(0, Math.floor((Date.now() / 1000 - at) / 86400));
}

/**
 * Order a shelf's books.
 *
 * `hand` returns the list untouched — it is already in `book_collections.position` order,
 * which is the reader's own arrangement and the one thing a sort must never quietly discard.
 */
export function sortBooks(list: BookRow[], key: ShelfOrder): BookRow[] {
  if (key === "hand") return list;
  const out = list.slice();
  const cmp = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");
  switch (key) {
    case "title":
      out.sort((a, b) => cmp(a.title, b.title));
      break;
    case "author":
      out.sort((a, b) => cmp(a.author, b.author));
      break;
    case "added":
      out.sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0));
      break;
    case "recent":
      out.sort((a, b) => (b.read_at ?? 0) - (a.read_at ?? 0));
      break;
    case "progress":
      out.sort((a, b) => (b.fraction ?? 0) - (a.fraction ?? 0));
      break;
  }
  return out;
}

/** The toolbar's sort, which drives Details and the library-wide ordering. */
export type DesignSort = "recent" | "added" | "title" | "author" | "progress";
export const DESIGN_SORTS: DesignSort[] = ["recent", "added", "title", "author", "progress"];

/**
 * Does this book match the query?
 *
 * The design searches titles and authors. Case and shelf names are matched by the caller,
 * which knows the structure — a hit on a shelf name shows the whole shelf.
 */
export function bookMatches(b: BookRow, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    (b.title ?? "").toLowerCase().includes(needle) ||
    (b.author ?? "").toLowerCase().includes(needle)
  );
}

/** One run of books under an optional category heading, in the order the shelf gives. */
export interface BookGroup {
  /** null = the ungrouped run, which the design shows without a heading. */
  categoryId: string | null;
  name: string | null;
  books: BookRow[];
}

/**
 * Split a shelf's books into its category runs.
 *
 * Categories keep the shelf's declared order and come first; anything uncategorised falls
 * into a trailing unnamed run. A shelf with no categories yields exactly one unnamed run,
 * which is what makes the grouped renderer identical for both cases.
 */
export function groupShelf(shelf: ShelfNode, items: ShelfItem[], byId: Map<string, BookRow>): BookGroup[] {
  const ordered = items.map((i) => byId.get(i.book_id)).filter((b): b is BookRow => !!b);
  if (!shelf.categories.length) {
    return [{ categoryId: null, name: null, books: ordered }];
  }
  const catOf = new Map(items.map((i) => [i.book_id, i.category_id]));
  const groups: BookGroup[] = shelf.categories.map((c) => ({
    categoryId: c.id,
    name: c.name,
    books: [],
  }));
  const index = new Map(groups.map((g) => [g.categoryId, g]));
  const loose: BookRow[] = [];
  for (const b of ordered) {
    const cid = catOf.get(b.id) ?? null;
    const g = cid ? index.get(cid) : undefined;
    if (g) g.books.push(b);
    else loose.push(b);
  }
  if (loose.length) groups.push({ categoryId: null, name: null, books: loose });
  return groups.filter((g) => g.books.length > 0);
}

/** Every shelf in the tree, cases first then loose, as one flat list. */
export function allShelves(cases: CaseNode[], loose: ShelfNode[]): ShelfNode[] {
  return [...cases.flatMap((c) => c.shelves), ...loose];
}

/**
 * The synthetic shelf that holds books on no shelf at all.
 *
 * Without it the grouped views show only what has already been filed, so a library whose
 * books have never been put on a shelf renders as empty — which is what it did until this
 * was added. It is not a row in `collections`: it exists only for the duration of a render,
 * cannot be written to, and disappears as soon as every book has a home.
 */
export const LOOSE_SHELF_ID = "__unshelved";

export const isVirtualShelf = (id: string) => id === LOOSE_SHELF_ID;

export function unshelvedBooks(books: BookRow[], filed: Set<string>): BookRow[] {
  return books.filter((b) => !filed.has(b.id));
}

export function makeLooseShelf(name: string, count: number): ShelfNode {
  return {
    id: LOOSE_SHELF_ID,
    name,
    case_id: null,
    order_rule: "hand",
    auto_rule: null,
    collapsed: false,
    count,
    categories: [],
  };
}
