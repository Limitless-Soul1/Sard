// The library design's own arithmetic — sizes, grouping, ordering, search.
//
// Every number here is the design's, carried over rather than re-chosen: the four density
// steps, the fitted Vista width, the spine thickness curve, the progress thresholds. Where
// the design read a field Sard does not have, the substitution is named at the site.

import type { BookRow, CaseNode, LibraryTree, ShelfItem, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { UNFILED } from "../../../lib/ipc";

/** The five views. `grid` is Sard's original Library grid, kept alongside the four new ones. */
export type DesignView = "grid" | "covers" | "spines" | "details" | "vista";

export const DESIGN_VIEWS: DesignView[] = ["grid", "covers", "spines", "details", "vista"];

/** Covers and Spines share one renderer — the design draws both as cases → shelves → books. */
export const isGroupedView = (v: DesignView) => v === "covers" || v === "spines";

/**
 * Which views can express a hand-made order.
 *
 * Arranging by hand means dropping a book INTO A PLACE BETWEEN TWO OTHERS, so a view has to be able
 * to draw that place. Covers, Spines and Vista lay books out in shelf order and can open a gap
 * between any two of them. Details is a sortable table — its order is the sort column's, not the
 * reader's — and Grid is Sard's original library grid, drawn outside this surface entirely and
 * holding no shelf structure to order within.
 *
 * Measured, before this existed: the Arrange control turned ON in Grid and in Details and then did
 * nothing whatsoever — no book became draggable, no landing place appeared, nothing was written. A
 * control that can be switched on and means nothing is worse than one that is not offered.
 *
 * DETAILS HAS SINCE JOINED, CONDITIONALLY, and so is no longer a member of this set. It always had
 * the shelf and the books; what it lacked was any way to SHOW a hand order, because a column sort
 * always governed. It can now sort by the shelf-s own stored order, and under THAT sort — and only
 * under it — its rows are draggable. Its answer therefore depends on the sort and the shelf, and is
 * decided by the owner rather than by this predicate.
 *
 * Grid is still a flat no: it renders the whole library from its own list, ignores the reader-s
 * place entirely, and does not own the markup a landing place would have to sit in.
 */
export const canArrange = (v: DesignView) => v === "covers" || v === "spines" || v === "vista";


/**
 * Whether the VISTA STAGE, as it currently stands, holds anything the reader can reorder.
 *
 * `canArrange` answers for the view; this answers for the DEPTH, and both have to be true. Vista
 * drills down, so the same view shows containers at one depth and books at another: at the library
 * root and inside a case it draws cases and shelves, whose sample covers are decorative children of
 * a navigation button — not books, and never draggable. Measured before this existed: at the root,
 * arrange mode switched on over six containers and fifteen visible covers with nothing orderable
 * and no explanation, and pressing one of those covers opened the case.
 *
 * Two conditions, and they are different questions:
 *   `books.length > 0`  the stage is drawing real books at all, rather than previews of containers
 *
 * IT NO LONGER ALSO ASKS FOR `bookDrop`. That extra condition meant "this stage's own order is the
 * reader's", and refusing the mode on that basis switched Manual Ordering off over خارج الأرفف and
 * over a computed shelf — the two places holding most of a library that has not been filed yet. The
 * reader's objection was exact: a book being outside a shelf is not a reason it cannot be moved. It
 * has no order of its own to change, but it has somewhere to GO, and the destinations the interface
 * offers are what decide that — not the stage it happens to be standing on.
 *
 * Whether this stage can be reordered WITHIN itself is still `bookDrop`, and still what decides
 * whether landing places are drawn here. The two questions are simply no longer the same one.
 */
export const vistaArrangeable = (v: Pick<VistaView, "books" | "bookDrop">) =>
  v.books.length > 0;

/** The design's four density steps, as authored. */
const DENSITY_WIDTHS = [92, 118, 148, 184];
export const DENSITY_STEPS = DENSITY_WIDTHS.length;

/**
 * DENSITY IS A POSITION, NOT AN INDEX ANY MORE — and the design's own numbers are its anchors.
 *
 * It was an index into the four widths above, which is why the reader had four sizes and no way to
 * ask for anything between them. Measured on a 1680px pane, Covers reached 12, 9, 8 and 6 books to
 * a row: ten and eleven were simply unreachable, and at 1400 eight was.
 *
 * So the value is now a REAL NUMBER over the same 0..3 range and every per-step table is read by
 * interpolation. Two things fall out of that, both deliberate:
 *
 *   · every authored number still renders EXACTLY as authored at 0, 1, 2 and 3. Nothing here
 *     invents a size the design did not choose; the steps stop being the only places to stand.
 *   · nothing has to be migrated. `libd_density` has always stored "0".."3", and those are already
 *     valid positions on the continuum, so a reader's stored choice survives untouched.
 */
export const DENSITY_MIN = 0;
export const DENSITY_MAX = DENSITY_WIDTHS.length - 1;
/** Fine enough to feel continuous under a pointer; coarse enough that an arrow key does something. */
export const DENSITY_STEP = 0.1;

export const clampDensity = (d: number) =>
  Number.isFinite(d) ? Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, d)) : 1;

/**
 * Read one of the design's per-step tables at a fractional position.
 *
 * The tables are the authored design (`DENSITY_WIDTHS`, `SPINE_HEIGHTS`, `SHELF_COL`, …); this is
 * the only thing that changed about how they are used. At an integer it returns that entry exactly.
 */
export function atDensity(table: readonly number[], density: number): number {
  const d = Math.max(0, Math.min(table.length - 1, Number.isFinite(density) ? density : 1));
  const lo = Math.floor(d);
  const hi = Math.min(table.length - 1, lo + 1);
  return table[lo] + (table[hi] - table[lo]) * (d - lo);
}

export const baseWidth = (density: number) => Math.round(atDensity(DENSITY_WIDTHS, density));

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
  // "hand" is the order the list ARRIVES in — `shelfBooks` builds it from the shelf's stored
  // positions, so re-sorting here would throw away the very thing being asked for.
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
/**
 * `shelf` is THE SHELF'S OWN STORED ORDER, and not a computed one like the rest.
 *
 * The other five are properties of a book — when it was read, when it was added, its title. This
 * one is a property of the MEMBERSHIP: the position recorded in `book_collections`, the same number
 * a hand reorder writes. It is therefore the only sort under which Details can show the result of
 * a manual reorder, and the only one under which its rows are allowed to be dragged.
 *
 * It is offered only where it means something — inside a single hand-orderable shelf. Everywhere
 * else there is no one shelf whose order it could be, so the toolbar does not list it.
 */
export type DesignSort = "recent" | "added" | "title" | "author" | "progress" | "shelf";
/** The sorts offered everywhere. `shelf` is added by the toolbar only where a shelf owns the stage. */
export const DESIGN_SORTS: DesignSort[] = ["recent", "added", "title", "author", "progress"];

/**
 * The toolbar-s sort, expressed as a SHELF-s ordering rule.
 *
 * The two vocabularies share five names and differ on one: the toolbar calls the stored order
 * "shelf", because that is what the reader is choosing; a shelf calls it "hand", because that is
 * who put it there. One place translates, so no call site has to remember which word it is in.
 */
export const asShelfOrder = (s: DesignSort): ShelfOrder => (s === "shelf" ? "hand" : s);

// There is deliberately no title/author matcher here. The design's own file had one, but Sard
// searches in SQL, where `library_list_books` folds Arabic the way RAWY-178 requires — an
// unvocalized query finds a vocalized title, and hamza/alef variants match. A naive
// `toLowerCase().includes()` on top would DISCARD exactly the rows folding had just matched, so
// the library would answer قراءة but not قِراءة. Anything reaching a view has already passed the
// folded search; a second pass is not a refinement, it is a regression waiting to be wired up.

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
export function groupShelf(
  shelf: ShelfNode,
  items: ShelfItem[],
  byId: Map<string, BookRow>,
  /**
   * Keep categories that hold nothing.
   *
   * A browsing view has no use for an empty run and drops it. The MANAGEMENT panel must not: an
   * empty category that cannot be seen cannot be renamed, reordered or deleted either, so making
   * one and not filling it immediately left an object stranded in the database with no way back
   * to it.
   */
  keepEmpty = false,
): BookGroup[] {
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
  return keepEmpty ? groups : groups.filter((g) => g.books.length > 0);
}

/** Every shelf in the tree, cases first then loose, as one flat list. */
export function allShelves(cases: CaseNode[], loose: ShelfNode[]): ShelfNode[] {
  return [...cases.flatMap((c) => c.shelves), ...loose];
}

// ---------------------------------------------------------------------------
// Vista — The Casement
// ---------------------------------------------------------------------------
//
// Vista is the Sard Library with the frosted pane lifted off the stage. The shell is the frame —
// the sidebar and the toolbar stay, at full size and full function — and the stage is the casement
// that opens in it, where the reader's photograph shows through unveiled.
//
// The stage holds FURNITURE, and the furniture's proportion says what kind of container it is:
//
//   a case        a TALL APERTURE, two grid rows high — the only portrait object on the stage
//   a shelf       a WIDE LOW SILL, one grid row — landscape, because a shelf is a thing you put
//                 books ON
//   a rule shelf  the same sill with NO LIT EDGE and its books floating clear: nothing rests on it
//                 because nothing can be filed into it
//   خارج الأرفف   the same sill with a GHOSTED edge — the container is real, the shelf inside it is
//                 not. Books on no shelf are a place, never a spill across the background.
//   a category    a THIN TRAY, only ever inside a shelf, as wide as what it holds
//
// The governing rule, and the reason the earlier attempts were rejected: CONTENT STATES THE FACT,
// GEOMETRY ONLY ACCELERATES THE SCAN. An aperture's own line reads "11 books · 4 shelves" — it
// holds shelves. A sill's reads "6 books" — it holds books. Nothing here has to be decoded first;
// the shape only makes the second glance instant.

/** What kind of container a piece of furniture is, which is also what shape it takes. */
export type VistaKind = "case" | "shelf" | "rule" | "unshelved" | "category";

/** One container on the stage. */
export interface VistaChild {
  key: string;
  kind: VistaKind;
  name: string;
  /** A case's reader-chosen colour, drawn as an inset rule under its name. */
  ink: string | null;
  /** Candidate books for the sample. The renderer measures and shows as many as fit whole. */
  books: BookRow[];
  /** What it holds in total, so "+n" can say how much is not shown. */
  total: number;
  /**
   * A CASE ONLY: how many books are actually FILED into its shelves, as the library counts them.
   *
   * `total` is what the case's shelves SHOW, and the two are not the same thing. A rule shelf fills
   * itself — its books hold no membership in the case, so the library counts none of them — and a
   * case whose only content is such a shelf therefore holds nothing while displaying nineteen
   * books. Measured: the sidebar, Covers and Spines all said «Test 0» while Vista said 19.
   *
   * Both numbers are kept, and Vista says which is which, rather than picking one and being wrong
   * on a different screen. Absent wherever the distinction does not arise.
   */
  filed?: number;
  /** For a case, how many shelves — a case is described by both, so it reads as holding shelves. */
  children: number;
  /** True when this container earns two grid columns. */
  wide: boolean;
  /** Where going in leads. */
  enter: NavScope;
  /**
   * Where a dropped book lands, or null when that cannot be named.
   *
   * A CASE CANNOT ANSWER "WHICH SHELF?", so an aperture takes no drops. A RULE SHELF computes its
   * own contents, so it takes none either — and the refusal is visible before the attempt rather
   * than after it, because both are drawn with no lit edge.
   */
  drop: { shelfId: string; categoryId: string | null } | null;
  /**
   * WHICH DIRECTION THE DROP GOES, and the two are not the same operation.
   *
   *   "file"    the book JOINS this container, leaving the shelf it came from.
   *   "unfile"  the book LEAVES the shelf it came from and joins nothing. Only خارج الأرفف means
   *             this, because it is not a collection: there is no row to write, only one to delete.
   *
   * Keeping them apart in the contract is what lets خارج الأرفف accept a book being taken OFF a
   * shelf while remaining impossible to file INTO — a distinction an earlier pass collapsed by
   * refusing it any drop at all, which left no way to unfile a book by dragging.
   */
  dropKind: "file" | "unfile" | null;
}

/** Where the reader is standing. Null at the root, which the toolbar already names. */
export interface VistaHere {
  kind: "case" | "shelf" | "category";
  /** True when this shelf fills itself, so its order is not the reader's to set. */
  rule?: boolean;
  name: string;
  ink: string | null;
  books: number;
  /** A case only — the FILED count, where it differs from the books on show. See VistaChild. */
  filed?: number;
  children: number;
}

export interface VistaView {
  here: VistaHere | null;
  /**
   * The root's cases, drawn ABOVE the hairline.
   *
   * The two bands are the whole answer to "does this shelf belong to that case": everything above
   * the line holds shelves, everything below it holds books, and no shelf at the root ever sits
   * inside a case's band. It needs no label, and the sidebar's own tree says the same in words.
   */
  cases: VistaChild[];
  /** Everything below the line: loose shelves at the root, a case's shelves, a shelf's categories. */
  children: VistaChild[];
  /** The books themselves, when this level holds books rather than containers. */
  books: BookRow[];
  /** Where a book dropped among `books` lands — always a "file", into the shelf being shown. */
  bookDrop: { shelfId: string; categoryId: string | null } | null;
  /** The shelf a book lifted from `books` is leaving, or null when that is ambiguous. */
  bookSource: ShelfNode | null;
  /**
   * The ink of the case the reader is standing INSIDE, at any depth.
   *
   * Separate from `here.ink`, which is the container's own signature and is null for a shelf. This
   * is the identity of the case that OWNS where you are, and it is what the stage's head rule
   * draws — the same colour as that case's bar in the sidebar. Two shelves called «العربية» in two
   * different cases are told apart by it, with no parent's name printed beside the child's.
   */
  caseInk: string | null;
}

/** A shelf with its runs already grouped — what the grouped views render from. */
export interface ShelfRuns {
  shelf: ShelfNode;
  groups: BookGroup[];
}

export interface VistaInput {
  /** The scoped, query-filtered tree the grouped views render. */
  rendered: { node: CaseNode | null; shelves: ShelfRuns[] }[];
  /** Every case, so one holding nothing is still a place at the root. */
  allCases: CaseNode[];
  scope: NavScope;
  shelfBooks: (s: ShelfNode) => BookRow[];
  /** The reader's library sort. A case has no order of its own, so this is the only honest one. */
  librarySort: ShelfOrder;
  /** True while a search narrows the library. */
  filtered: boolean;
}

/**
 * How many books a container offers the renderer as sample candidates.
 *
 * These are CANDIDATES, not a count: the renderer measures the row and shows as many as fit whole,
 * because a cropped cover is never acceptable. A case is deliberately short — two large covers say
 * "these are books" where three small ones say "these are thumbnails", and the plate already
 * reports how many it holds.
 */
const SAMPLE_CASE = 4;
const SAMPLE_SHELF = 8;
const SAMPLE_CATEGORY = 10;
/** A shelf earns two columns once it has enough to show. */
const WIDE_FROM = 4;

function dedupe(lists: BookRow[][]): BookRow[] {
  const seen = new Set<string>();
  const out: BookRow[] = [];
  for (const list of lists) for (const b of list) if (!seen.has(b.id)) { seen.add(b.id); out.push(b); }
  return out;
}

const EMPTY_VIEW: VistaView = {
  here: null, cases: [], children: [], books: [], bookDrop: null, bookSource: null, caseInk: null,
};

/**
 * The stage, as seen from wherever the reader is standing.
 *
 * Root       cases above the line; loose shelves and خارج الأرفف below it.
 * In a case  its shelves, as sills.
 * In a shelf its categories, as trays — or its books, when it has none.
 * In a run   its books.
 */
export function vistaView(input: VistaInput): VistaView {
  const { rendered, allCases, scope, shelfBooks, librarySort, filtered } = input;
  const caseInk = scope.caseId
    ? allCases.find((c) => c.id === scope.caseId)?.ink ?? null
    : null;

  const runsOf = (s: ShelfRuns): BookGroup[] =>
    s.groups.length ? s.groups : [{ categoryId: null, name: null, books: [] }];
  const booksOf = (s: ShelfRuns): BookRow[] =>
    // The unshelved run owns no membership rows, so its books come from the run itself.
    isVirtualShelf(s.shelf.id) ? s.groups.flatMap((g) => g.books) : shelfBooks(s.shelf);

  const shelfChild = (s: ShelfRuns, caseId: string | null): VistaChild => {
    const books = booksOf(s);
    const unshelved = isVirtualShelf(s.shelf.id);
    const rule = !!s.shelf.auto_rule;
    return {
      key: s.shelf.id,
      kind: unshelved ? "unshelved" : rule ? "rule" : "shelf",
      name: s.shelf.name,
      ink: null,
      books: sortBooks(books, s.shelf.order_rule).slice(0, SAMPLE_SHELF),
      total: books.length,
      children: s.shelf.categories.length,
      // خارج الأرفف is always given the room to show what it holds: it is the one container a
      // reader most needs to see into, and the one an earlier design scattered across the wall.
      wide: unshelved || books.length >= WIDE_FROM,
      enter: { caseId: caseId ?? UNFILED_CASE_ID, shelfId: s.shelf.id, categoryId: null },
      // خارج الأرفف takes a drop, and it means the opposite of every other one: the book leaves the
      // shelf it came from and joins nothing.
      drop: rule ? null : { shelfId: s.shelf.id, categoryId: null },
      dropKind: rule ? null : unshelved ? "unfile" : "file",
    };
  };

  // ---- inside a shelf, or inside one of its runs -------------------------------------------------
  if (scope.shelfId) {
    const found = rendered.flatMap((c) => c.shelves).find((s) => s.shelf.id === scope.shelfId);
    if (!found) return EMPTY_VIEW;
    const all = booksOf(found);
    const runs = runsOf(found);
    const named = found.shelf.categories.length > 0;
    // A LENS CANNOT TAKE A BOOK. NOTHING ELSE IS EXCLUDED.
    //
    // This also refused the books on no shelf, from a time when that run was synthesised per render
    // and had nowhere to write an order to. Under the placement model it is an ordinary container
    // with an ordinary order, and every other format had already stopped making the exception — so
    // standing in «خارج الأرفف», Grid, Details and Spines each drew all forty-two places while Vista
    // drew none. The books were there and could be lifted; there was simply nowhere to put them.
    // Measured on the reader's library: `gapsFor` returned 42 canonical places, one end, all
    // distinct, and this line threw them away before the projection could carry them.
    const canDrop = !found.shelf.auto_rule;

    // Inside a category: its books, and nothing further to enter.
    if (scope.categoryId) {
      const run = runs.find((g) => g.categoryId === scope.categoryId);
      return {
        here: { kind: "category", name: run?.name ?? found.shelf.name, ink: null,
          books: run?.books.length ?? 0, children: 0 },
        cases: [],
        children: [],
        books: sortBooks(run?.books ?? [], found.shelf.order_rule),
        bookDrop: canDrop ? { shelfId: found.shelf.id, categoryId: scope.categoryId } : null,
        bookSource: found.shelf,
        caseInk,
      };
    }

    const here: VistaHere = { kind: "shelf", name: found.shelf.name, ink: null,
      books: all.length, children: found.shelf.categories.length,
      rule: !!found.shelf.auto_rule };

    // A shelf that has categories shows them as trays; one that has none holds its books directly.
    if (!named) {
      return {
        here, cases: [], children: [],
        books: sortBooks(all, found.shelf.order_rule),
        bookDrop: canDrop ? { shelfId: found.shelf.id, categoryId: null } : null,
        bookSource: found.shelf,
        caseInk,
      };
    }
    return {
      here,
      cases: [],
      children: runs.map((g) => ({
        key: `${found.shelf.id}::${g.categoryId ?? ""}`,
        kind: "category" as VistaKind,
        name: g.name ?? "",
        ink: null,
        books: sortBooks(g.books, found.shelf.order_rule).slice(0, SAMPLE_CATEGORY),
        total: g.books.length,
        children: 0,
        wide: true,
        // The uncategorised run is a real place on this shelf and can be entered like any other.
        enter: { caseId: scope.caseId, shelfId: found.shelf.id, categoryId: g.categoryId },
        drop: canDrop ? { shelfId: found.shelf.id, categoryId: g.categoryId } : null,
        dropKind: canDrop ? "file" : null,
      })),
      books: [],
      bookDrop: null,
      bookSource: null,
      caseInk,
    };
  }

  // ---- inside a case: its shelves, as sills --------------------------------------------------------
  if (scope.caseId) {
    const node = allCases.find((c) => c.id === scope.caseId) ?? null;
    const shelves = rendered.flatMap((c) => c.shelves);
    const books = dedupe(shelves.map(booksOf));
    return {
      here: { kind: "case", name: node?.name ?? "", ink: node?.ink ?? null,
        books: books.length, filed: node?.count ?? books.length,
        children: node ? node.shelves.length : shelves.length },
      cases: [],
      children: shelves.map((s) => shelfChild(s, scope.caseId)),
      books: [],
      bookDrop: null,
      bookSource: null,
      caseInk,
    };
  }

  // ---- the root: cases above the line, shelves below it ---------------------------------------------
  const cases: VistaChild[] = [];
  const byId = new Map(rendered.filter((c) => c.node).map((c) => [c.node!.id, c]));
  for (const node of allCases) {
    const shelves = byId.get(node.id)?.shelves ?? [];
    // DISTINCT books, because that is what a case's count already promises.
    const books = dedupe(shelves.map(booksOf));
    // A case the reader made and has not filled is still a place. A case emptied by a SEARCH is
    // not — the search has already said it holds nothing that matches.
    if (filtered && books.length === 0) continue;
    cases.push({
      key: node.id,
      kind: "case",
      name: node.name,
      ink: node.ink,
      // A case has no order of its own — "sorting decides order in Details; inside a shelf, order
      // is the shelf's own", and a case is not a shelf.
      books: sortBooks(books, librarySort).slice(0, SAMPLE_CASE),
      total: books.length,
      // The library's own number, untouched. Vista draws both and names the difference.
      filed: node.count,
      children: node.shelves.length,
      wide: false,
      enter: { caseId: node.id, shelfId: null, categoryId: null },
      drop: null,
      dropKind: null,
    });
  }
  const children: VistaChild[] = [];
  for (const c of rendered) {
    if (c.node) continue;
    for (const s of c.shelves) children.push(shelfChild(s, null));
  }
  // خارج الأرفف is always last: it is where the library runs out of structure.
  children.sort((a, b) => Number(a.kind === "unshelved") - Number(b.kind === "unshelved"));
  return { here: null, cases, children, books: [], bookDrop: null, bookSource: null, caseInk: null };
}

/**
 * The synthetic shelf that holds books on no shelf at all.
 *
 * Without it the grouped views show only what has already been filed, so a library whose
 * books have never been put on a shelf renders as empty — which is what it did until this
 * was added. It is not a row in `collections`: it exists only for the duration of a render,
 * cannot be written to, and disappears as soon as every book has a home.
 */
export const LOOSE_SHELF_ID = UNFILED;

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

export function placementPlan(
  fromShelf: string,
  toShelf: string,
  opts: { sourceIsRule?: boolean } = {},
): PlacementPlan {
  if (isVirtualShelf(toShelf)) {
    // Dropping onto the unshelved run means "take this off its shelf". A book that was already
    // unshelved has nothing to leave, and neither has one whose shelf is a rule.
    return isVirtualShelf(fromShelf) || opts.sourceIsRule
      ? { kind: "none" }
      : { kind: "unshelve", removeFrom: fromShelf };
  }
  if (fromShelf === toShelf) return { kind: "reorder", shelfId: toShelf };
  // A RULE SHELF IS A VIEW, NOT A LOCATION. Its contents are a live query — there is no
  // membership row to delete — so a book leaving one is an ADD, and the book goes on appearing
  // there for exactly as long as the rule still describes it. Treating it as a move would
  // promise a removal that cannot happen.
  if (isVirtualShelf(fromShelf) || opts.sourceIsRule) return { kind: "add", shelfId: toShelf };
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
  /**
   * THE FOURTH LEVEL, AND THE ONE THAT WAS MISSING.
   *
   * `collection_categories` has always held a category as a real row under one shelf, the book
   * sheet has always filed into one, and this library's own description is "cases holding shelves
   * holding categories holding books". But a category was never somewhere the reader could STAND:
   * scope stopped at the shelf, so a category could be written to and never visited. Any view that
   * had to show one was left spelling the hierarchy out in text, because there was no position for
   * the text to be a substitute for.
   */
  categoryId: string | null;
}

export const ROOT_SCOPE: NavScope = { caseId: null, shelfId: null, categoryId: null };

/**
 * `scope.caseId` when the reader is standing in "not in a case".
 *
 * A UI-ONLY value. It names a place to stand, not a row: no case with this id exists, nothing
 * writes it to `collections.case_id`, and the only thing that ever sets a shelf's case is the
 * picker, which offers real cases and null. Reusing the id the open-set and the management panel
 * already answer to keeps one name for one concept rather than inventing a third.
 */
export const UNFILED_SCOPE: NavScope = { caseId: UNFILED_CASE_ID, shelfId: null, categoryId: null };

export const isUnfiledScope = (s: NavScope) => s.caseId === UNFILED_CASE_ID;

export const isRootScope = (s: NavScope) => !s.caseId && !s.shelfId && !s.categoryId;

// ---- scope, written down and read back ----------------------------------------------------------
//
// The rebuild described the library as persisting "density, sort, scope and collapsed cases". Three
// of those were written; scope never was, so every launch landed at the root and a reader who had
// walked into a shelf had to walk back in. `|` cannot occur in an id: ids are hex digests, the two
// UI-only sentinels, or the seeded `c_` names.
const SCOPE_SEP = "|";

export function serialiseScope(s: NavScope): string {
  // ONE SPELLING FOR THE ROOT. Written as "||" it means the same as an empty setting, and the two
  // took turns in the store — the first load after an empty one rewrote it, which reads as the
  // library changing under you when nothing has.
  if (isRootScope(s)) return "";
  return [s.caseId ?? "", s.shelfId ?? "", s.categoryId ?? ""].join(SCOPE_SEP);
}

/**
 * One level up, or null at the root.
 *
 * The trail and the Escape key are the same movement, so they read it from the same place rather
 * than each deciding for itself what "out" means.
 */
export function parentScope(s: NavScope): NavScope | null {
  if (s.categoryId) return { caseId: s.caseId, shelfId: s.shelfId, categoryId: null };
  if (s.shelfId) return s.caseId ? { caseId: s.caseId, shelfId: null, categoryId: null } : ROOT_SCOPE;
  if (s.caseId) return ROOT_SCOPE;
  return null;
}

export function parseScope(v: string | null): NavScope {
  if (!v) return ROOT_SCOPE;
  const [caseId, shelfId, categoryId] = v.split(SCOPE_SEP);
  return { caseId: caseId || null, shelfId: shelfId || null, categoryId: categoryId || null };
}

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
    // The shelf is gone: stay in the group it was in if that still exists, else go to the root.
    // A category cannot outlive its shelf, so it goes with it.
    if (!inCase && !isLoose) {
      const groupStands = isUnfiledScope(scope) || (scope.caseId && cases.some((c) => c.id === scope.caseId));
      return { caseId: groupStands ? scope.caseId : null, shelfId: null, categoryId: null };
    }
    // A shelf's parent is whatever holds it — a case, or "not in a case". Following it here is
    // what keeps the breadcrumb honest when a shelf is filed into a case, or taken out of one,
    // while the reader is looking at it.
    const owner = inCase?.id ?? UNFILED_CASE_ID;
    // A DELETED CATEGORY DROPS THE READER ONTO ITS SHELF, not out of the library. Deleting a
    // category deliberately keeps its books (the membership's `category_id` is nulled, never
    // cascaded), so the shelf is still exactly where those books are and where the reader was.
    const shelf = inCase?.shelves.find((s) => s.id === scope.shelfId)
      ?? loose.find((s) => s.id === scope.shelfId);
    const categoryId = scope.categoryId && shelf?.categories.some((k) => k.id === scope.categoryId)
      ? scope.categoryId
      : null;
    return owner === scope.caseId && categoryId === scope.categoryId
      ? scope
      : { caseId: owner, shelfId: scope.shelfId, categoryId };
  }

  // The unshelved run holds no categories, so standing in one there cannot mean anything.
  if (scope.shelfId && isVirtualShelf(scope.shelfId) && scope.categoryId) {
    return { ...scope, categoryId: null };
  }
  // A category without a shelf names nothing: there is no such row and no such place.
  if (!scope.shelfId && scope.categoryId) return { ...scope, categoryId: null };

  // "Not in a case" names no row, so no tree can vouch for it — and it must survive reconciling,
  // or the reader is thrown out of a place they legitimately stand in.
  if (isUnfiledScope(scope)) return scope;
  if (scope.caseId && !cases.some((c) => c.id === scope.caseId)) {
    return { caseId: null, shelfId: scope.shelfId, categoryId: scope.categoryId };
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
/**
 * The same correction `dropIndex` makes, for a BOOK moved within its own shelf.
 *
 * A view draws a landing place BEFORE each book and one at the tail, so `gap` is an index into the
 * list as the reader currently sees it. `shelf_place_book` removes the book FIRST and then inserts
 * at the index it is given, so its index is one into the list with that book already taken out.
 * Every position after the book's own therefore shifts down by one, and passing the visual gap
 * straight through overshoots: dropping a book into the gap immediately after itself sends it to the
 * end instead of leaving it alone.
 *
 * Measured, before this existed: a two-book shelf, first book dragged onto the gap after itself,
 * came back reversed — in Vista and in Covers alike, because both feed the same command.
 *
 * The backend is right for the case it was written for. Joining a shelf performs no removal, so its
 * index needs no correction, and changing the command would move every other caller. The
 * translation belongs here, where the source and the destination are both known.
 *
 * NOTE the boundary: this corrects a shelf-wide gap against a shelf-wide position. A shelf with
 * CATEGORIES draws its landing places per category run, so the index it produces is not shelf-wide
 * to begin with — a separate defect, shared with the grouped views, and not addressed here.
 */
/**
 * Does the destination picker still need a shelf before it means anything?
 *
 * A CASE IS NOT A PLACEMENT DESTINATION. It contains shelves, so it cannot answer "which shelf?" —
 * the same reason a case takes no drop. Choosing one only narrows the level below it. The dialog
 * used to render the two levels as one control with Save beneath, so choosing a case and pressing
 * Save read as filing and silently did nothing at all.
 *
 * True while the reader has aimed at a case the book is not in and has not yet named a shelf inside
 * it. False when the picked case is where the book already sits — nothing is pending then — and
 * false when that case offers no shelf to pick, because the level below says so on its own.
 */
export function awaitsShelfChoice(
  currentCaseId: string | null,
  pickedCaseId: string | null,
  shelvesInPicked: number,
): boolean {
  return pickedCaseId !== currentCaseId && shelvesInPicked > 0;
}

/** One shelf's memberships, as the placement rule needs to see them. */
export interface PlacementShelf {
  id: string;
  /** A shelf that fills itself is never a placement: nothing was filed there to move. */
  rule: boolean;
  items: { book_id: string; category_id: string | null }[];
}

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

/**
 * Which top-level groups are open, given the ones the reader deliberately closed.
 *
 * Open is the default and closed is the exception, so the stored set records collapses rather
 * than expansions. Deriving the open set on every load — rather than seeding it once — is what
 * makes a case created later appear open like every other: seeded once, it belonged to no set at
 * all and drew collapsed, and a collapsed case renders no shelf list, so "New shelf" from its own
 * menu had nowhere to put its input and looked like a control that did nothing.
 */
export function openGroups(caseIds: string[], closed: ReadonlySet<string>): Set<string> {
  return new Set([...caseIds, UNFILED_CASE_ID].filter((id) => !closed.has(id)));
}

/**
 * The inverse: which groups to store as closed, given what is open.
 *
 * The pair has to be read from a tree and an open set that describe the same moment. When they did
 * not — a tree carrying a case the open set predated — this recorded that case as a deliberate
 * collapse, and it stayed folded from then on. Keeping both halves here makes the round trip
 * testable: closing nothing must store nothing, whatever ids arrive.
 */
export function closedGroups(caseIds: string[], open: ReadonlySet<string>): string[] {
  return [...caseIds, UNFILED_CASE_ID].filter((id) => !open.has(id));
}

/**
 * Is this actually the structure?
 *
 * Most library commands answer with the whole tree, but not all of them do — `collection_rename`
 * answers with the collection ROWS. One call site bridged that difference with a cast, so an array
 * reached the code that reads `.cases`, and the window went blank: an empty React root, no sidebar,
 * nothing to click, and no message anywhere. Checking the shape turns that into an ordinary
 * reported write failure instead of a dead window.
 */
/**
 * The translation key naming a shelf's sort rule.
 *
 * "By hand" is not a sort and has no `lib.sort.*` entry — it is the absence of one — so the type
 * excludes it rather than letting a template literal ask for a key that was never written. The
 * call sites already branched on it; this makes the compiler agree, and removes the cast that was
 * hiding the gap.
 */
export type SortKey = `lib.sort.${Exclude<ShelfOrder, "hand">}`;

export const sortKey = (rule: Exclude<ShelfOrder, "hand">): SortKey => `lib.sort.${rule}`;

export function isLibraryTree(v: unknown): v is LibraryTree {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<LibraryTree>;
  return Array.isArray(t.cases) && Array.isArray(t.loose);
}
