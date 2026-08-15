// The library surface: the Vista chrome, with five views drawn inside it.
//
// The five are Sard's original Grid plus the four from the references. Grid is NOT a new
// rendering of the old idea — it delegates to the same `renderGrid` the previous Library
// used, so everything that view already did (cover fit mode, the edit dialog, its empty
// state) keeps working unchanged.
//
// State that the design owns — the view, the density, the sort, the scope, which cases are
// open — is persisted through the same `settings` IPC the Library has always used.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookRow, CaseNode, LibraryTree, ShelfItem, ShelfNode } from "../../../lib/ipc";
import {
  caseCreate,
  caseDelete,
  caseRename,
  caseReorder,
  categoryCreate,
  libraryShelfItems,
  libraryTree,
  settingsGet,
  settingsSet,
  shelfCreate,
  shelfPlaceBook,
  shelfSetCollapsed,
  shelfSetOrder,
  shelfSetInk,
  caseSetInk,
  shelfReorder,
  shelfSetCase,
  collectionRemoveBook,
  progressSave,
  type ShelfOrder,
} from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { useTheme, THEMES } from "../../../theme";
import { useBackground } from "../../../lib/background";
import { Header, Sidebar, type Scope, type Section } from "./Chrome";
import { ViewGrouped, type CaseRender, type ShelfRender } from "./ViewGrouped";
import { ViewDetails } from "./ViewDetails";
import { VistaEnvironment, VistaHero, ViewVista, type VistaBand } from "./ViewVista";
import { CarryGhost, SelectTray } from "./Menus";
import { BookDetails } from "./BookDetails";
import { CaseEditor } from "./CaseEditor";
import {
  DESIGN_VIEWS,
  groupShelf,
  isGroupedView,
  isVirtualShelf,
  LOOSE_SHELF_ID,
  makeLooseShelf,
  placementPlan,
  reconcileScope,
  spineWidth,
  selectionSource,
  sortBooks,
  unfiledCase,
  UNFILED_CASE_ID,
  unshelvedBooks,
  type DesignSort,
  type DesignView,
} from "./model";

const EMPTY_TREE: LibraryTree = { cases: [], loose: [] };

/** `editorFor` sentinel: manage the shelves that belong to no case. */
const UNFILED_EDITOR = UNFILED_CASE_ID;

export interface LibraryDesignProps {
  books: BookRow[];
  section: Section;
  onSection: (s: Section) => void;
  /** Panes for the non-library sections, rendered by the caller. */
  renderSection: (s: Section) => React.ReactNode;
  /** Sard's original Library grid, preserved intact and shown as the Grid view. */
  renderGrid: () => React.ReactNode;
  /** Grid's own cover-fit control, which belongs to that view and only appears with it. */
  coverMode: "crop" | "fit";
  onCoverMode: () => void;
  /** RAWY-15's EPUB/PDF filter — applied in SQL, so it belongs to the owner of the query. */
  format: string | null;
  onFormat: (f: string | null) => void;
  onOpenBook: (b: BookRow) => void;
  onEditBook: (b: BookRow) => void;
  onAddBooks: () => void;
  importing: boolean;
  onSettings: () => void;
  onReloadBooks: () => void;
  query: string;
  onQuery: (q: string) => void;
  onRenameShelf: (id: string, name: string) => void;
  onDeleteShelf: (id: string) => void;
}

export function LibraryDesign(props: LibraryDesignProps) {
  const { t, lang } = useI18n();
  const themeId = useTheme((s) => s.themeId);
  const dark = THEMES[themeId]?.dark ?? false;
  // Whether a library background image is actually in force — the same two pieces of store state
  // `applyBackgrounds` gates the `data-bg-library` attribute on.
  const bgEnabled = useBackground((s) => s.enabled);
  const bgLibrary = useBackground((s) => s.library);
  const hasUserBackground = bgEnabled && !!bgLibrary;
  const num = (n: number) => localeNum(n, lang);

  const [tree, setTree] = useState<LibraryTree>(EMPTY_TREE);
  const [items, setItems] = useState<Record<string, ShelfItem[]>>({});
  const [view, setView] = useState<DesignView>("covers");
  const [density, setDensity] = useState(1);
  const [sort, setSort] = useState<DesignSort>("recent");
  const [scope, setScope] = useState<Scope>({ caseId: null, shelfId: null });
  const [openCases, setOpenCases] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"browse" | "select" | "arrange">("browse");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [carry, setCarry] = useState<{ book: BookRow; fromShelf: string } | null>(null);
  const [orderMenuFor, setOrderMenuFor] = useState<string | null>(null);
  const [renamingShelf, setRenamingShelf] = useState<string | null>(null);
  // Shelves the reader has expanded past the reference's two-row cap.
  const [expandedShelves, setExpandedShelves] = useState<Set<string>>(new Set());
  const [detailsFor, setDetailsFor] = useState<BookRow | null>(null);
  // Which case the management panel is open on — the reference's "Manage" destination.
  // `UNFILED_EDITOR` opens the same panel over the shelves that belong to no case.
  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Which cases the reader had collapsed, restored before the tree is first grouped so a
  // collapsed case never flashes open on the way in.
  const closedCases = useRef<Set<string>>(new Set());
  // Set once the open/closed set has actually been seeded from the tree, so the persistence
  // effect below can never write before there is anything true to write.
  const seeded = useRef(false);
  const [closedLoaded, setClosedLoaded] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(1180);

  // ---- persisted preferences -------------------------------------------------
  useEffect(() => {
    (async () => {
      const [v, d, s] = await Promise.all([
        settingsGet("libd_view"),
        settingsGet("libd_density"),
        settingsGet("libd_sort"),
      ]);
      if (v && (DESIGN_VIEWS as string[]).includes(v)) setView(v as DesignView);
      const dn = Number(d);
      if (Number.isFinite(dn) && dn >= 0 && dn <= 3) setDensity(dn);
      if (s) setSort(s as DesignSort);
      // CLOSED cases are what is stored, not open ones: a case made after this was written
      // should appear open, which is the design's own default, and storing the closed set is
      // what makes that true without special-casing anything.
      const closed = await settingsGet("libd_closed_cases");
      closedCases.current = new Set((closed ?? "").split(",").filter(Boolean));
      setClosedLoaded(true);
    })().catch(() => setClosedLoaded(true));
  }, []);
  useEffect(() => {
    settingsSet("libd_view", view).catch(() => {});
  }, [view]);
  useEffect(() => {
    settingsSet("libd_density", String(density)).catch(() => {});
  }, [density]);
  useEffect(() => {
    settingsSet("libd_sort", sort).catch(() => {});
  }, [sort]);

  // ---- the structure, and every shelf's own order ----------------------------
  const loadTree = useCallback(async () => {
    const next = await libraryTree().catch(() => EMPTY_TREE);
    // Cases start open, as the design shows them — except any the reader closed last time.
    //
    // SEEDED IN THE SAME BATCH AS THE TREE, and this is not a style choice. Seeding after the
    // `shelf_items` await left a render in which `tree.cases` was full and `openCases` was still
    // empty; the effect below reads exactly that pair and concluded every case was closed, wrote
    // that, and the next launch opened with the whole library collapsed. Measured, not theorised:
    // it is what made every case in a real profile come up folded.
    setTree(next);
    setOpenCases((prev) =>
      prev.size ? prev : new Set(next.cases.map((c) => c.id).filter((id) => !closedCases.current.has(id))),
    );
    seeded.current = true;
    const shelves = [...next.cases.flatMap((c) => c.shelves), ...next.loose];
    const pairs = await Promise.all(
      shelves.map(async (s) => [s.id, await libraryShelfItems(s.id).catch(() => [])] as const),
    );
    setItems(Object.fromEntries(pairs));
  }, []);

  useEffect(() => {
    if (!closedLoaded) return; // else the first group runs before the closed set is known
    loadTree().catch(() => {});
  }, [loadTree, props.books, closedLoaded]);

  // Persist the collapsed cases, on the same `settings` path the view, density and sort use.
  useEffect(() => {
    if (!closedLoaded || !seeded.current || !tree.cases.length) return;
    const closed = tree.cases.map((c) => c.id).filter((id) => !openCases.has(id));
    closedCases.current = new Set(closed);
    settingsSet("libd_closed_cases", closed.join(",")).catch(() => {});
  }, [openCases, tree.cases, closedLoaded]);

  // ---- pane width, for Vista's fitted columns --------------------------------
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setPaneWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const byId = useMemo(() => new Map(props.books.map((b) => [b.id, b])), [props.books]);

  // ---- navigation -------------------------------------------------------------
  //
  // THE MODEL, in two pieces and no more: `section` says which pane, `scope` says how far into
  // the library the reader has walked. `scope` is meaningful ONLY inside the library section, and
  // the library section has exactly one root.
  //
  //   root      section = library, scope = { null, null }   — everything
  //   case      section = library, scope = { caseId, null } — one case
  //   shelf     section = library, scope = { …, shelfId }   — one shelf
  //
  // The rule that was missing: GOING TO A SECTION IS GOING TO ITS ROOT. Clicking Library set the
  // section and left `scope` alone, so "Library" meant "the case I last opened" and the pane kept
  // filtering. Leaving for Highlights and coming back restored the old case too. One helper now
  // owns that transition so no call site can forget it — which is exactly how it was forgotten.
  const atRoot = !scope.caseId && !scope.shelfId;
  const goRoot = useCallback(() => setScope({ caseId: null, shelfId: null }), []);

  const goSection = useCallback(
    (s: Section) => {
      goRoot();
      props.onSection(s);
    },
    [goRoot, props],
  );

  /**
   * EVERY structure write goes through here.
   *
   * These commands all answer with the whole tree, so the happy path was written as
   * `setTree(await thing())` — which means a rejected promise produced an unhandled rejection and
   * absolutely nothing on screen. A rename that failed looked exactly like a rename the reader had
   * not made. Now a failure is said out loud, and the tree is re-read from the database afterwards
   * so what is on screen is what was actually stored rather than an optimistic guess.
   */
  const write = useCallback(
    async (fn: () => Promise<LibraryTree>): Promise<boolean> => {
      try {
        setTree(await fn());
        return true;
      } catch (e) {
        console.error(e);
        flash(t("lib.writeFailed"));
        await loadTree().catch(() => {});
        return false;
      }
    },
    [flash, t, loadTree],
  );


  // Started and not finished — the number the reference prints beside "Reading now".
  const readingCount = useMemo(
    () => props.books.filter((b) => (b.fraction ?? 0) > 0 && (b.fraction ?? 0) < 1).length,
    [props.books],
  );

  // The node the management panel is standing over: a real case, or the synthesised group that
  // holds every shelf belonging to no case. Its count is DISTINCT books, matching a real case's.
  const editorNode = useMemo<CaseNode | null>(() => {
    if (!editorFor) return null;
    if (editorFor !== UNFILED_EDITOR) return tree.cases.find((x) => x.id === editorFor) ?? null;
    if (!tree.loose.length) return null;
    return unfiledCase(t("lib.unfiled"), tree.loose, items);
  }, [editorFor, tree.cases, tree.loose, items, t]);

  const shelfById = useMemo(() => {
    const m = new Map<string, { shelf: ShelfNode; caseNode: CaseNode | null }>();
    for (const c of tree.cases) for (const s of c.shelves) m.set(s.id, { shelf: s, caseNode: c });
    for (const s of tree.loose) m.set(s.id, { shelf: s, caseNode: null });
    return m;
  }, [tree]);

  /**
   * A scope must always name somewhere that exists.
   *
   * Delete the case you are standing in and `scope.caseId` kept pointing at it: no case matched
   * the filter any more, so the pane rendered EMPTY while the breadcrumb said "Library" — an empty
   * library with no visible reason for being empty. The same happened to a deleted shelf, and to a
   * shelf moved into a different case, which left the case and the shelf disagreeing.
   *
   * Rather than remember to clear the scope at each of the half-dozen sites that can invalidate
   * it, the scope is reconciled against the tree whenever the tree changes. A location that has
   * gone falls back to the nearest one that still exists, and in the worst case to the root.
   */
  useEffect(() => {
    if (!seeded.current) return; // nothing loaded yet; the initial scope is already the root
    setScope((s) => reconcileScope(s, tree.cases, tree.loose));
  }, [tree]);

  // Moving somewhere else drops a selection made where you were.
  //
  // Otherwise the tray goes on reporting "3 selected" over books that are no longer on screen, and
  // the next action operates on things the reader can no longer see. A carried book is deliberately
  // NOT dropped: picking one up in one case and carrying it to another is the point of carrying.
  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set<string>() : prev));
    setOrderMenuFor(null);
  }, [scope.caseId, scope.shelfId]);

  /** The full placement of a book — case, shelf and category — for Book Details' assignment path. */
  const placementOf = useCallback(
    (bookId: string) => {
      for (const [sid, list] of Object.entries(items)) {
        const row = list.find((i) => i.book_id === bookId);
        if (!row) continue;
        const entry = shelfById.get(sid);
        if (!entry || entry.shelf.auto_rule) continue; // a rule shelf is not a placement
        return { caseNode: entry.caseNode, shelf: entry.shelf, categoryId: row.category_id };
      }
      return null;
    },
    [items, shelfById],
  );

  /** Where a book lives, for the Details second line and the book sheet. */
  const placeOf = useCallback(
    (bookId: string): string => {
      for (const [sid, list] of Object.entries(items)) {
        if (list.some((i) => i.book_id === bookId)) {
          const entry = shelfById.get(sid);
          if (!entry) continue;
          return entry.caseNode ? `${entry.caseNode.name} · ${entry.shelf.name}` : entry.shelf.name;
        }
      }
      return t("lib.unfiled");
    },
    [items, shelfById, t],
  );

  // ---- what the current scope and query select -------------------------------
  const q = props.query.trim().toLowerCase();

  const shelfBooks = useCallback(
    (s: ShelfNode): BookRow[] => {
      const list = (items[s.id] ?? []).map((i) => byId.get(i.book_id)).filter((b): b is BookRow => !!b);
      return sortBooks(list, s.order_rule);
    },
    [items, byId],
  );

  /**
   * The books a shelf shows.
   *
   * There is deliberately NO text matching here. `props.books` has already been filtered by
   * `library_list_books`, whose search folds Arabic the way RAWY-178 requires — an unvocalized
   * query finds a vocalized title, and hamza/alef variants match. A second, naive
   * `toLowerCase().includes()` pass on top would DISCARD exactly the rows that folding had just
   * matched, so the library would answer قراءة but not قِراءة. The membership lookup below
   * already restricts every shelf to books that survived that query.
   */
  const filterShelf = useCallback((_s: ShelfNode, list: BookRow[]): BookRow[] => list, []);

  const rendered: CaseRender[] = useMemo(() => {
    const caseList: CaseRender[] = [];
    const wanted = (c: CaseNode) => !scope.caseId || scope.caseId === c.id;
    for (const c of tree.cases) {
      if (!wanted(c)) continue;
      const shelves: ShelfRender[] = [];
      for (const s of c.shelves) {
        if (scope.shelfId && scope.shelfId !== s.id) continue;
        const books = filterShelf(s, shelfBooks(s));
        if (q && books.length === 0 && !s.name.toLowerCase().includes(q)) continue;
        shelves.push({ shelf: s, groups: groupShelf(s, items[s.id] ?? [], byId), total: books.length });
      }
      if (shelves.length) caseList.push({ node: c, shelves });
    }
    if (!scope.caseId) {
      const shelves: ShelfRender[] = [];
      for (const s of tree.loose) {
        if (scope.shelfId && scope.shelfId !== s.id) continue;
        const books = filterShelf(s, shelfBooks(s));
        if (q && books.length === 0 && !s.name.toLowerCase().includes(q)) continue;
        shelves.push({ shelf: s, groups: groupShelf(s, items[s.id] ?? [], byId), total: books.length });
      }
      // Books on no shelf at all. Without this run they would be invisible in every grouped
      // view — which, on a library whose books have never been filed, is the whole library.
      //
      // It must survive being SCOPED TO, not just being listed. Focusing this run sets
      // `scope.shelfId` to its synthetic id; no row in `collections` can match that, so the
      // loop above yields nothing, and skipping the run here as well left the whole library
      // blank — "not on a shelf" is a real place a reader can stand in, not an absence.
      if (!scope.shelfId || scope.shelfId === LOOSE_SHELF_ID) {
        const filed = new Set<string>();
        for (const list of Object.values(items)) for (const i of list) filed.add(i.book_id);
        const loose = unshelvedBooks(props.books, filed);
        const shown = loose; // already narrowed by the folded SQL search — see `filterShelf`
        if (shown.length) {
          const shelf = makeLooseShelf(t("lib.unshelved"), shown.length);
          shelves.push({
            shelf,
            groups: [{ categoryId: null, name: null, books: sortBooks(shown, sort) }],
            total: shown.length,
          });
        }
      }
      if (shelves.length) caseList.push({ node: null, shelves });
    }
    return caseList;
  }, [tree, scope, items, byId, filterShelf, shelfBooks, q, props.books, sort, t]);

  /** Details and the counts work off one flat, sorted list. */
  const flatBooks = useMemo(() => {
    const inScope = new Set<string>();
    let any = false;
    for (const c of rendered) {
      for (const s of c.shelves) {
        any = true;
        for (const g of s.groups) for (const b of g.books) inScope.add(b.id);
      }
    }
    const base = any && (scope.caseId || scope.shelfId)
      ? props.books.filter((b) => inScope.has(b.id))
      : props.books;
    return sortBooks(base, sort === "recent" ? "recent" : sort);
  }, [rendered, props.books, q, sort, scope]);

  // Vista reads the same runs the grouped views do, so the unshelved books appear there too.
  const vistaBands: VistaBand[] = useMemo(
    () =>
      rendered.flatMap((c) =>
        c.shelves.map((s) => ({
          key: s.shelf.id,
          shelf: s.shelf,
          caseNode: c.node,
          books: isVirtualShelf(s.shelf.id)
            ? s.groups.flatMap((g) => g.books)
            : filterShelf(s.shelf, shelfBooks(s.shelf)),
          runName: null,
        })),
      ),
    [rendered, filterShelf, shelfBooks],
  );

  const heroBook = useMemo(() => {
    const started = props.books
      .filter((b) => (b.fraction ?? 0) > 0.001 && (b.fraction ?? 0) < 0.995)
      .sort((a, b) => (b.read_at ?? 0) - (a.read_at ?? 0));
    return started[0] ?? null;
  }, [props.books]);

  // ---- writes ----------------------------------------------------------------
  const place = useCallback(
    async (shelfId: string, categoryId: string | null, index: number) => {
      if (!carry) return;
      const plan = placementPlan(carry.fromShelf, shelfId);
      if (plan.kind === "none") {
        setCarry(null);
        return;
      }

      // Dropping onto the unshelved run takes the book off the shelf it came from and puts it
      // nowhere — the run is not a collection, so there is nothing to join.
      if (plan.kind === "unshelve") {
        setCarry(null);
        let ok = true;
        try {
          await collectionRemoveBook(plan.removeFrom, carry.book.id);
        } catch (e) {
          console.error(e);
          ok = false;
        }
        await loadTree();
        flash(ok ? t("lib.tookOffShelf") : t("lib.writeFailed"));
        return;
      }

      const target = shelfById.get(shelfId);
      if (target?.shelf.auto_rule) {
        flash(t("lib.cannotPlace"));
        return;
      }
      if (target && target.shelf.order_rule !== "hand") {
        flash(t("lib.cannotPlaceSorted"));
        return;
      }

      // A MOVE, not a copy. The destination is written first: if it refuses — a rule shelf, a
      // sorted shelf, a failed write — the book is still on the shelf it started on, which is
      // the state the reader can recover from. Removing first and then failing would lose it
      // from both.
      const bookId = carry.book.id;
      if (!(await write(() => shelfPlaceBook(shelfId, bookId, categoryId, index)))) {
        setCarry(null);
        return;
      }
      if (plan.kind === "move") {
        try {
          await collectionRemoveBook(plan.removeFrom, bookId);
        } catch (e) {
          // The book reached its destination but did not leave the source, so it is now on both.
          // Say so rather than report a clean move.
          console.error(e);
          await loadTree();
          setCarry(null);
          flash(t("lib.movedButNotRemoved"));
          return;
        }
      }
      await loadTree();
      setCarry(null);
      flash(`${t("lib.placed")} ${t("lib.on")} ${target?.shelf.name ?? ""}`);
    },
    [carry, shelfById, flash, t, loadTree, write],
  );

  const removeFromShelf = useCallback(
    async (bookId: string, shelfId: string) => {
      try {
        await collectionRemoveBook(shelfId, bookId);
      } catch (e) {
        console.error(e);
        flash(t("lib.writeFailed"));
      }
      await loadTree();
    },
    [loadTree, flash, t],
  );

  const setFinished = useCallback(
    async (b: BookRow, finished: boolean) => {
      try {
        await progressSave(b.id, "", finished ? 1 : 0);
      } catch (e) {
        console.error(e);
        flash(t("lib.writeFailed"));
      }
      props.onReloadBooks();
    },
    [props, flash, t],
  );

  // Where a Select-mode move should take its books OUT of, decided from the reader's actual
  // context rather than assumed. `ambiguous` is a real answer, and the tray asks rather than
  // guessing — guessing is what would destroy a second placement someone made on purpose.
  const moveSource = useMemo(
    () => selectionSource(selected, items, scope.shelfId),
    [selected, items, scope.shelfId],
  );

  /**
   * Select mode's "Move to…" — a MOVE, which means the books also LEAVE somewhere.
   *
   * `removeFrom` is the shelf the tray resolved as the source: the scoped shelf, the one shelf the
   * whole selection shares, or the one the reader named when it spanned several. It is `null` only
   * when there is genuinely nothing to leave (the books were on no shelf) or when the reader chose
   * to add without moving. NOTHING ELSE is touched — a book that also sits on two other shelves
   * keeps both, because that is a placement someone made on purpose.
   *
   * Each book is placed first and only then removed from the source, so a failure at either step
   * leaves the book somewhere rather than nowhere; a book whose placement failed is never removed
   * from where it already was.
   */
  const bulkMove = useCallback(
    async (shelfId: string, categoryId: string | null, removeFrom: string | null) => {
      const ids = [...selected];
      let placed = 0;
      let failedPlace = 0;
      let failedRemove = 0;
      for (const id of ids) {
        try {
          await shelfPlaceBook(shelfId, id, categoryId, 0);
        } catch (e) {
          console.error(e);
          failedPlace++;
          continue; // it never arrived, so it must not be taken away from where it is
        }
        if (removeFrom && removeFrom !== shelfId) {
          try {
            await collectionRemoveBook(removeFrom, id);
          } catch (e) {
            console.error(e);
            failedRemove++;
            continue; // arrived but did not leave: this book is now on both
          }
        }
        placed++;
      }
      await loadTree();
      setSelected(new Set());
      setMode("browse");
      const target = shelfById.get(shelfId);
      const name = target?.shelf.name ?? "";
      // Never announce a move that did not happen, and never call a half-move a move. A loop of
      // swallowed rejections used to end in "Placed on <shelf>" whether one book moved or none.
      if (failedPlace && !placed && !failedRemove) flash(t("lib.writeFailed"));
      else if (failedRemove) flash(t("lib.movedButNotRemoved"));
      else if (failedPlace) flash(t("lib.placedSome", { n: num(placed), failed: num(failedPlace) }));
      else if (removeFrom && removeFrom !== shelfId)
        flash(t("lib.movedOut", { n: num(placed), name: shelfById.get(removeFrom)?.shelf.name ?? "" }));
      else flash(t("lib.addedTo", { n: num(placed), name }));
    },
    [selected, loadTree, shelfById, flash, t, num],
  );

  const caseOps = useMemo(
    () => ({
      rename: (id: string, name: string) => write(() => caseRename(id, name)),
      remove: async (id: string) => {
        const name = tree.cases.find((c) => c.id === id)?.name ?? "";
        if (await write(() => caseDelete(id))) flash(t("lib.case.deleted", { name }));
        await loadTree();
      },
      move: async (id: string, direction: number) => {
        const at = tree.cases.findIndex((c) => c.id === id);
        if (at < 0) return;
        await write(() => caseReorder(id, Math.max(0, at + direction)));
      },
    }),
    [tree.cases, loadTree, write, flash, t],
  );

  // RAWY-31's rename and delete still belong to the Library above — but they write through the
  // OLD flat `shelves` state, which the design's tree knows nothing about. Without reloading the
  // tree afterwards a renamed shelf kept its old name and a deleted one stayed on screen until
  // some unrelated book reload happened to refresh it.
  const renameShelf = useCallback(
    async (id: string, name: string) => {
      props.onRenameShelf(id, name);
      await loadTree();
    },
    [props, loadTree],
  );
  const deleteShelf = useCallback(
    async (id: string) => {
      props.onDeleteShelf(id);
      if (scope.shelfId === id) setScope({ caseId: scope.caseId, shelfId: null });
      await loadTree();
    },
    [props, loadTree, scope],
  );

  const shelfOps = useMemo(
    () => ({
      setOrder: async (shelfId: string, order: ShelfOrder) => {
        await write(() => shelfSetOrder(shelfId, order));
        await loadTree();
      },
      move: async (shelfId: string, direction: number) => {
        const entry = shelfById.get(shelfId);
        const siblings = entry?.caseNode ? entry.caseNode.shelves : tree.loose;
        const at = siblings.findIndex((s) => s.id === shelfId);
        if (at < 0) return;
        await write(() => shelfReorder(shelfId, Math.max(0, at + direction)));
      },
      newCategory: async (shelfId: string) => {
        await write(() => categoryCreate(shelfId, t("lib.newCategory")));
        await loadTree();
      },
    }),
    [loadTree, t, shelfById, tree.loose],
  );

  // Esc cancels a carry, exactly as the design specifies.
  useEffect(() => {
    if (!carry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCarry(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carry]);

  // ---- chrome inputs ---------------------------------------------------------
  const scopedCase = scope.caseId ? tree.cases.find((c) => c.id === scope.caseId) ?? null : null;
  // The unshelved run is a real place to stand but not a row in `collections`, so it resolves
  // here rather than through `shelfById` — without this, focusing it left the heading and the
  // breadcrumb both claiming "Library" while the pane showed one filtered run.
  const scopedShelf: { id: string; name: string } | null = !scope.shelfId
    ? null
    : isVirtualShelf(scope.shelfId)
      ? { id: scope.shelfId, name: t("lib.unshelved") }
      : (shelfById.get(scope.shelfId)?.shelf ?? null);

  const crumbs = [
    { label: t("lib.nav.library"), go: goRoot },
    ...(scopedCase ? [{ label: scopedCase.name, go: () => setScope({ caseId: scopedCase.id, shelfId: null }) }] : []),
    ...(scopedShelf ? [{ label: scopedShelf.name, go: () => {} }] : []),
  ];

  const heading = scopedShelf ? scopedShelf.name : scopedCase ? scopedCase.name : t("lib.title");
  const vista = view === "vista";

  if (props.section !== "library") {
    return (
      // BOTH classes, deliberately. `.lib-root` is the element the RAWY-265 background system hangs
    // its two layers on (`::before` the image, `::after` the scrim), the element it gives
    // `isolation: isolate`, and the element whose `--lib-faint` it re-grounds to hold the measured
    // 3:1 floor over a photograph. Renaming the shell to `.libd-root` alone silently detached all
    // three. `.libd-root` adds only the design's variable bindings on top.
    <div className="lib-root libd-root">
        <Sidebar
          section={props.section}
          onSection={goSection}
          cases={tree.cases}
          loose={tree.loose}
          bookCount={props.books.length}
          readingCount={readingCount}
          scope={scope}
          atRoot={atRoot}
          onScope={(s) => {
            setScope(s);
            props.onSection("library");
          }}
          openCases={openCases}
          onToggleCase={(id) =>
            setOpenCases((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onNewCase={(name) => write(() => caseCreate(name))}
          onNewShelf={(caseId, name) => write(() => shelfCreate(name, caseId))}
          onRenameCase={caseOps.rename}
          onDeleteCase={caseOps.remove}
          onMoveCase={caseOps.move}
          onNewRuleShelf={(caseId) => write(() => shelfCreate(t("lib.rule.reading"), caseId, "reading"))}
          onCaseInk={(id, ink) => write(() => caseSetInk(id, ink))}
          onPlaceCase={(id, at) => write(() => caseReorder(id, at))}
          onManageUnfiled={() => setEditorFor(UNFILED_EDITOR)}
          onManageCase={setEditorFor}
          onSettings={props.onSettings}
          themeName={THEMES[themeId]?.name ?? ""}
          langName={t(lang === "ar" ? "lang.arabic" : "lang.english")}
        />
        {/* `.lib-main` + `.lib-pane` verbatim, because the section panes were written against that
            contract: `.inbox` is `height:100%; overflow:hidden`, which needs an ancestor that is
            both sized and allowed to shrink (`min-height: 0`). A hand-rolled wrapper without it
            lets those panes grow past the window instead of scrolling inside it. */}
        <div className="lib-main">
          <div className="lib-pane">{props.renderSection(props.section)}</div>
        </div>
      </div>
    );
  }

  return (
    // BOTH classes, deliberately. `.lib-root` is the element the RAWY-265 background system hangs
    // its two layers on (`::before` the image, `::after` the scrim), the element it gives
    // `isolation: isolate`, and the element whose `--lib-faint` it re-grounds to hold the measured
    // 3:1 floor over a photograph. Renaming the shell to `.libd-root` alone silently detached all
    // three. `.libd-root` adds only the design's variable bindings on top.
    <div className="lib-root libd-root">
      <Sidebar
        section={props.section}
        onSection={goSection}
        cases={tree.cases}
        loose={tree.loose}
        bookCount={props.books.length}
        readingCount={readingCount}
        scope={scope}
        atRoot={atRoot}
        onScope={setScope}
        openCases={openCases}
        onToggleCase={(id) =>
          setOpenCases((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onNewCase={(name) => write(() => caseCreate(name))}
        onNewShelf={(caseId, name) => write(() => shelfCreate(name, caseId))}
        onRenameCase={caseOps.rename}
        onDeleteCase={caseOps.remove}
        onMoveCase={caseOps.move}
        onNewRuleShelf={(caseId) => write(() => shelfCreate(t("lib.rule.reading"), caseId, "reading"))}
          onCaseInk={(id, ink) => write(() => caseSetInk(id, ink))}
          onPlaceCase={(id, at) => write(() => caseReorder(id, at))}
          onManageUnfiled={() => setEditorFor(UNFILED_EDITOR)}
          onManageCase={setEditorFor}
        onSettings={props.onSettings}
        themeName={THEMES[themeId]?.name ?? ""}
        langName={t(lang === "ar" ? "lang.arabic" : "lang.english")}
      />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          // TRANSPARENT, always. The old `.lib-main` painted nothing for the same reason: the
          // ground belongs to `.lib-root`, and a chosen background image lives between the two.
          // Painting `--pap` here is what hid the image behind every non-Vista view.
          background: "transparent",
        }}
      >
        {vista && <VistaEnvironment dark={dark} hasUserBackground={hasUserBackground} />}

        <Header
          crumbs={crumbs}
          heading={heading}
          subcount={t("lib.count", { n: num(flatBooks.length) })}
          mode={mode}
          onToggleSelect={() => {
            setMode((m) => (m === "select" ? "browse" : "select"));
            setSelected(new Set());
          }}
          onToggleArrange={() => {
            setMode((m) => (m === "arrange" ? "browse" : "arrange"));
            setCarry(null);
          }}
          onAddBooks={props.onAddBooks}
          importing={props.importing}
          query={props.query}
          onQuery={props.onQuery}
          view={view}
          onView={setView}
          density={density}
          onDensity={setDensity}
          sort={sort}
          onSort={setSort}
          overEnvironment={vista}
          coverMode={props.coverMode}
          onCoverMode={props.onCoverMode}
          format={props.format}
          onFormat={props.onFormat}
        />

        {/* GRID is Sard's original grid, rendered as it always was: `.lib-grid` is itself
            `flex:1; overflow:auto` with its own padding, so it must be a direct flex child and
            must NOT be nested inside the scroller the new views use — that would give it a
            second scrollbar and override the padding RAWY-170 set to clear the rosette. */}
        {view === "grid" ? (
          <div
            ref={paneRef}
            className="libd-stage"
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 2 }}
          >
            {props.renderGrid()}
          </div>
        ) : (
        <div
          ref={paneRef}
          className="libd-stage"
          style={{
            flex: 1,
            minHeight: 0,
            position: "relative",
            zIndex: 2,
            overflowX: "hidden",
            scrollbarGutter: "stable",
            overflowY: "auto",
            padding: vista ? "22px 0 46px" : "18px 0 110px",
          }}
        >
          {view === "details" ? (
            <ViewDetails
              books={flatBooks}
              placeOf={placeOf}
              sort={sort}
              onSort={setSort}
              selected={selected}
              selectOn={mode === "select"}
              onOpenBook={props.onOpenBook}
              onToggleSelect={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          ) : vista ? (
            <>
              <VistaHero
                book={heroBook}
                where={heroBook ? placeOf(heroBook.id) : ""}
                onOpen={() => heroBook && props.onOpenBook(heroBook)}
                onDetails={() => heroBook && setDetailsFor(heroBook)}
              />
              <ViewVista
                bands={vistaBands}
                density={density}
                paneWidth={paneWidth}
                focused={!!scope.shelfId}
                mode={mode}
                selected={selected}
                carryId={carry?.book.id ?? null}
                onOpenShelf={(id) => setScope((s) => ({ ...s, shelfId: id }))}
                onOpenBook={props.onOpenBook}
                onEditBook={setDetailsFor}
                onToggleSelect={(id) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onPickUp={(b, shelfId) => setCarry({ book: b, fromShelf: shelfId })}
                onRemoveFromShelf={removeFromShelf}
                onSetFinished={setFinished}
                onPlace={place}
                libraryCoverMode={props.coverMode}
              />
            </>
          ) : isGroupedView(view) ? (
            <ViewGrouped
              cases={rendered}
              view={view}
              density={density}
              paneWidth={paneWidth}
              mode={mode}
              selected={selected}
              carryId={carry?.book.id ?? null}
              openCases={openCases}
              onToggleCase={(id) =>
                setOpenCases((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onFocusCase={(id) => setScope({ caseId: id, shelfId: null })}
              onFocusShelf={(id) => setScope((s) => ({ ...s, shelfId: id }))}
              onToggleShelf={async (s) => {
                await write(() => shelfSetCollapsed(s.id, !s.collapsed));
              }}
              onOpenBook={props.onOpenBook}
              onEditBook={setDetailsFor}
              onToggleSelect={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onPickUp={(b, shelfId) => setCarry({ book: b, fromShelf: shelfId })}
              onRemoveFromShelf={removeFromShelf}
              onSetFinished={setFinished}
              onNewShelf={(caseId) => write(() => shelfCreate(t("lib.shelf.untitled"), caseId))}
              onManageCase={(id) => setEditorFor(id)}
              expandedShelves={expandedShelves}
              onExpandShelf={(id) => setExpandedShelves((prev) => new Set(prev).add(id))}
              carryWidth={carry ? spineWidth(carry.book, density) : 0}
              carryFromUnshelved={!!carry && isVirtualShelf(carry.fromShelf)}
              orderMenuFor={orderMenuFor}
              onOpenOrder={setOrderMenuFor}
              onSetOrder={shelfOps.setOrder}
              renamingShelf={renamingShelf}
              onRenameShelf={setRenamingShelf}
              onCommitRename={(id, name) => {
                setRenamingShelf(null);
                // `renameShelf`, not `props.onRenameShelf`: the wrapper is what re-reads the tree
                // afterwards. Calling the raw prop here left the renamed shelf showing its old
                // name in this very view until something else happened to reload.
                if (name.trim()) renameShelf(id, name.trim());
              }}
              onDeleteShelf={deleteShelf}
              onNewCategory={shelfOps.newCategory}
              onShelfInk={(id, ink) => write(() => shelfSetInk(id, ink))}
              onSetShelfCase={async (id, caseId) => { await write(() => shelfSetCase(id, caseId)); await loadTree(); }}
              onMoveShelf={shelfOps.move}
              onPlace={place}
              libraryCoverMode={props.coverMode}
            />
          ) : null}

          {flatBooks.length === 0 && (
            <div style={{ maxWidth: 430, margin: "60px auto", textAlign: "center", padding: "0 20px" }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  margin: "0 auto 18px",
                  border: "1.5px solid var(--rule)",
                  borderRadius: 3,
                  position: "relative",
                  opacity: 0.7,
                }}
              />
              <div style={{ font: "600 1.125rem var(--book)", marginBottom: 8 }}>{t("lib.noResults")}</div>
              <p style={{ margin: "0 0 18px", font: "400 .8125rem/1.65 var(--ui)", color: "var(--mut)" }}>
                {t("lib.noResultsBody")}
              </p>
              {props.query && (
                <button
                  className="libd-hov"
                  onClick={() => props.onQuery("")}
                  style={{
                    height: 32,
                    padding: "0 15px",
                    borderRadius: 9,
                    border: "1px solid var(--brd)",
                    background: "var(--soft)",
                    font: "500 .75rem var(--ui)",
                  }}
                >
                  {t("lib.clearSearch")}
                </button>
              )}
            </div>
          )}
        </div>
        )}

        {carry && (
          <div
            style={{
              position: "absolute",
              insetInline: 0,
              bottom: 0,
              zIndex: 85,
              background: "var(--chr)",
              borderTop: "1px solid var(--brd)",
              boxShadow: "var(--sh3)",
              padding: "11px 24px",
              display: "flex",
              alignItems: "center",
              gap: 18,
              animation: "sard-rise .16s ease-out",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  font: "600 .625rem var(--ui)",
                  letterSpacing: ".13em",
                  textTransform: "uppercase",
                  color: "var(--acc)",
                }}
              >
                {t("lib.inHand")}
              </div>
              <div style={{ font: "500 .8125rem var(--ui)", overflow: "hidden", textOverflow: "ellipsis" }}>
                {carry.book.title}
              </div>
            </div>
            <span style={{ flex: 1, font: "400 .75rem var(--ui)", color: "var(--mut)" }}>
              {t("lib.arrangeHintOn")}
            </span>
            <button
              className="libd-hov libd-hov-txt"
              onClick={() => setCarry(null)}
              style={{
                height: 30,
                padding: "0 12px",
                borderRadius: 9,
                border: "1px solid var(--brd)",
                font: "500 .75rem var(--ui)",
                color: "var(--mut)",
              }}
            >
              {t("lib.cancel")}
            </button>
          </div>
        )}

        <SelectTray
          selected={[...selected]}
          byId={byId}
          cases={tree.cases}
          loose={tree.loose}
          source={moveSource}
          shelfName={(id) => shelfById.get(id)?.shelf.name ?? id}
          onMove={bulkMove}
          onClear={() => {
            setSelected(new Set());
            setMode("browse");
          }}
        />

        {toast && (
          <div
            style={{
              position: "absolute",
              insetInline: 0,
              bottom: 78,
              display: "flex",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 90,
            }}
          >
            <div
              style={{
                background: "var(--txt)",
                color: "var(--pap)",
                borderRadius: 20,
                padding: "8px 18px",
                font: "500 .75rem var(--ui)",
                boxShadow: "var(--sh3)",
                animation: "sard-fade .16s ease-out",
              }}
            >
              {toast}
            </div>
          </div>
        )}
      </div>

      {/* The management panel. A real case supplies its own node; the unfiled group is given a
          synthesised one carrying the loose shelves, so an un-cased shelf can be renamed, ordered,
          coloured, reordered, filed into a case and deleted through exactly the same panel — and
          the sidebar shelf row stays the mark/name/count the reference draws. */}
      {editorNode && (
        <CaseEditor
          caseNode={editorNode}
          unfiled={editorFor === UNFILED_EDITOR}
          cases={tree.cases}
          byId={byId}
          items={items}
          onTree={setTree}
          onChanged={() => {
            loadTree().catch(() => {});
            props.onReloadBooks();
          }}
          onClose={() => setEditorFor(null)}
          onOpenBookDetails={setDetailsFor}
          notify={flash}
        />
      )}

      {carry && <CarryGhost book={carry.book} spines={view === "spines"} />}

      {/* Book Details, from the reference bundles. One dialog, mounted once here, so it is the
          same dialog with the same controls whichever view opened it. */}
      {detailsFor && (
        <BookDetails
          book={detailsFor}
          cases={tree.cases}
          loose={tree.loose}
          placement={placementOf(detailsFor.id)}
          notify={flash}
          libraryCoverMode={props.coverMode}
          onClose={() => setDetailsFor(null)}
          onChanged={() => {
            loadTree().catch(() => {});
            props.onReloadBooks();
          }}
        />
      )}
    </div>
  );
}
