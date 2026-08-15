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

/**
 * A destructive menu row, armed by the first click and acted on by the second — RAWY-76's
 * two-step, which the sidebar had before the redesign and which every delete here now uses.
 *
 * Between the two clicks the reader is told the three things that matter: what is being deleted,
 * what survives it, and what happens to the books. The backend already refuses to take a book
 * with a shelf or a case, but a guarantee the reader cannot see is not a safeguard for them —
 * so the sentence says it, and the second click is a separate target from the first.
 */
export function DangerRow({
  label,
  confirmText,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  confirmText: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        className="libd-hov"
        onClick={() => setArmed(true)}
        style={{ ...menuItem(false), justifyContent: "flex-start", color: "#c0503a" }}
      >
        {label}
      </button>
    );
  }
  return (
    <div
      style={{
        margin: "2px 4px 4px",
        padding: "8px 9px 9px",
        borderRadius: 9,
        border: "1px solid color-mix(in srgb, #c0503a 38%, var(--brd))",
        background: "color-mix(in srgb, #c0503a 8%, transparent)",
      }}
    >
      <div style={{ font: "400 .6875rem/1.45 var(--ui)", color: "var(--txt)", paddingBottom: 8 }}>
        {confirmText}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="libd-hov"
          onClick={() => setArmed(false)}
          style={{
            flex: 1,
            height: 26,
            borderRadius: 7,
            border: "1px solid var(--brd)",
            font: "500 .75rem var(--ui)",
            color: "var(--mut)",
          }}
        >
          {t("lib.cancel")}
        </button>
        <button
          className="libd-hov"
          onClick={onConfirm}
          style={{
            flex: 1,
            height: 26,
            borderRadius: 7,
            border: "1px solid #c0503a",
            font: "600 .75rem var(--ui)",
            color: "#c0503a",
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
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
  onInk,
  onMove,
  cases,
  onSetCase,
}: {
  shelf: ShelfNode;
  cases: CaseNode[];
  onSetCase: (caseId: string | null) => void;
  onOrder: (o: ShelfOrder) => void;
  onRename: () => void;
  onDelete: () => void;
  onNewCategory: () => void;
  onClose: () => void;
  onInk: (ink: string | null) => void;
  /** -1 = earlier among its siblings, +1 = later. */
  onMove: (direction: number) => void;
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
        <div style={{ ...legend, paddingTop: 0 }}>{t("lib.colour")}</div>
        <InkPicker value={shelf.ink} onPick={onInk} />
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        <div style={{ display: "flex", gap: 4, padding: "0 6px 4px" }}>
          <button
            className="libd-hov"
            onClick={() => {
              onMove(-1);
              onClose();
            }}
            style={{ ...menuItem(false), justifyContent: "center", flex: 1 }}
          >
            ↑ {t("lib.moveShelf")}
          </button>
          <button
            className="libd-hov"
            onClick={() => {
              onMove(1);
              onClose();
            }}
            style={{ ...menuItem(false), justifyContent: "center", flex: 1 }}
          >
            ↓
          </button>
        </div>
        {/* WHICH CASE HOLDS THIS SHELF. Without this a shelf could be created inside a case but
            never moved into or out of one afterwards — `shelf_set_case` existed on the backend
            and nothing in the UI could reach it, so an existing library could not be filed. */}
        {cases.length > 0 && (
          <>
            <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
            <div style={{ ...legend, paddingTop: 0 }}>{t("lib.caseWord")}</div>
            <button
              className="libd-hov"
              onClick={() => {
                onSetCase(null);
                onClose();
              }}
              style={menuItem(!shelf.case_id)}
            >
              <span>{t("lib.unfiled")}</span>
              <span style={{ color: "var(--acc)", fontSize: 11 }}>{!shelf.case_id ? "✓" : ""}</span>
            </button>
            {cases.map((cs) => (
              <button
                key={cs.id}
                className="libd-hov"
                onClick={() => {
                  onSetCase(cs.id);
                  onClose();
                }}
                style={menuItem(shelf.case_id === cs.id)}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      flex: "none",
                      width: 7,
                      height: 7,
                      borderRadius: 2,
                      background: cs.ink ?? "var(--faint)",
                    }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cs.name}
                  </span>
                </span>
                <span style={{ color: "var(--acc)", fontSize: 11 }}>
                  {shelf.case_id === cs.id ? "✓" : ""}
                </span>
              </button>
            ))}
          </>
        )}

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
        <DangerRow
          label={t("lib.shelf.delete")}
          confirmText={t("lib.shelf.deleteConfirm")}
          confirmLabel={t("lib.shelf.deleteYes")}
          onConfirm={() => {
            onDelete();
            onClose();
          }}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Case management — the ⋯ beside a case.
// ---------------------------------------------------------------------------

/**
 * The inks a case or shelf may carry — the reference's own case colours.
 *
 * A row of swatches inside the manage menu, opening with a struck-through "none" that clears the
 * choice. Without this the `ink` column existed and nothing could ever set it, so every case and
 * shelf drew with no colour at all — which is what "shelf colours are inconsistent" was.
 */
const INKS = ["#BFA8D6", "#8DC3BA", "#9DC0D6", "#E8C36A", "#D69C9C", "#A8C08D", "#C9A88D", "#9C8DC3"];

export function InkPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (ink: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", padding: "6px 10px 8px", alignItems: "center" }}>
      <button
        title={t("lib.inkNone")}
        aria-label={t("lib.inkNone")}
        aria-pressed={!value}
        onClick={() => onPick(null)}
        style={{
          position: "relative",
          width: 18,
          height: 18,
          borderRadius: 4,
          background: "var(--soft)",
          boxShadow: !value ? "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)" : "0 0 0 1px var(--brd)",
          overflow: "hidden",
        }}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            insetInline: -3,
            top: "50%",
            height: 1.5,
            background: "var(--faint)",
            transform: "rotate(-45deg)",
          }}
        />
      </button>
      {INKS.map((k) => (
        <button
          key={k}
          aria-label={k}
          aria-pressed={value === k}
          onClick={() => onPick(k)}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            background: k,
            boxShadow: value === k ? "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)" : "0 0 0 1px var(--brd)",
          }}
        />
      ))}
    </div>
  );
}

export function CaseManageMenu({
  onManage,
  onRename,
  onNewShelf,
  onNewRuleShelf,
  onMoveUp,
  onMoveDown,
  onDelete,
  onClose,
  ink,
  onInk,
}: {
  onManage: () => void;
  onRename: () => void;
  onNewShelf: () => void;
  onNewRuleShelf: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onClose: () => void;
  ink: string | null;
  onInk: (ink: string | null) => void;
}) {
  const { t } = useI18n();
  const row = (label: string, run: () => void) => (
    <button
      className="libd-hov"
      onClick={() => {
        run();
        onClose();
      }}
      style={{ ...menuItem(false), justifyContent: "flex-start" }}
    >
      {label}
    </button>
  );
  return (
    <>
      <Backdrop onClose={onClose} />
      <div style={panel(220)}>
        <div style={legend}>{t("lib.managing")}</div>
        {/* The management PANEL, from the sidebar. It used to be reachable only from a case card,
            which exists in Covers and Spines — so in Grid, Details and Vista the categories, the
            shelf grips and the move-books-out-first delete were all unreachable. The sidebar is
            present in every view, so the entry belongs here too. */}
        {row(t("lib.manage"), onManage)}
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        <div style={{ ...legend, paddingTop: 0 }}>{t("lib.colour")}</div>
        <InkPicker value={ink} onPick={onInk} />
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        {row(t("lib.shelf.rename"), onRename)}
        {row(t("lib.newShelf"), onNewShelf)}
        {row(`${t("lib.newShelf")} · ${t("lib.automatic")}`, onNewRuleShelf)}
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        {row(`↑ ${t("lib.moveCase")}`, onMoveUp)}
        {row(`↓ ${t("lib.moveCase")}`, onMoveDown)}
        <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
        <DangerRow
          label={t("lib.deleteCase")}
          confirmText={t("lib.case.deleteConfirm")}
          confirmLabel={t("lib.case.deleteYes")}
          onConfirm={() => {
            onDelete();
            onClose();
          }}
        />
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
  loose,
  onMove,
  onClear,
}: {
  selected: string[];
  byId: Map<string, BookRow>;
  cases: CaseNode[];
  loose: ShelfNode[];
  onMove: (shelfId: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!selected.length) return null;

  // EVERY hand shelf is a target, including the ones in no case. Listing only the shelves
  // inside cases left this menu empty on a library that has no cases — which is every library
  // until someone makes one, and Select's whole purpose is to move books somewhere.
  const targets: { id: string; name: string; ink: string | null }[] = [];
  for (const c of cases) {
    for (const s of c.shelves) {
      if (s.auto_rule) continue; // a rule shelf fills itself; it cannot be moved into
      targets.push({ id: s.id, name: `${c.name} · ${s.name}`, ink: s.ink ?? c.ink });
    }
  }
  for (const s of loose) {
    if (s.auto_rule) continue;
    targets.push({ id: s.id, name: s.name, ink: s.ink });
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
