// The library's skeleton — the permanent body the views are drawn inside.
//
// SOURCE: `Sard Library - Vista (standalone).html`, whose chrome is the design of record.
// Sidebar geometry (244px, 18/12/12 padding), the cases tree with its discs and grips, the
// breadcrumb line, the title row with Select / Arrange by hand / Add books, and the console
// row with search, the view switcher, the density steps and the sort menu — all carried over
// with the design's own measurements.

import { useEffect, useRef, useState } from "react";
import type { CaseNode, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { ProfileSwitcher } from "../../profiles/ProfileSwitcher";
import { localeNum } from "../../../lib/format";
import { Hoopoe } from "../Hoopoe";
import { CaseManageMenu, ShelfOrderMenu } from "./Menus";
import { DENSITY_MAX, DENSITY_MIN, DENSITY_STEP, DESIGN_SORTS, dropIndex, isVirtualShelf, UNFILED_CASE_ID, type DesignSort, type DesignView } from "./model";
import { createEdgeScroller, type EdgeScroller } from "./dragScroll";
import { Icon, type IconName } from "../../../components/Icon";
import { openTransient } from "./transient";


import { displayFaceFor, scriptOf } from "../../../lib/typography";
export type Section = "library" | "inbox" | "cards" | "bookmarks";

/** What the main pane is currently scoped to. */
export interface Scope {
  caseId: string | null;
  shelfId: string | null;
  /** The category the reader is standing in — Vista's fourth level. See `NavScope`. */
  categoryId: string | null;
}

interface SidebarProps {
  section: Section;
  onSection: (s: Section) => void;
  cases: CaseNode[];
  loose: ShelfNode[];
  /**
   * «خارج الأرفف» as a place the reader can actually GO, not only a band that appears inside a
   * view. It is a real Manual Ordering context — the books there have an order of their own — but
   * the sidebar listed only cases and real shelves, so the one route to it was a scope no button
   * produced. The synthesised node is built by the owner; this only draws it, with the same row
   * every other shelf gets.
   */
  unshelved: ShelfNode | null;
  bookCount: number;
  /** Books started and not finished — the count the reference shows beside "Reading now". */
  scope: Scope;
  onScope: (s: Scope) => void;
  /**
   * True when the library is showing EVERYTHING — no case and no shelf focused.
   *
   * The Library row is a root, not a section marker: it may only look active when the pane really
   * is the whole library. Without this it lit up while a case was focused, so the sidebar showed
   * two active rows at once and told the reader they were at the root when they were not. The
   * reference states the same rule — `S.nav === id && !S.scope` — and the port had dropped it.
   */
  atRoot: boolean;
  openCases: Set<string>;
  onToggleCase: (id: string) => void;
  /**
   * ASK FOR A SHELF, OR A CASE — the sidebar does not make either.
   *
   * It used to: a field opened in the list, with the destination as a row of chips above it, and
   * the same form existed twice over. Both now open one dialog, which is the only thing that
   * knows what making a shelf involves. All the sidebar contributes is the case it was asked
   * from, which the dialog opens on and the reader can change.
   */
  onCreateCase: () => void;
  onCreateShelf: (preselect: string | null) => void;
  /** Renaming opens the same dialog, carrying what it is renaming and what it is called now. */
  onRenameCaseDialog: (id: string, name: string) => void;
  onRenameShelfDialog: (id: string, name: string) => void;
  onRenameCase: (id: string, name: string) => void;
  onDeleteCase: (id: string) => void;
  /** Direction is -1 (earlier) or +1 (later) among the case's peers. */
  onMoveCase: (id: string, direction: number) => void;
  onNewRuleShelf: (caseId: string) => void;
  onCaseInk: (caseId: string, ink: string | null) => void;
  /** Place a lifted case at an index among its peers. */
  onPlaceCase: (id: string, toIndex: number) => void;
  /** Open the management panel over the shelves that belong to no case. */
  onManageUnfiled: () => void;
  /** Open the management panel over one case — reachable from every view, not just the cards. */
  onManageCase: (id: string) => void;
  /**
   * ONE SHELF'S OPERATIONS — the set `ShelfOrderMenu` has always offered, handed to the one
   * surface every format draws. These are the same handlers `ViewGrouped` receives, not a second
   * implementation of them: the sidebar opens that component and gives it these.
   */
  onRenameShelf: (id: string, name: string) => void;
  onDeleteShelf: (id: string) => void;
  onSetShelfOrder: (id: string, order: ShelfOrder) => void;
  onSetShelfCase: (id: string, caseId: string | null) => void;
  onShelfInk: (id: string, ink: string | null) => void;
  /** Direction is -1 (earlier) or +1 (later) among the shelf's siblings. */
  onMoveShelf: (id: string, direction: number) => void;
  onSettings: () => void;
  themeName: string;
  langName: string;
}

/**
 * The five destinations' marks.
 *
 * These were five 13x13 CSS boxes differing only in corner radius — and three of them (Library,
 * Bookmarks, Photo cards) were the SAME square, so the sidebar's five rows could not be told apart
 * without reading their labels. Direction 02 v3 gives each destination a silhouette from a different
 * register — furniture, page, mark — which is what makes the column legible before any label is.
 */
const NAV_ICON: Record<string, IconName> = {
  library: "navLibrary",
  inbox: "navHighlightsNotes",
  bookmarks: "navBookmarks",
  cards: "navPhotoCards",
};

// The reference's own numbers: gap 11, padding 8/10, radius 6, and — the part that reads as
// depth rather than a flat tint — a 1px inset ring on the selected row. The height is decided by
// the padding, not fixed, so a wrapped label cannot be clipped.
const navRow = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 11,
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  font: "500 .8125rem var(--ui)",
  color: active ? "var(--txt)" : "var(--mut)",
  background: active ? "var(--act)" : "transparent",
  boxShadow: active ? "inset 0 0 0 1px var(--brd)" : undefined,
  textAlign: "start",
});

export function Sidebar(props: SidebarProps) {
  const { t, lang } = useI18n();

  /** Which shelf row has its ⋯ menu open, and which is having its name typed. */
  const [shelfMenuFor, setShelfMenuFor] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  // A case lifted by its grip, waiting for a rail to be clicked.
  const [caseHand, setCaseHand] = useState<string | null>(null);
  // A case being DRAGGED by its grip right now, and where it would land.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragStart = useRef<{ id: string; y: number; moved: boolean } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const ghostRef = useRef<HTMLDivElement | null>(null);
  // One scroller for the sidebar, kept across renders so a re-render cannot cancel a live drag.
  const scrollerRef = useRef<EdgeScroller | null>(null);
  if (!scrollerRef.current) scrollerRef.current = createEdgeScroller();

  /**
   * The grip's drag.
   *
   * Bound to the window rather than the button because a pointer that leaves the 20px grip must
   * not end the drag — which is what "it looks like a handle but I cannot drag it" feels like from
   * the outside. A few pixels of movement is what separates a drag from a click, so a click can
   * still lift the case the way the reference does.
   */
  useEffect(() => {
    // Recomputing the landing place from a bare pointer position, so an auto-scroll can ask for
    // it again without a pointermove — the reader holds still at the edge while the list moves.
    const retarget = (y: number) => {
      const st = dragStart.current;
      if (!st?.moved) return;
      const order = props.cases.map((c) => c.id);
      const from = order.indexOf(st.id);
      const mids = order.map((id) => {
        const el = rowRefs.current.get(id);
        if (!el) return Number.POSITIVE_INFINITY;
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      setDropAt(dropIndex(y, mids, from));
    };
    const scroller = scrollerRef.current!;
    scroller.onScrolled = (_x, y) => retarget(y);
    const move = (e: PointerEvent) => {
      const st = dragStart.current;
      if (!st) return;
      if (!st.moved && Math.abs(e.clientY - st.y) < 4) return;
      if (!st.moved) {
        st.moved = true;
        setDragging(st.id);
        setCaseHand(null); // a drag supersedes any lift
      }
      retarget(e.clientY);
      scroller.update(e.clientX, e.clientY);
      const g = ghostRef.current;
      if (g) g.style.transform = `translate(${e.clientX + 12}px, ${e.clientY - 10}px)`;
    };
    const up = () => {
      // `pointerup` on the grip does the placing; this only catches a release elsewhere.
      scroller.stop();
      if (dragStart.current?.moved) {
        setDragging(null);
        setDropAt(null);
      }
      dragStart.current = null;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      scroller.stop();
      dragStart.current = null;
      setDragging(null);
      setDropAt(null);
      setCaseHand(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    return () => {
      scroller.stop();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
    };
  }, [props.cases]);

  const num = (n: number) => localeNum(n, lang);
  const rtl = lang === "ar";
  // The unfiled group answers to the same open set as the cases, under the shared synthetic id.
  const looseOpen = props.openCases.has(UNFILED_CASE_ID);
  // Standing IN the unfiled group — a scope, not a case selection.
  const unfiledActive = props.scope.caseId === UNFILED_CASE_ID && !props.scope.shelfId;

  const nav: { id: Section; label: string; count?: number }[] = [
    { id: "library", label: t("lib.nav.library"), count: props.bookCount },
    { id: "inbox", label: t("lib.nav.highlights") },
    { id: "bookmarks", label: t("lib.nav.bookmarks") },
    { id: "cards", label: t("lib.nav.cards") },
  ];

  // The design's shelf row: a mark, the name, the count. Shelf management lives in the shelf's
  // own order popover in the main pane, which is where the design puts it — not here.
  const shelfRow = (s: ShelfNode) => {
    const active = props.scope.shelfId === s.id;
    const ink = s.ink;
    // THE UNSHELVED RUN IS NOT A COLLECTION. It is the books that belong to no shelf, gathered
    // under a name so they can be reached — there is no row behind it to rename, re-file or
    // delete. Everything else in this list is a real shelf and gets the whole menu.
    const real = !isVirtualShelf(s.id);

    return (
      // The reference's shelf row: padded 6/8/6/10, radius 6, `500 .75rem` in `--mut`, and on
      // selection it takes `--act` and `--txt`. No height is set — the padding decides it.
      //
      // MANAGING A SHELF WAS REACHABLE FROM TWO OF THE FIVE FORMATS.
      //
      // `ShelfOrderMenu` — order, colour, move, which case holds it, rename, delete — was drawn
      // by `ViewGrouped`, and `isGroupedView` is Covers and Spines. So in Vista, Grid and Details
      // a shelf could not be renamed, re-filed or DELETED at all: the only route to any of those
      // was to switch to another format first and find the shelf's own header there. The backend
      // has always carried every one of them.
      //
      // It is the same defect the drop destinations had, and it takes the same answer: the
      // sidebar is rendered by the shell that wraps all five views and is handed every shelf in
      // the library, so a control placed here is reachable from everywhere by construction. The
      // menu is the SAME component the grouped views open, given the same handlers, so there is
      // one shelf-management path rather than a second one free to drift from it.
      //
      // The row is a DIV holding the destination and the ⋯ side by side, because a button cannot
      // contain a button. The drop attributes moved out here with it, which widens the landing
      // area to the whole row rather than narrowing it: `dropTarget` resolves with `closest()`,
      // so a book let go over the name, the count or the menu still finds this shelf.
      <div
        key={s.id}
        // A SHELF IN THE SIDEBAR IS A PLACE A BOOK CAN BE PUT.
        //
        // Until now a destination existed only where the current view happened to have DRAWN it,
        // so the same book in the same shelf could be sent elsewhere from Grid and Details and
        // nowhere at all from Covers, Spines or Vista — those draw the shelf the reader is standing
        // in and nothing else. At the library root the grouped views draw a SAMPLE of each case, so
        // most books had no destination there either, and no book past the sample could be reached.
        // Both are the same defect: the set of places a book may go was being decided by layout.
        //
        // The sidebar is the one surface that escapes it. It is rendered by the shell that wraps
        // all five views, and it is handed `cases`, `loose` and `unshelved` — every shelf in the
        // library — so it is untouched by the view, by the scope, by the search and by the sample.
        // Vista's own note already says as much: taking the sidebar away cost "every destination in
        // the library". So the destinations live where the shelves are listed, and every format
        // inherits the same set by construction rather than by five separate agreements.
        //
        // Dropping here means the END of that shelf, which is the only position a name can honestly
        // stand for; placing BETWEEN two particular books is what the shelf itself is for. A shelf
        // that fills itself from a query is not offered, because a row written to it is never read
        // back — an unmarked row here would be a destination the app cannot honour.
        data-drop-shelf={s.auto_rule ? undefined : s.id}
        // The END of that shelf — the only position a name can honestly stand for. Placing BETWEEN
        // two particular books is what the shelf itself is for. This carried an INDEX until the
        // destinations became neighbours; an empty string is how a place says «at the end».
        data-drop-before={s.auto_rule ? undefined : ""}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          borderRadius: "var(--r-sm)",
          paddingInlineEnd: real ? 2 : 0,
          background: active ? "var(--act)" : "transparent",
        }}
      >
        <button
          className="libd-hov"
          onClick={() => props.onScope({ caseId: s.case_id ?? UNFILED_CASE_ID, shelfId: active ? null : s.id, categoryId: null })}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-4)",
            padding: "6px 8px 6px 10px",
            borderRadius: "var(--r-sm)",
            font: "500 .75rem var(--ui)",
            color: active ? "var(--txt)" : "var(--mut)",
          }}
        >
          {/* A rule shelf is an OUTLINED circle; a hand shelf is a filled square. The SHAPE says
              which kind of shelf it is; the COLOUR says which shelf it is.

              THE MARK NEVER READ THE SHELF'S INK. It was `--faint` in both states, and its own
              note here said so — so `shelf_set_ink`, the `InkPicker` in the shelf's ⋯ menu and
              the `collections.ink` column behind them formed a complete path that ended nowhere:
              a colour could be chosen, was written, survived a reload, and was drawn by nothing.
              Measured before this line existed — the ink stored as #8DC3BA, and zero elements in
              the whole document carrying it.

              Colouring the mark is the treatment the app already uses for a shelf's ink, in the
              move-a-book menu and in the case picker; both fill a small square with
              `ink ?? var(--faint)`. It is the shelf's identity without a coloured row: the ground
              still belongs to hover and to selection, which is what keeps both readable. */}
          <span
            style={{
              flex: "none",
              width: 7,
              height: 7,
              // THE INK IS PAINTED AS CHOSEN, and given an edge instead of being corrected.
              //
              // The first attempt ran it through `resolveMarkOnGround`, which walks a colour
              // toward `--text` until it clears 3:1. That is right for a highlight lying over a
              // page and wrong for a 7px mark: measured on Parchment and Sepia, whose text is a
              // warm brown, #BFA8D6 came out at 42-46% walked with its saturation down from 46 to
              // 18 and its hue dragged from 270° to 307°. It cleared the floor and stopped being
              // the colour the reader picked, which is the only thing it was for.
              //
              // A case's ink is drawn RAW — measured, `3px rgb(191,168,214)`, unwalked — and the
              // swatches in `InkPicker` carry `0 0 0 1px var(--brd)` so each sits on its own edge
              // whatever is behind it. Both of those already exist, and together they are the
              // answer: the true colour, with a hairline that gives the mark a shape on any
              // ground. A shelf with no ink keeps `--faint` and no ring, exactly as before.
              ...(s.auto_rule
                ? { borderRadius: "50%", border: `1.5px solid ${ink ?? "var(--faint)"}` }
                : {
                    borderRadius: 2,
                    background: ink ?? "var(--faint)",
                    boxShadow: ink ? "0 0 0 1px var(--brd)" : undefined,
                  }),
            }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textAlign: "start",
            }}
          >
            {s.name}
          </span>
          <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)" }}>{num(s.count)}</span>
        </button>
        {real && (
          <span style={{ position: "relative", flex: "none" }}>
            <button
              // Not `.libd-hov`: that class is (0,2,0) and the shell reset above it is (0,2,1),
              // so inside the chrome it paints nothing. Rest, hover and keyboard all come from
              // `.libd-shelfdots`, which is written to win.
              className="libd-shelfdots"
              title={t("lib.manageShelf")}
              aria-label={t("lib.manageShelf")}
              onClick={(e) => {
                e.stopPropagation();
                setShelfMenuFor((m) => (m === s.id ? null : s.id));
              }}
              style={{
                width: "var(--ctl-xs)",
                height: "var(--ctl-xs)",
                borderRadius: "var(--r-sm)",
                fontSize: 13,
                lineHeight: 1,
              }}
            >
              <Icon name="more" size="sm" />
            </button>
            {shelfMenuFor === s.id && (
              <ShelfOrderMenu
                shelf={s}
                cases={props.cases}
                onOrder={(o) => props.onSetShelfOrder(s.id, o)}
                onRename={() => props.onRenameShelfDialog(s.id, s.name)}
                onDelete={() => props.onDeleteShelf(s.id)}
                onSetCase={(caseId) => props.onSetShelfCase(s.id, caseId)}
                onInk={(ink) => props.onShelfInk(s.id, ink)}
                onMove={(d) => props.onMoveShelf(s.id, d)}
                onClose={() => setShelfMenuFor(null)}
              />
            )}
          </span>
        )}
      </div>
    );
  };

  return (
    // `.lib-sidebar` carries the BACKGROUND only. RAWY-278 makes it translucent with a
    // blur that follows the blur slider whenever a library image is set, and that rule cannot
    // win against an inline `background`, so this one is not set inline. The design's geometry
    // — 244px, its own padding — is inline and so still overrides the class's own 228px.
    <aside
      className="lib-sidebar libd-chrome"
      style={{
        width: 244,
        flex: "none",
        borderInlineEnd: "1px solid var(--brd)",
        display: "flex",
        flexDirection: "column",
        padding: "18px 12px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 8px 18px" }}>
        <Hoopoe size={22} />
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, direction: "ltr" }}>
          <b style={{ font: "600 1.0625rem/1 var(--brand)" }}>Sard</b>
          {/* The rule between the two wordmarks. Its height is tuned to the cap-height of the
              lettering either side of it, so it is a LENGTH, not an icon and not a spacing step —
              and the app has no token for that, because it has no such concept: its nine dividers
              are 13, 16, 19, 20, 22, 22, 26, 34 and 54px, each measured against what it stands
              beside. A token would be invented for one caller, so the literal stays and says why. */}
          <i
            style={{
              width: 1.5,
              // geometry-guard-allow: a divider length matched to cap-height, not an icon size
              height: 16,
              alignSelf: "center",
              background: "currentColor",
              opacity: 0.28,
            }}
          />
          <em style={{ font: "700 1.1875rem/1 var(--brand-ar)", fontStyle: "normal" }}>سَرْد</em>
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
        {nav.map((n) => (
          <button
            key={n.id}
            className="libd-hov"
            onClick={() => props.onSection(n.id)}
            style={{
              // Library is active only AT the root. Every other section is active whenever it is
              // the section, because none of them can be focused into.
              ...navRow(n.id === props.section && (n.id !== "library" || props.atRoot)),
              cursor: "pointer",
            }}
          >
            <Icon name={NAV_ICON[n.id]} size="md" style={{ opacity: 0.85 }} />
            <span
              style={{
                flex: 1,
                textAlign: "start",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.label}
            </span>
            {n.count != null && (
              <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)" }}>
                {num(n.count)}
              </span>
            )}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 10px 6px",
        }}
      >
        <span
          style={{
            font: "600 .625rem var(--ui)",
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: "var(--faint)",
          }}
        >
          {t("lib.cases")}
        </span>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-1)",
          scrollbarWidth: "thin",
          paddingBottom: 8,
        }}
      >
        {props.cases.map((c, ci) => {
          const open = props.openCases.has(c.id);
          const active = props.scope.caseId === c.id && !props.scope.shelfId;
          const ink = c.ink ?? "var(--acc)";
          const lifted = caseHand === c.id;
          return (
            <div key={c.id} style={{ position: "relative" }}>
              {/* THE INSERTION BAR while a case is being dragged — the answer to "where will this
                  land if I let go now". It is the same accent rail the lift-and-place path uses,
                  so both routes show the reader the same thing. */}
              {dragging && dropAt === ci && (
                <span
                  style={{
                    display: "block",
                    height: 2,
                    margin: "3px 0",
                    borderRadius: 1,
                    background: "var(--acc)",
                    boxShadow: "0 0 0 3px color-mix(in srgb, var(--acc) 22%, transparent)",
                  }}
                />
              )}
              {/* A place-here rail above each other case while one is lifted by its grip. */}
              {caseHand && caseHand !== c.id && (
                <button
                  onClick={() => {
                    props.onPlaceCase(caseHand, props.cases.findIndex((x) => x.id === c.id));
                    setCaseHand(null);
                  }}
                  aria-label={t("lib.placeHere")}
                  style={{ display: "block", width: "100%", padding: "4px 0 3px" }}
                >
                  <span style={{ display: "block", height: 2, borderRadius: 1, background: "var(--acc)" }} />
                </button>
              )}
              {/* THE CASE'S COLOUR IS A 3px BAR down the row's leading edge — the reference's
                  own marker, not a small square beside the name. It is what makes a case row
                  read as a case at a glance, and it is why the shelf rows below (which have no
                  bar) read as children. */}
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(c.id, el);
                  else rowRefs.current.delete(c.id);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  borderRadius: "var(--r-md)",
                  paddingInlineEnd: 2,
                  borderInlineStart: `3px solid ${ink}`,
                  background: active ? "var(--act)" : "transparent",
                  opacity: lifted || dragging === c.id ? 0.4 : 1,
                }}
              >
                <button
                  className="libd-hov"
                  onClick={() => props.onToggleCase(c.id)}
                  aria-label={c.name}
                  style={{
                    flex: "none",
                    display: "grid",
                    placeItems: "center",
                    width: "var(--ctl-xs)",
                    height: "var(--ctl-xs)",
                    marginInlineEnd: "var(--sp-1)",
                    borderRadius: "var(--r-md)",
                    // The disc fills with the case's own colour once it is open.
                    border: `1px solid ${open ? "var(--brd)" : "transparent"}`,
                    background: open ? `color-mix(in srgb, ${ink} 18%, transparent)` : "transparent",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: 7,
                      height: 7,
                      borderRight: "1.6px solid var(--mut)",
                      borderBottom: "1.6px solid var(--mut)",
                      transform: `rotate(${open ? "45deg" : rtl ? "135deg" : "-45deg"}) translate(-1.2px,-1.2px)`,
                      transition: "transform .18s ease-out",
                    }}
                  />
                </button>
                <button
                  onClick={() => props.onScope({ caseId: c.id, shelfId: null, categoryId: null })}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-4)",
                    textAlign: "start",
                    padding: "6px 0",
                  }}
                >
                  {/* No dot here — the row's leading bar is the case's colour. */}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      font: "600 .8125rem var(--ui)",
                      color: "var(--txt)",
                    }}
                  >
                    {c.name}
                  </span>
                  <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)" }}>
                    {num(c.count)}
                  </span>
                </button>
                {/* THE GRIP — one meaning: this is how you move a case.
                    Drag it and the case follows the pointer with a live insertion bar; release
                    to drop. A plain click still lifts the case and shows the same rails, for
                    anyone who would rather not drag — the two are the same operation reached two
                    ways, which is exactly how the management panel already treats a book. What it
                    must never be is a control that LOOKS like a handle and only highlights. */}
                <button
                  title={t("lib.moveCaseHint")}
                  aria-label={t("lib.moveCaseHint")}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    dragStart.current = { id: c.id, y: e.clientY, moved: false };
                    scrollerRef.current?.setContainer(e.currentTarget as Element);
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    const st = dragStart.current;
                    dragStart.current = null;
                    if (st?.moved) {
                      // A real drag: drop where the bar is showing.
                      if (dropAt != null) props.onPlaceCase(c.id, dropAt);
                      setDragging(null);
                      setDropAt(null);
                      setCaseHand(null);
                    } else {
                      // A click: lift, or put back down.
                      setCaseHand(lifted ? null : c.id);
                    }
                  }}
                  style={{
                    flex: "none",
                    width: "var(--icon-lg)",
                    height: "var(--ctl-xs)",
                    borderRadius: "var(--r-sm)",
                    fontSize: 11,
                    lineHeight: 1,
                    cursor: dragging === c.id ? "grabbing" : "grab",
                    touchAction: "none",
                    color: lifted || dragging === c.id ? "var(--acc)" : "var(--faint)",
                    background: lifted || dragging === c.id ? "var(--act)" : "transparent",
                  }}
                >
                  <Icon name="grip" size="sm" />
                </button>
                <span style={{ position: "relative", flex: "none" }}>
                  <button
                    className="libd-hov libd-hov-txt"
                    title={t("lib.manage")}
                    aria-label={t("lib.manage")}
                    onClick={() => setManaging((m) => (m === c.id ? null : c.id))}
                    style={{
                      width: "var(--ctl-xs)",
                      height: "var(--ctl-xs)",
                      borderRadius: "var(--r-sm)",
                      color: "var(--faint)",
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    <Icon name="more" size="sm" />
                  </button>
                  {managing === c.id && (
                    <CaseManageMenu
                      onManage={() => props.onManageCase(c.id)}
                      onRename={() => props.onRenameCaseDialog(c.id, c.name)}
                      onNewShelf={() => props.onCreateShelf(c.id)}
                      onNewRuleShelf={() => props.onNewRuleShelf(c.id)}
                      onMoveUp={() => props.onMoveCase(c.id, -1)}
                      onMoveDown={() => props.onMoveCase(c.id, 1)}
                      onDelete={() => props.onDeleteCase(c.id)}
                      onClose={() => setManaging(null)}
                      ink={c.ink}
                      onInk={(ink) => props.onCaseInk(c.id, ink)}
                    />
                  )}
                </span>
              </div>

              {open && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    padding: "1px 0 6px 0",
                    marginInlineStart: 22,
                    borderInlineStart: "1px solid var(--brd)",
                  }}
                >
                  {c.shelves.map(shelfRow)}
                </div>
              )}
            </div>
          );
        })}

        {/* The bar's last position: after every case. Without it the bottom of the list would be
            the one place a drag could not reach. */}
        {dragging && dropAt === props.cases.length - 1 && (
          <span
            style={{
              display: "block",
              height: 2,
              margin: "3px 0",
              borderRadius: 1,
              background: "var(--acc)",
              boxShadow: "0 0 0 3px color-mix(in srgb, var(--acc) 22%, transparent)",
            }}
          />
        )}

        {/* The tail rail. Without it a lifted case could be dropped ABOVE any other case but
            never after the last one, so the bottom position was unreachable. */}
        {caseHand && props.cases.length > 0 && props.cases[props.cases.length - 1].id !== caseHand && (
          <button
            onClick={() => {
              props.onPlaceCase(caseHand, props.cases.length - 1);
              setCaseHand(null);
            }}
            aria-label={t("lib.placeHere")}
            style={{ display: "block", width: "100%", padding: "5px 0 2px" }}
          >
            <span style={{ display: "block", height: 2, borderRadius: 1, background: "var(--acc)" }} />
          </button>
        )}

        {/* MAKING A CASE, SAID IN WORDS.
            The action already existed — a bare "+" at `--ctl-xs` in `--mut`, beside the section
            heading — and it is why a reader looking for "add a case" found nothing: an unlabelled
            glyph the size of an icon, next to a title, reads as decoration. It is now the same
            chip the shelf action wears, in the same place relative to its own list, so the two
            read as a pair without either becoming a card. Both now open the same dialog. */}
        {(
          <button
            className="libd-newshelf"
            onClick={props.onCreateCase}
            style={{
              justifyContent: "flex-start",
              margin: "5px 2px 2px",
              padding: "6px 10px",
              font: "600 .75rem var(--ui)",
              color: "var(--newshelf-ink, var(--accent-text))",
              background: "var(--newshelf-bg, transparent)",
              border: "1px solid var(--newshelf-edge, color-mix(in srgb, var(--accent) 32%, transparent))",
              borderRadius: "var(--r-md)",
            }}
          >
            {t("lib.newCaseAction")}
          </button>
        )}

        {/* Shelves in no case, and — importantly — the ONLY way to make one.
            "New shelf" previously lived only inside a case, so a library with no cases had no
            way to create a shelf at all: the affordance the old sidebar had was gone and its
            replacement was unreachable until a case existed first. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingTop: 8 }}>
          {/* The heading carries the ⋯, not the shelf rows. A shelf row stays exactly what the
              reference draws — mark, name, count — and the group it sits in gets the single
              management entry, the same way a case row does. That keeps an unfiled shelf fully
              manageable without adding one control to the row the design specifies. */}
          {props.loose.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", padding: "6px 4px 4px 10px" }}>
              {/* The heading collapses the group, the way a case's disc collapses a case. The
                  caret is the case row's own — same 7px box, same 1.6px strokes, same rotation
                  and the same RTL flip — sized to sit against a small uppercase label rather
                  than inside a disc, because this is a heading and not a case row. */}
              {/* The caret collapses; the NAME navigates. Exactly the division a case row makes
                  between its disc and its title, so the two behave alike without this heading
                  pretending to be a case: no colour bar, no grip, no disc. */}
              <button
                className="libd-hov-txt"
                onClick={() => props.onToggleCase(UNFILED_CASE_ID)}
                title={looseOpen ? t("lib.collapse") : t("lib.expand")}
                aria-label={looseOpen ? t("lib.collapse") : t("lib.expand")}
                aria-expanded={looseOpen}
                style={{ flex: "none", width: "var(--icon-md)", height: "var(--icon-md)", borderRadius: 4, display: "grid", placeItems: "center" }}
              >
                <span
                  style={{
                    display: "block",
                    width: 6,
                    height: 6,
                    borderRight: "1.6px solid var(--faint)",
                    borderBottom: "1.6px solid var(--faint)",
                    transform: `rotate(${looseOpen ? "45deg" : rtl ? "135deg" : "-45deg"}) translate(-1px,-1px)`,
                    transition: "transform .18s ease-out",
                  }}
                />
              </button>
              <button
                className="libd-hov-txt"
                onClick={() => props.onScope({ caseId: UNFILED_CASE_ID, shelfId: null, categoryId: null })}
                title={t("lib.openUnfiled")}
                style={{
                  flex: 1,
                  justifyContent: "flex-start",
                  textAlign: "start",
                  padding: "2px 6px",
                  marginInlineStart: "var(--sp-1)",
                  borderRadius: 5,
                  font: "600 .625rem var(--ui)",
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  // Active, but not the way a case is: the accent alone, with no case's colour bar
                  // behind it, so "not in a case" can never be mistaken for one.
                  color: unfiledActive ? "var(--acc)" : "var(--faint)",
                  background: unfiledActive ? "var(--act)" : "transparent",
                }}
              >
                {t("lib.unfiled")}
              </button>
              <button
                className="libd-hov libd-hov-txt"
                title={t("lib.manageUnfiled")}
                aria-label={t("lib.manageUnfiled")}
                onClick={props.onManageUnfiled}
                style={{
                  flex: "none",
                  width: "var(--ctl-xs)",
                  height: "var(--ctl-xs)",
                  borderRadius: "var(--r-sm)",
                  color: "var(--faint)",
                  fontSize: 13,
                  lineHeight: 1,
                }}
              >
                <Icon name="more" size="sm" />
              </button>
            </div>
          )}
          {(looseOpen || props.loose.length === 0) && props.loose.map(shelfRow)}
          {(looseOpen || props.loose.length === 0) && props.unshelved && shelfRow(props.unshelved)}
          {(looseOpen || props.loose.length === 0) && (
            <button
              // MAKING A SHELF IS AN ACTION, AND LOOKED LIKE A CAPTION.
              //
              // It was `--faint` — the quietest colour Sard has, the one the contrast audit found
              // washed out — at .6875rem, with no ground and no edge, sitting directly under the
              // shelf rows it is not one of. Nothing about it said "press me": it read as a label
              // for the list above it.
              //
              // It is now an outlined chip: the accent for its ink (through `--accent-text`, which
              // is the accent walked toward the text colour until it clears Sard's own 3.0 floor),
              // a hairline of the same hue, and no fill at rest — so it is unmistakably a control
              // without becoming a card, and it cannot be mistaken for the rows above it, which
              // carry neither edge nor accent. The states come from the stylesheet through custom
              // properties, because an inline `background` would otherwise beat every `:hover` rule
              // — the same mechanism the ⋯ control uses.
              className="libd-newshelf"
              // Standing inside a case, that case is what the dialog opens on — a starting point
              // and never a decision, which is why the dialog shows the destination either way.
              onClick={() =>
                props.onCreateShelf(
                  props.scope.caseId && props.scope.caseId !== UNFILED_CASE_ID ? props.scope.caseId : null,
                )
              }
              style={{
                justifyContent: "flex-start",
                margin: "5px 8px 3px 10px",
                padding: "6px 10px",
                font: "600 .75rem var(--ui)",
                color: "var(--newshelf-ink, var(--accent-text))",
                background: "var(--newshelf-bg, transparent)",
                border: "1px solid var(--newshelf-edge, color-mix(in srgb, var(--accent) 32%, transparent))",
                borderRadius: "var(--r-md)",
              }}
            >
              {t("lib.newShelf")}
            </button>
            )}
        </div>
      </div>

      {/* THE SIDEBAR FOOT.
          The reference's band — pushed to the bottom, ruled off, `500 .75rem` in `--mut` — but
          the thing inside it is Sard's own Settings entry, not two pieces of text. The theme and
          the language named on their own do not tell anyone that this is where Settings lives;
          they read as a status line, which is what they are. So the band now carries the gear
          and the word, in the `.lib-settings-btn` the Library has always used (RAWY-39), with
          the theme and language beneath it as the caption they always were.

          `.lib-sidefoot` and `.lib-settings-btn` are the existing stylesheet's own classes, so
          the padding, the radius, the accent gear and the hover come from the same place every
          other Sard control gets them, and they follow the writing direction because the class
          uses `text-align: start`. */}
      {/* The case in hand, following the pointer — the thing that makes a drag read as carrying
          something rather than as the list rearranging itself for reasons of its own. */}
      {dragging && (
        <div
          ref={ghostRef}
          aria-hidden
          style={{
            position: "fixed",
            insetBlockStart: 0,
            insetInlineStart: 0,
            zIndex: 200,
            pointerEvents: "none",
            padding: "5px 11px",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--brd)",
            borderInlineStart: `3px solid ${props.cases.find((c) => c.id === dragging)?.ink ?? "var(--acc)"}`,
            background: "var(--chr)",
            boxShadow: "var(--sh3)",
            font: "600 .8125rem var(--ui)",
            color: "var(--txt)",
            opacity: 0.95,
          }}
        >
          {props.cases.find((c) => c.id === dragging)?.name}
        </div>
      )}

      <div className="lib-sidefoot" style={{ display: "block", paddingTop: 10, borderTop: "1px solid var(--brd)" }}>
        {/* PROFILES: the active profile joins the theme and the language in the foot. One row,
            above Settings; the caption below is left exactly as it is. Self-contained — it reads
            its own store, so the Library learns nothing about profiles by mounting it. */}
        <ProfileSwitcher onManage={props.onSettings} />
        <button
          className="lib-settings-btn"
          onClick={props.onSettings}
          title={t("gs.open")}
          aria-label={t("gs.open")}
        >
          <span className="lib-settings-ico" aria-hidden>
            <Icon name="gear" size="sm" />
          </span>
          <span>{t("gs.open")}</span>
        </button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--sp-4)",
            padding: "2px 11px 4px",
            font: "500 .6875rem var(--ui)",
            color: "var(--faint)",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {props.langName}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {props.themeName}
          </span>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Header — breadcrumbs, title row, and the console row.
// ---------------------------------------------------------------------------

/**
 * WHERE THE READER IS STANDING, as one object.
 *
 * Vista replaces the crumb row and the title row with this. The two together said the location
 * twice and weakly — a 12px trail in `--faint` above a heading that looked like a page title — so
 * here the ancestors ARE the way out: the immediate parent is a button, the same button the sort
 * and filter controls beside it are, because leaving is an action and not a caption.
 *
 * THE TITLE IS THE TITLE EVERY OTHER VIEW DRAWS. An earlier pass gave each level its own face —
 * the serif for a case, the interface face for a shelf — which is the "typographic register" idea
 * that was rejected twice: a register has to be decoded, and the trail and the case's ink already
 * say what kind of place this is. One declaration, so Vista's heading and the Covers heading are
 * the same object.
 *
 * The other four views keep the crumb-and-title rows they have always had.
 */
export interface PlaceLine {
  level: "lib" | "case" | "shelf" | "category";
  name: string;
  /** A case's own colour, drawn as the inset underline under its name. Null everywhere else. */
  ink: string | null;
  /** The container's own counts — for a case, books AND shelves, so it reads as holding shelves. */
  sub: string;
  /** Root first, immediate parent last. The last one is drawn as the way out. */
  trail: { label: string; go: () => void }[];
}

interface HeaderProps {
  crumbs: { label: string; go: () => void }[];
  heading: string;
  subcount: string;
  /** Vista only. When set, this replaces the crumb row and the title. */
  place?: PlaceLine | null;
  mode: "browse" | "select" | "arrange";
  onToggleSelect: () => void;
  onToggleArrange: () => void;
  onAddBooks: () => void;
  /**
   * THE LIBRARY HAS NO BOOKS AND NOTHING IS BEING SEARCHED FOR.
   *
   * Search, sort, the format filter, Select, Manual arrange and the five view tabs all act on
   * books; with none, they are chrome for content that does not exist, and they crowd out the one
   * thing a new reader needs. They are removed rather than disabled — a row of greyed controls says
   * no at length, and absence says it quietly. Every one of them returns the moment a first book
   * does. See `libraryIsBare`.
   */
  bare?: boolean;
  importing: boolean;
  query: string;
  onQuery: (q: string) => void;
  view: DesignView;
  /**
   * Whether Manual Ordering can act on what is currently on screen.
   *
   * Computed by the owner, because only it knows the depth: in Vista the same view draws
   * containers at the root and books inside a shelf, and the control must follow the CONTENT, not
   * the view. `canArrange(view)` is one half of it; see `vistaArrangeable` for the other.
   */
  canArrangeHere: boolean;
  /** Why it cannot act here, for the reader — null when it can. */
  arrangeReason: string | null;
  /**
   * Whether the stage is one hand-orderable shelf, so "shelf order" names something.
   * At the root, in a case, or on a computed shelf there is no single stored order to sort by.
   */
  canSortByShelf: boolean;
  /**
   * Whether the sequence on screen is the reader's own arrangement. The line under the toolbar is
   * the one place the mode explains itself, so it must not promise a slot between two books when
   * the sort in force cannot draw one.
   */
  handOrdered: boolean;
  onView: (v: DesignView) => void;
  density: number;
  onDensity: (d: number) => void;
  sort: DesignSort;
  onSort: (s: DesignSort) => void;
  /** Vista floats its header over the environment. */
  overEnvironment: boolean;
  /** Grid's own control, shown only while Grid is the view — as it was before. */
  coverMode: "crop" | "fit";
  onCoverMode: () => void;
  /**
   * NAMES OUT OF THE WAY UNTIL A BOOK IS TOUCHED.
   *
   * Offered only in the three COVER-LED views. Spines writes the title onto the spine — the words
   * are the artwork there — and Details lists it in a column under its own heading; in both, hiding
   * the name would empty the view rather than quiet it, so the control does not appear.
   */
  hideTitles: boolean;
  onHideTitles: () => void;
  format: string | null;
  onFormat: (f: string | null) => void;
}

/**
 * The place-line: the trail out, then the name of where you are, then what it holds.
 *
 * THE TITLE DOES NOT SHRINK WITH DEPTH. A ladder that quietens the deeper levels is backwards —
 * deep is exactly where a reader is most likely to be lost — so every level is set at the same
 * size and the FACE carries the difference.
 */
function PlaceHeading({ place }: { place: PlaceLine }) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
  return (
    // THE ONE GROUP THAT HAS NO PLATE OF ITS OWN.
    //
    // Every control in this header stands on its own ground already — search, the view switcher,
    // the size chips, format, sort, Select, Arrange, Add. This is bare text on a photograph, and it
    // is the only reason the toolbar ever needed a plane behind it. `libd-plate` gives it the same
    // material the plane was made of, sized to the words rather than to the window. It paints
    // wherever a background image is set, in every format — the scrim that used to carry these
    // words outside Vista is now the reader's to switch off.
    <div className="libd-plate" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", minWidth: 0 }}>
      {/* THE WAY OUT IS DRAWN ONLY WHERE THERE IS ONE.
          `minHeight` reserved a row for the trail whether or not a trail existed, so at the library
          root — where nothing is above you — Vista opened with an EMPTY 20px row and its 4px gap
          above the title. Measured on the real header: one element, no text, 24px. Inside a case or
          a shelf the trail is real navigation and is drawn exactly as before. */}
      {place.trail.length > 0 && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          font: "500 .75rem var(--ui)",
          color: "var(--faint)",
          minHeight: "var(--icon-lg)",
          flexWrap: "wrap",
        }}
      >
        {place.trail.map((cr, i) => {
          const last = i === place.trail.length - 1;
          return (
            <span key={`${cr.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              {i > 0 && <span style={{ fontSize: 10, opacity: 0.5 }}>›</span>}
              {last ? (
                // THE WAY OUT, drawn as a control rather than as text. The old trail was 12px of
                // faint prose in a corner, which is why leaving never felt like an offer.
                <button
                  className="libd-hov"
                  onClick={cr.go}
                  title={t("lib.vista.up")}
                  aria-label={t("lib.vista.up") + ": " + cr.label}
                  style={ctlBtn(false)}
                >
                  {/* In Arabic the way back points to the START of the line, which is the right —
                      the chevron is semantic, not a mirrored glyph. */}
                  <Icon name={rtl ? "caretRight" : "caretLeft"} size="sm" />
                  {cr.label}
                </button>
              ) : (
                <button className="libd-hov-txt" onClick={cr.go} style={{ color: "inherit" }}>
                  {cr.label}
                </button>
              )}
            </span>
          );
        })}
      </div>
      )}
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-5)", minWidth: 0 }}>
        <h1
          dir="auto"
          className={place.level === "category" ? "libd-place-cat" : undefined}
          style={{
            margin: 0,
            // `ledeTitleStyle` in the design of record. This named the LATIN book face with no
            // Arabic branch at all, and Literata has no Arabic glyphs — so an Arabic case or
            // shelf name fell out of Sard's faces entirely, into whatever serif the system
            // happened to offer. Arabic is Amiri here as everywhere, at the reference's size.
            font: `${scriptOf(place.name) === "arabic" ? "700 1.625rem/1.35" : "600 1.5rem/1.2"} ${displayFaceFor(place.name)}`,
            color: "var(--txt)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            // The case's own signature, the same inset underline the case cards draw.
            boxShadow: place.ink
              ? `inset 0 -8px 0 -3px color-mix(in srgb, ${place.ink} 40%, transparent)`
              : undefined,
          }}
        >
          {place.name}
        </h1>
        <span style={{ font: "500 .8125rem var(--ui)", color: "var(--faint)", whiteSpace: "nowrap" }}>
          {place.sub}
        </span>
      </div>
    </div>
  );
}

const ctlBtn = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 32,
  padding: "0 12px",
  borderRadius: 9,
  font: "500 .8125rem var(--ui)",
  border: `1px solid ${active ? "var(--acc)" : "var(--brd)"}`,
  color: active ? "var(--acc)" : "var(--mut)",
  background: active ? "var(--act)" : "var(--pap)",
});

/**
 * EACH FORMAT'S MARK IS A MINIATURE OF ITS OWN LAYOUT.
 *
 * What was here was five CSS gradients painted on a 12px box, and three of them could not be told
 * apart: `grid` and `covers` were the SAME STRING, character for character; `spines` and `details`
 * were the same stripe turned two ways; `vista` was a dot. A gradient cannot draw a thumbnail
 * beside two lines of text, or a horizon, so no amount of tuning those values could have made the
 * set legible — the medium was the limit.
 *
 * They are drawings now, in the app's own icon set, at its 24x24 box and its `currentColor`, so
 * they take the ink of the control that holds them and follow all sixteen themes with no
 * per-theme artwork. See `components/Icon.tsx` for what each one draws and why.
 */
const VIEW_ICONS: Record<DesignView, IconName> = {
  covers: "viewCovers",
  grid: "viewGrid",
  spines: "viewSpines",
  details: "viewDetails",
  vista: "viewVista",
};

export function Header(props: HeaderProps) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
  const [sortOpen, setSortOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement | null>(null);
  const formatRef = useRef<HTMLDivElement | null>(null);
  // Both menus register with the one dismissal stack, so opening either closes whatever was open,
  // a press outside closes it, and Escape is spent on it rather than on the view underneath.
  useEffect(() => {
    if (!sortOpen) return;
    return openTransient(() => setSortOpen(false), () => sortRef.current);
  }, [sortOpen]);
  useEffect(() => {
    if (!formatOpen) return;
    return openTransient(() => setFormatOpen(false), () => formatRef.current);
  }, [formatOpen]);

  const views: { id: DesignView; label: string; hint: string }[] = [
    { id: "grid", label: t("lib.view.grid"), hint: t("lib.view.gridHint") },
    { id: "covers", label: t("lib.view.covers"), hint: t("lib.view.coversHint") },
    { id: "spines", label: t("lib.view.spines"), hint: t("lib.view.spinesHint") },
    { id: "details", label: t("lib.view.details"), hint: t("lib.view.detailsHint") },
    { id: "vista", label: t("lib.view.vista"), hint: t("lib.view.vistaHint") },
  ];

  const sortLabel: Record<DesignSort, string> = {
    recent: t("lib.sort.recent"),
    added: t("lib.sort.added"),
    title: t("lib.sort.title"),
    author: t("lib.sort.author"),
    progress: t("lib.sort.progress"),
    shelf: t("lib.sort.shelf"),
  };
  // The shelf's own order joins the list only where one shelf owns the stage.
  const sorts: DesignSort[] = props.canSortByShelf ? [...DESIGN_SORTS, "shelf"] : DESIGN_SORTS;

  const groupStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: 3,
    borderRadius: 11,
    background: "var(--soft)",
    border: "1px solid var(--brd)",
  };

  return (
    // NO background and NO border, in every view — the design's own header paints nothing.
    // Giving the non-Vista views an opaque `--pap` band here is what drew a black strip across
    // the top of a library with a background image: the header sat ON the photograph instead of
    // over it. The ground belongs to `.lib-root`, and the scrim's own falloff already adds theme
    // weight at exactly this height so the title and search stay legible.
    <header
      className={"libd-chrome" + (props.overEnvironment ? " libd-console" : "")}
      style={{
        flex: "none",
        position: "relative",
        zIndex: 3,
        // VISTA'S BAND CARRIES A FOOT, NOT A SECOND HEADER'S WORTH OF AIR.
        //
        // Only Vista draws this header as a PLANE — `.libd-console`, a translucent chrome surface
        // with a blur and a bottom border — so every pixel of its height is a pixel of the reader's
        // photograph covered. It was given 18px beneath its content to match the 18px above, which
        // is right for a band that floats and generous for one that is trying to stay out of the
        // way. Measured against the other four formats: identical content (135px of it), identical
        // top padding, and a band 19px taller — 18 of padding and 1 of border, all of it Vista's.
        //
        // The plane still needs a foot: with none at all the last control would sit against the
        // border, which is what the other views avoid by having no border to sit against. Half the
        // original is enough to read as a finished surface.
        //
        // Nothing above this line changes for any other view, and no control moves: the row
        // heights, gaps and order are untouched.
        padding: props.overEnvironment ? "18px 30px 8px" : "18px 30px 0",
      }}
    >
      {/* A SINGLE CRUMB IS NOT A TRAIL. At the library root `crumbs` holds one entry, «المكتبة»,
          whose button navigates to where the reader already is — and the heading directly beneath
          says the same word. That restatement cost an 18px row and its 6px margin in four of the
          five formats. Two or more crumbs is a path out, and is drawn exactly as before. */}
      {!props.place && props.crumbs.length > 1 && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          font: "500 .75rem var(--ui)",
          color: "var(--faint)",
          marginBottom: "var(--sp-3)",
          minHeight: 18,
        }}
      >
        {props.crumbs.map((cr, i) => (
          <span key={`${cr.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            {i > 0 && <span style={{ fontSize: 10 }}>›</span>}
            <button className="libd-hov-txt" onClick={cr.go} style={{ color: "inherit" }}>
              {cr.label}
            </button>
          </span>
        ))}
      </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--sp-6)" }}>
        {/* THE ARRANGE NOTE LIVES ON THIS LINE, not on one of its own.
            It was the last child of the control row and declared `flex: 1 1 220px`, which says it
            was always meant to sit BESIDE the controls. It never could: measured at a 1600px
            window, that row is 1296px wide, its five controls take 1170px, and 126px is left — less
            than the 220px basis — so it wrapped, and `flex-grow: 1` then stretched it across the
            full width. An 18px line plus its 11px gap, in four of the five formats.
            This line, meanwhile, was carrying 419px of content in 1296px: 877px of empty middle,
            one row above. The note now occupies that space, which is what `space-between` was
            already holding open. It truncates rather than wrapping so it can never push this row to
            two lines, and keeps the full sentence in `title` for the narrow case.
            Nothing about WHAT it says, or when it says it, changes. */}
        {props.place ? (
          <PlaceHeading place={props.place} />
        ) : (
        // THE SAME PLATE, FOR THE SAME REASON. `PlaceHeading` above is Vista's branch and carries
        // one; this is every other format's, and it did not — which was fine only while those four
        // lay under a flat scrim that gave the words a ground. The scrim now follows the reader's
        // own control and can be nothing at all, so this is bare text on a photograph without it.
        // The rule paints only when a background is actually set, so with none this is inert.
        <div className="libd-plate" style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-5)", minWidth: 0 }}>
          <h1
            dir="auto"
            style={{
              margin: 0,
              font: `${scriptOf(props.heading) === "arabic" ? "700 1.625rem/1.35" : "600 1.5rem/1.2"} ${displayFaceFor(props.heading)}`,
              color: "var(--txt)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {props.heading}
          </h1>
          <span style={{ font: "500 .8125rem var(--ui)", color: "var(--faint)", whiteSpace: "nowrap" }}>
            {props.subcount}
          </span>
        </div>
        )}
        {/* WITH NO BOOKS, NONE OF THESE HAS ANYTHING TO ACT ON — and the empty state below carries
            «إضافة كتب» as its own primary action, so the toolbar's copy of it would compete with the
            one thing the screen is for. */}
        {!props.bare && (
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <button onClick={props.onToggleSelect} style={ctlBtn(props.mode === "select")}>
            {t("lib.select")}
          </button>
          {/* ALWAYS DRAWN — Manual Ordering is a feature of the library, not of one place in it.
              Hiding it where the current scope holds nothing reorderable made it vanish from
              twelve of the twenty view-and-depth combinations, including the unshelved run a
              reader may well be standing in when they open the app, and that reads as the feature
              having been taken away rather than as a property of where they are standing.

              Disabled instead, with the reason on it, which is what this surface already does with
              the sidebar's «reading now» row: `disabled`, six-tenths opacity, default cursor. */}
          <button
            onClick={props.onToggleArrange}
            disabled={!props.canArrangeHere}
            title={props.arrangeReason ?? undefined}
            aria-label={
              props.arrangeReason
                ? `${t("lib.arrange")} — ${props.arrangeReason}`
                : undefined
            }
            style={{
              ...ctlBtn(props.mode === "arrange"),
              ...(props.canArrangeHere ? {} : { opacity: 0.6, cursor: "default" }),
            }}
          >
            {props.mode === "arrange" ? t("lib.arranging") : t("lib.arrange")}
          </button>
          <button
            className="libd-hov-bright"
            onClick={props.onAddBooks}
            disabled={props.importing}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: "var(--r-md)",
              background: "var(--acc)",
              color: "var(--pap)",
              font: "600 .75rem var(--ui)",
              boxShadow: "var(--sh1)",
              opacity: props.importing ? 0.7 : 1,
            }}
          >
            {t(props.importing ? "lib.importing" : "lib.add")}
          </button>
        </div>
        )}
      </div>

      {/* Search, the five views, the sort and the format filter — every one of them a way of
          narrowing a set of books. */}
      {!props.bare && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          flexWrap: "wrap",
          marginTop: "var(--sp-5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-4)",
            height: "var(--ctl-lg)",
            minWidth: 240,
            flex: "0 1 320px",
            padding: "0 11px",
            borderRadius: "var(--r-md)",
            background: "var(--soft)",
            border: "1px solid var(--brd)",
          }}
        >
          <span style={{ color: "var(--faint)", fontSize: 13 }} aria-hidden>
            <Icon name="search" size="sm" />
          </span>
          <input
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder={t("lib.searchWide")}
            aria-label={t("lib.searchWide")}
            style={{
              flex: 1,
              minWidth: 0,
              background: "none",
              border: 0,
              outline: "none",
              font: "400 .8125rem var(--ui)",
            }}
          />
          {props.query && (
            <button
              onClick={() => props.onQuery("")}
              aria-label={t("lib.clearSearch")}
              style={{ color: "var(--faint)", fontSize: 12, padding: "0 2px" }}
            >
              <Icon name="close" size="sm" />
            </button>
          )}
        </div>

        <div style={groupStyle} role="tablist">
          {views.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={props.view === v.id}
              title={v.hint}
              // Hover, the selected ink and the keyboard ring all come from the stylesheet — an
              // inline `background` would beat every one of those rules. Only the ground the tab
              // rests at is stated here, through a property those rules can reach.
              className="libd-viewtab"
              onClick={() => props.onView(v.id)}
              style={{
                ...ctlBtn(props.view === v.id),
                height: 28,
                padding: "0 10px",
                border: "none",
                background: props.view === v.id
                  ? "var(--act)"
                  : "var(--viewtab-bg, transparent)",
                // `ctlBtn` carries a colour of its own, and it is spread above — so it is cleared
                // here rather than merely left unset. Colour is what the rest, hover and selected
                // states differ by, and an inline one beats every rule that would set them.
                // `ctlBtn` itself is untouched: it dresses Select, Arrange and Add books too.
                color: undefined,
              }}
            >
              {/* A LIST MIRRORS AND A PICTURE DOES NOT.
                  Details draws a thumbnail beside its lines, and in Arabic that thumbnail really
                  is on the other side — so its mark follows the writing direction, or it stops
                  being a miniature of what it opens. The other four are symmetrical about the
                  vertical, and Vista is a photograph, which the app already refuses to mirror
                  anywhere else. */}
              <span
                aria-hidden
                style={{
                  flex: "none",
                  display: "flex",
                  transform: rtl && v.id === "details" ? "scaleX(-1)" : undefined,
                }}
              >
                <Icon name={VIEW_ICONS[v.id]} size="md" />
              </span>
              <span style={{ font: "500 .8125rem var(--ui)" }}>{v.label}</span>
            </button>
          ))}
        </div>

        {props.view === "grid" && (
          <button onClick={props.onCoverMode} style={ctlBtn(false)}>
            {t(props.coverMode === "crop" ? "lib.cover.crop" : "lib.cover.fit")}
            <span style={{ color: "var(--faint)", display: "flex" }} aria-hidden><Icon name="caretDown" size="sm" /></span>
          </button>
        )}

        {(props.view === "grid" || props.view === "covers" || props.view === "vista") && (
          <button
            onClick={props.onHideTitles}
            aria-pressed={props.hideTitles}
            title={t("lib.titles.hint")}
            style={ctlBtn(props.hideTitles)}
          >
            {/* NO GLYPH. The icon set holds nothing that means "a name, withheld" — the nearest
                candidates all say something else — and `ctlBtn(active)` already carries "on" the way
                every other toolbar toggle does, in border, ink and fill. Two words that say exactly
                what the shelf becomes are quieter than a borrowed symbol that says almost it. */}
            {t("lib.titles.quiet")}
          </button>
        )}

        {/* HOW BIG THE BOOKS STAND — and it now includes Grid.
            Four buttons stood here, one per authored step, and they were the only sizes a reader
            could ask for: measured on a 1680px pane Covers reached 12, 9, 8 and 6 books to a row,
            so ten and eleven could not be had at all. The steps are now anchors on a continuum
            (`atDensity`) rather than the only places to stand, and this is the control for it.

            IT IS A NATIVE RANGE, which is what a slider already is everywhere else in Sard —
            `.gs-slider` is `accent-color: var(--accent)` over the platform control and nothing
            more. That also buys RTL for free: RAWY-65 records that a native range mirrors itself.

            The two bars are the ones the four buttons drew, kept as the small and large ends, so
            the control reads as the same family rather than a generic slider dropped into the
            toolbar. They are `aria-hidden` — the range carries the accessible name.

            GRID IS INCLUDED NOW. It was excluded because it never read density at all: its CSS
            said `minmax(148px, 1fr)`, a hardcoded floor which is exactly `DENSITY_WIDTHS[2]`.
            Measured, all four steps drew an identical 179px card. That was a wiring gap, not a
            decision. DETAILS is still out, and that one IS a decision: it is a row list, and cover
            size is not what organises it. */}
        {props.view !== "details" && (
          <div style={{ ...groupStyle, gap: 7, paddingInline: "var(--sp-4)" }}>
            <span aria-hidden style={{ display: "block", width: 4, height: 11, borderRadius: 1, background: "var(--faint)" }} />
            <input
              type="range"
              className="libd-size"
              min={DENSITY_MIN}
              max={DENSITY_MAX}
              step={DENSITY_STEP}
              value={props.density}
              onChange={(e) => props.onDensity(Number(e.target.value))}
              aria-label={t("lib.size")}
              title={t("lib.size")}
              // What a screen reader says instead of "1.4": the size as a share of the range, which
              // is the only thing the number means to a reader.
              aria-valuetext={`${Math.round((props.density / DENSITY_MAX) * 100)}%`}
            />
            <span aria-hidden style={{ display: "block", width: 4, height: 15, borderRadius: 1, background: "var(--faint)" }} />
          </div>
        )}

        {/* RAWY-15's format filter, carried over from the old toolbar. It filters in SQL. */}
        <div style={{ position: "relative" }}>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setFormatOpen((v) => !v)}
            title={t("lib.filter")}
            aria-label={t("lib.filter")}
            style={ctlBtn(!!props.format)}
          >
            <Icon name="filter" size="sm" />
            {props.format ? props.format.toUpperCase() : t("lib.filter.all")}
          </button>
          {formatOpen && (
            <>
              <div
                ref={formatRef}
                style={{
                  position: "absolute",
                  insetInlineEnd: 0,
                  top: "calc(100% + 6px)",
                  zIndex: 70,
                  width: 180,
                  background: "var(--chr)",
                  border: "1px solid var(--brd)",
                  borderRadius: "var(--r-lg)",
                  boxShadow: "var(--sh4)",
                  padding: "var(--sp-3)",
                  animation: "sard-rise .12s ease-out",
                }}
              >
                {[null, "epub", "pdf"].map((f) => (
                  <button
                    key={f ?? "all"}
                    className="libd-hov"
                    onClick={() => {
                      props.onFormat(f);
                      setFormatOpen(false);
                    }}
                    style={{
                      width: "100%",
                      justifyContent: "flex-start",
                      padding: "7px 10px",
                      borderRadius: "var(--r-md)",
                      font: "500 .8125rem var(--ui)",
                      color: props.format === f ? "var(--txt)" : "var(--mut)",
                      background: props.format === f ? "var(--act)" : "transparent",
                    }}
                  >
                    {f ? f.toUpperCase() : t("lib.filter.all")}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ position: "relative" }}>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setSortOpen((v) => !v)}
            style={ctlBtn(false)}
          >
            <span
              style={{
                color: "var(--faint)",
                font: "600 .625rem var(--ui)",
                letterSpacing: ".12em",
                textTransform: "uppercase",
              }}
            >
              {t("lib.sortEyebrow")}
            </span>
            <span style={{ font: "500 .8125rem var(--ui)" }}>{sortLabel[props.sort]}</span>
            <span style={{ color: "var(--faint)", display: "flex" }} aria-hidden><Icon name="caretDown" size="sm" /></span>
          </button>
          {sortOpen && (
            <>
              <div
                ref={sortRef}
                style={{
                  position: "absolute",
                  insetInlineEnd: 0,
                  top: "calc(100% + 6px)",
                  zIndex: 70,
                  width: 216,
                  background: "var(--chr)",
                  border: "1px solid var(--brd)",
                  borderRadius: "var(--r-lg)",
                  boxShadow: "var(--sh4)",
                  padding: "var(--sp-3)",
                  animation: "sard-rise .12s ease-out",
                }}
              >
                {sorts.map((s) => (
                  <button
                    key={s}
                    className="libd-hov"
                    onClick={() => {
                      props.onSort(s);
                      setSortOpen(false);
                    }}
                    style={{
                      width: "100%",
                      justifyContent: "space-between",
                      padding: "7px 10px",
                      borderRadius: "var(--r-md)",
                      font: "500 .8125rem var(--ui)",
                      color: props.sort === s ? "var(--txt)" : "var(--mut)",
                    }}
                  >
                    <span>{sortLabel[s]}</span>
                    <span style={{ color: "var(--acc)", display: "flex" }} aria-hidden>
                      {props.sort === s ? <Icon name="check" size="sm" /> : null}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

      </div>
      )}
    </header>
  );
}
