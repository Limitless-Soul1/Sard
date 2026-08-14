// Covers and Spines.
//
// SOURCE: `Sard Library (standalone).html`. Both are the design's `isGrouped` path — cases,
// then shelves, then the category runs inside them, then the books — and the only difference
// between them is how a book is drawn, which is `BookTile`'s `spines` branch.
//
// (Verified before porting: the block that produces this view is byte-identical in the two
// reference files, so taking it from the base file is not merely correct by instruction but
// unambiguous in fact.)

import type { BookRow, CaseNode, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { BookTile } from "./BookTile";
import { CaseManageMenu, ShelfOrderMenu } from "./Menus";
import { type BookGroup, type DesignView, isVirtualShelf, itemWidth } from "./model";
import type { CoverMode } from "./coverPresentation";

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
  onRemoveFromShelf: (bookId: string, shelfId: string) => void;
  onSetFinished: (b: BookRow, finished: boolean) => void;
  onNewShelf: (caseId: string) => void;
  manageMenuFor: string | null;
  onManageCase: (id: string | null) => void;
  renamingCase: string | null;
  onRenameCase: (id: string | null) => void;
  onCommitCaseRename: (id: string, name: string) => void;
  onDeleteCase: (id: string) => void;
  onMoveCase: (id: string, direction: number) => void;
  onNewRuleShelf: (caseId: string) => void;
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
  /** Placement targets while a book is in hand. */
  /** The library Crop/Fit default, passed through to each tile. */
  libraryCoverMode: CoverMode;
  onPlace: (shelfId: string, categoryId: string | null, index: number) => void;
}

export function ViewGrouped(props: GroupedProps) {
  const { t, lang } = useI18n();
  const num = (n: number) => localeNum(n, lang);
  const spines = props.view === "spines";
  const iw = itemWidth(props.density, props.view, props.paneWidth);
  const carrying = props.carryId != null;

  const ruleLabel = (s: ShelfNode) =>
    s.auto_rule === "reading"
      ? t("lib.rule.reading")
      : s.auto_rule === "finished"
        ? t("lib.rule.finished")
        : t("lib.rule.added");

  /** A drop slot between two books, shown only while a book is in hand and the shelf can take one. */
  const gap = (shelfId: string, categoryId: string | null, index: number, key: string) =>
    carrying && !isVirtualShelf(shelfId) ? (
      <button
        key={key}
        onClick={() => props.onPlace(shelfId, categoryId, index)}
        title={t("lib.placeHere")}
        aria-label={t("lib.placeHere")}
        style={{ width: 18, alignSelf: "stretch", display: "grid", placeItems: "center" }}
      >
        <span
          style={{
            display: "block",
            width: 3,
            height: "72%",
            minHeight: 40,
            borderRadius: 2,
            background: "var(--acc)",
            opacity: 0.55,
          }}
        />
      </button>
    ) : null;

  return (
    <>
      {props.cases.map((c) => {
        const id = c.node?.id ?? "__loose";
        const open = !c.node || props.openCases.has(c.node.id);
        const shelfCount = c.shelves.length;
        // DISTINCT books, never the sum of the shelf totals — a book on two shelves of the same
        // case would otherwise be counted twice, which is how a 42-book library reported 43.
        // A real case has the backend's own DISTINCT count; the un-cased group is assembled here,
        // so it is counted here.
        const bookCount =
          c.node?.count ??
          new Set(c.shelves.flatMap((s) => s.groups.flatMap((g) => g.books.map((b) => b.id)))).size;
        return (
          <section key={id} style={{ padding: "0 32px 26px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "14px 0 10px",
                borderBottom: "1px solid var(--rule)",
                marginBottom: 16,
              }}
            >
              <button
                className="libd-hov"
                onClick={() => c.node && props.onToggleCase(c.node.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 0,
                  padding: "4px 8px",
                  borderRadius: 8,
                  marginInlineStart: -8,
                }}
              >
                <span
                  style={{
                    flex: "none",
                    width: 16,
                    height: 16,
                    display: "grid",
                    placeItems: "center",
                    color: "var(--faint)",
                  }}
                >
                  <span
                    style={{
                      width: 0,
                      height: 0,
                      borderInlineStart: "4px solid currentColor",
                      borderBlockStart: "3.5px solid transparent",
                      borderBlockEnd: "3.5px solid transparent",
                      transform: open ? "rotate(90deg)" : undefined,
                      transition: "transform .14s ease-out",
                    }}
                  />
                </span>
                {c.node?.ink && (
                  <span
                    style={{
                      flex: "none",
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: c.node.ink,
                    }}
                  />
                )}
                {c.node && props.renamingCase === c.node.id ? (
                  <input
                    autoFocus
                    defaultValue={c.node.name}
                    dir="auto"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") props.onCommitCaseRename(c.node!.id, e.currentTarget.value);
                      else if (e.key === "Escape") props.onRenameCase(null);
                    }}
                    onBlur={(e) => props.onCommitCaseRename(c.node!.id, e.currentTarget.value)}
                    style={{
                      width: 260,
                      background: "var(--soft)",
                      border: "1px solid var(--brd)",
                      borderRadius: 7,
                      padding: "5px 9px",
                      font: "600 1rem var(--book)",
                      outline: "none",
                    }}
                  />
                ) : (
                  <span
                    dir="auto"
                    style={{
                      font: "600 1.0625rem var(--book)",
                      color: "var(--txt)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.node ? c.node.name : t("lib.unfiled")}
                  </span>
                )}
                <span style={{ font: "500 .75rem var(--ui)", color: "var(--faint)" }}>
                  {t("lib.shelfCount", { n: num(bookCount) })} · {t("lib.shelvesCount", { n: num(shelfCount) })}
                </span>
                {!open && (
                  <span
                    style={{
                      font: "500 .625rem var(--ui)",
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: "var(--faint)",
                    }}
                  >
                    {t("lib.collapsed")}
                  </span>
                )}
              </button>
              {c.node && (
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ position: "relative" }}>
                    <button
                      className="libd-hov-txt"
                      onClick={() =>
                        props.onManageCase(props.manageMenuFor === c.node!.id ? null : c.node!.id)
                      }
                      style={{ font: "500 .75rem var(--ui)", color: "var(--mut)" }}
                    >
                      {t("lib.manage")}
                    </button>
                    {props.manageMenuFor === c.node!.id && (
                      <CaseManageMenu
                        onRename={() => props.onRenameCase(c.node!.id)}
                        onNewShelf={() => props.onNewShelf(c.node!.id)}
                        onNewRuleShelf={() => props.onNewRuleShelf(c.node!.id)}
                        onMoveUp={() => props.onMoveCase(c.node!.id, -1)}
                        onMoveDown={() => props.onMoveCase(c.node!.id, 1)}
                        onDelete={() => props.onDeleteCase(c.node!.id)}
                        onClose={() => props.onManageCase(null)}
                      />
                    )}
                  </span>
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
                <div key={shelf.id} style={{ padding: "0 0 22px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "0 0 9px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <button
                        onClick={() => props.onToggleShelf(shelf)}
                        aria-label={shelf.name}
                        style={{ color: "var(--faint)", fontSize: 9, width: 12 }}
                      >
                        {shelf.collapsed ? "▸" : "▾"}
                      </button>
                      <button
                        className="libd-hov-txt"
                        onClick={() => props.onFocusShelf(shelf.id)}
                        dir="auto"
                        style={{ font: "600 .9375rem var(--ui)", color: "var(--txt)" }}
                      >
                        {shelf.name}
                      </button>
                      <span style={{ font: "500 .75rem var(--ui)", color: "var(--faint)" }}>
                        {num(total)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
                      {isVirtualShelf(shelf.id) ? null : shelf.auto_rule ? (
                        <span
                          title={t("lib.ruleFixed")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            height: 26,
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
                            gap: 6,
                            height: 26,
                            padding: "0 10px",
                            borderRadius: 20,
                            font: "500 .6875rem var(--ui)",
                            color: "var(--mut)",
                            background: "var(--soft)",
                            border: "1px solid var(--brd)",
                          }}
                        >
                          {shelf.order_rule === "hand"
                            ? t("lib.byHand")
                            : `⇅ ${t(`lib.sort.${shelf.order_rule}` as never)}`}
                          <span style={{ color: "var(--faint)", fontSize: 9 }}>▾</span>
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
                        gap: 2,
                        padding: "8px 10px",
                        borderRadius: 9,
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
                              height: 22,
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
                          marginInlineStart: 8,
                        }}
                      >
                        {t("lib.collapsed")} · {num(total)}
                      </span>
                    </button>
                  ) : total === 0 ? (
                    <div
                      style={{
                        font: "400 .8125rem var(--ui)",
                        color: "var(--faint)",
                        padding: "10px 0 4px",
                      }}
                    >
                      {shelf.auto_rule ? t("lib.shelfRow.empty") : t("lib.emptyShelf")}
                    </div>
                  ) : (
                    groups.map((g) => (
                      <div key={g.categoryId ?? "__loose"}>
                        {g.name && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              margin: "4px 0 10px",
                              font: "600 .6875rem var(--ui)",
                              letterSpacing: ".08em",
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
                                  gap: 3,
                                  flexWrap: "wrap",
                                  paddingBottom: 10,
                                  borderBottom: "2px solid var(--rule)",
                                  marginBottom: 14,
                                }
                              : {
                                  display: "grid",
                                  gridTemplateColumns: `repeat(auto-fill, minmax(${iw}px, 1fr))`,
                                  gap: 20,
                                  marginBottom: 14,
                                }
                          }
                        >
                          {g.books.map((b, i) => (
                            <div
                              key={b.id}
                              style={spines ? { display: "flex", alignItems: "flex-end" } : undefined}
                            >
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
                                onRemoveFromShelf={
                                  shelf.auto_rule ? null : () => props.onRemoveFromShelf(b.id, shelf.id)
                                }
                                onSetFinished={(f) => props.onSetFinished(b, f)}
                                libraryCoverMode={props.libraryCoverMode}
                              />
                            </div>
                          ))}
                          {gap(shelf.id, g.categoryId, g.books.length, "gap-end")}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ))}
          </section>
        );
      })}
    </>
  );
}
