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
    ink: null,
    case_id: null,
    order_rule: "hand",
    auto_rule: null,
    collapsed: false,
    count,
    categories: [],
  };
}

/** The management panel's `caseNode` id when it is standing over the unfiled shelves. */
export const UNFILED_CASE_ID = "__unfiled";

/**
 * The synthesised case that lets the management panel stand over shelves belonging to no case.
 *
 * The count is DISTINCT books, matching what the backend reports for a real case: a book sitting
 * on two unfiled shelves is one book, not two. Summing the shelf counts is the mistake that once
 * had a 42-book library reporting 43.
 */
export function unfiledCase(name: string, loose: ShelfNode[], items: Record<string, ShelfItem[]>): CaseNode {
  const ids = new Set<string>();
  for (const s of loose) for (const i of items[s.id] ?? []) ids.add(i.book_id);
  return { id: UNFILED_CASE_ID, name, ink: null, count: ids.size, shelves: loose };
}

/**
 * What a manual placement actually has to do to the database.
 *
 * Arrange used to call `shelfPlaceBook(destination, …)` and stop there. That adds a membership
 * without removing the one the book came from, so dragging a book from shelf A to shelf B left it
 * on BOTH — a copy wearing the clothes of a move. `book_collections` is a many-to-many table and
 * the backend's placement only ever touches rows for the destination collection, so nothing
 * underneath was going to notice.
 *
 * The source is known at pick-up, so the decision is a pure one:
 *
 *   - the same shelf          → reorder in place; removing first would only delete and re-add
 *   - the unshelved run       → nothing to remove, because it is not a collection: it is the
 *                               render-time set of books that are on no shelf at all
 *   - anything else           → a real move: leave the source, join the destination
 *   - dropped on the unshelved run → leave the source and join nothing
 */
export type PlacementPlan =
  | { kind: "reorder"; shelfId: string }
  | { kind: "move"; shelfId: string; removeFrom: string }
  | { kind: "add"; shelfId: string }
  | { kind: "unshelve"; removeFrom: string }
  | { kind: "none" };

export function placementPlan(fromShelf: string, toShelf: string): PlacementPlan {
  if (isVirtualShelf(toShelf)) {
    // Dropping onto the unshelved run means "take this off its shelf". A book that was already
    // unshelved has nothing to leave.
    return isVirtualShelf(fromShelf) ? { kind: "none" } : { kind: "unshelve", removeFrom: fromShelf };
  }
  if (fromShelf === toShelf) return { kind: "reorder", shelfId: toShelf };
  if (isVirtualShelf(fromShelf)) return { kind: "add", shelfId: toShelf };
  return { kind: "move", shelfId: toShelf, removeFrom: fromShelf };
}

/**
 * Where a Select-mode move should take its books OUT of.
 *
 * "Move to…" used to only add: the destination gained the books and every source kept them, so a
 * move quietly became a copy. Fixing it by stripping every other membership would be worse —
 * `book_collections` is many-to-many on purpose and a book may legitimately sit on several
 * shelves, so a naive strip would destroy placements the reader made deliberately.
 *
 * The source therefore has to be derived from what the reader is actually working in, and the
 * answer is allowed to be "I cannot tell":
 *
 *   - `scoped`    — the pane is scoped to one shelf, so that shelf IS the context and the books
 *                   are being moved out of it.
 *   - `single`    — unscoped, but every selected book sits on exactly the same one shelf. There
 *                   is only one thing the move could mean.
 *   - `ambiguous` — the selection spans several shelves. Nothing is assumed; the caller must ask.
 *   - `none`      — nothing selected sits on any real shelf, so there is nothing to leave.
 */
export interface SelectionSource {
  kind: "scoped" | "single" | "ambiguous" | "none";
  /** The shelf to leave, when it is known beyond doubt. */
  shelfId: string | null;
  /** Every real shelf the selection currently occupies — what an "out of which?" chooser offers. */
  shelves: string[];
}

export function selectionSource(
  selected: ReadonlySet<string>,
  items: Record<string, ShelfItem[]>,
  scopedShelfId: string | null,
): SelectionSource {
  const occupied = new Set<string>();
  for (const [shelfId, list] of Object.entries(items)) {
    if (isVirtualShelf(shelfId)) continue; // not a collection; nothing to leave
    if (list.some((i) => selected.has(i.book_id))) occupied.add(shelfId);
  }
  const shelves = [...occupied].sort();

  // A scope is an explicit statement of context, so it wins — even over a selection that happens
  // to be unanimous, and even if some selected book is not on the scoped shelf at all (removing
  // it from a shelf it was never on is a no-op, not a wrong guess).
  if (scopedShelfId && !isVirtualShelf(scopedShelfId)) {
    return { kind: "scoped", shelfId: scopedShelfId, shelves };
  }
  if (shelves.length === 0) return { kind: "none", shelfId: null, shelves };
  if (shelves.length === 1) return { kind: "single", shelfId: shelves[0], shelves };
  return { kind: "ambiguous", shelfId: null, shelves };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Where in the library the reader is standing.
 *
 * Two fields and no more. `ROOT` — both null — is the whole library, and it is a real place, not
 * the absence of one: "Library" must mean the complete collection every time it is clicked, never
 * "the last case I happened to open".
 */
export interface NavScope {
  caseId: string | null;
  shelfId: string | null;
}

export const ROOT_SCOPE: NavScope = { caseId: null, shelfId: null };

export const isRootScope = (s: NavScope) => !s.caseId && !s.shelfId;

/**
 * Pull a scope back to somewhere that still exists.
 *
 * Deleting the case you are standing in used to leave its id in the scope: nothing matched the
 * filter, so the pane rendered empty while the breadcrumb said "Library" — an empty library with
 * no visible cause. A shelf moved into another case left the two halves disagreeing, which is the
 * same failure wearing a different hat.
 *
 * Reconciling against the tree, rather than remembering to clear the scope at each of the sites
 * that can invalidate it, is what makes that class of bug impossible instead of merely fixed.
 */
export function reconcileScope(scope: NavScope, cases: CaseNode[], loose: ShelfNode[]): NavScope {
  if (isRootScope(scope)) return scope;

  if (scope.shelfId && !isVirtualShelf(scope.shelfId)) {
    const inCase = cases.find((c) => c.shelves.some((s) => s.id === scope.shelfId));
    const isLoose = loose.some((s) => s.id === scope.shelfId);
    // The shelf is gone: stay in the case if that still exists, else go to the root.
    if (!inCase && !isLoose) {
      const caseStillThere = scope.caseId && cases.some((c) => c.id === scope.caseId);
      return { caseId: caseStillThere ? scope.caseId : null, shelfId: null };
    }
    // The shelf may have been filed into a different case — follow it rather than show a case
    // that no longer contains the shelf being displayed.
    const owner = inCase?.id ?? null;
    return owner === scope.caseId ? scope : { caseId: owner, shelfId: scope.shelfId };
  }

  if (scope.caseId && !cases.some((c) => c.id === scope.caseId)) {
    return { caseId: null, shelfId: scope.shelfId };
  }
  return scope;
}

/**
 * Where a vertically dragged row would land, given the rows' midpoints.
 *
 * The pointer is above a row's midpoint → it goes before that row; below the last midpoint → it
 * goes to the end. Expressed over midpoints rather than edges because that is what makes the
 * insertion bar track the pointer without flickering between two positions at a boundary.
 *
 * `from` is the row being carried. Removing it first and reinserting is what makes "drop just
 * below where I started" a no-op rather than an off-by-one — the reference does the same
 * correction inline (`at > from ? at - 1 : at`) and getting it wrong is how a case appears to
 * refuse to move down by one.
 */
export function dropIndex(pointerY: number, midpoints: number[], from: number): number {
  let at = midpoints.length;
  for (let i = 0; i < midpoints.length; i++) {
    if (pointerY < midpoints[i]) {
      at = i;
      break;
    }
  }
  return at > from ? at - 1 : at;
}
