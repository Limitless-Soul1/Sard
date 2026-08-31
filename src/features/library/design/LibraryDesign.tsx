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
import { coverSrc } from "../coverSrc";
import type { CardOrder } from "../Library";
import type { BookRow, CaseNode, LibraryTree, Placement, ShelfItem, ShelfNode } from "../../../lib/ipc";
import { buildArrangement } from "./arrangement";
import {
  applyRunOrder,
  baselineBySection,
  bySection,
  isNoMoveInRun,
  promoteRecent,
  scopeKey,
  WHOLE_RUN,
  type SavedOrders,
} from "./viewOrder";
import { Icon } from "../../../components/Icon";
import { OVERLAY_HOST_CLASS } from "./overlay";
import { CreateDialog, type CreateRequest } from "./CreateDialog";
import {
  caseCreate,
  caseDelete,
  caseRename,
  caseReorder,
  libraryArrangement,
  libraryPlaceBook,
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
  viewOrdersForScope,
  viewOrderReorder,
} from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { useTheme, resolveTheme } from "../../../theme";
import { useBackground } from "../../../lib/background";
import { Header, Sidebar, type PlaceLine, type Scope, type Section } from "./Chrome";
import { ViewGrouped, type CaseRender, type ShelfRender } from "./ViewGrouped";
import { ViewDetails } from "./ViewDetails";
import { VistaEnvironment, ViewVista } from "./ViewVista";
import { CarryGhost, SelectTray } from "./Menus";
import type { BookActionsProps } from "./BookActions";
import { BookDetails } from "./BookDetails";
import { CaseEditor } from "./CaseEditor";
import {
  baseWidth,
  DESIGN_VIEWS,
  groupShelf,
  isGroupedView,
  asShelfOrder,
  vistaArrangeable,
  isLibraryTree,
  isVirtualShelf,
  isFinished,
  LOOSE_SHELF_ID,
  makeLooseShelf,
  closedGroups,
  openGroups,
  reconcileScope,
  parentScope,
  parseScope,
  serialiseScope,
  ROOT_SCOPE,
  spineWidth,
  selectionSource,
  sortBooks,
  vistaView,
  unfiledCase,
  UNFILED_CASE_ID,
  type DesignSort,
  type DesignView,
} from "./model";
import { createPortal } from "react-dom";
import { overlayHost } from "./overlay";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { createEdgeScroller, type EdgeScroller } from "./dragScroll";
import { emptyKind, libraryIsBare, type EmptyKind } from "./emptyState";
import { Hoopoe } from "../Hoopoe";
import { useDialog } from "../../../components/useDialog";
import type { TKey } from "../../../i18n/locales/en";

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
  /**
   * Grid is Sard's original library grid and stays that way. Called with nothing, it draws what it
   * always drew. Standing inside a shelf, this surface hands it that shelf's books in the shelf's
   * own order, a place-renderer to interleave between them, and the shared pickup descriptor for
   * each card — which is the whole of what manual ordering needs. See `CardOrder` in Library.tsx.
   */
  renderGrid: (g?: {
    books: BookRow[];
    /** A landing place before this book, when it is a shelf-mate of the one in hand. */
    gap: (b: BookRow) => React.ReactNode;
    /** The place after the whole list — "put it last on its own shelf". */
    gapAfter: (b: BookRow) => React.ReactNode;
    order: (b: BookRow) => CardOrder | undefined;
    /**
     * What can be DONE with a book — the same answer every other view gets.
     *
     * Grid used to be handed only the ordering descriptor, so it grew its own idea of a book's
     * actions: one button that opened Sard's older editor, with no menu, no Open in folder and no
     * Mark read. Handing the actions across the same boundary as the order is what stops a format
     * from having to invent them, and stops the answer drifting per view.
     */
    actions: (b: BookRow) => BookActionsProps;
    /** The Library's "hide names until touched" preference, for the caption Grid draws itself. */
    hideTitles?: boolean;
    /**
     * The cover size the reader has chosen, as a CSS length for Grid's `minmax()` floor.
     *
     * Grid had no size control because it never read density: its stylesheet said
     * `minmax(148px, 1fr)`, a hardcoded floor which happens to be `DENSITY_WIDTHS[2]` exactly.
     * Measured, all four steps drew an identical 179px card — 1 distinct layout out of 4. Covers
     * uses the very same mechanism (`minmax(iw, 1fr)`) and simply passes a real width, so this is
     * the whole of what Grid was missing.
     */
    coverMin?: number;
  }) => React.ReactNode;
  /** Grid's own cover-fit control, which belongs to that view and only appears with it. */
  coverMode: "crop" | "fit";
  onCoverMode: () => void;
  /** RAWY-15's EPUB/PDF filter — applied in SQL, so it belongs to the owner of the query. */
  format: string | null;
  onFormat: (f: string | null) => void;
  onOpenBook: (b: BookRow) => void;
  onEditBook: (b: BookRow) => void;
  onAddBooks: () => void;
  /**
   * DELETE A BOOK FROM THE LIBRARY — through the owner's own `bookDelete` path, not a second one.
   *
   * The design layer asks and confirms; the library performs the delete and reloads, because that
   * is where the reload and the toast already live — `onDeleted` on the edit dialog has done
   * exactly this since RAWY-76.
   */
  onDeleteBook: (book: BookRow) => void | Promise<void>;
  importing: boolean;
  onSettings: () => void;
  onReloadBooks: () => void;
  query: string;
  onQuery: (q: string) => void;
  onRenameShelf: (id: string, name: string) => void;
  onDeleteShelf: (id: string) => void;
}

/** Where the reader's order for books on no shelf is kept. See `applyLooseOrder`. */

export function LibraryDesign(props: LibraryDesignProps) {
  const { t, lang } = useI18n();
  const themeId = useTheme((s) => s.themeId);
  const dark = resolveTheme(themeId).dark;
  // Whether a library background image is actually in force — the same two pieces of store state
  // `applyBackgrounds` gates the `data-bg-library` attribute on.
  const bgEnabled = useBackground((s) => s.enabled);
  const bgLibrary = useBackground((s) => s.library);
  const hasUserBackground = bgEnabled && !!bgLibrary;
  const num = (n: number) => localeNum(n, lang);

  const [tree, setTree] = useState<LibraryTree>(EMPTY_TREE);
  /**
   * WHERE EVERY BOOK IS — the whole arrangement, as persistence last returned it.
   *
   * One piece of state, holding one placement per book. It replaces three things that used to be
   * kept apart and could disagree: a per-shelf membership map, a separately remembered order for
   * the books on no shelf, and whatever each view worked out for itself. The books on no shelf are
   * an ordinary container here, so their order is in the library rather than in a settings key that
   * nothing could keep honest — measured, that key named five books out of thirty-nine and three of
   * the ids it did name were no longer unshelved.
   */
  const [placements, setPlacements] = useState<Placement[]>([]);
  /**
   * What each rule shelf currently matches.
   *
   * Kept apart from the placements on purpose. A lens observes books; it never holds one. Merging
   * the two is what let a book listed in «قيد القراءة» be treated as living there — so the grouped
   * views called that its home, offered it that shelf's positions, and drew it a second time.
   */
  const [lenses, setLenses] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<DesignView>("covers");
  const [density, setDensity] = useState(1);
  // NAMES OUT OF THE WAY UNTIL A BOOK IS TOUCHED — a Library preference, stored exactly the way the
  // view, the density, the sort and the scope are. Off is the current behaviour, so a reader who
  // never opens the control sees no change at all.
  const [hideTitles, setHideTitles] = useState(false);
  const [sort, setSort] = useState<DesignSort>("recent");
  const [scope, setScope] = useState<Scope>(ROOT_SCOPE);
  const [openCases, setOpenCases] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"browse" | "select" | "arrange">("browse");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [carry, setCarry] = useState<{ book: BookRow; fromShelf: string } | null>(null);
  const [orderMenuFor, setOrderMenuFor] = useState<string | null>(null);
  const [renamingShelf, setRenamingShelf] = useState<string | null>(null);
  // Shelves the reader has expanded past the reference's two-row cap.
  const [expandedShelves, setExpandedShelves] = useState<Set<string>>(new Set());
  // The book the dialog is open on, AND the shelf the reader opened it from — a book can be on
  // several shelves, and a move has to leave the one they were looking at.
  const [detailsFor, setDetailsFor] = useState<{ book: BookRow; fromShelf: string | null } | null>(null);
  // Which case the management panel is open on — the reference's "Manage" destination.
  // `UNFILED_EDITOR` opens the same panel over the shelves that belong to no case.
  const [editorFor, setEditorFor] = useState<string | null>(null);
  /**
   * MAKING A SHELF OR A CASE — one request, whoever asked.
   *
   * The sidebar's foot action, a case's own ⋯ menu, and the grouped views' "+ new shelf" all set
   * this and nothing else. They differ only in the case they name, which the dialog opens on and
   * the reader can change. Before this the first two carried a form each and the third made an
   * untitled shelf on the spot, so "add a shelf" meant three different things.
   */
  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /**
   * THE SAVED ORDERS FOR THIS FORMAT, AT THIS PLACE — every section of it, in one statement.
   *
   * Keyed by section, because a grouped format draws several at once and each is rearranged on
   * its own. Empty for a run nobody has arranged, which is not an error: it means the run keeps
   * the order it is given.
   */
  const [savedOrders, setSavedOrders] = useState<SavedOrders>(() => new Map());
  /**
   * WHEN EACH RUN OF THIS SCOPE WAS LAST ARRANGED BY HAND.
   *
   * Reading promotes a book only if it was read after its run's stamp, which is what lets a
   * reading-aware order and a hand-made one be the same order rather than two that fight. Loaded on
   * the same rows as `savedOrders`, from the same statement.
   */
  const [baselines, setBaselines] = useState<Map<string, number>>(() => new Map());
  /** The floor for a run that has never been arranged and so has no stamp of its own. */
  const [epoch, setEpoch] = useState(0);
  // Which cases the reader had collapsed, restored before the tree is first grouped so a
  // collapsed case never flashes open on the way in.
  const closedCases = useRef<Set<string>>(new Set());
  // Set once the open/closed set has actually been seeded from the tree, so the persistence
  // effect below can never write before there is anything true to write.
  const seeded = useRef(false);
  // Set once `libd_scope` has actually been read back, so nothing is written over it before then.
  const scopeLoaded = useRef(false);
  /**
   * The same guard, for the three preferences that always had it coming.
   *
   * Each of these effects also runs on MOUNT, with the value still at its default — so the first
   * render wrote "covers" over the reader's chosen view, and the read that was already in flight
   * came back with whatever won the race. Measured: storing `vista`, reloading, and reading it back
   * gave `covers` every time, which is why the view never survived a restart. Invisible until now
   * only because the value it clobbered to was the default.
   */
  const prefsLoaded = useRef(false);
  const [closedLoaded, setClosedLoaded] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(1180);

  // ---- persisted preferences -------------------------------------------------
  useEffect(() => {
    (async () => {
      const [v, d, s, h] = await Promise.all([
        settingsGet("libd_view"),
        settingsGet("libd_density"),
        settingsGet("libd_sort"),
        settingsGet("libd_hide_titles"),
      ]);
      if (v && (DESIGN_VIEWS as string[]).includes(v)) setView(v as DesignView);
      const dn = Number(d);
      if (Number.isFinite(dn) && dn >= 0 && dn <= 3) setDensity(dn);
      if (s) setSort(s as DesignSort);
      setHideTitles(h === "1");
      prefsLoaded.current = true;
      // WHERE THE READER WAS STANDING. Restored before the tree arrives and reconciled against it
      // the moment it does, so a case or category deleted since the last session pulls the reader
      // back to somewhere that exists instead of onto an empty pane.
      setScope(parseScope(await settingsGet("libd_scope")));
      scopeLoaded.current = true;
      // CLOSED cases are what is stored, not open ones: a case made after this was written
      // should appear open, which is the design's own default, and storing the closed set is
      // what makes that true without special-casing anything.
      const closed = await settingsGet("libd_closed_cases");
      closedCases.current = new Set((closed ?? "").split(",").filter(Boolean));
      setClosedLoaded(true);
    })().catch(() => { prefsLoaded.current = true; scopeLoaded.current = true; setClosedLoaded(true); });
  }, []);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    settingsSet("libd_view", view).catch(() => {});
  }, [view]);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    settingsSet("libd_density", String(density)).catch(() => {});
  }, [density]);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    settingsSet("libd_sort", sort).catch(() => {});
  }, [sort]);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    settingsSet("libd_hide_titles", hideTitles ? "1" : "").catch(() => {});
  }, [hideTitles]);
  useEffect(() => {
    // NOT BEFORE IT HAS BEEN READ. This effect also runs on mount, when `scope` is still the root
    // it was initialised to — so without the guard the first render writes "no scope" over wherever
    // the reader actually was, and the read that follows finds only what the write just put there.
    // `libd_closed_cases` guards itself the same way, for the same reason.
    if (!scopeLoaded.current) return;
    settingsSet("libd_scope", serialiseScope(scope)).catch(() => {});
  }, [scope]);

  // ---- the structure, and every shelf's own order ----------------------------
  /**
   * The ONLY way the tree reaches state.
   *
   * The tree and the open/closed set have to move together, in one batch. The persistence effect
   * below reads exactly that pair, so any render where they disagree is written to the database as
   * fact — and it was: `write()` used to call `setTree` alone, so a case created through the UI
   * arrived in `tree.cases` while `openCases` still held the set from before it existed. The effect
   * read that pair, concluded the new case was closed, and stored it. The case then drew collapsed,
   * and a collapsed case renders no shelf list, so "New shelf" from its own menu had nowhere to put
   * its input and appeared to do nothing.
   *
   * A case is open unless the reader closed it. The closed set is the record of deliberate
   * collapses, so consulting it on every tree is both simpler and correct: a new case opens, a
   * folded one stays folded.
   */
  // The tree as it stands, readable from a callback without making that callback change identity
  // on every write — which is what a dependency on `tree` would do.
  const treeRef = useRef<LibraryTree>(EMPTY_TREE);

  const applyTree = useCallback((next: LibraryTree) => {
    // A command that answers with something other than a tree used to reach here and blank the
    // window — an empty React root, no sidebar, nothing to click, and the only clue in a console
    // nobody has open. Refusing it turns that into an ordinary reported write failure, which the
    // callers already know how to show and recover from by re-reading the structure.
    if (!isLibraryTree(next)) throw new Error("library write answered with something that is not a tree");
    treeRef.current = next;
    setTree(next);
    setOpenCases(() => openGroups(next.cases.map((c) => c.id), closedCases.current));
    seeded.current = true;
  }, []);

  /**
   * THE WHOLE ARRANGEMENT, IN ONE READ.
   *
   * This used to ask every shelf in turn — six or more parallel requests on every write — and two
   * ways of lying came out of that, both of which the reader experienced as «Manual Ordering is
   * flaky»:
   *
   *  1 · A FAILED READ BECAME AN EMPTY SHELF. One refused request turned into «that shelf holds
   *      nothing»: no books drawn along it, no landing places, and a book whose home it was left
   *      with no position to be dropped next to. Measured — a shelf drawing 0 books in Covers while
   *      Grid and the database both held 7.
   *
   *  2 · AN OLDER ANSWER COULD LAND ON TOP OF A NEWER ONE. Nothing sequenced the passes, so a slow
   *      earlier one could overwrite the pass that ran after a write, and the screen would show the
   *      state before the drop while the database held the state after it.
   *
   * Both were treated with tickets and with «unknown is not empty». Neither can arise now: it is a
   * single statement, and a single statement cannot be read half way through or answered out of
   * order. The apparatus that guarded against them is gone with the thing it guarded.
   */
  const refreshArrangement = useCallback(async () => {
    try {
      const a = await libraryArrangement();
      applyTree(a.tree);
      setPlacements(a.placements);
      setLenses(Object.fromEntries(a.lenses.map((l) => [l.shelf_id, l.book_ids])));
      setEpoch(a.view_order_epoch ?? 0);
    } catch (e) {
      // A read that fails leaves the last true answer on screen rather than emptying the library.
      console.error("the arrangement could not be read", e);
    }
  }, [applyTree]);

  const loadTree = refreshArrangement;

  /**
   * Did this write change what is ON a shelf?
   *
   * A shelf's count IS its membership size, so a join or a leave always moves one. Structural writes
   * — renaming a case, re-inking one, creating a shelf — never do, which is what keeps this from
   * re-reading every shelf on operations that cannot have changed one.
   *
   * A REORDER within one shelf moves no count, and is deliberately not covered here: the drag path
   * that performs one already re-reads at the end of the whole operation.
   */
  const countsMoved = (a: LibraryTree, b: LibraryTree) => {
    const counts = (t: LibraryTree) =>
      [...t.cases.flatMap((c) => c.shelves), ...t.loose].map((s) => s.id + ":" + s.count).join("|");
    return counts(a) !== counts(b);
  };

  useEffect(() => {
    if (!closedLoaded) return; // else the first group runs before the closed set is known
    loadTree().catch(() => {});
  }, [loadTree, props.books, closedLoaded]);

  // Persist the collapsed cases, on the same `settings` path the view, density and sort use.
  useEffect(() => {
    if (!closedLoaded || !seeded.current) return;
    const closed = closedGroups(tree.cases.map((c) => c.id), openCases);
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
  const goRoot = useCallback(() => setScope(ROOT_SCOPE), []);

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
   *
   * The answer goes through `applyTree`, never `setTree`: see the note there for what a bare
   * `setTree` did to a case created through the UI.
   */
  /**
   * One write, and the state that must follow it.
   *
   * `applyTree` alone was not enough: the tree carries structure and counts, but the membership map
   * `items` — which is what every view reads a shelf's CONTENTS from — lived only in `loadTree`.
   * Every caller happened to reload afterwards, so nothing was broken; the next one that forgot
   * would have shown a shelf whose count had moved and whose books had not.
   *
   * `deferItems` is for a caller that performs several writes and re-reads once at the end, so this
   * does not add a second pass to an operation that already has one.
   */
  const write = useCallback(
    async (fn: () => Promise<LibraryTree>, opts?: { deferItems?: boolean }): Promise<boolean> => {
      try {
        const before = treeRef.current;
        const next = await fn();
        applyTree(next);
        if (!opts?.deferItems && countsMoved(before, next)) await refreshArrangement();
        return true;
      } catch (e) {
        console.error(e);
        flash(t("lib.writeFailed"));
        await loadTree().catch(() => {});
        return false;
      }
    },
    [flash, t, loadTree, applyTree],
  );


  // Started and not finished — the number the reference prints beside "Reading now".

  /**
   * THE ARRANGEMENT — built once, read by everything, re-derived by nothing.
   *
   * Every question about where a book is and what order a container is in is answered from here.
   * No view computes any of it, which is the mechanism that stops the five formats disagreeing:
   * for Grid and Covers to give a book different homes they would have to be reading different
   * data, and there is only one place to read from.
   *
   * The known containers include EVERY hand shelf, even one that holds nothing, because an empty
   * shelf is a real destination and a model that only knew about containers with books in them
   * would quietly make it unreachable.
   */
  const writableContainers = useMemo(() => {
    const out = [LOOSE_SHELF_ID];
    for (const c of tree.cases) for (const sh of c.shelves) if (!sh.auto_rule) out.push(sh.id);
    for (const sh of tree.loose) if (!sh.auto_rule) out.push(sh.id);
    return out;
  }, [tree]);

  const arrangement = useMemo(
    () => buildArrangement(placements, writableContainers),
    [placements, writableContainers],
  );

  /**
   * The arrangement as a per-container map, for the grouping and selection helpers that were
   * written against that shape.
   *
   * There used to be two of these maps: `items`, holding one entry per real shelf, and `homes`,
   * which was `items` plus a synthesised entry for the books on no shelf. Two names for one idea,
   * and code that reached for the wrong one silently excluded thirty-nine of forty-four books.
   * There is one now, derived from the arrangement, and the unfiled container is simply in it.
   */
  const shelfRows = useMemo<Record<string, ShelfItem[]>>(() => {
    const out: Record<string, ShelfItem[]> = {};
    for (const container of arrangement.containers) {
      out[container] = arrangement
        .orderOf(container)
        .map((entry, i) => ({ book_id: entry.id, position: i, category_id: entry.categoryId }));
    }
    return out;
  }, [arrangement]);

  // The node the management panel is standing over: a real case, or the synthesised group that
  // holds every shelf belonging to no case. Its count is DISTINCT books, matching a real case's.
  const editorNode = useMemo<CaseNode | null>(() => {
    if (!editorFor) return null;
    if (editorFor !== UNFILED_EDITOR) return tree.cases.find((x) => x.id === editorFor) ?? null;
    if (!tree.loose.length) return null;
    return unfiledCase(t("lib.unfiled"), tree.loose, shelfRows);
  }, [editorFor, tree.cases, tree.loose, shelfRows, t]);


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

  /**
   * The full placement of a book — case, shelf and category — for Book Details' assignment path.
   *
   * There is nothing to choose between any more. This used to weigh a book's several memberships
   * against each other, preferring the shelf the reader had opened it from because tree order meant
   * nothing to them; a book has one placement now, so the question it answered no longer exists.
   */
  const placementOf = useCallback(
    (bookId: string) => {
      const container = arrangement.containerOf(bookId);
      if (!container || container === LOOSE_SHELF_ID) return null;
      const entry = shelfById.get(container);
      if (!entry) return null;
      return { caseNode: entry.caseNode, shelf: entry.shelf, categoryId: arrangement.categoryOf(bookId) };
    },
    [arrangement, shelfById],
  );

  /**
   * The books that are on no shelf, in their own order.
   *
   * Once a derived run with its order kept in a settings key beside the library; now simply one
   * container among the others, read from the same place as every shelf.
   */
  const looseRun = useMemo(
    () => {
      const order = arrangement.orderOf(LOOSE_SHELF_ID);
      const byId = new Map(props.books.map((b) => [b.id, b]));
      return order.map((p) => byId.get(p.id)).filter((b): b is BookRow => !!b);
    },
    [arrangement, props.books],
  );

  /**
   * THE CONTAINER A BOOK IS IN. One lookup, no candidates, no preference order.
   *
   * This used to weigh a book's several memberships against one another — preferring the shelf the
   * reader had opened it from, skipping any rule shelf — because a book could have more than one
   * home and something had to choose. It has one, so there is nothing to choose. Every book has an
   * answer, including a book on no shelf: that is the unfiled container, not an absence.
   */
  const orderSourceOf = useCallback(
    (bookId: string): string | null => arrangement.containerOf(bookId),
    [arrangement],
  );

  /**
   * THE SHELF A DRAG SHOULD LEAVE — the book's own, not the section it happened to be drawn under.
   *
   * Covers, Spines and Vista hand the drag the id of the SHELF SECTION the tile was drawn in. A book
   * can be drawn in several: `c10918` is on the hand shelf «To read» AND matches the rule shelf
   * «قيد القراءة», and the case renders before the loose shelves, so the copy nearest the top of the
   * page — the one a reader is most likely to grab — is the RULE-SHELF copy.
   *
   * That made the source a rule shelf, and `placementPlan` turns a rule source into an ADD, because
   * a rule shelf holds no membership row to delete. The book therefore arrived on the destination
   * and stayed on «To read» as well. Measured: dragging it onto «test1» gave test1 ["c10918@0"] with
   * «To read» unchanged — a copy, where the reader had asked for a move.
   *
   * A rule shelf and the unshelved run are both VIEWS of a book rather than places it is filed, so
   * neither can be what a move leaves. When the section is one of those, the book's real membership
   * is used instead — and when it genuinely has none, the section stands and the placement is an
   * add, which is correct: there is nothing to leave.
   */
  const sourceFor = useCallback(
    (book: BookRow, sectionShelfId: string): string => {
      const entry = shelfById.get(sectionShelfId);
      const sectionIsAPlace =
        !!entry && !entry.shelf.auto_rule && !isVirtualShelf(sectionShelfId);
      if (sectionIsAPlace) return sectionShelfId;
      return orderSourceOf(book.id) ?? sectionShelfId;
    },
    [shelfById, orderSourceOf],
  );

  /**
   * WHERE A RELEASE AT THIS POINT WOULD PUT THE BOOK.
   *
   * A landing place under the pointer answers for itself. But a reader does not aim at the dashed
   * placeholder between two covers — they drag the book to WHERE THEY WANT IT, which is on top of
   * another book, and let go. Until this existed the release asked only for `[data-drop-shelf]`,
   * found nothing, and put the book down again having written nothing at all. Measured in Grid and
   * in Covers: released over a cover, the pointer was over `img.real`, no target was lit, and the
   * backend did not change. That is the whole of "I let go and nothing happens".
   *
   * So a book is a landing place too. Each one carries the shelf it is drawn under and its index
   * there, and the half of it the pointer is in decides whether the carried book lands before or
   * after it — inline for a grid of covers, vertical for a list of rows, and mirrored under RTL,
   * where "after" is to the LEFT.
   *
   * A rule shelf and the unshelved run are not destinations: the backend refuses the first and the
   * second is not a collection. Their books resolve to nothing rather than to a target that would
   * be rejected on release.
   */
  /**
   * IS THE SEQUENCE ON SCREEN THE READER'S OWN ARRANGEMENT?
   *
   * Everything Manual Ordering offers between two books depends on this one answer, and it is
   * answered once so that no format can decide it differently.
   *
   * Grid and Details lay a flat list out by the TOOLBAR's sort. Ask for titles and the sequence is
   * alphabetical, so a book's stored position and the place it appears have nothing to do with one
   * another: «put it before this one» would write a position the list cannot show, and the reader
   * would watch nothing happen. Measured at the root, twice — the arrangement said index 0 and the
   * screen was unchanged, and the app still answered «وُضع على Long Shelf».
   *
   * The grouped views never had that problem: Covers, Spines and Vista draw each shelf in the
   * shelf's own order, whatever the toolbar says, so what is on screen IS the arrangement.
   */
  const handOrdered = useMemo(
    () => !(view === "grid" || view === "details") || asShelfOrder(sort) === "hand",
    [view, sort],
  );

  /**
   * WHAT THE POINTER IS OVER, AS A DESTINATION.
   *
   * A destination is a container and the book to land in front of. Two things can be under the
   * pointer and both resolve to one:
   *
   *   a drawn landing place  — it says which container and which neighbour outright
   *   a book                 — its own container, and itself or the book after it, by which half
   *                            of it the pointer is on
   *
   * The second is what gives free arrangement. A book is a destination in ITS OWN container, not in
   * the carried book's, so dropping onto any book anywhere means «go where that book is, in front
   * of it». The old model could only draw positions belonging to the shelf the carried book came
   * from, which is why a book's freedom depended on the size of its own shelf — 42 places for one
   * book and 4 for its neighbour, measured, for no reason a reader could see.
   */
  /**
   * A FLAT LIST IN THE ORDER MANUAL ORDERING ACTUALLY WRITES.
   *
   * Grid and Details lay their books out by the toolbar's sort. A hand reorder made under a column
   * sort is written and hidden in the same instant — the code already said so, in the comment on
   * the arrange toggle, but only Details standing on a real shelf ever acted on it. Everywhere else
   * the reader dragged a book, the write landed, and the list did not move: indistinguishable from
   * nothing having happened, and the single loudest symptom of all of this.
   *
   * So when the reader ASKS for hand order, a flat list is ordered by where its books LIVE — home
   * first, then position within it. Every book has both, the unshelved run included, so the
   * arrangement on screen is exactly the arrangement being edited, at the root as much as inside a
   * shelf. It is read from `homes`, which a placement refreshes, so the screen cannot fall behind
   * the write the way it did while this order was taken from the flat list the library opened with.
   *
   * It hangs on the chosen SORT and never on the mode. Hanging it on the mode meant that merely
   * switching Manual Ordering on re-ordered the whole library in front of the reader.
   */
  /**
   * ORDERING IS PER FORMAT AND PER PLACE, so it is re-read when either changes — and keyed by the
   * MOST SPECIFIC part of the place, so a shelf's arrangement follows the shelf itself rather than
   * the cabinet it happens to sit in today. Moving a shelf between cabinets keeps its order.
   */
  const runScope = scopeKey(scope);
  useEffect(() => {
    let alive = true;
    viewOrdersForScope(view, runScope)
      .then((rows) => {
        if (!alive) return;
        setSavedOrders(bySection(rows));
        // The baselines arrive on the SAME rows — every row of a run carries its run's stamp — so
        // reading-aware order costs this screen no extra call and no extra query.
        setBaselines(baselineBySection(rows));
      })
      .catch(() => {
        // A run with no saved order is drawn in the default one; a failed read is the same
        // situation, and must not leave the PREVIOUS place's order on screen.
        if (alive) {
          setSavedOrders(new Map());
          setBaselines(new Map());
        }
      });
    return () => {
      alive = false;
    };
  }, [view, runScope]);

  /**
   * THE RULE SHELF THE READER IS STANDING INSIDE, if they are standing inside one.
   *
   * Only the flat formats need this. A grouped format draws a rule shelf as a band and takes its
   * sequence from `rowsFor`, which returns the lens untouched; a flat format has no bands, so
   * standing inside the shelf is the only way it shows one at all — and `flatBooks` had no way to
   * ask what the rule had decided.
   */
  const scopedRuleShelf = useMemo(() => {
    if (!scope.shelfId) return null;
    const s = shelfById.get(scope.shelfId)?.shelf;
    return s?.auto_rule ? s : null;
  }, [scope.shelfId, shelfById]);

  /** The ORDINARY shelf the reader is standing inside — the one that carries an `order_rule`. */
  const scopedHandShelf = useMemo(() => {
    if (!scope.shelfId) return null;
    const s = shelfById.get(scope.shelfId)?.shelf;
    return s && !s.auto_rule ? s : null;
  }, [scope.shelfId, shelfById]);

  /**
   * A RUN, AS THE READER SEES IT — their arrangement, with what they have since read in front.
   *
   * Every sequence in every format comes through here, for the same reason `sectionBooks` exists:
   * so that "what order is this run in" has one answer. The saved order is applied first because it
   * IS the run; promotion is then a projection over it, computed while drawing and never stored.
   *
   * A section with no stamp of its own has never been arranged, and falls back to the library-wide
   * epoch rather than to zero. Zero would mean "arranged at the beginning of time", so every book
   * ever read would count as read since — and a library that had never been arranged would open
   * with its entire reading history stacked on top, which is not an arrangement anyone made.
   */
  const runOf = useCallback(
    (books: BookRow[], section: string): BookRow[] =>
      promoteRecent(applyRunOrder(books, savedOrders.get(section) ?? []), baselines.get(section) ?? epoch),
    [savedOrders, baselines, epoch],
  );

  const homeSorted = useCallback(
    // THE FLAT RUN IS ONE SEQUENCE, and its order is its own.
    //
    // This used to be `inArrangementOrder` — the containers concatenated, ordered by where each
    // book LIVED. That is what put an invisible seam inside a list with no shelf on screen, and made
    // the last visible slot the end of whichever container happened to sort last. A book dragged
    // there was filed there.
    (list: BookRow[]) => runOf(list, WHOLE_RUN),
    [runOf],
  );

  /** Where a book lives, for the Details second line and the book sheet. */
  const placeOf = useCallback(
    (bookId: string): string => {
      for (const [sid, list] of Object.entries(shelfRows)) {
        if (sid !== LOOSE_SHELF_ID && list.some((i) => i.book_id === bookId)) {
          const entry = shelfById.get(sid);
          if (!entry) continue;
          return entry.caseNode ? `${entry.caseNode.name} · ${entry.shelf.name}` : entry.shelf.name;
        }
      }
      return t("lib.unfiled");
    },
    [shelfRows, shelfById, t],
  );

  // ---- what the current scope and query select -------------------------------
  const q = props.query.trim().toLowerCase();

  /**
   * THE SEQUENCE OF A SECTION — asked once, answered once, for every format.
   *
   * This is the whole architectural point, and the fault it repairs is worth stating plainly. A
   * section's books used to be produced in FOUR places: here, in `rowsFor` (which feeds the groups
   * Covers and Spines draw from), in `looseRun`, and in `sectionOrder` (which the drag path asks).
   * Only some of them applied the saved order. So a reorder inside a real shelf in Covers wrote its
   * row, reported success, and changed nothing on screen — measured: the write returned
   * `changed=true` with a saved order of [7a10, 1fc5, 890a] while the shelf went on drawing
   * [1fc5, 890a, 7a10], before and after a reload. The same reorder in Vista was correct, because
   * Vista happened to come through this function.
   *
   * Everything now delegates here, so «what does this section show» cannot have two answers.
   *
   * ── WHAT ORDERS WHAT ────────────────────────────────────────────────────────────────────────
   *
   *   a RULE shelf     its rule owns the order. «قيد القراءة» is
   *                    `… FROM reading_progress … ORDER BY p.updated_at DESC`, so the shelf is
   *                    newest-read-first BY DEFINITION, and reading a book moves it to the top of
   *                    that shelf and nowhere else. No saved order is applied, and none can be:
   *                    `canTake` in ViewGrouped and `canDrop` in Vista both refuse a rule shelf a
   *                    landing place, so there is no gesture that could write one.
   *
   *   a SORTED shelf   the reader asked for titles, or dates. That is presentation; it wins for as
   *                    long as it is chosen, and the arrangement waits untouched underneath.
   *
   *   a HAND shelf     the saved view order for this format, at this place.
   */
  const sectionBooks = useCallback(
    (s: ShelfNode, sectionKey?: string): BookRow[] => {
      // A lens's books come from what it matches; a shelf's from what is placed on it.
      const ids = s.auto_rule ? (lenses[s.id] ?? []) : (shelfRows[s.id] ?? []).map((i) => i.book_id);
      const list = ids.map((id) => byId.get(id)).filter((b): b is BookRow => !!b);
      // A RULE SHELF LEAVES HERE IN THE RULE'S OWN ORDER, UNTOUCHED.
      //
      // It used to go through `sortBooks(list, s.order_rule)` first. That was a no-op only because
      // every rule shelf in the wild carries `order_rule = NULL`, which matches no branch of that
      // switch and falls out the far side unchanged — the right answer reached by accident. Set
      // `order_rule` on a rule shelf and the shelf would have been re-sorted out of its rule's
      // order, while `rowsFor` — which the grouped formats draw from — went on returning the lens
      // sequence raw. Same shelf, two orders, decided by which format was on screen.
      if (s.auto_rule) return list;
      const base = sortBooks(list, s.order_rule);
      if (s.order_rule !== "hand") return base;
      return runOf(base, sectionKey ?? s.id);
    },
    [shelfRows, lenses, byId, runOf],
  );

  /** The name every other path knows this by. One function, two spellings, no second answer. */
  const shelfBooks = sectionBooks;

  // A shelf's books are NOT text-matched here, deliberately. `props.books` has already been
  // filtered by `library_list_books`, whose search folds Arabic the way RAWY-178 requires — an
  // unvocalized query finds a vocalized title, and hamza/alef variants match. A second, naive
  // `toLowerCase().includes()` pass on top would DISCARD exactly the rows that folding had just
  // matched, so the library would answer قراءة but not قِراءة. The membership lookup below already
  // restricts every shelf to books that survived that query — which is why nothing sits between
  // `shelfBooks` and the render.

  /**
   * The rows a shelf shows.
   *
   * A hand shelf shows the books placed on it. A LENS shows what it currently matches — minus any
   * book whose own container is also on screen, because a book is drawn once per viewport.
   *
   * That subtraction is the whole of the reader's «the book was copied». Nothing was ever
   * duplicated in the database: the book had simply moved to a shelf that was drawn, while still
   * satisfying a rule whose band was drawn beside it, so two tiles appeared for one book. Where the
   * book's real container is NOT on screen, the lens still lists it — that is what a lens is for.
   */
  const rowsFor = useCallback(
    (shelf: ShelfNode, drawnContainers: ReadonlySet<string>): ShelfItem[] => {
      if (!shelf.auto_rule) {
        // THE ROWS COVERS AND SPINES DRAW, IN THE SECTION'S OWN ORDER.
        //
        // This returned the membership rows straight from persistence — placement order, and blind
        // to anything the reader had arranged. It is why a reorder in Covers wrote its row and left
        // the screen alone. The rows still carry the categories, which is what they are for; only
        // the SEQUENCE now comes from the one place that knows it.
        const byBook = new Map((shelfRows[shelf.id] ?? []).map((i) => [i.book_id, i]));
        return sectionBooks(shelf)
          .filter((b) => byBook.has(b.id))
          .map((b, i) => ({ ...byBook.get(b.id)!, position: i }));
      }
      const seen = lenses[shelf.id] ?? [];
      return seen
        .filter((id) => {
          const home = arrangement.containerOf(id);
          return !home || !drawnContainers.has(home);
        })
        .map((id, i) => ({ book_id: id, position: i, category_id: null }));
    },
    [shelfRows, lenses, arrangement, sectionBooks],
  );

  const rendered: CaseRender[] = useMemo(() => {
    const caseList: CaseRender[] = [];
    // WHICH CONTAINERS THIS RENDER WILL DRAW, worked out before anything is built, so a lens can
    // leave out the books whose own shelf the reader is already looking at.
    const drawnContainers = new Set<string>();
    {
      const unfiledOnlyPass = scope.caseId === UNFILED_CASE_ID;
      const wantedPass = (c: CaseNode) => !unfiledOnlyPass && (!scope.caseId || scope.caseId === c.id);
      for (const c of tree.cases) {
        if (!wantedPass(c)) continue;
        for (const sh of c.shelves) {
          if (scope.shelfId && scope.shelfId !== sh.id) continue;
          if (!sh.auto_rule) drawnContainers.add(sh.id);
        }
      }
      if (!scope.caseId || unfiledOnlyPass) {
        for (const sh of tree.loose) {
          if (scope.shelfId && scope.shelfId !== sh.id) continue;
          if (!sh.auto_rule) drawnContainers.add(sh.id);
        }
        if (!scope.shelfId || scope.shelfId === LOOSE_SHELF_ID) drawnContainers.add(LOOSE_SHELF_ID);
      }
    }
    // "Not in a case" is a scope in its own right: it shows the un-cased group and no case.
    const unfiledOnly = scope.caseId === UNFILED_CASE_ID;
    const wanted = (c: CaseNode) => !unfiledOnly && (!scope.caseId || scope.caseId === c.id);
    for (const c of tree.cases) {
      if (!wanted(c)) continue;
      const shelves: ShelfRender[] = [];
      for (const s of c.shelves) {
        if (scope.shelfId && scope.shelfId !== s.id) continue;
        const books = shelfBooks(s);
        if (q && books.length === 0 && !s.name.toLowerCase().includes(q)) continue;
        // A SHELF THE READER IS STANDING INSIDE IS OPEN, whatever its stored collapsed flag says.
        //
        // The grouped views honour `collapsed` by drawing a summary row instead of the books. Right
        // in a list of shelves; wrong once the reader has navigated INTO one. Covers and Spines then
        // showed «collapsed · 7» and no books, while Grid, Details and Vista drew all seven, because
        // those three render the scoped shelf directly and never consult the flag. Same shelf, same
        // data, and whether the books were visible depended on the format. Answered here, so no view
        // has to know about scope.
        //
        // A shelf collapsed at the ROOT keeps its books hidden, and they cannot be dragged while
        // they are not drawn. Opening every collapsed shelf as soon as the mode came on was tried
        // and measured, and it is worse: switching Manual Ordering on then changed what Covers and
        // Spines were showing, which is the very thing the reader asked never to happen again.
        // Collapsing is the reader's own choice about how much of the library is on the page, it is
        // undone by pressing the shelf, and it hides a book from browsing exactly as much as from
        // arranging — so it is not the format deciding what may be moved. The shelf stays a
        // destination in every view either way, because the sidebar lists it.
        shelves.push({
          shelf: scope.shelfId === s.id && s.collapsed ? { ...s, collapsed: false } : s,
          groups: groupShelf(s, rowsFor(s, drawnContainers), byId),
          total: books.length,
        });
      }
      if (shelves.length) caseList.push({ node: c, shelves });
    }
    if (!scope.caseId || unfiledOnly) {
      const shelves: ShelfRender[] = [];
      for (const s of tree.loose) {
        if (scope.shelfId && scope.shelfId !== s.id) continue;
        const books = shelfBooks(s);
        if (q && books.length === 0 && !s.name.toLowerCase().includes(q)) continue;
        // A SHELF THE READER IS STANDING INSIDE IS OPEN, whatever its stored collapsed flag says.
        //
        // The grouped views honour `collapsed` by drawing a summary row instead of the books. Right
        // in a list of shelves; wrong once the reader has navigated INTO one. Covers and Spines then
        // showed «collapsed · 7» and no books, while Grid, Details and Vista drew all seven, because
        // those three render the scoped shelf directly and never consult the flag. Same shelf, same
        // data, and whether the books were visible depended on the format. Answered here, so no view
        // has to know about scope.
        //
        // A shelf collapsed at the ROOT keeps its books hidden, and they cannot be dragged while
        // they are not drawn. Opening every collapsed shelf as soon as the mode came on was tried
        // and measured, and it is worse: switching Manual Ordering on then changed what Covers and
        // Spines were showing, which is the very thing the reader asked never to happen again.
        // Collapsing is the reader's own choice about how much of the library is on the page, it is
        // undone by pressing the shelf, and it hides a book from browsing exactly as much as from
        // arranging — so it is not the format deciding what may be moved. The shelf stays a
        // destination in every view either way, because the sidebar lists it.
        shelves.push({
          shelf: scope.shelfId === s.id && s.collapsed ? { ...s, collapsed: false } : s,
          groups: groupShelf(s, rowsFor(s, drawnContainers), byId),
          total: books.length,
        });
      }
      // Books on no shelf at all. Without this run they would be invisible in every grouped
      // view — which, on a library whose books have never been filed, is the whole library.
      //
      // It must survive being SCOPED TO, not just being listed. Focusing this run sets
      // `scope.shelfId` to its synthetic id; no row in `collections` can match that, so the
      // loop above yields nothing, and skipping the run here as well left the whole library
      // blank — "not on a shelf" is a real place a reader can stand in, not an absence.
      if (!scope.shelfId || scope.shelfId === LOOSE_SHELF_ID) {
        // The unshelved run, in whatever order THIS format has saved for it — the same rule every
        // other section follows, and the reason arranging it in Covers leaves Spines alone.
        const shown = runOf(looseRun, LOOSE_SHELF_ID);
        if (shown.length) {
          const shelf = makeLooseShelf(t("lib.unshelved"), shown.length);
          shelves.push({
            shelf,
            // THE RUN IS IN ITS OWN ORDER, always. It used to fall back to the toolbar sort when
            // the reader had never arranged it, which meant the same container was drawn one way
            // here and another way in the flat views. It is a container like any other now.
            groups: [{ categoryId: null, name: null, books: shown }],
            total: shown.length,
          });
        }
      }
      if (shelves.length) caseList.push({ node: null, shelves });
    }
    return caseList;
    // Everything read above comes from `shelfRows` and `looseRun`, which both derive from the one
    // arrangement — so a placement that was written is a placement every view redraws. This memo
    // once omitted the unshelved run from its dependencies, and the result was a reorder that
    // landed in Grid and never appeared in Vista or Spines: same shelf, same anchor, one lit
    // target, and only the list that happened to be recomputed showed it.
  }, [tree, scope, rowsFor, byId, shelfBooks, q, props.books, sort, t, looseRun, runOf]);

  /**
   * THE FLAT LIST — every book the reader can see from where they are standing, in order.
   *
   * Grid and Details draw this. The books are whatever the current scope admits; the sequence is
   * either a column sort or the reader's own arrangement, and nothing else decides it.
   */
  const flatBooks = useMemo(() => {
    const inScope = new Set<string>();
    let any = false;
    for (const c of rendered) {
      for (const sh of c.shelves) {
        any = true;
        for (const g of sh.groups) for (const b of g.books) inScope.add(b.id);
      }
    }
    const base =
      any && (scope.caseId || scope.shelfId) ? props.books.filter((b) => inScope.has(b.id)) : props.books;

    // ORDERING BY CONTAINER AND THEN BY RANK WORKS AT EVERY SCOPE, so there is no longer a separate
    // branch for «inside a shelf». Standing in one shelf, every book shares a container and the
    // first key falls away by itself. The old special case existed because the per-shelf map it
    // consulted had no entry for the books on no shelf, and standing among those was exactly where
    // it silently did nothing.
    // THE ORDER THE READER ASKED FOR, TAKEN FROM THE ARRANGEMENT ITSELF.
    //
    // Two things used to go wrong here and both were reported as «it says it moved and it did not».
    //
    //  1 · Hand order at the library root was the order `props.books` happened to arrive in. That
    //      list is fetched when the library opens and is never re-fetched by a placement, so a
    //      reorder was written and the screen went on drawing the sequence from before it.
    //
    //  2 · Inside a shelf the positions were read from a per-shelf membership map that had no entry
    //      for the books on no shelf. Every book in that run scored «position unknown», the sort
    //      became a no-op, and the run was drawn in arrival order — measured, a book really did move
    //      to second in the database while the screen showed the old sequence with fresh position
    //      numbers written onto it.
    //
    // Both are gone for the same reason: the sequence is derived from the arrangement, which is the
    // thing the write updates. There is nowhere left for a stale copy of the order to live.
    //
    // This hangs on the SORT the reader chose and never on whether Manual Ordering is switched on.
    // Hanging it on the mode is what made merely enabling the mode reshuffle the library in front
    // of them, and switching it off shuffle it back.
    // INSIDE A RULE SHELF, THE RULE IS THE SHELF'S OWN ORDER.
    //
    // «The shelf's own order» means the saved arrangement on a hand shelf, and on a rule shelf it
    // means the rule — «قيد القراءة» is `… ORDER BY p.updated_at DESC`, so the book just read is
    // first BY DEFINITION. A rule shelf has no saved arrangement and can never have one, so
    // `homeSorted` was `applyRunOrder(base, [])`, the identity, and what reached the screen was
    // simply `props.books` filtered to the scope.
    //
    // That looked right and was not. `props.books` is fetched `date_read desc`, which is the SAME
    // comparison the reading rule makes, so the two sequences coincided and the shelf appeared to
    // honour a rule it never consulted. Measured, standing inside «قيد القراءة»: the drawn run
    // matched the rule exactly — and equally matched the fetch, because nothing distinguished
    // them. The order was inherited, not derived, and the only thing keeping it correct was the
    // library's default sort staying on «الأحدث قراءةً».
    //
    // The lens is that shelf's sequence as the rule produced it, so the run is read from there and
    // the coincidence stops being load-bearing. Nothing is written: a rule shelf still has no saved
    // order, still offers no landing place, and still cannot be arranged by hand.
    if (asShelfOrder(sort) === "hand") {
      const ruleRun = scopedRuleShelf ? (lenses[scopedRuleShelf.id] ?? []) : null;
      if (ruleRun) return applyRunOrder(base, ruleRun);
      // THE SORT CALLED «ترتيب الرفّ» DID NOT READ THE SHELF'S ORDER.
      //
      // `asShelfOrder` maps that choice to `hand`, and this branch then went straight to
      // `homeSorted` — the library's own arrangement — without ever asking the shelf being stood
      // in what order it keeps. A shelf's `order_rule` is a real column with six values and its
      // own control in the shelf's ⋯ menu, and the grouped formats have always honoured it
      // because they draw through `sectionBooks`.
      //
      // Measured on a six-book shelf, setting the rule to hand / title / author / added in turn:
      // Covers, Spines and Vista gave four different sequences; Grid and Details gave one, the
      // same one, four times. Half the formats were ignoring a setting the menu offers.
      //
      // `sectionBooks` is the function that knows the rule — it sorts by `order_rule` and falls
      // through to the saved `view_orders` run only when the rule is `hand`. Asking it here is
      // what makes the flat formats agree with the grouped ones, and it introduces no second
      // notion of ordering: the run it returns is imposed on the books already on screen exactly
      // as the rule-shelf run above is.
      if (scopedHandShelf) {
        return applyRunOrder(base, sectionBooks(scopedHandShelf, scope.categoryId
          ? `${scopedHandShelf.id}/${scope.categoryId}`
          : scopedHandShelf.id).map((b) => b.id));
      }
      return homeSorted(base);
    }
    return sortBooks(base, asShelfOrder(sort));
  }, [rendered, props.books, q, sort, scope, mode, homeSorted, scopedRuleShelf, scopedHandShelf, sectionBooks, lenses]);

  /**
   * THE RUN BEHIND A SECTION — the ids the screen is drawing there, in the order it draws them.
   *
   * One answer for all five formats. The flat ones draw a single run; a grouped one draws a section
   * per shelf, and a section may be a rule shelf, which holds books it does not own. Either way the
   * question is «what is on screen here», never «what belongs where».
   */
  const sectionOrder = useCallback(
    (section: string): string[] => {
      if (section === WHOLE_RUN) return flatBooks.map((b) => b.id);
      // خارج الأرفف IS A SECTION AND NOT A SHELF. There is no row for it and `shelfById` holds only
      // real shelves, so looking it up there returns nothing — and a run that reports itself empty
      // makes the write refuse the book as "not in this run". It is drawn from the arrangement, the
      // same place the views draw it from, and then put in whatever order this format has saved.
      if (section === LOOSE_SHELF_ID) {
        return runOf(looseRun, section).map((b) => b.id);
      }
      // A CATEGORY RUN IS A RUN OF ITS OWN, and is named `shelf/category`. Handing back the whole
      // shelf for one of its runs would compute a rank against neighbours the reader cannot see —
      // the same shape of fault as the flat concatenation, one level down.
      const [shelfId, categoryId] = section.split("/");
      const node = shelfById.get(shelfId)?.shelf;
      if (!node) return [];
      if (!categoryId) return sectionBooks(node).map((b) => b.id);
      // A category run is its own section, so it is ordered as its own section — same function,
      // same rule, with the run's own key.
      const run = sectionBooks(node).filter((b) => arrangement.categoryOf(b.id) === categoryId);
      return runOf(run, section).map((b) => b.id);
    },
    [flatBooks, looseRun, runOf, shelfById, sectionBooks, arrangement],
  );

  /**
   * WHAT A RELEASE CAN MEAN — and there are only two things, which is the point.
   *
   * An `order` target carries a section and a neighbour: where in this run. A `move` target carries
   * a container: which shelf. Nothing carries both, so no single gesture can do both, and the type
   * itself is what enforces it.
   */
  type DropTarget =
    | { el: HTMLElement; kind: "order"; section: string; before: string | null }
    | { el: HTMLElement; kind: "move"; container: string; categoryId: string | null };

  const dropTarget = useCallback(
    (x: number, y: number): DropTarget | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el?.closest) return null;

      // A PLACE IN THE RUN. Order, and nothing else — there is no container on it to write.
      const slot = el.closest("[data-drop-section]") as HTMLElement | null;
      if (slot) {
        const before = slot.dataset.dropBefore;
        return { el: slot, kind: "order", section: slot.dataset.dropSection!, before: before ? before : null };
      }

      // A SHELF IN THE SIDEBAR. The one gesture that is about belonging, and it names a shelf the
      // reader can see and chose to aim at. This is where «move to another shelf» lives; a drag
      // inside a run cannot reach it.
      const shelf = el.closest("[data-drop-shelf]") as HTMLElement | null;
      if (shelf) {
        return {
          el: shelf,
          kind: "move",
          container: shelf.dataset.dropShelf!,
          categoryId: shelf.dataset.dropCat || null,
        };
      }

      const bk = el.closest("[data-book][data-shelf]") as HTMLElement | null;
      if (!bk) return null;
      const container = bk.dataset.shelf;
      const bookId = bk.getAttribute("data-book");
      if (!container || !bookId) return null;
      // A shelf that fills itself owns nothing: a row written to it is never read back, so it can
      // never be a destination. It is still drawn, and its books are still draggable — they simply
      // go from wherever they actually live.
      if (shelfById.get(container)?.shelf.auto_rule) return null;

      const r = bk.getBoundingClientRect();
      const rtl = getComputedStyle(document.documentElement).direction === "rtl";
      const past =
        view === "details"
          ? y > r.top + r.height / 2
          : rtl
            ? x < r.left + r.width / 2
            : x > r.left + r.width / 2;
      // The far half means «after this one», which is «in front of whatever follows it». The
      // neighbour is read from the SECTION AS DRAWN, which is what the reader is looking at — and
      // which may be a rule shelf holding books it does not own.
      const run = sectionOrder(container);
      const at = run.indexOf(bookId);
      const before = past ? (at >= 0 && at + 1 < run.length ? run[at + 1] : null) : bookId;
      return { el: bk, kind: "order", section: container, before };
    },
    [view, sectionOrder],
  );


  /**
   * THE STAGE, AS SEEN FROM WHERE THE READER IS STANDING.
   *
   * One shaping. The ancestors, the way out and the reader's place are carried by the SHELL — the
   * sidebar's tree and the toolbar's place-line — so Vista does not draw a second breadcrumb of its
   * own, and does not draw a third.
   */
  const stage = useMemo(
    () =>
      vistaView({
        rendered,
        // Every case, not only the ones `rendered` kept: a case holding no shelves is still a
        // place the reader made, and it is in the sidebar of every other view.
        allCases: tree.cases,
        scope,
        shelfBooks,
        librarySort: asShelfOrder(sort),
        filtered: q.length > 0,
      }),
    [rendered, tree.cases, scope, shelfBooks, sort, q],
  );

  /**
   * WHERE MANUAL ORDERING CAN ACT AT ALL.
   *
   * The view is only half the question. Vista drills down, so at the library root and inside a case
   * it is drawing containers — and a container's sample covers belong to its navigation button, not
   * to any shelf. Offering the control there promises an operation the content cannot perform.
   *
   * The grouped views draw the whole hierarchy at once and always have some orderable shelf on
   * screen, so for them the view-level answer is the whole answer.
   */

  /**
   * The one shelf whose stored order Details may sort by and reorder — or null.
   *
   * A shelf owns the stage only when the reader is standing inside it, it fills itself from no
   * rule, and it is a real collection rather than the unshelved run. Those are the same three
   * conditions that decide whether a book can be dragged there, which is why they are answered
   * once, here, rather than in each view.
   */
  /**
   * WHETHER THE READER'S OWN ORDER CAN BE CHOSEN FROM THE SORT CONTROL.
   *
   * It used to ask «am I standing inside one real shelf?», because the reader's own order WAS that
   * shelf's stored positions and existed nowhere else. Under the view-order model every run has an
   * order of its own — the library root included — so that question no longer decides anything.
   *
   * Leaving it in place made switching away a ONE-WAY DOOR. Measured at the root: the control
   * offered «الأحدث قراءةً · الأحدث إضافةً · العنوان · المؤلف · التقدّم» and never «ترتيب الرفّ»,
   * so a reader who chose Recently read could not get their arrangement back from the same menu —
   * the arrangement was still there, and there was no way to ask for it.
   *
   * A rule shelf is the one place it stays out: that shelf's order is its rule's, there is no saved
   * order to return to, and the control says so in its own words.
   */
  const canChooseOwnOrder = useMemo(() => {
    if (!scope.shelfId) return true; // the root, a case, خارج الأرفف — each has a run of its own
    const s = shelfById.get(scope.shelfId)?.shelf;
    return !s || !s.auto_rule;
  }, [scope.shelfId, shelfById]);

  /**
   * MANUAL ORDERING IS A CAPABILITY OF THE PLACE, NOT OF THE VIEW.
   *
   * It is offered wherever the reader is looking at a real hand shelf whose books have a stored
   * order — in every one of the five views. Vista also has to be asked about DEPTH, because it
   * drills down and draws containers at the top: a case's sample covers belong to its navigation
   * button, not to any shelf.
   *
   * Details and Grid used to be refused outright. Details could not SHOW a hand order, because a
   * column sort always governed; it can now sort by the shelf's own order, and switching the mode
   * on switches to it. Grid could not say which book a card was, nor put a landing place between
   * two cards; it can now, through `renderGrid`.
   */
  /**
   * Whether this flat list is drawing any books at all.
   *
   * It used to ask whether any book on screen was FILED — which switched Manual Ordering off over
   * خارج الأرفف, where nothing is. That is the conflation this no longer makes: being unfiled is a
   * reason a book has no order of its own, never a reason it cannot be moved.
   */
  const booksOnScreen = flatBooks.length > 0;
  /** The book whose deletion is being confirmed. Owned here, so all five views share one dialog. */
  const [deleting, setDeleting] = useState<BookRow | null>(null);
  /**
   * WHICH KIND OF NOTHING, or `null` when there is something to draw.
   *
   * Computed here, beside `booksOnScreen`, because it is a fact about the library rather than about
   * any one view — and because every view now renders through it.
   */
  const emptyState = flatBooks.length === 0
    ? emptyKind({ query: props.query, totalBooks: props.books.length, scoped: !atRoot })
    : null;

  /**
   * WHETHER MANUAL ORDERING CAN ACT ON WHAT IS ON SCREEN — never "is the scope a shelf".
   *
   * Vista is asked about depth, because it drills down: at the root and inside a case it draws
   * containers, and a container's sample covers belong to its navigation button rather than to any
   * shelf, so there is genuinely nothing to pick up. Everywhere else the question is whether any
   * book on screen has a shelf of its own — which is true of Covers and Spines at every depth, and
   * true of Grid and Details wherever the list happens to include a book that is filed somewhere.
   */
  //
  // ONE QUESTION, ASKED THE SAME WAY IN EVERY VIEW: are there books here?
  //
  // There used to be three different rules, and that is precisely why the feature worked in some
  // views and not others. Measured across all twenty-five cells: Covers and Spines refused a
  // computed shelf and خارج الأرفف while Vista allowed both; Grid and Details refused خارج الأرفف
  // for a third reason again. The reader met a control that came and went as they changed view over
  // the same books.
  //
  // Whether a book can be REORDERED WHERE IT STANDS is a different question, and it is answered per
  // book and per destination further down — by `orderSourceOf`, by the landing places a stage draws
  // and by `dropTarget`. Refusing the mode outright was answering it far too early.
  const canArrangeHere =
    view === "vista"
      ? vistaArrangeable(stage)
      : view === "covers" || view === "spines"
        ? rendered.some((k) => k.shelves.some((sh) => sh.total > 0))
        : booksOnScreen;

  /**
   * WHY MANUAL ORDERING CANNOT ACT HERE — the sentence the disabled control carries.
   *
   * The control is never taken away; where it cannot do anything it says what is missing, so the
   * reader learns the rule instead of finding a gap. Each depth gets its own answer, because they
   * fail for different reasons: a case holds shelves rather than books, a computed shelf fills
   * itself, خارج الأرفف is not a collection and has no order to keep, and an empty shelf has
   * nothing to put in an order at all.
   */
  const arrangeReason = useMemo(() => {
    if (canArrangeHere) return null;
    const here = scope.shelfId ? shelfById.get(scope.shelfId)?.shelf ?? null : null;
    if (here?.auto_rule) return t("lib.cannotPlace");
    if (here && isVirtualShelf(here.id)) return t("lib.vista.orderNotYours");
    if (here) return t("lib.arrangeEmptyShelf");
    // Grid and Details fail for a different reason: the list holds no book that is filed anywhere.
    if (view === "grid" || view === "details") return t("lib.arrangeNoFiledBooks");
    return t("lib.arrangeNeedsShelf");
  }, [canArrangeHere, scope.shelfId, shelfById, view, t]);


  // LEAVING A PLACE THAT CANNOT ARRANGE LEAVES ARRANGE MODE.
  //
  // A mode left switched on behind a control that is no longer drawn is a state the reader can
  // neither see nor turn off — and it would come back on when they returned somewhere that does
  // draw it. Any book in hand goes down with it: there is nowhere here to put it.
  //
  // This watches the CAPABILITY, not the view, so walking out of a shelf into its case clears the
  // mode exactly as switching to Details does.
  //
  // THE BOOK IN HAND DOES NOT GO DOWN WITH IT. It used to: "there is nowhere here to put it" was
  // true while a book outside a shelf could not be lifted at all. Now one can, and the whole point
  // of lifting it is to carry it somewhere that WILL take it — which in Vista means walking up out
  // of خارج الأرفف and into a case, a depth that originates no drag of its own. Clearing the carry
  // on the way put the book down at exactly the moment the reader was carrying it to its shelf.
  // The landing places follow the carry rather than the mode, so they are still drawn on arrival,
  // and Escape still puts the book down deliberately.
  useEffect(() => {
    if (canArrangeHere) return;
    setMode((m) => (m === "arrange" ? "browse" : m));
  }, [canArrangeHere]);

  // ---- writes ----------------------------------------------------------------
  /**
   * PUT THE CARRIED BOOK IN A GAP — the whole of a move, in one call.
   *
   * What this replaced was a hundred lines that decided, per case, whether the release was a
   * reorder or a move or an add; whether the source was a rule shelf and therefore could not be
   * left; whether the destination was the unshelved run and therefore lived in a settings key
   * rather than in the library; how to convert the index a view had drawn into the index the
   * command wanted; and which of two writes to issue first so a failure between them would not
   * lose the book from both. Every one of those questions came from a book being able to live in
   * more than one place, and none of them can be asked now.
   *
   * The order on screen is taken from what the transaction RETURNED. Nothing is guessed ahead of
   * the write and nothing is re-fetched after it, so «the app said it moved» and «the shelf in
   * front of me moved» cannot come apart.
   */
  /**
   * REORDER — how the books read here. Membership is not consulted and cannot be written.
   *
   * `viewOrderReorder` writes to `view_orders`, whose rows have no container column, so this path
   * has nowhere to file a book even if it wanted to. It is the whole reason the two operations are
   * separate functions calling separate commands against separate tables.
   *
   * What the reader is told says nothing about a shelf, because nothing about a shelf happened. The
   * old message named the destination CONTAINER — so a pure reorder inside the unshelved run
   * announced «وُضع على خارج الأرفف», and a reorder that crossed an invisible seam announced a
   * shelf the reader had never chosen. Both were truthful about the write and wrong about the act.
   */
  const reorderInto = useCallback(
    async (section: string, before: string | null) => {
      if (!carry) return;
      const book = carry.book;
      setCarry(null);

      const run = sectionOrder(section);
      // NOTHING TO DO, AND SO NOTHING TO CLAIM. Released in front of itself, in front of whatever
      // already follows it, or at the end when it is already last. The write asks again, against
      // the run as it really is, because the reader may be looking at a list drawn a moment ago.
      if (isNoMoveInRun(run, book.id, { before })) return;

      try {
        const res = await viewOrderReorder({
          format: view,
          scope: runScope,
          section,
          bookId: book.id,
          before,
          present: run,
        });
        if (!res.changed) return;
        setSavedOrders((prev) => {
          const next = new Map(prev);
          next.set(section, res.order);
          return next;
        });
        // THE BASELINE MOVES WITH THE ORDER, and forgetting it is a divergence rather than a delay.
        //
        // The write stamped this run as arranged just now, which is what folds the promotions the
        // reader was looking at into the sequence they just approved. Leaving the old stamp on this
        // side would re-promote those same books on top of the order that already contains them —
        // so the screen would show one thing and a reload would show another, from the same rows.
        // Measured before this line existed: the drag landed the book at 2 instead of 1, and the
        // list after a reload did not match the list on screen.
        setBaselines((prev) => {
          const next = new Map(prev);
          next.set(section, Math.floor(Date.now() / 1000));
          return next;
        });
        flash(t("lib.reordered"));
      } catch (e) {
        console.error(e);
        flash(t("lib.writeFailed"));
      }
    },
    [carry, sectionOrder, view, runScope, flash, t],
  );

  /**
   * MOVE — where the book belongs. Order is not consulted and is not written.
   *
   * Reached only by releasing on a shelf in the sidebar: a place the reader can see and aimed at.
   * A drag inside a run cannot arrive here, which is what makes «I reordered» and «I refiled» two
   * different acts rather than the same write under two descriptions.
   */
  const moveToShelf = useCallback(
    async (container: string, categoryId: string | null = null) => {
      if (!carry) return;
      const book = carry.book;
      setCarry(null);
      if (arrangement.containerOf(book.id) === container && !categoryId) return;

      try {
        const res = await libraryPlaceBook(book.id, container, null, categoryId);
        applyTree(res.arrangement.tree);
        setPlacements(res.arrangement.placements);
        setLenses(Object.fromEntries(res.arrangement.lenses.map((l) => [l.shelf_id, l.book_ids])));
        if (!res.placed.changed) return;
        const where = shelfById.get(container)?.shelf.name ?? t("lib.unshelved");
        flash(`${t("lib.movedTo")} ${where}`);
      } catch (e) {
        console.error(e);
        flash(t("lib.writeFailed"));
        await refreshArrangement();
      }
    },
    [carry, arrangement, applyTree, shelfById, flash, t, refreshArrangement],
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
    () => selectionSource(selected, shelfRows, scope.shelfId),
    [selected, shelfRows, scope.shelfId],
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

  /**
   * Drop a case at a position, and SAY where it landed.
   *
   * The reference announces the new position after every case move (`this.say(...)`) and the port
   * had never carried that across — so a reorder was a silent rearrangement of a list the reader
   * was in the middle of looking at, which is a large part of why the grip felt like it did
   * nothing in particular.
   */
  const placeCase = useCallback(
    async (id: string, at: number) => {
      const name = tree.cases.find((c) => c.id === id)?.name ?? "";
      if (await write(() => caseReorder(id, at))) {
        flash(t("lib.caseMoved", { name, n: num(at + 1) }));
      }
    },
    [tree.cases, write, flash, t, num],
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
      if (scope.shelfId === id) setScope({ caseId: scope.caseId, shelfId: null, categoryId: null });
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
    }),
    [loadTree, t, shelfById, tree.loose],
  );

  /**
   * ARRANGE IS A DRAG, in the main views as everywhere else.
   *
   * A book used to be picked up by a click and put down by a click on a slot. That is a different
   * manipulation from the one a case, a shelf, a category and a book-in-the-panel all use, and it
   * is the one interaction left that the reader had to learn separately.
   *
   * The pointer going down on a book only records it. The carry begins once the pointer has
   * actually travelled — which is what keeps a click a click — and the release is hit-tested
   * against the drop slots, each of which names its own destination. Those same slots stay
   * clickable, so the older route still works for anyone who prefers it.
   */
  const bookDrag = useRef<{ book: BookRow; fromShelf: string; x: number; y: number; moved: boolean } | null>(null);
  // ONE scroller for the component's lifetime. Building it inside the effect meant it was torn
  // down and rebuilt on every render the effect's dependencies changed — which, during a drag, is
  // most of them — so it was destroyed before a single frame could scroll anything.
  const bookScroll = useRef<EdgeScroller | null>(null);
  if (!bookScroll.current) bookScroll.current = createEdgeScroller();
  /**
   * THE BOOK FOLLOWS THE HAND, AND THE PLACE UNDER IT LIGHTS UP.
   *
   * Dragging a book used to be invisible while it was happening: the tile dimmed where it started,
   * the landing places appeared, and then nothing else moved until the release. Measured across a
   * six-step drag, every landing place stayed byte-identical to every other one — the reader had no
   * way to tell which of them the book would go into, so the drop was a guess.
   *
   * Both are written straight to the DOM rather than through state: a pointermove that re-rendered
   * the whole stage would make the drag stutter on a shelf of any size, and neither the ghost's
   * position nor the lit place is anything the rest of the view needs to know about.
   */
  /** The sort Details was showing before Manual Ordering borrowed it, so it can be handed back. */
  const dragGhost = useRef<HTMLDivElement | null>(null);
  const hotSlot = useRef<HTMLElement | null>(null);
  /** The last position actually written to the ghost, so an unmoved pointer writes nothing. */
  const ghostAt = useRef<{ x: number; y: number } | null>(null);

  const litSlot = useCallback((el: HTMLElement | null) => {
    if (hotSlot.current === el) return;
    hotSlot.current?.classList.remove("libd-hot");
    el?.classList.add("libd-hot");
    hotSlot.current = el;
  }, []);

  const followPointer = useCallback((x: number, y: number) => {
    const g = dragGhost.current;
    // A POINTER THAT HAS NOT MOVED NEEDS NOTHING WRITTEN. Coordinates arrive integral, so this is
    // an exact comparison, not a tolerance: a jittering hand that stays on the same pixel — or a
    // pointermove delivered without a position change — costs nothing at all.
    const at = ghostAt.current;
    if (g && (!at || at.x !== x || at.y !== y)) {
      // Centred on the pointer by the element's own size, so the offset cannot depend on the
      // writing direction — see .libd-drag-ghost.
      g.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) rotate(-3deg)`;
      if (!at) g.style.opacity = "1";
      ghostAt.current = { x, y };
    }

    // AND A POINTER STILL INSIDE THE LIT PLACE NEEDS NO HIT-TEST. Measured: dragging while
    // jittering within a single landing place cost the same 5.03 style recalculations per move as
    // crossing the whole shelf, because the target was recomputed every time regardless. Reading
    // the current rect of the element already lit is both cheaper than a hit-test and correct
    // under scrolling, since it is re-read rather than remembered.
    const lit = hotSlot.current;
    if (lit) {
      const r = lit.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
    }

    // The ghost never takes the hit-test — it is `pointer-events: none` — so this resolves exactly
    // what the release will resolve. WHAT IS LIT IS WHAT WILL HAPPEN, including when the thing
    // under the pointer is another book rather than a dashed placeholder.
    litSlot(dropTarget(x, y)?.el ?? null);
  }, [litSlot, dropTarget]);

  const endDragFeedback = useCallback(() => {
    litSlot(null);
    ghostAt.current = null;
    const g = dragGhost.current;
    if (g) g.style.opacity = "0";
  }, [litSlot]);

  const armBookDrag = useCallback((book: BookRow, fromShelf: string, x: number, y: number, el: Element) => {
    bookDrag.current = { book, fromShelf, x, y, moved: false };
    // The pane to follow is decided by where the press happened, not by hit-testing a point that
    // may be off screen — a tile can be pressed while its own centre is below the fold.
    bookScroll.current?.setContainer(el);
  }, []);

  /**
   * THE LANDING PLACES A FLAT LIST DRAWS.
   *
   * A place is a container and the neighbour to land in front of. It used to be a container and an
   * INDEX, and the index had to be corrected for the moving book's own removal before the command
   * would honour it — that correction is where the off-by-ones lived. A neighbour needs no
   * correction and means the same thing to the view that drew it and to the transaction.
   *
   * More important than the shape: a place is drawn before ANY book on screen, not only before the
   * carried book's own shelf-mates. That single restriction is what made a book's freedom depend on
   * the size of its own shelf — measured on a real library, 42 destinations for a book in the
   * unfiled run and 4 for a book alone on a shelf. A book on screen belongs to some container, and
   * landing in front of it means joining that container there, whichever one the book came from.
   */
  /**
   * A LANDING PLACE DRAWN INSIDE A VISIBLE SHELF is two things at once, and legitimately so.
   *
   * Covers, Spines and Vista put the shelf on screen. Releasing into one of its places therefore
   * says «this shelf» as plainly as it says «here» — the reader aimed at a named shelf they can
   * see. So it files the book if it is not already there, and then positions it within that
   * section. Both halves are explicit, because both were visible.
   *
   * The flat formats have no such slot. There is no shelf on screen to have aimed at, so a release
   * there is only ever a reorder — which is the whole point of the split.
   */
  const placeOnShelf = useCallback(
    async (gap: { container: string; before: string | null }, categoryId: string | null) => {
      if (!carry) return;
      const book = carry.book;
      const alreadyThere = arrangement.containerOf(book.id) === gap.container;
      if (!alreadyThere || categoryId) {
        await moveToShelf(gap.container, categoryId);
      } else {
        setCarry(null);
      }
      if (gap.before !== null || alreadyThere) {
        await reorderInto(gap.container, gap.before);
      }
    },
    [carry, arrangement, moveToShelf, reorderInto],
  );

  /**
   * THE ONE ORDERING GAP — every format's landing place, drawn here and nowhere else.
   *
   * A view decides how a gap LOOKS and where it appears; it does not decide what a gap MEANS. That
   * split is not tidiness, it is the fix for a real fault: Vista and the grouped views each built
   * their own landing place, and both stamped it with `data-drop-shelf` — the MEMBERSHIP attribute.
   *
   * `dropTarget` looks for `data-drop-section` first and, finding none, matched `data-drop-shelf`
   * and called the slot a MOVE. `moveToShelf` then returned early, because the book was already in
   * that container. Measured on the reader's library, on the very same element: releasing on it
   * moved the book from position 0 to position 0 and said nothing, while CLICKING it — which runs
   * the handler instead of hit-testing the attributes — moved it to position 5 and said «تم تغيير
   * ترتيب الكتاب». The gap was right; only the release misread it.
   *
   * The invariant this renderer exists to hold: AN ORDERING GAP NEVER CARRIES A CONTAINER. It emits
   * `data-drop-section` and a neighbour, and nothing else — there is no shelf on it for a release to
   * mistake for a destination, and no category either. A view that cannot emit the attributes cannot
   * emit the wrong ones.
   */
  const orderGap = useCallback(
    (o: {
      section: string;
      before: string | null;
      key: string;
      /** Presentation belongs to the view: it knows what a gap looks like in its own layout. */
      className?: string;
      style?: React.CSSProperties;
      label?: string;
    }) => {
      if (!carry) return null;
      return (
        <div
          key={o.key}
          className={o.className ?? (view === "grid" ? "libd-cardslot" : "libd-rowslot")}
          style={o.style}
          data-drop-section={o.section}
          data-drop-before={o.before ?? ""}
          onClick={() => reorderInto(o.section, o.before)}
          title={o.label ?? t("lib.placeHere")}
          aria-label={o.label ?? t("lib.placeHere")}
        />
      );
    },
    [carry, view, reorderInto, t],
  );

  /** The flat formats' own shape of the same thing. */
  const orderPlace = useCallback(
    (section: string, before: string | null, key: string, label?: string) =>
      orderGap({ section, before, key, label }),
    [orderGap],
  );

  /** A place in front of this book, in whatever container the book itself belongs to. */
  const gapBefore = useCallback(
    (b: BookRow) => {
      if (!carry) return null;
      // THE FLAT RUN, WHOLE. This used to hand back the gap of the book's own CONTAINER, which is
      // how a list with no shelf on screen came to have shelf-shaped seams in it: the first slot
      // belonged to whichever container sorted first, the last to whichever sorted last, and
      // dragging across one filed the book. There is no container here to reach for now.
      //
      // A rule shelf is no longer a reason to withhold a place either. It withheld one because a
      // rule shelf owns nothing and so could not be a destination — true of MEMBERSHIP, and
      // irrelevant to order.
      //
      // EVERY position is offered, including the one or two that would not move THIS book. Hiding
      // them made the number of places depend on which book was in hand. A release into one writes
      // nothing and says nothing.
      return orderPlace(WHOLE_RUN, b.id, "gap-" + b.id);
    },
    [carry, orderPlace],
  );

  /**
   * THE END OF A CONTAINER, DRAWN WHERE THAT CONTAINER ENDS.
   *
   * A flat list holds books from several containers at once, so «the end» is not one place — it is
   * one place per container. This used to emit all of them together after the last book of the
   * whole list, which produced the fault the reader hit twice over:
   *
   *   · SEVEN identical dashed slots appeared after the final book. Measured on their library:
   *     the ends of the unfiled run, test1, تست, العربية, العربية, To read and روايات ادبية, each
   *     163×245, side by side, with nothing to tell them apart.
   *
   *   · Releasing into «the last one» therefore committed to the end of «روايات ادبية» — a
   *     different shelf. Shelves are drawn before the unfiled run, so the book left the run, joined
   *     that shelf, and appeared at the TOP of the library. «I placed it at the end and it became
   *     the first book» was exactly what the interface offered.
   *
   * The identities were never ambiguous — seven distinct containers, seven distinct destinations.
   * What was ambiguous was the drawing: seven canonical places rendered as one visual place. So an
   * end is now drawn immediately after the last book of ITS OWN container, which the hand order
   * already groups together, and the reader can only reach the end they are looking at.
   */
  /**
   * THE END OF THE RUN — one place, after the last book on screen.
   *
   * There used to be one end PER CONTAINER, because a flat list held several and each had its own.
   * Seven identical dashed slots appeared after the final book, measured on a real library, and
   * releasing into «the last one» committed to the end of a different shelf — so a book placed at
   * the end arrived at the TOP of the library, on a shelf the reader had not chosen.
   *
   * A flat run has one end, because it is one run. No container is consulted to find it.
   */
  const lastInRun = flatBooks.length ? flatBooks[flatBooks.length - 1].id : null;

  const gapAfter = useCallback(
    (b: BookRow) => {
      if (!carry) return null;
      if (lastInRun !== b.id) return null;
      return orderPlace(WHOLE_RUN, null, "gap-end");
    },
    [carry, lastInRun, orderPlace],
  );

  // A CONTAINER WITH NO BOOK ON SCREEN IS REACHED THROUGH THE SIDEBAR, NOT THROUGH THE PANE.
  //
  // The pane used to draw a labelled slot for each such container, all together after the final
  // book, because at the time there was nowhere else to put a book onto an empty shelf. There is
  // now: every shelf is a row in the sidebar, the sidebar is rendered by the shell that wraps all
  // five formats, and dropping on a row means the end of that shelf. Keeping both was what left a
  // stack of identical dashed boxes after the last book, so that reaching for «the end» could
  // commit to some other shelf entirely — and the reader watched a book they had placed last
  // appear first, because shelves are drawn before the unfiled run.
  //
  // One end, drawn where its container ends. Everything else is named in the sidebar.
  /**
   * WHERE A BOOK SITS ON A GIVEN SHELF — the single authority, for every format.
   *
   * The grouped views used to answer this themselves, with the index of the tile inside the slice
   * they had just rendered: `shownBooks.map((b, i) => ... srcIndex={i})`. That number restarts at
   * zero for every category run and is cut short by the two-row cap, so it is not the book's
   * position on the shelf and it is not even unique within one shelf. Grid and Details meanwhile
   * took the real position out of the membership map. The same book reported a different index
   * depending only on which format was drawing it — and since a release resolves against exactly
   * that number, the same drag meant different things in different views, and positions past the
   * cap had no anchor at all.
   *
   * Answered once, here, from the same arrangement every other ordering decision is made against.
   */
  const positionIn = useCallback(
    (shelfId: string | null | undefined, bookId: string): number =>
      shelfId ? arrangement.indexIn(shelfId, bookId) : -1,
    [arrangement],
  );

  /**
   * WHAT CAN BE DONE WITH A BOOK — one answer, handed to every format that draws one.
   *
   * Vista, Covers and Spines got these through `BookTile`; Grid grew its own single button onto
   * Sard's older editor; Details had none at all. Three formats, three answers to the same
   * question. Resolved here, a format decides only where the control SITS.
   */
  const bookActions = useCallback(
    (b: BookRow): BookActionsProps => {
      const home = orderSourceOf(b.id);
      return {
        filePath: b.file_path,
        finished: isFinished(b),
        onEditDetails: () => setDetailsFor({ book: b, fromShelf: home }),
        onOpen: () => props.onOpenBook(b),
        onSetFinished: (f: boolean) => setFinished(b, f),
        // A rule shelf holds no membership row and the unshelved run is not a shelf, so neither
        // offers anything to leave.
        onRemoveFromShelf: home && !isVirtualShelf(home) ? () => removeFromShelf(b.id, home) : null,
        // The menu ASKS; the confirmation decides. Opening a dialog is the whole of what this does,
        // so a stray press on a five-item menu cannot cascade a book away.
        onDelete: () => setDeleting(b),
      };
    },
    [orderSourceOf, props, setFinished, removeFromShelf],
  );

  /**
   * The pickup descriptor for one book, carrying ITS shelf — never the view's.
   *
   * EVERY BOOK GETS ONE, INCLUDING A BOOK THAT CANNOT BE REORDERED. It used to get `undefined`,
   * with the reasoning that a book filed nowhere is an ordinary card — and in a view that draws
   * nothing else that would be true. But a flat list mixes the two, and handing back nothing does
   * not merely withhold the drag: it withholds the whole gesture, so the card falls back to opening
   * on a click while Manual Ordering is switched on over it. Measured at the library root: three of
   * forty-four books were draggable and the other forty-one opened, under an active mode.
   *
   * The two questions are therefore both answered, separately, on every book:
   *
   *   `arrangeOn`  is Manual Ordering running?           — the same answer for every book on screen
   *   `orderable`  can THIS book take part in ordering?  — its own answer, from its own shelf
   *
   * `useBookPickup` already knows what to do with `arrangeOn && !orderable`: it answers the press,
   * arms nothing, offers no grab cursor and opens nothing. It simply had to be asked.
   */
  const bookOrder = useCallback(
    (b: BookRow): CardOrder => {
      // WHERE THE BOOK IS. Every book has an answer, including one on no shelf: that is the
      // unfiled container, which has an order like any other and is somewhere to be carried from.
      const source = orderSourceOf(b.id) ?? LOOSE_SHELF_ID;
      const shelfId = source;
      const index = arrangement.indexIn(source, b.id);
      return {
        bookId: b.id,
        arrangeOn: mode === "arrange",
        orderable: true,
        shelfId,
        index,
        inHand: carry?.book.id === b.id,
        onArrangeDown: (x, y, el) => armBookDrag(b, source, x, y, el),
        onPickUp: () => setCarry({ book: b, fromShelf: source }),
      };
    },
    [orderSourceOf, arrangement, mode, carry, armBookDrag],
  );

  useEffect(() => {
    // The drop slots are all on screen at once, so nothing needs recomputing as the pane scrolls —
    // but the pane DOES need to scroll, or a shelf below the fold cannot be reached at all.
    const scroller = bookScroll.current!;
    const move = (e: PointerEvent) => {
      const st = bookDrag.current;
      if (st && !st.moved) {
        if (Math.abs(e.clientX - st.x) < 5 && Math.abs(e.clientY - st.y) < 5) return;
        st.moved = true;
        setCarry({ book: st.book, fromShelf: st.fromShelf });
      }
      // A BOOK IN HAND IS A BOOK IN HAND, however it was lifted — the same rule the release already
      // follows. A press-and-hold sets the carry without arming `bookDrag`, so keying the drag
      // feedback off `bookDrag` alone would have given the ghost and the lit place to arrange mode
      // only, and left the hold-then-drag gesture as blind as it was before.
      if (!st?.moved && !carry) return;
      scroller.update(e.clientX, e.clientY);
      followPointer(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      scroller.stop();
      endDragFeedback();
      const st = bookDrag.current;
      bookDrag.current = null;

      // A BOOK IN HAND IS A BOOK IN HAND, however it was lifted.
      //
      // This used to return unless the release came from a drag ARMED IN ARRANGE MODE, because only
      // that path fills `bookDrag`. Press-and-hold sets the carry directly, so lifting a book that
      // way, dragging it onto a landing place and letting go did nothing at all: the slots stayed on
      // screen, the book stayed in hand, and nothing was written. Measured on «To read» — the same
      // gesture reordered the shelf with arrange mode on and left it untouched with arrange mode off.
      //
      // The release now hit-tests whenever anything is being carried. What `bookDrag` still decides
      // is what an EMPTY release means: a real drag that ended over nothing puts the book back, while
      // a press-and-hold that ended over nothing leaves it in hand — which is what keeps
      // lift-then-click working as the second way to place it.
      const target = dropTarget(e.clientX, e.clientY);
      if (!target) {
        if (st?.moved) setCarry(null);
        return;
      }
      // THE TWO ACTS, KEPT APART AT THE ONE POINT WHERE A GESTURE BECOMES A WRITE.
      //
      // A release onto a shelf in the sidebar is a move. A release inside the run is a reorder.
      //
      // And one case in between, which only the GROUPED formats can produce: a release onto a tile
      // in a DIFFERENT section from the one the book is in. There the section is on screen with its
      // name above it, so aiming at it is as deliberate as aiming at the sidebar — it files the book
      // there and positions it among its new neighbours.
      //
      // The flat formats cannot reach this branch. Their only target is the whole run, which by
      // definition already holds the book, so a drag there is a reorder and can be nothing else.
      if (target.kind !== "order") {
        moveToShelf(target.container, target.categoryId);
      } else if (
        target.section !== WHOLE_RUN &&
        carry &&
        !sectionOrder(target.section).includes(carry.book.id)
      ) {
        placeOnShelf({ container: target.section, before: target.before }, null);
      } else {
        reorderInto(target.section, target.before);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [reorderInto, moveToShelf, placeOnShelf, sectionOrder, carry, followPointer, endDragFeedback, dropTarget]);

  // Whatever put the book down — a placement, Escape, the carry bar's own cancel — the ghost and
  // the lit place go with it. One rule, rather than one at each exit.
  useEffect(() => {
    if (!carry) endDragFeedback();
  }, [carry, endDragFeedback]);

  // Esc cancels a carry, exactly as the design specifies.
  useEffect(() => {
    if (!carry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Also forget the press that started it, so the release does not then place the book at
      // whatever happens to be under the pointer.
      bookDrag.current = null;
      setCarry(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carry]);

  /**
   * Esc walks one level out, which is the only keyboard binding Vista gains.
   *
   * It defers to everything that already answers to Escape — a carried book, an open sheet, the
   * editor, a menu, a field being typed into — so it can never steal the key from a more local
   * meaning. `parentScope` is the same function the trail uses, so the two cannot disagree.
   */
  useEffect(() => {
    if (view !== "vista" || carry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (detailsFor || editorFor || orderMenuFor || renamingShelf) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const up = parentScope(scope);
      if (!up) return;
      e.preventDefault();
      setScope(up);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, carry, scope, detailsFor, editorFor, orderMenuFor, renamingShelf]);

  // ---- chrome inputs ---------------------------------------------------------
  const unfiledScoped = scope.caseId === UNFILED_CASE_ID;
  const scopedCase: { id: string; name: string } | null = unfiledScoped
    ? { id: UNFILED_CASE_ID, name: t("lib.unfiled") }
    : scope.caseId
      ? (tree.cases.find((c) => c.id === scope.caseId) ?? null)
      : null;
  // The unshelved run is a real place to stand but not a row in `collections`, so it resolves
  // here rather than through `shelfById` — without this, focusing it left the heading and the
  // breadcrumb both claiming "Library" while the pane showed one filtered run.
  const scopedShelf: { id: string; name: string } | null = !scope.shelfId
    ? null
    : isVirtualShelf(scope.shelfId)
      ? { id: scope.shelfId, name: t("lib.unshelved") }
      : (shelfById.get(scope.shelfId)?.shelf ?? null);

  // The category the reader is standing in. It lives on its shelf, so it resolves through the same
  // lookup — and if the shelf is the unshelved run, there is nothing to resolve.
  const scopedCategory: { id: string; name: string } | null = !scope.categoryId
    ? null
    : (shelfById.get(scope.shelfId ?? "")?.shelf.categories.find((k) => k.id === scope.categoryId) ?? null);

  // THE PATH, AND THE ONLY PLACE IT IS SPELLED OUT. Vista's bands name themselves and nothing more;
  // who owns them is answered here, at every depth, by a header that does not scroll. Every ancestor
  // is a way back — including the shelf, which was inert while it was always the last crumb.
  const crumbs = [
    { label: t("lib.nav.library"), go: goRoot },
    ...(scopedCase
      ? [{ label: scopedCase.name, go: () => setScope({ caseId: scopedCase.id, shelfId: null, categoryId: null }) }]
      : []),
    ...(scopedShelf
      ? [{ label: scopedShelf.name, go: () => setScope((s) => ({ ...s, shelfId: scopedShelf.id, categoryId: null })) }]
      : []),
    ...(scopedCategory ? [{ label: scopedCategory.name, go: () => {} }] : []),
  ];

  /**
   * Vista's place-line — the trail out, the name of where the reader is, and what it holds.
   *
   * Only Vista takes it; the other four views keep the crumb row and title they have always had,
   * so nothing outside this view moves. A case reports its SHELVES as well as its books, which is
   * how a reader learns that a case is a thing that holds shelves.
   */
  const vistaPlace: PlaceLine | null = useMemo(() => {
    if (view !== "vista") return null;
    const trail: { label: string; go: () => void }[] = [];
    if (scope.caseId || scope.shelfId) trail.push({ label: t("lib.nav.library"), go: goRoot });
    if (scopedCase && (scope.shelfId || scope.categoryId)) {
      const id = scopedCase.id;
      trail.push({ label: scopedCase.name, go: () => setScope({ caseId: id, shelfId: null, categoryId: null }) });
    }
    if (scopedShelf && scope.categoryId) {
      trail.push({ label: scopedShelf.name, go: () => setScope((s) => ({ ...s, categoryId: null })) });
    }
    const books = t("lib.count", { n: num(flatBooks.length) });
    if (scopedCategory) {
      return { level: "category", name: scopedCategory.name, ink: null, sub: books, trail };
    }
    if (scopedShelf) {
      const cats = shelfById.get(scopedShelf.id)?.shelf.categories.length ?? 0;
      return {
        level: "shelf",
        name: scopedShelf.name,
        ink: null,
        sub: cats ? `${books} · ${t("lib.categoriesCount", { n: num(cats) })}` : books,
        trail,
      };
    }
    if (scopedCase) {
      const node = tree.cases.find((c) => c.id === scopedCase.id) ?? null;
      const shelves = node ? node.shelves.length : tree.loose.length;
      // Same two numbers as the case's plate, and the same reason for keeping both: `flatBooks` is
      // what the case's shelves SHOW, `node.count` is what is filed into them, and a rule shelf
      // makes them differ. See VistaChild.filed.
      const filed = node ? node.count : flatBooks.length;
      const shelvesLine = t("lib.shelvesCount", { n: num(shelves) });
      const filedLine = t("lib.count", { n: num(filed) });
      return {
        level: "case",
        name: scopedCase.name,
        ink: node?.ink ?? null,
        sub:
          filed < flatBooks.length
            ? `${filedLine} · ${shelvesLine} · ${t("lib.vista.shownByRule", { n: num(flatBooks.length - filed) })}`
            : `${books} · ${shelvesLine}`,
        trail,
      };
    }
    return {
      level: "lib",
      name: t("lib.title"),
      ink: null,
      sub: tree.cases.length
        ? `${books} · ${t("lib.casesCount", { n: num(tree.cases.length) })}`
        : books,
      trail,
    };
  }, [view, scope, scopedCase, scopedShelf, scopedCategory, flatBooks.length, tree, shelfById, t, lang, goRoot]);

  const heading = scopedCategory
    ? scopedCategory.name
    : scopedShelf
      ? scopedShelf.name
      : scopedCase
        ? scopedCase.name
        : t("lib.title");
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
          unshelved={looseRun.length ? makeLooseShelf(t("lib.unshelved"), looseRun.length) : null}
          bookCount={props.books.length}
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
          onCreateCase={() => setCreating({ kind: "case", preselect: null })}
          onCreateShelf={(preselect) => setCreating({ kind: "shelf", preselect })}
          onRenameCaseDialog={(id, name) => setCreating({ kind: "case", preselect: null, rename: { id, name } })}
          onRenameShelfDialog={(id, name) => setCreating({ kind: "shelf", preselect: null, rename: { id, name } })}
          onRenameCase={caseOps.rename}
          onDeleteCase={caseOps.remove}
          onMoveCase={caseOps.move}
          onNewRuleShelf={(caseId) => write(() => shelfCreate(t("lib.rule.reading"), caseId, "reading"))}
          onCaseInk={(id, ink) => write(() => caseSetInk(id, ink))}
          onPlaceCase={placeCase}
          onManageUnfiled={() => setEditorFor(UNFILED_EDITOR)}
          onManageCase={setEditorFor}
          onRenameShelf={renameShelf}
          onDeleteShelf={deleteShelf}
          onSetShelfOrder={shelfOps.setOrder}
          onSetShelfCase={async (id, caseId) => { await write(() => shelfSetCase(id, caseId)); await loadTree(); }}
          onShelfInk={(id, ink) => write(() => shelfSetInk(id, ink))}
          onMoveShelf={shelfOps.move}
          onSettings={props.onSettings}
          themeName={resolveTheme(themeId).name}
          langName={t(lang === "ar" ? "lang.arabic" : "lang.english")}
        />
        {/* `.lib-main` + `.lib-pane` verbatim, because the section panes were written against that
            contract: `.inbox` is `height:100%; overflow:hidden`, which needs an ancestor that is
            both sized and allowed to shrink (`min-height: 0`). A hand-rolled wrapper without it
            lets those panes grow past the window instead of scrolling inside it. */}
        <div className="lib-main">
          <div className="lib-pane">{props.renderSection(props.section)}</div>
        </div>
        <div className={OVERLAY_HOST_CLASS} />
      </div>
    );
  }

  return (
    // BOTH classes, deliberately. `.lib-root` is the element the RAWY-265 background system hangs
    // its two layers on (`::before` the image, `::after` the scrim), the element it gives
    // `isolation: isolate`, and the element whose `--lib-faint` it re-grounds to hold the measured
    // 3:1 floor over a photograph. Renaming the shell to `.libd-root` alone silently detached all
    // three. `.libd-root` adds only the design's variable bindings on top.
    // THERE IS NO `libd-vista` ANY MORE. It existed to lift the flat scrim off Vista's stage and
    // off Vista's alone, which is what made a chosen photograph look different in four of the five
    // formats. The scrim now follows the reader's Presence control everywhere; see the note in
    // `library-design.css` where the class's rule used to be.
    <div className="lib-root libd-root">
      {/* THE SHELL STAYS, AT FULL SIZE AND FULL FUNCTION. An earlier Vista removed the sidebar and
          the toolbar to give the photograph the whole window; measured, that bought 1.6x more
          photograph and cost the reader search, sort, density, filtering and every destination in
          the library. The scrim, not the shell, was what was hiding the picture. */}
      <Sidebar
        section={props.section}
        onSection={goSection}
        cases={tree.cases}
        loose={tree.loose}
        unshelved={looseRun.length ? makeLooseShelf(t("lib.unshelved"), looseRun.length) : null}
        bookCount={props.books.length}
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
        onCreateCase={() => setCreating({ kind: "case", preselect: null })}
        onCreateShelf={(preselect) => setCreating({ kind: "shelf", preselect })}
        onRenameCaseDialog={(id, name) => setCreating({ kind: "case", preselect: null, rename: { id, name } })}
        onRenameShelfDialog={(id, name) => setCreating({ kind: "shelf", preselect: null, rename: { id, name } })}
        onRenameCase={caseOps.rename}
        onDeleteCase={caseOps.remove}
        onMoveCase={caseOps.move}
        onNewRuleShelf={(caseId) => write(() => shelfCreate(t("lib.rule.reading"), caseId, "reading"))}
          onCaseInk={(id, ink) => write(() => caseSetInk(id, ink))}
          onPlaceCase={placeCase}
          onManageUnfiled={() => setEditorFor(UNFILED_EDITOR)}
          onManageCase={setEditorFor}
          onRenameShelf={renameShelf}
          onDeleteShelf={deleteShelf}
          onSetShelfOrder={shelfOps.setOrder}
          onSetShelfCase={async (id, caseId) => { await write(() => shelfSetCase(id, caseId)); await loadTree(); }}
          onShelfInk={(id, ink) => write(() => shelfSetInk(id, ink))}
          onMoveShelf={shelfOps.move}
        onSettings={props.onSettings}
        themeName={resolveTheme(themeId).name}
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
          bare={libraryIsBare({ query: props.query, totalBooks: props.books.length })}
          crumbs={crumbs}
          heading={heading}
          subcount={t("lib.count", { n: num(flatBooks.length) })}
          place={vistaPlace}
          canArrangeHere={canArrangeHere}
          arrangeReason={arrangeReason}
          canSortByShelf={canChooseOwnOrder}
          handOrdered={handOrdered}
          mode={mode}
          onToggleSelect={() => {
            setMode((m) => (m === "select" ? "browse" : "select"));
            setSelected(new Set());
          }}
          onToggleArrange={() => {
            setMode((m) => {
              const next = m === "arrange" ? "browse" : "arrange";
              // THE MODE DECIDES WHAT MAY BE MOVED. IT DOES NOT DECIDE WHAT ORDER THE LIST IS IN.
              //
              // Details used to switch the sort to the shelf's own order when this went on, and put
              // the reader's sort back when it went off, so that a hand reorder would be visible
              // rather than written and hidden in the same instant. The reader's own words for what
              // that felt like: enabling Manual Ordering reshuffles the books, disabling restores
              // them. Asking to be ABLE to move one book is not a request to rearrange the rest.
              //
              // What the reorder needed was never a change of sort — it was for the app to stop
              // offering positions it cannot draw. Under a column sort «between these two books» has
              // no meaning on screen, so it is no longer offered at all; a book can still be sent to
              // a shelf, which changes something the reader can see. See `handOrdered`.
              return next;
            });
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
          hideTitles={hideTitles}
          onHideTitles={() => setHideTitles((v) => !v)}
          format={props.format}
          onFormat={props.onFormat}
        />

        {/* NOTHING TO SHOW — DECIDED ONCE, ABOVE THE FIVE VIEWS.
            It used to be a sibling INSIDE the third branch, so only Covers, Spines and Details ever
            reached it: Grid and Vista are branches of their own, and both drew an empty stage for
            all three kinds of nothing. Measured, with a search that matched nothing:

              عرض شبكي  none     الأغلفة  search     الكعوب  search
              التفاصيل  search   المشهد   none

            Hoisting it here rather than repeating it in two more branches means every view is
            covered by construction, and that exactly ONE empty state can ever be on screen —
            neither is a property a reviewer has to check per view. `paneRef` stays attached so the
            pane-width measurement and the edge scroller keep their element in every state. */}
        {emptyState ? (
          <div
            ref={paneRef}
            className="libd-stage"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              overflowY: "auto",
              overflowX: "hidden",
              position: "relative",
              zIndex: 2,
            }}
          >
            <LibraryEmpty
              kind={emptyState}
              t={t}
              onAddBooks={props.onAddBooks}
              onClearQuery={() => props.onQuery("")}
            />
          </div>
        ) : vista ? (
          <div ref={paneRef} style={{ flex: 1, minHeight: 0, position: "relative", zIndex: 2 }}>
            <ViewVista
              onDeleteBook={(b) => setDeleting(b)}
              view={stage}
              density={density}
              hideTitles={hideTitles}
              paneWidth={paneWidth}
              mode={mode}
              selected={selected}
              carryId={carry?.book.id ?? null}
              onGo={(next) => {
                setScope(next);
                // The sidebar opens the case the stage walks into, so its tree and the stage
                // always agree about where the reader is.
                if (next.caseId) setOpenCases((prev) => new Set(prev).add(next.caseId!));
              }}
              onOpenBook={props.onOpenBook}
              onEditBook={(b) => setDetailsFor({ book: b, fromShelf: stage.bookSource?.id ?? null })}
              onToggleSelect={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              positionIn={positionIn}
              onPickUp={(b, shelfId) => setCarry({ book: b, fromShelf: sourceFor(b, shelfId) })}
              onArrangeDown={(b, shelfId, x, y, el) => armBookDrag(b, sourceFor(b, shelfId), x, y, el)}
              onRemoveFromShelf={removeFromShelf}
              onSetFinished={setFinished}
              onPlace={placeOnShelf}
              orderGap={orderGap}
              libraryCoverMode={props.coverMode}
            />
          </div>
        ) : view === "grid" ? (
          <div
            ref={paneRef}
            className="libd-stage"
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 2 }}
          >
            {props.renderGrid({
              actions: bookActions,
              coverMin: baseWidth(density),
              // THE FLAT RUN, AT EVERY SCOPE — the same list Details draws, and the same one the
              // landing places write to.
              //
              // Standing inside a shelf, this used to draw `shelfBooks(scopedShelfNode)` — the
              // SHELF's section — while the gaps it drew wrote to the flat run `*`. Write one
              // section, read another: a reorder there wrote a row nobody read and the screen did
              // not move. `flatBooks` is already filtered to the scope, so inside a shelf it holds
              // exactly that shelf's books, in the order this format saved for them.
              books: flatBooks,
              hideTitles,
              gap: gapBefore,
              gapAfter,
              order: bookOrder,
            })}
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
              // Details reorders under exactly the conditions everything else does, and through
              // exactly the same machinery: it emits `data-book` and the landing-place attributes,
              // and `LibraryDesign`'s own pointer listeners do the carrying.
              // The same three things Grid gets, for the same reason: a row's shelf is the
              // book's, not the view's.
              gap={gapBefore}
              gapAfter={gapAfter}
              order={bookOrder}
              actions={bookActions}
              arrangeOn={mode === "arrange"}
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
          ) : isGroupedView(view) ? (
            <ViewGrouped
              onDeleteBook={(b) => setDeleting(b)}
              cases={rendered}
              view={view}
              density={density}
              hideTitles={hideTitles}
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
              onFocusCase={(id) => setScope({ caseId: id, shelfId: null, categoryId: null })}
              onFocusShelf={(id) => setScope((s) => ({ ...s, shelfId: id, categoryId: null }))}
              onToggleShelf={async (s) => {
                await write(() => shelfSetCollapsed(s.id, !s.collapsed));
              }}
              onOpenBook={props.onOpenBook}
              onEditBook={(b, fromShelf) => setDetailsFor({ book: b, fromShelf: fromShelf ?? null })}
              onToggleSelect={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              positionIn={positionIn}
              onPickUp={(b, shelfId) => setCarry({ book: b, fromShelf: sourceFor(b, shelfId) })}
              onArrangeDown={(b, shelfId, x, y, el) => armBookDrag(b, sourceFor(b, shelfId), x, y, el)}
              onRemoveFromShelf={removeFromShelf}
              onSetFinished={setFinished}
              onNewShelf={(caseId) => setCreating({ kind: "shelf", preselect: caseId })}
              onManageCase={(id) => setEditorFor(id)}
              expandedShelves={expandedShelves}
              onExpandShelf={(id) => setExpandedShelves((prev) => new Set(prev).add(id))}
              carryWidth={carry ? spineWidth(carry.book, density) : 0}
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
              onShelfInk={(id, ink) => write(() => shelfSetInk(id, ink))}
              onSetShelfCase={async (id, caseId) => { await write(() => shelfSetCase(id, caseId)); await loadTree(); }}
              onMoveShelf={shelfOps.move}
              onPlace={placeOnShelf}
              orderGap={orderGap}
              libraryCoverMode={props.coverMode}
            />
          ) : null}

        </div>
        )}

        {carry && (
          // The book itself, under the hand. Sized and offset entirely in CSS: the stage's geometry
          // belongs to the stylesheet, and the guard enforces that.
          <div ref={dragGhost} className="libd-drag-ghost" aria-hidden>
            {coverSrc(carry.book) ? (
              <img src={coverSrc(carry.book)!} alt="" draggable={false} />
            ) : (
              <span dir="auto">{carry.book.title}</span>
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
              {handOrdered ? t("lib.arrangeHintOn") : t("lib.arrangeHintSorted")}
            </span>
            <button
              className="libd-hov libd-hov-txt"
              onClick={() => setCarry(null)}
              style={{
                height: "var(--ctl-md)",
                padding: "0 12px",
                borderRadius: "var(--r-md)",
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
            // Named the same way the tiles and the landing places are, and for the same reason: a
            // check that wants to know what the reader was told should read it, not infer it from
            // the one unlabelled absolutely-positioned box near the bottom of the pane.
            data-toast="1"
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
          items={shelfRows}
          onTree={applyTree}
          onChanged={() => {
            loadTree().catch(() => {});
            props.onReloadBooks();
          }}
          onClose={() => setEditorFor(null)}
          onOpenBookDetails={(b, fromShelf) => setDetailsFor({ book: b, fromShelf: fromShelf ?? null })}
          notify={flash}
        />
      )}

      {/* THE ONE CREATION DIALOG. Mounted here beside the other two, so it is the same dialog with
          the same fields and the same validation whichever surface asked for it. */}
      {creating && (
        <CreateDialog
          request={creating}
          cases={tree.cases}
          // Names already in use in the same family — a shelf compares against shelves, a case
          // against cases — so a repeat can be pointed out. The model allows one, so this only
          // ever informs; see the dialog.
          taken={
            creating.kind === "case"
              ? tree.cases.map((c) => c.name)
              : [...tree.cases.flatMap((c) => c.shelves.map((sh) => sh.name)), ...tree.loose.map((sh) => sh.name)]
          }
          busy={creatingBusy}
          onCancel={() => setCreating(null)}
          onCreate={async (name, caseId, ink) => {
            setCreatingBusy(true);
            // RENAMING TOUCHES THE NAME AND NOTHING ELSE — the dialog shows neither a destination
            // nor a colour in that mode, so there is nothing else it could have been asked to do.
            // A case renames through `case_rename`, which answers with a tree; a shelf renames
            // through `collection_rename`, which answers with rows, so it goes the way every other
            // shelf rename in the app already goes — the Library's own call, then a reload.
            const target = creating.rename;
            if (target) {
              if (creating.kind === "case") await write(() => caseRename(target.id, name));
              else await renameShelf(target.id, name);
              setCreatingBusy(false);
              setCreating(null);
              return;
            }
            const made = await write(async () => {
              // A CASE TAKES ITS INK IN ONE CALL — `case_create` has always accepted one.
              if (creating.kind === "case") return caseCreate(name, ink);
              const next = await shelfCreate(name, caseId);
              if (!ink) return next;
              // A SHELF'S DOES NOT, so it is a second write — made only when a colour was
              // actually chosen, so the ordinary shelf is still one. The new shelf is found by
              // difference rather than by name: two shelves may honestly share a name, and
              // matching on one would colour whichever the search happened to reach first.
              const had = new Set([
                ...tree.cases.flatMap((k) => k.shelves.map((sh) => sh.id)),
                ...tree.loose.map((sh) => sh.id),
              ]);
              const fresh = [...next.cases.flatMap((k) => k.shelves), ...next.loose].find((sh) => !had.has(sh.id));
              return fresh ? shelfSetInk(fresh.id, ink) : next;
            });
            setCreatingBusy(false);
            // A FAILED WRITE KEEPS THE DIALOG, AND WHAT WAS TYPED IN IT. `write` has already told
            // the reader what went wrong; closing on top of that would take the name away too and
            // leave them to type it again with no idea whether the first attempt half-landed.
            if (made) setCreating(null);
          }}
        />
      )}

      {carry && <CarryGhost book={carry.book} spines={view === "spines"} />}

      {/* Book Details, from the reference bundles. One dialog, mounted once here, so it is the
          same dialog with the same controls whichever view opened it. */}
      {deleting && (
        <ConfirmDeleteBook
          book={deleting}
          t={t}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const book = deleting;
            setDeleting(null);
            await props.onDeleteBook(book);
          }}
        />
      )}
      {detailsFor && (
        <BookDetails
          book={detailsFor.book}
          cases={tree.cases}
          loose={tree.loose}
          placement={placementOf(detailsFor.book.id)}
          notify={flash}
          libraryCoverMode={props.coverMode}
          onClose={() => setDetailsFor(null)}
          onChanged={() => {
            loadTree().catch(() => {});
            props.onReloadBooks();
          }}
        />
      )}
      {/* WHERE EVERY FLOATING SURFACE IS DRAWN. Last, so it paints over the pane and the sidebar;
          inside the shell, so it inherits the design tokens. See `overlay.ts`. */}
      <div className={OVERLAY_HOST_CLASS} />
    </div>
  );
}


/**
 * WHAT THE LIBRARY SAYS WHEN IT HAS NOTHING TO SHOW.
 *
 * Three states, and the copy for two of them was already written and simply never reached: the old
 * library's welcome — `lib.empty.title` / `lib.empty.sub`, with the hoopoe over it — and the
 * shelf's own line, `lib.emptyShelf`, which already says what a reader should do with a shelf
 * («التقط كتابًا وضعه هنا»). Nothing new is invented here beyond routing.
 *
 * THE WELCOME IS THE ONE THAT CARRIES WEIGHT. It is a new reader's first screen, so it gets the
 * mark, the larger setting and a single primary action; the other two stay quiet, because a reader
 * meeting them already knows what Sard is and is looking for one specific thing.
 */
function LibraryEmpty({
  kind,
  t,
  onAddBooks,
  onClearQuery,
}: {
  kind: EmptyKind;
  t: (k: TKey) => string;
  onAddBooks: () => void;
  onClearQuery: () => void;
}) {
  const welcome = kind === "library";
  return (
    <div className="libd-empty" data-empty={kind} data-scale={welcome ? "welcome" : "quiet"}>
      {/* THE MARK, AND IT IS NEVER EMPTY.
          What stood here for the two quiet states was a bare 52px div with a border and no
          content — an unfinished placeholder that read as a missing icon above «لا نتائج». The
          Inbox's empty state already had the answer: an icon from the set, tinted, as an ornament.
          Each state now names ITSELF — the search finds nothing, the shelf holds nothing — and the
          welcome keeps the hoopoe, which is the one mark here that is an identity rather than a
          label. */}
      <div className="libd-empty-mark" aria-hidden>
        {welcome ? <Hoopoe size={104} /> : <Icon name={kind === "search" ? "search" : "navLibrary"} size="xl" />}
      </div>

      <div className="libd-empty-title">
        {kind === "library" ? t("lib.empty.title")
          : kind === "shelf" ? t("lib.emptyShelfShort")
          : t("lib.noResults")}
      </div>

      <p className="libd-empty-body">
        {kind === "library" ? t("lib.empty.sub")
          : kind === "shelf" ? t("lib.shelfRow.empty")
          : t("lib.noResultsBody")}
      </p>

      {/* ONE ACTION, AND IT IS THE ONE THE STATE IS ABOUT. */}
      <div className="libd-empty-act">
        {kind === "search" ? (
          <button
            className="libd-hov"
            onClick={onClearQuery}
            style={{
              minHeight: "var(--ctl-lg)",
              padding: "0 15px",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--brd)",
              background: "var(--soft)",
              font: "500 .75rem var(--ui)",
            }}
          >
            {t("lib.clearSearch")}
          </button>
        ) : (
          <button
            className="libd-hov-bright"
            onClick={onAddBooks}
            style={{
              minHeight: welcome ? "var(--ctl-xl)" : "var(--ctl-lg)",
              padding: welcome ? "0 26px" : "0 18px",
              borderRadius: "var(--r-md)",
              border: "none",
              background: "var(--acc)",
              color: "var(--pap)",
              font: welcome ? "600 .875rem var(--ui)" : "600 .8125rem var(--ui)",
              boxShadow: "var(--sh1)",
              cursor: "pointer",
            }}
          >
            {t("lib.add")}
          </button>
        )}
      </div>
    </div>
  );
}


/**
 * DELETING A BOOK, ASKED PROPERLY.
 *
 * Nothing new is invented here. The words are the ones the edit dialog has used since RAWY-76 —
 * `edit.deleteConfirm` already names exactly what goes with the book («تظليلات وملاحظات وفواصل
 * وبطاقات») and says it cannot be undone — and the deletion itself runs through the owner's single
 * `bookDelete` path. What was missing was a way to reach it from the menu that names the book.
 *
 * It is a dialog rather than the edit dialog's two-step footer because it arrives from a MENU: a
 * menu item that swaps a row in place would leave a reader confirming inside a surface they opened
 * for something else. `useDialog` gives it the same focus, trap, Escape and restoration as every
 * other dialog in Sard; focus lands on the dialog, never on «حذف», because Enter on arrival must
 * not delete a book.
 */
function ConfirmDeleteBook({
  book,
  t,
  onCancel,
  onConfirm,
}: {
  book: BookRow;
  t: (k: TKey) => string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const dlg = useDialog({ onDismiss: onCancel, initialFocus: "none" });
  // The SAME name the tile and the details sheet show — a confirmation that renamed the book
  // between the menu and the dialog would be its own small betrayal.
  const title = displayTitle(resolveBookMeta(book), t);
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.34)",
        display: "grid", placeItems: "center", padding: "var(--sp-6)",
        animation: "sard-fade .14s ease-out",
      }}
    >
      <div
        className="libd-dialog"
        ref={dlg.ref}
        {...dlg.props}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px,100%)", maxHeight: "100%", overflowY: "auto",
          background: "var(--chr)", border: "1px solid var(--brd)",
          borderRadius: "var(--r-xl)", boxShadow: "var(--sh4)",
          padding: "var(--sp-7)", animation: "sard-rise .16s ease-out",
        }}
      >
        <div id={dlg.titleId} style={{ font: "600 1.0625rem var(--ui)", color: "var(--txt)", marginBottom: "var(--sp-4)" }}>
          {t("edit.delete")}
        </div>
        {/* The book being deleted, named — a confirmation that does not say WHICH book is a
            confirmation of nothing. */}
        <div dir="auto" style={{ font: "600 .875rem var(--ui)", color: "var(--txt)", marginBottom: "var(--sp-3)" }}>
          {title}
        </div>
        <p style={{ margin: "0 0 var(--sp-7)", font: "400 .8125rem/1.7 var(--ui)", color: "var(--mut)" }}>
          {t("edit.deleteConfirm")}
        </p>
        <div style={{ display: "flex", gap: "var(--sp-4)", justifyContent: "flex-end" }}>
          <button
            className="libd-hov"
            onClick={onCancel}
            disabled={busy}
            style={{
              minHeight: "var(--ctl-lg)", padding: "0 16px", borderRadius: "var(--r-md)",
              border: "1px solid var(--brd)", background: "transparent",
              font: "500 .8125rem var(--ui)", color: "var(--txt)",
            }}
          >
            {t("edit.deleteKeep")}
          </button>
          <button
            onClick={async () => {
              // ONE DELETE PER CONFIRMATION. The press is spent the moment it is made, so a second
              // press while the first is still running cannot ask the core to delete it twice.
              if (busy) return;
              setBusy(true);
              await onConfirm();
            }}
            disabled={busy}
            style={{
              minHeight: "var(--ctl-lg)", padding: "0 16px", borderRadius: "var(--r-md)",
              border: "none", background: "#9c3b3b", color: "var(--pap)",
              font: "600 .8125rem var(--ui)", cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {t("edit.deleteYes")}
          </button>
        </div>
      </div>
    </div>,
    // INSIDE THE SHELL, NOT ON `document.body`. Every design token this dialog uses — `--chr`,
    // `--brd`, `--txt`, `--mut`, `--pap` — is declared on `.libd-root`, so portalled to the body it
    // rendered as an outlined box with no fill and no scrim, its words lying over the covers behind
    // it. `overlay.ts` exists because the book menu hit exactly this, and says so at length.
    overlayHost(),
  );
}
