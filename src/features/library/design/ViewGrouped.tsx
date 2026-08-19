// Covers and Spines.
//
// SOURCE: `Sard Library (standalone).html`. Both are the design's `isGrouped` path — cases,
// then shelves, then the category runs inside them, then the books — and the only difference
// between them is how a book is drawn, which is `BookTile`'s `spines` branch.
//
// (Verified before porting: the block that produces this view is byte-identical in the two
// reference files, so taking it from the base file is not merely correct by instruction but
// unambiguous in fact.)

import { Fragment } from "react";
import type { BookRow, CaseNode, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { BookTile } from "./BookTile";
import { ShelfOrderMenu } from "./Menus";
import { type BookGroup, type DesignView, isVirtualShelf, itemWidth, sortKey, UNFILED_CASE_ID } from "./model";
import type { CoverMode } from "./coverPresentation";
import { Icon } from "../../../components/Icon";

export interface ShelfRender {
  shelf: ShelfNode;
  groups: BookGroup[];
  /** Total after the search filter, before the display cap. */
  total: number;
}

export interface CaseRender {
  node: CaseNode | null;
  shelves: ShelfRender[];
}

export interface GroupedProps {
  cases: CaseRender[];
  view: DesignView;
  density: number;
  paneWidth: number;
  mode: "browse" | "select" | "arrange";
  selected: Set<string>;
  carryId: string | null;
  openCases: Set<string>;
  onToggleCase: (id: string) => void;
  onFocusCase: (id: string) => void;
  onFocusShelf: (id: string) => void;
  onToggleShelf: (s: ShelfNode) => void;
  onOpenBook: (b: BookRow) => void;
  onEditBook: (b: BookRow) => void;
  onToggleSelect: (id: string) => void;
  onPickUp: (b: BookRow, shelfId: string, x: number, y: number) => void;
  /** Arrange mode: the pointer went down on a book. The surface decides when it becomes a drag. */
  onArrangeDown: (b: BookRow, shelfId: string, x: number, y: number, el: Element) => void;
  onRemoveFromShelf: (bookId: string, shelfId: string) => void;
  onSetFinished: (b: BookRow, finished: boolean) => void;
  onNewShelf: (caseId: string) => void;
  onManageCase: (id: string | null) => void;
  /** Which shelf's order popover is open, and how to open/close one. */
  orderMenuFor: string | null;
  onOpenOrder: (shelfId: string | null) => void;
  onSetOrder: (shelfId: string, order: ShelfOrder) => void;
  /** The shelf whose name is being edited inline, as the design shows it. */
  renamingShelf: string | null;
  onRenameShelf: (shelfId: string | null) => void;
  onCommitRename: (shelfId: string, name: string) => void;
  onDeleteShelf: (shelfId: string) => void;
  onNewCategory: (shelfId: string) => void;
  onShelfInk: (shelfId: string, ink: string | null) => void;
  onSetShelfCase: (shelfId: string, caseId: string | null) => void;
  onMoveShelf: (shelfId: string, direction: number) => void;
  /** Placement targets while a book is in hand. */
  /** Shelves the reader has expanded past the two-row cap. */
  expandedShelves: Set<string>;
  onExpandShelf: (shelfId: string) => void;
  /** Width of the book in hand, for the spine-shaped drop slot. */
  carryWidth: number;
  /** True when the book in hand came from the unshelved run, which it cannot be dropped back into. */
  carryFromUnshelved: boolean;
  /** The library Crop/Fit default, passed through to each tile. */
  libraryCoverMode: CoverMode;
  onPlace: (shelfId: string, categoryId: string | null, index: number) => void;
}

/** Spine heights per density step — the reference's numbers. */
const SPINE_HEIGHTS = [104, 132, 168, 208];

export function ViewGrouped(props: GroupedProps) {
  const { t, lang } = useI18n();
  const num = (n: number) => localeNum(n, lang);
  const rtl = lang === "ar";
  const spines = props.view === "spines";
  const iw = itemWidth(props.density, props.view, props.paneWidth);
  const carrying = props.carryId != null;
  // How many covers fit across, and therefore how many the reference shows before it offers
  // "Show all": Covers caps a shelf at TWO rows so a long shelf stays a shelf instead of
  // sprawling down the page. `perRow` is the reference's own formula.
  const perRow = Math.max(2, Math.floor((Math.max(320, props.paneWidth - 96) + 20) / (iw + 20)));
  const capFor = (shelfId: string) =>
    spines ? Number.MAX_SAFE_INTEGER : props.expandedShelves.has(shelfId) ? perRow * 99 : perRow * 2;

  /**
   * Whether this band can take the book currently in hand — which is what decides whether it
   * lights up or dims while a drag is live.
   *
   * The unshelved run counts: dropping there means "take it off its shelf", so it is a target for
   * anything that came from a real shelf, and for nothing that was already unshelved.
   */
  // A SORTED shelf can take a book — the sort simply decides where it sits once it arrives. Only
  // a rule shelf cannot, because its contents are a query rather than a list.
  const canTake = (s: ShelfNode) =>
    isVirtualShelf(s.id) ? !props.carryFromUnshelved : !s.auto_rule;

  const ruleLabel = (s: ShelfNode) =>
    s.auto_rule === "reading"
      ? t("lib.rule.reading")
      : s.auto_rule === "finished"
        ? t("lib.rule.finished")
        : t("lib.rule.added");

  /**
   * The drop slot, as the reference draws it: a BOOK-SHAPED dashed placeholder that takes a
   * cell in the grid, not a thin bar wedged between two covers. The reference's own style is
   * `width:100%; aspect-ratio:2/3; border:2px dashed var(--acc); border-radius:3px;
   * background:var(--act)`, which is why the row reads as opening a gap for the book in hand.
   */
  //
  // The unshelved run takes a drop too, and it means the opposite: the book leaves the shelf it
  // came from and joins nothing. Without it there was no way to drag a book OFF a shelf — only
  // the book's own ⋯ could do that — so a drag could file a book and never unfile one.
  const gap = (shelfId: string, categoryId: string | null, index: number, key: string) =>
    carrying && !(isVirtualShelf(shelfId) && props.carryFromUnshelved) ? (
      <button
        key={key}
        // The slot names its own destination, so a RELEASE can find it by hit-testing the point
        // under the pointer. Clicking it still works and does the same thing.
        data-drop-shelf={shelfId}
        data-drop-cat={categoryId ?? ""}
        data-drop-index={index}
        onClick={() => props.onPlace(shelfId, categoryId, index)}
        title={isVirtualShelf(shelfId) ? t("lib.takeOffShelf") : t("lib.placeHere")}
        aria-label={isVirtualShelf(shelfId) ? t("lib.takeOffShelf") : t("lib.placeHere")}
        style={{
          display: "block",
          width: spines ? props.carryWidth : "100%",
          ...(spines ? { height: SPINE_HEIGHTS[props.density] } : { aspectRatio: "2/3" }),
          border: "2px dashed var(--acc)",
          borderRadius: "var(--r-xs)",
          background: "var(--act)",
          animation: "sard-open .14s ease-out",
        }}
      />
    ) : null;

  return (
    <>
      {props.cases.map((c) => {
        // The unfiled group is a top-level group like any other, so it answers to the same open
        // set under a synthetic id. It used to render the same disc and caret as a case and then
        // ignore the click — a control that looked collapsible and was not.
        const id = c.node?.id ?? UNFILED_CASE_ID;
        const open = props.openCases.has(id);
        const shelfCount = c.shelves.length;
        // DISTINCT books, never the sum of the shelf totals — a book on two shelves of the same
        // case would otherwise be counted twice, which is how a 42-book library reported 43.
        // A real case has the backend's own DISTINCT count; the un-cased group is assembled here,
        // so it is counted here.
        const bookCount =
          c.node?.count ??
          new Set(c.shelves.flatMap((s) => s.groups.flatMap((g) => g.books.map((b) => b.id)))).size;
        // A CASE IS A CARD, not a heading with a rule under it. The reference gives it a chrome
        // panel with a 4px spine of its own colour down the leading edge and its shelves banded
        // inside — which is the whole reason the hierarchy reads as Case → Shelves → Books
        // rather than as shelves floating in a page. Rendering it as a bare section, which is
        // what this did, removed the case layer in everything but name.
        //
        // `color-mix` rather than the reference's hex suffixes (`ink + "55"`), so a case that has
        // not been given a colour yet falls back to the accent instead of composing "null55".
        const ink = c.node?.ink ?? "var(--acc)";
        const spine = c.node ? ink : "var(--brd)";
        return (
          <section
            key={id}
            style={{
              margin: "0 24px 22px",
              // Slightly translucent, so a library background reads faintly through the case
              // without the card becoming glass. 88% is the same register as the sidebar's own
              // 85% floor (RAWY-278) and stays well clear of it, and there is deliberately no
              // backdrop-filter: the blur is what turns a translucent panel into a glass one,
              // and it is not wanted here. With no background image this simply carries the
              // chrome a little toward the paper, which is the intended restraint.
              background: "color-mix(in srgb, var(--chr) 88%, transparent)",
              border: "1px solid var(--brd)",
              // The case's ink runs down this card as a spine, so the two corners it passes through
              // square off to the spine's own 4px and the far side keeps the card radius. Both have
              // to be stated logically: border-inline-start follows the writing direction but the
              // border-radius shorthand is physical and does not, so in Arabic the spine bowed
              // around the 14px curve while the bare edge kept the square corners cut for it.
              borderInlineStart: `4px solid ${spine}`,
              borderStartStartRadius: 4,
              borderEndStartRadius: 4,
              borderStartEndRadius: 14,
              borderEndEndRadius: 14,
              boxShadow: "var(--sh1)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 14,
                padding: "15px 22px 14px",
              }}
            >
              <button
                className="libd-hov"
                onClick={() => props.onToggleCase(id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  // START, explicitly. This button is `flex: 1` so it spans the header, and the
                  // surface's own button reset sets `justify-content: center` — which pushed the
                  // disc, the name and the counts into the middle of the case and made the header
                  // read as a centred title. The reference's `headBtn` sets no justification at
                  // all, i.e. start, and mirrors with the UI direction on its own.
                  justifyContent: "flex-start",
                  gap: "var(--sp-5)",
                  minWidth: 0,
                  flex: 1,
                  margin: "-7px 0 -7px -8px",
                  padding: "7px 12px 7px 8px",
                  borderRadius: 10,
                  textAlign: "start",
                }}
              >
                {/* The disc takes the case's colour while it is open — the clearest signal that
                    everything below belongs to this case. */}
                <span
                  style={{
                    flex: "none",
                    display: "grid",
                    placeItems: "center",
                    width: "var(--ctl-sm)",
                    height: "var(--ctl-sm)",
                    borderRadius: 8,
                    background: open ? `color-mix(in srgb, ${ink} 20%, transparent)` : "var(--soft)",
                    border: `1px solid ${open ? `color-mix(in srgb, ${ink} 53%, transparent)` : "var(--brd)"}`,
                    transition: "background .14s ease-out",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: 8,
                      height: 8,
                      borderRight: "1.7px solid var(--txt)",
                      borderBottom: "1.7px solid var(--txt)",
                      transform: `rotate(${open ? "45deg" : rtl ? "135deg" : "-45deg"}) translate(-1.4px,-1.4px)`,
                      transition: "transform .18s ease-out",
                    }}
                  />
                </span>
                {/* The name carries the case's colour as an inset underline — the reference's
                    own `box-shadow: inset 0 -6px 0 -2px {ink}55`. Renaming happens in the
                    management panel that "Manage" opens, which is where the reference puts it. */}
                <span
                  dir="auto"
                  style={{
                    flex: "none",
                    font: rtl ? "700 1.125rem var(--ar)" : "600 1.0625rem var(--book)",
                    color: "var(--txt)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    boxShadow: c.node
                      ? `inset 0 -6px 0 -2px color-mix(in srgb, ${ink} 33%, transparent)`
                      : undefined,
                  }}
                >
                  {c.node ? c.node.name : t("lib.unfiled")}
                </span>
                <span
                  style={{
                    flex: "none",
                    whiteSpace: "nowrap",
                    font: "500 .75rem var(--ui)",
                    color: "var(--faint)",
                  }}
                >
                  {t("lib.shelfCount", { n: num(bookCount) })} · {t("lib.shelvesCount", { n: num(shelfCount) })}
                </span>
                {!open && (
                  // A collapsed case still says so, as a pill rather than bare text.
                  <span
                    style={{
                      flex: "none",
                      whiteSpace: "nowrap",
                      font: "600 .625rem var(--ui)",
                      letterSpacing: ".12em",
                      textTransform: "uppercase",
                      color: "var(--faint)",
                      border: "1px solid var(--brd)",
                      borderRadius: 20,
                      padding: "3px 9px",
                    }}
                  >
                    {t("lib.collapsed")}
                  </span>
                )}
              </button>
              {c.node && (
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {/* "Manage" opens the management PANEL — the reference's own destination for
                      it. There used to be a context menu behind a `manageMenuFor` that nothing
                      ever set, so every control inside it was unreachable: rename, colour, move
                      and delete all lived in a menu that could not open. They live in the panel. */}
                  <button
                    className="libd-hov-txt"
                    onClick={() => props.onManageCase(c.node!.id)}
                    style={{ font: "500 .75rem var(--ui)", color: "var(--mut)" }}
                  >
                    {t("lib.manage")}
                  </button>
                  <button
                    className="libd-hov-txt"
                    onClick={() => props.onNewShelf(c.node!.id)}
                    style={{ font: "500 .75rem var(--ui)", color: "var(--mut)" }}
                  >
                    {t("lib.newShelf")}
                  </button>
                  <button
                    className="libd-hov-fade"
                    onClick={() => props.onFocusCase(c.node!.id)}
                    style={{ font: "500 .75rem var(--ui)", color: "var(--acc)" }}
                  >
                    {t("lib.openCase")}
                  </button>
                </div>
              )}
            </div>

            {open &&
              c.shelves.map(({ shelf, groups, total }) => (
                // Each shelf is a BAND inside the case card, divided by a rule — which is what
                // makes "these shelves belong to this case" legible without reading a word.
                // While a book is in hand the band says whether it can take it.
                <div
                  key={shelf.id}
                  style={{
                    padding: "14px 22px 16px",
                    borderTop: "1px solid var(--brd)",
                    ...(carrying && canTake(shelf) ? { background: "var(--soft)" } : {}),
                    ...(carrying && !canTake(shelf) ? { opacity: 0.45 } : {}),
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "var(--sp-5)",
                      padding: "0 0 9px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      {/* The shelf's collapse toggle took its size from its own glyph -- 12x14 --
                          inside a row 26px tall, while the same faint-glyph control in the case
                          editor is 22x22 on a 6px radius. The extra width is absorbed by a negative
                          inline-end margin rather than by the row gap: this row holds three items,
                          so narrowing the gap would also have pulled the count in against the name. */}
                      <button
                        onClick={() => props.onToggleShelf(shelf)}
                        aria-label={shelf.name}
                        style={{
                          color: "var(--faint)", fontSize: 9, flex: "none",
                          width: "var(--ctl-xs)", height: "var(--ctl-xs)", borderRadius: "var(--r-sm)",
                          marginInlineEnd: -8,
                        }}
                      >
                        <Icon name={shelf.collapsed ? "caretRight" : "caretDown"} size="sm" />
                      </button>
                      <button
                        className="libd-hov-txt"
                        onClick={() => props.onFocusShelf(shelf.id)}
                        dir="auto"
                        style={{ font: rtl ? "700 .9375rem var(--ar)" : "600 .875rem var(--ui)", color: "var(--txt)" }}
                      >
                        {shelf.name}
                      </button>
                      <span style={{ font: "500 .75rem var(--ui)", color: "var(--faint)" }}>
                        {num(total)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", position: "relative" }}>
                      {isVirtualShelf(shelf.id) ? null : shelf.auto_rule ? (
                        <span
                          title={t("lib.ruleFixed")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "var(--sp-3)",
                            height: "var(--ctl-sm)",
                            padding: "0 10px",
                            borderRadius: 20,
                            font: "500 .6875rem var(--ui)",
                            color: "var(--faint)",
                            background: "var(--soft)",
                            border: "1px solid var(--brd)",
                          }}
                        >
                          {t("lib.automatic")} · {ruleLabel(shelf)}
                        </span>
                      ) : (
                        <button
                          className="libd-hov"
                          onClick={() => props.onOpenOrder(shelf.id)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "var(--sp-3)",
                            height: "var(--ctl-sm)",
                            padding: "0 10px",
                            borderRadius: 20,
                            font: "500 .6875rem var(--ui)",
                            color: "var(--mut)",
                            background: "var(--soft)",
                            border: "1px solid var(--brd)",
                          }}
                        >
                          {shelf.order_rule === "hand" ? (
                            t("lib.byHand")
                          ) : (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <Icon name="sort" size="sm" />
                              {t(sortKey(shelf.order_rule))}
                            </span>
                          )}
                          <span style={{ color: "var(--faint)", display: "flex" }} aria-hidden><Icon name="caretDown" size="sm" /></span>
                        </button>
                      )}
                      {props.orderMenuFor === shelf.id && (
                        <ShelfOrderMenu
                          shelf={shelf}
                          onOrder={(o) => props.onSetOrder(shelf.id, o)}
                          onRename={() => props.onRenameShelf(shelf.id)}
                          onDelete={() => props.onDeleteShelf(shelf.id)}
                          onNewCategory={() => props.onNewCategory(shelf.id)}
                          onClose={() => props.onOpenOrder(null)}
                          cases={props.cases.map((x) => x.node).filter((x): x is CaseNode => !!x)}
                          onSetCase={(caseId) => props.onSetShelfCase(shelf.id, caseId)}
                          onInk={(ink) => props.onShelfInk(shelf.id, ink)}
                          onMove={(d) => props.onMoveShelf(shelf.id, d)}
                        />
                      )}
                    </div>
                  </div>

                  {props.renamingShelf === shelf.id && (
                    <input
                      autoFocus
                      defaultValue={shelf.name}
                      dir="auto"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") props.onCommitRename(shelf.id, e.currentTarget.value);
                        else if (e.key === "Escape") props.onRenameShelf(null);
                      }}
                      onBlur={(e) => props.onCommitRename(shelf.id, e.currentTarget.value)}
                      style={{
                        margin: "0 0 10px",
                        width: 260,
                        background: "var(--soft)",
                        border: "1px solid var(--brd)",
                        borderRadius: 7,
                        padding: "6px 9px",
                        font: "500 .8125rem var(--ui)",
                        outline: "none",
                      }}
                    />
                  )}

                  {shelf.collapsed ? (
                    <button
                      onClick={() => props.onToggleShelf(shelf)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--sp-1)",
                        padding: "8px 10px",
                        borderRadius: "var(--r-md)",
                        background: "var(--soft)",
                        border: "1px solid var(--brd)",
                        width: "100%",
                        justifyContent: "flex-start",
                      }}
                    >
                      {groups
                        .flatMap((g) => g.books)
                        .slice(0, 14)
                        .map((b) => (
                          <span
                            key={b.id}
                            style={{
                              display: "block",
                              width: 4,
                              height: "var(--ctl-xs)",
                              borderRadius: 1,
                              background: "var(--faint)",
                              opacity: 0.7,
                            }}
                          />
                        ))}
                      <span
                        style={{
                          font: "500 .6875rem var(--ui)",
                          color: "var(--faint)",
                          marginInlineStart: "var(--sp-4)",
                        }}
                      >
                        {t("lib.collapsed")} · {num(total)}
                      </span>
                    </button>
                  ) : total === 0 && !(carrying && canTake(shelf)) ? (
                    // The reference's empty shelf: a dashed box that reads as a place waiting to
                    // be filled, not a line of grey text.
                    //
                    // While a book is in hand this branch stands aside, because it used to be a
                    // dead end: an empty shelf drew this box INSTEAD of any drop slot, so a book
                    // could never be dragged onto a shelf that had nothing on it yet — which is
                    // exactly the shelf someone has just made in order to put something on it.
                    <div
                      style={{
                        border: "1px dashed var(--rule)",
                        borderRadius: "var(--r-md)",
                        padding: "16px 18px",
                        background: "var(--soft)",
                        font: "400 .8125rem var(--ui)",
                        color: "var(--mut)",
                      }}
                    >
                      {shelf.auto_rule ? t("lib.shelfRow.empty") : t("lib.emptyShelf")}
                    </div>
                  ) : (
                    (() => {
                      // A shelf shows at most two rows of covers before offering "Show all",
                      // spending its budget across the category runs in order — the reference's
                      // own rule, and what keeps a 40-book shelf a shelf rather than a page.
                      let budget = capFor(shelf.id);
                      // A shelf whose only categories are empty groups to NOTHING, so there is no
                      // run to hang a slot off. Give the drop somewhere to land.
                      if (!groups.length) return gap(shelf.id, null, 0, "gap-empty");
                      return groups.map((g) => {
                        const take = spines ? g.books.length : Math.max(0, Math.min(g.books.length, budget));
                        if (!spines) budget -= take;
                        const shownBooks = g.books.slice(0, take);
                        if (shownBooks.length === 0 && !carrying) return null;
                        return (
                          <div key={g.categoryId ?? "__loose"}>
                            {g.name && (
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  padding: "2px 0 8px",
                                  font: "600 .625rem var(--ui)",
                                  letterSpacing: ".13em",
                                  textTransform: "uppercase",
                                  color: "var(--mut)",
                                }}
                              >
                                <span>{g.name}</span>
                                <span style={{ flex: 1, height: 1, background: "var(--rule)" }} />
                                <span style={{ color: "var(--faint)" }}>{num(g.books.length)}</span>
                              </div>
                            )}
                            <div
                              style={
                                spines
                                  ? {
                                      display: "flex",
                                      alignItems: "flex-end",
                                      flexWrap: "wrap",
                                      gap: 6,
                                      minHeight: SPINE_HEIGHTS[props.density],
                                      ...(g.name ? { marginBottom: 16 } : {}),
                                    }
                                  : {
                                      display: "grid",
                                      gridTemplateColumns: `repeat(auto-fill, minmax(${iw}px, 1fr))`,
                                      gap: 20,
                                      ...(g.name ? { marginBottom: 16 } : {}),
                                    }
                              }
                            >
                              {shownBooks.map((b, i) => (
                                <Fragment key={b.id}>
                                  {gap(shelf.id, g.categoryId, i, `gap-${b.id}`)}
                                  <BookTile
                                    book={b}
                                    view={props.view}
                                    density={props.density}
                                    itemW={iw}
                                    selected={props.selected.has(b.id)}
                                    inHand={props.carryId === b.id}
                                    arrangeOn={props.mode === "arrange"}
                                    selectOn={props.mode === "select"}
                                    onOpen={() => props.onOpenBook(b)}
                                    onEdit={() => props.onEditBook(b)}
                                    onToggleSelect={() => props.onToggleSelect(b.id)}
                                    onPickUp={(x, y) => props.onPickUp(b, shelf.id, x, y)}
                                    onArrangeDown={(x, y, el) => props.onArrangeDown(b, shelf.id, x, y, el)}
                                    onRemoveFromShelf={
                                      // A rule shelf fills itself, and the unshelved run is not a
                                      // collection — offering "remove from shelf" on either is a
                                      // control that would look real and do nothing.
                                      shelf.auto_rule || isVirtualShelf(shelf.id)
                                        ? null
                                        : () => props.onRemoveFromShelf(b.id, shelf.id)
                                    }
                                    onSetFinished={(f) => props.onSetFinished(b, f)}
                                    libraryCoverMode={props.libraryCoverMode}
                                  />
                                </Fragment>
                              ))}
                              {gap(shelf.id, g.categoryId, shownBooks.length, "gap-end")}
                            </div>
                          </div>
                        );
                      });
                    })()
                  )}

                  {/* The shelf's own rail — the line the books stand on. Covers only; Vista has
                      its band instead. Without it a shelf reads as a grid, not a shelf. */}
                  {!shelf.collapsed && !spines && (
                    <div
                      aria-hidden
                      style={{
                        height: 2,
                        marginTop: 9,
                        background: "var(--rule)",
                        boxShadow: "0 3px 7px -4px rgba(0,0,0,.5)",
                      }}
                    />
                  )}

                  {!shelf.collapsed && !spines && total > capFor(shelf.id) && (
                    <button
                      className="libd-hov libd-hov-txt"
                      onClick={() => props.onExpandShelf(shelf.id)}
                      style={{
                        marginTop: 11,
                        font: "500 .75rem var(--ui)",
                        color: "var(--mut)",
                        border: "1px solid var(--brd)",
                        background: "var(--soft)",
                        borderRadius: 20,
                        padding: "5px 14px",
                      }}
                    >
                      {t("lib.showAll")} · {num(total)}
                    </button>
                  )}
                </div>
              ))}
          </section>
        );
      })}
    </>
  );
}
