// The design's popovers, the carry ghost, and the selection tray.
//
// SOURCE: `Sard Library - Vista (standalone).html` — these are chrome, not book presentation,
// so they come from the chrome's file. The shelf popover's contents are the design's own:
// six ordering rules, then a rule, then Rename and Delete shelf.

import { useEffect, useRef, useState } from "react";
import type { BookRow, CaseNode, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { autoCoverPaint } from "../AutoCover";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";

/** The design's menu row, active and inactive. */
export const menuItem = (active: boolean): React.CSSProperties => ({
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 9,
  justifyContent: "space-between",
  padding: "7px 10px",
  borderRadius: 8,
  font: "500 .8125rem var(--ui)",
  textAlign: "start",
  background: active ? "var(--act)" : "transparent",
  color: active ? "var(--txt)" : "var(--mut)",
});

const panel = (width: number): React.CSSProperties => ({
  position: "absolute",
  insetInlineEnd: 0,
  top: "calc(100% + 6px)",
  zIndex: 60,
  width,
  background: "var(--chr)",
  border: "1px solid var(--brd)",
  borderRadius: 12,
  boxShadow: "var(--sh4)",
  padding: 6,
  animation: "sard-rise .12s ease-out",
});

const legend: React.CSSProperties = {
  font: "600 .625rem var(--ui)",
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "var(--faint)",
  padding: "5px 10px 5px",
};

/** Click-away, shared by every popover here. */
function Backdrop({ onClose }: { onClose: () => void }) {
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59 }} />;
}

// ---------------------------------------------------------------------------
// Shelf order — the design's own list, then Rename and Delete shelf.
// ---------------------------------------------------------------------------

const ORDER_DEFS: { id: ShelfOrder; key: string }[] = [
  { id: "hand", key: "lib.byHand" },
  { id: "title", key: "lib.sort.title" },
  { id: "author", key: "lib.sort.author" },
  { id: "recent", key: "lib.sort.recent" },
  { id: "added", key: "lib.sort.added" },
  { id: "progress", key: "lib.sort.progress" },
];

export function ShelfOrderMenu({
  shelf,
  onOrder,
  onRename,
  onDelete,
  onNewCategory,
  onClose,
}: {
  shelf: ShelfNode;
  onOrder: (o: ShelfOrder) => void;
  onRename: () => void;
  onDelete: () => void;
  onNewCategory: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Backdrop onClose={onClose} />
      <div style={panel(210)}>
        <div style={legend}>{t("lib.orderOfThisShelf")}</div>
        {ORDER_DEFS.map((o) => (
          <button
            key={o.id}
            className="libd-hov"
            onClick={() => {
              onOrder(o.id);
              onClose();
            }}
            style={menuItem(shelf.order_rule === o.id)}
          >
            <span>{t(o.key as never)}</span>
            <span style={{ color: "var(--acc)", fontSize: 11 }}>
              {shelf.order_rule === o.id ? "✓" : ""}
            </span>
          </button>
        ))}
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        <button
          className="libd-hov"
          onClick={() => {
            onNewCategory();
            onClose();
          }}
          style={{ ...menuItem(false), justifyContent: "flex-start" }}
        >
          {t("lib.newCategory")}
        </button>
        <button
          className="libd-hov"
          onClick={() => {
            onRename();
            onClose();
          }}
          style={{ ...menuItem(false), justifyContent: "flex-start" }}
        >
          {t("lib.shelf.rename")}
        </button>
        <button
          className="libd-hov"
          onClick={() => {
            onDelete();
            onClose();
          }}
          style={{ ...menuItem(false), justifyContent: "flex-start", color: "#c0503a" }}
        >
          {t("lib.shelf.delete")}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Case management — the ⋯ beside a case.
// ---------------------------------------------------------------------------

export function CaseManageMenu({
  onRename,
  onNewShelf,
  onNewRuleShelf,
  onMoveUp,
  onMoveDown,
  onDelete,
  onClose,
}: {
  onRename: () => void;
  onNewShelf: () => void;
  onNewRuleShelf: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const row = (label: string, run: () => void, danger?: boolean) => (
    <button
      className="libd-hov"
      onClick={() => {
        run();
        onClose();
      }}
      style={{ ...menuItem(false), justifyContent: "flex-start", color: danger ? "#c0503a" : undefined }}
    >
      {label}
    </button>
  );
  return (
    <>
      <Backdrop onClose={onClose} />
      <div style={panel(220)}>
        <div style={legend}>{t("lib.managing")}</div>
        {row(t("lib.shelf.rename"), onRename)}
        {row(t("lib.newShelf"), onNewShelf)}
        {row(`${t("lib.newShelf")} · ${t("lib.automatic")}`, onNewRuleShelf)}
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        {row(`↑ ${t("lib.moveCase")}`, onMoveUp)}
        {row(`↓ ${t("lib.moveCase")}`, onMoveDown)}
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        {row(t("lib.deleteCase"), onDelete, true)}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The carry ghost — a small card that follows the pointer while a book is in hand.
// ---------------------------------------------------------------------------

export function CarryGhost({ book, spines }: { book: BookRow; spines: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { t } = useI18n();
  const title = displayTitle(resolveBookMeta(book), t);
  const paint = autoCoverPaint(title);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      // translate() rather than left/top: this runs on every pointermove.
      el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px) rotate(-4deg)`;
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: "fixed",
        insetBlockStart: 0,
        insetInlineStart: 0,
        zIndex: 200,
        pointerEvents: "none",
        width: spines ? 34 : 74,
        ...(spines ? { height: 104 } : { aspectRatio: "2/3" }),
        borderRadius: 3,
        boxShadow: "var(--sh3)",
        display: "grid",
        placeItems: "center",
        padding: 8,
        textAlign: "center",
        background: paint.bg,
        color: paint.ink,
        font: "500 .625rem/1.25 var(--ui)",
        overflow: "hidden",
      }}
    >
      {spines ? "" : title}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The selection tray — count, a few covers, "Move to…", Done.
// ---------------------------------------------------------------------------

export function SelectTray({
  selected,
  byId,
  cases,
  onMove,
  onClear,
}: {
  selected: string[];
  byId: Map<string, BookRow>;
  cases: CaseNode[];
  onMove: (shelfId: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!selected.length) return null;

  const targets: { id: string; name: string; ink: string | null }[] = [];
  for (const c of cases) {
    for (const s of c.shelves) {
      if (s.auto_rule) continue; // a rule shelf cannot be moved into
      targets.push({ id: s.id, name: `${c.name} · ${s.name}`, ink: c.ink });
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        insetInline: 0,
        bottom: 20,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 80,
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 14,
          background: "var(--chr)",
          border: "1px solid var(--brd)",
          borderRadius: 14,
          boxShadow: "var(--sh4)",
          padding: "9px 10px 9px 16px",
          animation: "sard-rise .16s ease-out",
        }}
      >
        <span style={{ font: "500 .8125rem var(--ui)" }}>
          {selected.length} {t("lib.selected")}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          {selected.slice(0, 4).map((id) => {
            const b = byId.get(id);
            const paint = b ? autoCoverPaint(displayTitle(resolveBookMeta(b), t)) : null;
            return (
              <span
                key={id}
                style={{
                  width: 14,
                  height: 20,
                  borderRadius: 2,
                  background: paint?.bg ?? "var(--lbox)",
                  boxShadow: "var(--sh1)",
                }}
              />
            );
          })}
        </div>
        <div style={{ width: 1, height: 22, background: "var(--brd)" }} />
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              height: 30,
              padding: "0 13px",
              borderRadius: 9,
              background: "var(--acc)",
              color: "var(--pap)",
              font: "600 .75rem var(--ui)",
            }}
          >
            {t("lib.moveTo")}
          </button>
          {open && (
            <>
              <Backdrop onClose={() => setOpen(false)} />
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  insetInlineEnd: 0,
                  zIndex: 60,
                  width: 250,
                  maxHeight: 260,
                  overflowY: "auto",
                  background: "var(--chr)",
                  border: "1px solid var(--brd)",
                  borderRadius: 12,
                  boxShadow: "var(--sh4)",
                  padding: 6,
                  animation: "sard-rise .12s ease-out",
                }}
              >
                {targets.map((m) => (
                  <button
                    key={m.id}
                    className="libd-hov"
                    onClick={() => {
                      onMove(m.id);
                      setOpen(false);
                    }}
                    style={{ ...menuItem(false), justifyContent: "flex-start" }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: m.ink ?? "var(--faint)",
                        flex: "none",
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        textAlign: "start",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.name}
                    </span>
                  </button>
                ))}
                {targets.length === 0 && (
                  <div style={{ ...legend, textTransform: "none", letterSpacing: 0 }}>
                    {t("lib.noShelves")}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <button
          className="libd-hov libd-hov-txt"
          onClick={onClear}
          style={{
            height: 30,
            padding: "0 12px",
            borderRadius: 9,
            border: "1px solid var(--brd)",
            font: "500 .75rem var(--ui)",
            color: "var(--mut)",
          }}
        >
          {t("lib.done")}
        </button>
      </div>
    </div>
  );
}
