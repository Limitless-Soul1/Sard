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
  libraryShelfItems,
  libraryTree,
  settingsGet,
  settingsSet,
  shelfCreate,
  shelfPlaceBook,
  shelfSetCollapsed,
  collectionRemoveBook,
  progressSave,
} from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { useTheme, THEMES } from "../../../theme";
import { Header, Sidebar, type Scope, type Section } from "./Chrome";
import { ViewGrouped, type CaseRender, type ShelfRender } from "./ViewGrouped";
import { ViewDetails } from "./ViewDetails";
import { VistaEnvironment, VistaHero, ViewVista, type VistaBand } from "./ViewVista";
import {
  DESIGN_VIEWS,
  bookMatches,
  groupShelf,
  isGroupedView,
  sortBooks,
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

  const shelfById = useMemo(() => {
    const m = new Map<string, { shelf: ShelfNode; caseNode: CaseNode | null }>();
    for (const c of tree.cases) for (const s of c.shelves) m.set(s.id, { shelf: s, caseNode: c });
    for (const s of tree.loose) m.set(s.id, { shelf: s, caseNode: null });
    return m;
  }, [tree]);

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

  /** A shelf survives the search when its own name matches, or any of its books do. */
  const filterShelf = useCallback(
    (s: ShelfNode, list: BookRow[]): BookRow[] => {
      if (!q) return list;
      if (s.name.toLowerCase().includes(q)) return list;
      return list.filter((b) => bookMatches(b, q));
    },
    [q],
  );

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
      if (shelves.length) caseList.push({ node: null, shelves });
    }
    return caseList;
  }, [tree, scope, items, byId, filterShelf, shelfBooks, q]);

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
    const filtered = q ? base.filter((b) => bookMatches(b, q)) : base;
    return sortBooks(filtered, sort === "recent" ? "recent" : sort);
  }, [rendered, props.books, q, sort, scope]);

  const vistaBands: VistaBand[] = useMemo(
    () =>
      rendered.flatMap((c) =>
        c.shelves.map((s) => ({
          key: s.shelf.id,
          shelf: s.shelf,
          caseNode: c.node,
          books: filterShelf(s.shelf, shelfBooks(s.shelf)),
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
      <div className="libd-root">
        <Sidebar
          section={props.section}
          onSection={props.onSection}
          cases={tree.cases}
          loose={tree.loose}
          bookCount={props.books.length}
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
          onManageCase={() => {}}
          onRenameShelf={props.onRenameShelf}
          onDeleteShelf={props.onDeleteShelf}
          onSettings={props.onSettings}
          themeName={THEMES[themeId]?.name ?? ""}
          langName={t(lang === "ar" ? "lang.arabic" : "lang.english")}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--pap)" }}>
          {props.renderSection(props.section)}
        </div>
      </div>
    );
  }

  return (
    <div className="libd-root">
      <Sidebar
        section={props.section}
        onSection={props.onSection}
        cases={tree.cases}
        loose={tree.loose}
        bookCount={props.books.length}
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
        onManageCase={() => {}}
        onRenameShelf={props.onRenameShelf}
        onDeleteShelf={props.onDeleteShelf}
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
          background: vista ? "transparent" : "var(--pap)",
        }}
      >
        {vista && <VistaEnvironment dark={dark} />}

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
        />

        <div
          ref={paneRef}
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
          {view === "grid" ? (
            props.renderGrid()
          ) : view === "details" ? (
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
                onDetails={() => heroBook && props.onEditBook(heroBook)}
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
                onEditBook={props.onEditBook}
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
              onEditBook={props.onEditBook}
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
              onNewShelf={async (caseId) => setTree(await shelfCreate(t("lib.newShelf"), caseId))}
              onManageCase={() => {}}
              onOpenOrder={() => {}}
              onPlace={place}
            />
          ) : null}

          {flatBooks.length === 0 && view !== "grid" && (
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
    </div>
  );
}
