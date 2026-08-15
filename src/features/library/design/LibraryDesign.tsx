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
  spineWidth,
  sortBooks,
  unshelvedBooks,
  type DesignSort,
  type DesignView,
} from "./model";

const EMPTY_TREE: LibraryTree = { cases: [], loose: [] };

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
  const [manageMenuFor] = useState<string | null>(null);
  const [renamingCase, setRenamingCase] = useState<string | null>(null);
  const [detailsFor, setDetailsFor] = useState<BookRow | null>(null);
  // Which case the management panel is open on — the reference's "Manage" destination.
  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
    })().catch(() => {});
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
    setTree(next);
    const shelves = [...next.cases.flatMap((c) => c.shelves), ...next.loose];
    const pairs = await Promise.all(
      shelves.map(async (s) => [s.id, await libraryShelfItems(s.id).catch(() => [])] as const),
    );
    setItems(Object.fromEntries(pairs));
    // Cases start open, as the design shows them.
    setOpenCases((prev) => (prev.size ? prev : new Set(next.cases.map((c) => c.id))));
  }, []);

  useEffect(() => {
    loadTree().catch(() => {});
  }, [loadTree, props.books]);

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

  // Started and not finished — the number the reference prints beside "Reading now".
  const readingCount = useMemo(
    () => props.books.filter((b) => (b.fraction ?? 0) > 0 && (b.fraction ?? 0) < 1).length,
    [props.books],
  );

  const shelfById = useMemo(() => {
    const m = new Map<string, { shelf: ShelfNode; caseNode: CaseNode | null }>();
    for (const c of tree.cases) for (const s of c.shelves) m.set(s.id, { shelf: s, caseNode: c });
    for (const s of tree.loose) m.set(s.id, { shelf: s, caseNode: null });
    return m;
  }, [tree]);

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
    if (!scope.caseId || scope.caseId === "__loose") {
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
      // The unshelved run is a render-time fiction, not a collection — nothing can be put into it.
      if (isVirtualShelf(shelfId)) {
        flash(t("lib.cannotPlace"));
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
      try {
        setTree(await shelfPlaceBook(shelfId, carry.book.id, categoryId, index));
        setItems((prev) => ({ ...prev }));
        await loadTree();
        flash(`${t("lib.placed")} ${t("lib.on")} ${target?.shelf.name ?? ""}`);
      } catch (e) {
        flash(String(e));
      }
      setCarry(null);
    },
    [carry, shelfById, flash, t, loadTree],
  );

  const removeFromShelf = useCallback(
    async (bookId: string, shelfId: string) => {
      await collectionRemoveBook(shelfId, bookId).catch(() => {});
      await loadTree();
    },
    [loadTree],
  );

  const setFinished = useCallback(
    async (b: BookRow, finished: boolean) => {
      await progressSave(b.id, "", finished ? 1 : 0).catch(() => {});
      props.onReloadBooks();
    },
    [props],
  );

  /** Move every selected book onto one shelf, then leave Select mode as the design does. */
  const bulkMove = useCallback(
    async (shelfId: string) => {
      const ids = [...selected];
      for (const id of ids) await shelfPlaceBook(shelfId, id, null, 0).catch(() => {});
      await loadTree();
      setSelected(new Set());
      setMode("browse");
      const target = shelfById.get(shelfId);
      flash(`${t("lib.placed")} ${t("lib.on")} ${target?.shelf.name ?? ""}`);
    },
    [selected, loadTree, shelfById, flash, t],
  );

  const caseOps = useMemo(
    () => ({
      rename: async (id: string, name: string) => setTree(await caseRename(id, name)),
      remove: async (id: string) => {
        setTree(await caseDelete(id));
        await loadTree();
      },
      move: async (id: string, direction: number) => {
        const at = tree.cases.findIndex((c) => c.id === id);
        if (at < 0) return;
        setTree(await caseReorder(id, Math.max(0, at + direction)));
      },
    }),
    [tree.cases, loadTree],
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
        setTree(await shelfSetOrder(shelfId, order));
        await loadTree();
      },
      move: async (shelfId: string, direction: number) => {
        const entry = shelfById.get(shelfId);
        const siblings = entry?.caseNode ? entry.caseNode.shelves : tree.loose;
        const at = siblings.findIndex((s) => s.id === shelfId);
        if (at < 0) return;
        setTree(await shelfReorder(shelfId, Math.max(0, at + direction)));
      },
      newCategory: async (shelfId: string) => {
        setTree(await categoryCreate(shelfId, t("lib.newCategory")));
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
  const scopedShelf = scope.shelfId ? shelfById.get(scope.shelfId)?.shelf ?? null : null;

  const crumbs = [
    { label: t("lib.nav.library"), go: () => setScope({ caseId: null, shelfId: null }) },
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
          onSection={props.onSection}
          cases={tree.cases}
          loose={tree.loose}
          bookCount={props.books.length}
          readingCount={readingCount}
          scope={scope}
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
          onNewCase={async (name) => setTree(await caseCreate(name))}
          onNewShelf={async (caseId, name) => setTree(await shelfCreate(name, caseId))}
          onRenameCase={caseOps.rename}
          onDeleteCase={caseOps.remove}
          onMoveCase={caseOps.move}
          onNewRuleShelf={async (caseId) => setTree(await shelfCreate(t("lib.rule.reading"), caseId, "reading"))}
          onCaseInk={async (id, ink) => setTree(await caseSetInk(id, ink))}
          onPlaceCase={async (id, at) => setTree(await caseReorder(id, at))}
          onRenameShelf={renameShelf}
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
        onSection={props.onSection}
        cases={tree.cases}
        loose={tree.loose}
        bookCount={props.books.length}
        readingCount={readingCount}
        scope={scope}
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
        onNewCase={async (name) => setTree(await caseCreate(name))}
        onNewShelf={async (caseId, name) => setTree(await shelfCreate(name, caseId))}
        onRenameCase={caseOps.rename}
        onDeleteCase={caseOps.remove}
        onMoveCase={caseOps.move}
        onNewRuleShelf={async (caseId) => setTree(await shelfCreate(t("lib.rule.reading"), caseId, "reading"))}
          onCaseInk={async (id, ink) => setTree(await caseSetInk(id, ink))}
          onPlaceCase={async (id, at) => setTree(await caseReorder(id, at))}
        onRenameShelf={renameShelf}
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
                setTree(await shelfSetCollapsed(s.id, !s.collapsed));
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
              onNewShelf={async (caseId) => setTree(await shelfCreate(t("lib.shelf.untitled"), caseId))}
              manageMenuFor={manageMenuFor}
              onManageCase={(id) => setEditorFor(id)}
              renamingCase={renamingCase}
              onRenameCase={setRenamingCase}
              onCommitCaseRename={(id, name) => {
                setRenamingCase(null);
                if (name.trim()) caseOps.rename(id, name.trim());
              }}
              onDeleteCase={caseOps.remove}
              onMoveCase={caseOps.move}
              onNewRuleShelf={async (caseId) =>
                setTree(await shelfCreate(t("lib.rule.reading"), caseId, "reading"))
              }
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
                if (name.trim()) props.onRenameShelf(id, name.trim());
              }}
              onDeleteShelf={deleteShelf}
              onNewCategory={shelfOps.newCategory}
              onShelfInk={async (id, ink) => setTree(await shelfSetInk(id, ink))}
              onSetShelfCase={async (id, caseId) => { setTree(await shelfSetCase(id, caseId)); await loadTree(); }}
              onCaseInk={async (id, ink) => setTree(await caseSetInk(id, ink))}
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

      {editorFor && tree.cases.some((x) => x.id === editorFor) && (
        <CaseEditor
          caseNode={tree.cases.find((x) => x.id === editorFor)!}
          byId={byId}
          items={items}
          onTree={setTree}
          onChanged={() => {
            loadTree().catch(() => {});
            props.onReloadBooks();
          }}
          onClose={() => setEditorFor(null)}
          onOpenBookDetails={setDetailsFor}
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
