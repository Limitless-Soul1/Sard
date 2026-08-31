// The design's popovers, the carry ghost, and the selection tray.
//
// SOURCE: `Sard Library - Vista (standalone).html` — these are chrome, not book presentation,
// so they come from the chrome's file. The shelf popover's contents are the design's own:
// six ordering rules, then a rule, then Rename and Delete shelf.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BookRow, CaseNode, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import type { TKey } from "../../../i18n/locales/en";
import { autoCoverPaint } from "../AutoCover";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import type { SelectionSource } from "./model";
import { openTransient } from "./transient";
import { Icon } from "../../../components/Icon";

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

/**
 * A MENU THAT DOES NOT FALL OFF THE BOTTOM OF THE WINDOW.
 *
 * `panel` opened downward and only downward. That was survivable while the only ⋯ in the sidebar
 * belonged to a case — cases sit at the top of the list — and stopped being survivable when every
 * shelf row gained one, because shelf rows run all the way to the foot of the column.
 *
 * Measured on a shelf near the bottom at 1400x900: the menu's colour swatches landed at y 872 and
 * 895, and `elementFromPoint` at each swatch's own centre returned the root rather than the swatch
 * — they were past the edge of the window. The colours were on screen in the sense that they had
 * coordinates, and unreachable in the sense that mattered.
 *
 * So the panel is measured where it wants to be and flipped above its anchor if it does not fit,
 * once, on the frame it opens. Flipping only when there is room above means a menu taller than the
 * window still opens downward and scrolls, rather than being pushed off the top instead.
 */
function useFlipUp<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [up, setUp] = useState(false);
  const [pull, setPull] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // MEASURED FROM THE ANCHOR, NOT FROM WHERE THE PANEL CURRENTLY IS.
    //
    // Reading the panel's own rect works exactly once: the moment a correction has been applied,
    // the next reading includes it, and re-measuring would correct the correction. Deriving the
    // position from the anchor and the panel's SIZE gives the same answer however many times it
    // runs — which is what lets this re-run when the panel grows, as it does when the colour
    // palette unfolds inside it.
    const place = () => {
      const anchor = el.offsetParent as HTMLElement | null;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const h = el.offsetHeight;
      const w = el.offsetWidth;
      const GAP = 6, EDGE = 8;
      const fitsDown = a.bottom + GAP + h <= window.innerHeight - EDGE;
      const fitsUp = a.top - GAP - h >= EDGE;
      setUp(!fitsDown && fitsUp);
      // The panel hangs from the anchor's inline-END, so which physical edge it grows from
      // depends on the writing direction.
      const rtl = getComputedStyle(document.documentElement).direction === "rtl";
      const left = rtl ? a.left : a.right - w;
      setPull(Math.round(Math.max(0, EDGE - left, left + w - (window.innerWidth - EDGE))));
    };
    place();
    // The panel changes size in use — the palette unfolds, a page swaps for a longer one — and a
    // menu that fitted when it opened can stop fitting without anything else happening.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  return { ref, up, pull };
}

const panel = (width: number, up = false, pull = 0): React.CSSProperties => ({
  position: "absolute",
  insetInlineEnd: -pull,
  ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
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
// The full-screen backdrop is gone. `transient.ts` now answers the outside press and Escape for
// every transient surface at once, and a per-menu overlay is exactly what stopped a click from
// reaching the NEXT menu's button. What is left is a marker the stack can measure the menu by.
function Backdrop({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => openTransient(onClose, () => ref.current?.parentElement ?? null), [onClose]);
  return <span ref={ref} hidden />;
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
        borderRadius: "var(--r-md)",
        border: "1px solid color-mix(in srgb, #c0503a 38%, var(--brd))",
        background: "color-mix(in srgb, #c0503a 8%, transparent)",
      }}
    >
      <div style={{ font: "400 .6875rem/1.45 var(--ui)", color: "var(--txt)", paddingBottom: 8 }}>
        {confirmText}
      </div>
      <div style={{ display: "flex", gap: "var(--sp-3)" }}>
        <button
          className="libd-hov"
          onClick={() => setArmed(false)}
          style={{
            flex: 1,
            height: "var(--ctl-sm)",
            borderRadius: "var(--r-md)",
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
            height: "var(--ctl-sm)",
            borderRadius: "var(--r-md)",
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

const ORDER_DEFS: { id: ShelfOrder; key: TKey }[] = [
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
  onClose: () => void;
  onInk: (ink: string | null) => void;
  /** -1 = earlier among its siblings, +1 = later. */
  onMove: (direction: number) => void;
}) {
  const { t } = useI18n();
  const flip = useFlipUp<HTMLDivElement>();
  /**
   * ONE MENU, THREE PAGES — the two settings that have a CURRENT VALUE open onto their own list.
   *
   * WHAT THIS REPLACED, and why. The menu was one column holding, in order: the legend «ترتيب هذا
   * الرفّ» followed by all six order rules as six sibling rows; the colour swatches; a «تحريك هذا
   * الرفّ» pair of arrows; the legend «الخزانة» followed by every case in the library as more
   * sibling rows; «فئة جديدة»; «إعادة تسمية»; and delete. Twenty-odd rows, most of them values
   * rather than actions, and nothing saying which of the six orders or which of the cases was the
   * one in force — the ✓ was there, but you had to read the whole list to find it.
   *
   * A setting with a current value is ONE row that states it and opens onto the choices. That is
   * what makes the menu short enough to read: the root is now six rows, and each says either what
   * it will do or what it currently is.
   *
   * The pages live inside this panel rather than in a nested popover. A popover hanging off a
   * popover has to be positioned against the window all over again — and this panel already has
   * to flip above its anchor near the foot of the sidebar, which is where shelf rows mostly are.
   *
   * «فئة جديدة» IS GONE, and nothing replaced it. It called `categoryCreate` with the literal
   * name «فئة جديدة» — a category made with no name asked, from a menu that is not about
   * categories. Categories have a home: `CaseEditor` creates them WITH a typed name, renames them
   * and deletes them, and is one press away through the case's own ⋯ → «إدارة». Removing the
   * duplicate takes no capability away; it takes away the only route that made an unnamed one.
   */
  const [page, setPage] = useState<"root" | "order" | "case">("root");
  /**
   * THE PALETTE IS FOLDED AWAY UNTIL IT IS WANTED.
   *
   * Nine swatches shown at all times took about a third of the menu's height to answer a question
   * most openings of it are not about. Collapsed, the row states the colour the shelf HAS — which
   * is the thing worth seeing every time — and opens the palette in place when that is the thing
   * being changed. In place rather than on a page of its own: a colour is chosen by eye against
   * the others, and a page would take the row's own swatch off screen at the moment of comparing.
   */
  const [palette, setPalette] = useState(false);
  const orderNow = ORDER_DEFS.find((o) => o.id === shelf.order_rule) ?? ORDER_DEFS[0];
  const caseNow = shelf.case_id ? cases.find((k) => k.id === shelf.case_id) : null;

  /** A row that states a setting's current value and opens onto the choices. */
  const settingRow = (label: string, value: string, to: "order" | "case") => (
    <button
      className="libd-menu-item"
      onClick={() => setPage(to)}
      style={{ ...menuItem(false), justifyContent: "space-between", gap: "var(--sp-4)" }}
    >
      <span style={{ flex: "none" }}>{label}</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          minWidth: 0,
          overflow: "hidden",
          color: "var(--mut)",
          font: "500 .75rem var(--ui)",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
        {/* Points the way the reader's writing goes, so "onward" is onward in both directions. */}
        <span aria-hidden style={{ display: "flex", color: "var(--faint)" }}>
          <Icon name="caretDown" size="sm" />
        </span>
      </span>
    </button>
  );

  const backRow = (title: string) => (
    <button
      className="libd-menu-item"
      onClick={() => setPage("root")}
      style={{ ...menuItem(false), justifyContent: "flex-start", gap: "var(--sp-3)" }}
    >
      <span aria-hidden style={{ display: "flex", color: "var(--faint)", transform: "rotate(90deg)" }}>
        <Icon name="caretDown" size="sm" />
      </span>
      <span style={{ font: "600 .75rem var(--ui)" }}>{title}</span>
    </button>
  );

  const chosen = (on: boolean) => (
    <span style={{ color: "var(--acc)", fontSize: 11 }}>{on ? "✓" : ""}</span>
  );

  return (
    <>
      <Backdrop onClose={onClose} />
      <div ref={flip.ref} style={panel(226, flip.up, flip.pull)}>
        {page === "root" && (
          <>
            <div style={legend}>{t("lib.manageShelf")}</div>

            <button
              className="libd-menu-item"
              aria-expanded={palette}
              onClick={() => setPalette((v) => !v)}
              style={{ ...menuItem(false), justifyContent: "space-between", gap: "var(--sp-4)" }}
            >
              <span style={{ flex: "none" }}>{t("lib.menu.shelfColour")}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-3)", flex: "none" }}>
                {/* The colour the shelf HAS, at the size the sidebar draws it, with the same
                    hairline — so the row is a preview of the row it describes. No colour shows
                    the ruled-through swatch `InkPicker` itself uses for «no colour». */}
                <span
                  aria-hidden
                  style={{
                    position: "relative",
                    width: "var(--icon-sm)",
                    height: "var(--icon-sm)",
                    borderRadius: "var(--r-xs)",
                    background: shelf.ink ?? "var(--soft)",
                    boxShadow: shelf.ink ? "0 0 0 1px var(--brd)" : "0 0 0 1px var(--brd)",
                    overflow: "hidden",
                  }}
                >
                  {!shelf.ink && (
                    <span
                      style={{
                        position: "absolute",
                        insetInline: -3,
                        top: "50%",
                        height: 1.5,
                        background: "var(--faint)",
                        transform: "rotate(-45deg)",
                      }}
                    />
                  )}
                </span>
                <span
                  aria-hidden
                  style={{
                    display: "flex",
                    color: "var(--faint)",
                    transform: palette ? "rotate(180deg)" : "none",
                    transition: "transform .16s ease-out",
                  }}
                >
                  <Icon name="caretDown" size="sm" />
                </span>
              </span>
            </button>
            {/* `InkPicker` carries a menu's own 10px sides. Nine 18px swatches with 5px between
                them need 202px, and the panel's inner width is 214 — six pixels short once that
                padding is counted twice. Pulling it back puts all nine on one line instead of
                leaving the ninth stranded on a second. */}
            {palette && (
              <div style={{ margin: "0 -6px" }}>
                <InkPicker value={shelf.ink} onPick={onInk} />
              </div>
            )}

            <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
            <div style={{ ...legend, paddingTop: 0 }}>{t("lib.menu.organisation")}</div>
            {settingRow(t("lib.menu.bookOrder"), t(orderNow.key), "order")}
            {settingRow(t("lib.caseWord"), caseNow ? caseNow.name : t("lib.unfiled"), "case")}

            {/* ---- WHERE THE SHELF SITS AMONG ITS SIBLINGS.
                    It said «تحريك هذا الرفّ» — "move this shelf" — beside two arrows, which is
                    true and says nothing: moved where, and among what? A shelf can only move up
                    or down among the shelves it shares a parent with, and the row now says so.
                    It is kept because it is the ONLY way to reorder shelves from here: dragging
                    one exists in the management panel and nowhere else. */}
            <div style={{ ...menuItem(false), justifyContent: "space-between", gap: "var(--sp-4)", cursor: "default" }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {caseNow ? t("lib.menu.positionIn", { name: caseNow.name }) : t("lib.menu.positionLoose")}
              </span>
              <span style={{ display: "inline-flex", gap: "var(--sp-2)", flex: "none" }}>
                <button
                  className="libd-menu-item"
                  title={t("lib.menu.earlier")}
                  aria-label={t("lib.menu.earlier")}
                  onClick={() => { onMove(-1); onClose(); }}
                  style={{ width: "var(--ctl-xs)", height: "var(--ctl-xs)", borderRadius: "var(--r-sm)", justifyContent: "center" }}
                >
                  ↑
                </button>
                <button
                  className="libd-menu-item"
                  title={t("lib.menu.later")}
                  aria-label={t("lib.menu.later")}
                  onClick={() => { onMove(1); onClose(); }}
                  style={{ width: "var(--ctl-xs)", height: "var(--ctl-xs)", borderRadius: "var(--r-sm)", justifyContent: "center" }}
                >
                  ↓
                </button>
              </span>
            </div>

            <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
            <button
              className="libd-menu-item"
              onClick={() => { onRename(); onClose(); }}
              style={{ ...menuItem(false), justifyContent: "flex-start" }}
            >
              {t("lib.shelf.rename")}
            </button>
            <DangerRow
              label={t("lib.shelf.delete")}
              confirmText={t("lib.shelf.deleteConfirm")}
              confirmLabel={t("lib.shelf.deleteYes")}
              onConfirm={() => { onDelete(); onClose(); }}
            />
          </>
        )}

        {/* ---- ONE SETTING, SIX VALUES.
                «يدويّ» is not a seventh sort — it is the shelf saying "leave my order alone",
                and the arrangement the reader made waits underneath whichever rule is chosen.
                That distinction is already in the model: `sectionBooks` sorts by `order_rule`
                and only falls through to the saved `view_orders` run when the rule is `hand`. */}
        {page === "order" && (
          <>
            {backRow(t("lib.menu.bookOrder"))}
            <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
            {ORDER_DEFS.map((o) => (
              <button
                key={o.id}
                className="libd-menu-item"
                onClick={() => { onOrder(o.id); onClose(); }}
                style={menuItem(shelf.order_rule === o.id)}
              >
                <span>{t(o.key)}</span>
                {chosen(shelf.order_rule === o.id)}
              </button>
            ))}
            <div style={{ ...legend, paddingTop: 6, letterSpacing: "normal", textTransform: "none", lineHeight: 1.5 }}>
              {t("lib.menu.byHandNote")}
            </div>
          </>
        )}

        {/* ---- WHICH CASE HOLDS THIS SHELF. `shelf_set_case` has always existed; before it was
                reachable here, a shelf made inside a case could never leave it. */}
        {page === "case" && (
          <>
            {backRow(t("lib.caseWord"))}
            <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
            <button
              className="libd-menu-item"
              onClick={() => { onSetCase(null); onClose(); }}
              style={menuItem(!shelf.case_id)}
            >
              <span>{t("lib.unfiled")}</span>
              {chosen(!shelf.case_id)}
            </button>
            {cases.map((cs) => (
              <button
                key={cs.id}
                className="libd-menu-item"
                onClick={() => { onSetCase(cs.id); onClose(); }}
                style={menuItem(shelf.case_id === cs.id)}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--sp-4)",
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
                {chosen(shelf.case_id === cs.id)}
              </button>
            ))}
          </>
        )}
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
  const flip = useFlipUp<HTMLDivElement>();
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
      <div ref={flip.ref} style={panel(220, flip.up, flip.pull)}>
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
        borderRadius: "var(--r-xs)",
        boxShadow: "var(--sh3)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-4)",
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
  source,
  shelfName,
  onMove,
  onClear,
}: {
  selected: string[];
  byId: Map<string, BookRow>;
  cases: CaseNode[];
  loose: ShelfNode[];
  /** Which shelf this move should take the books OUT of, and whether that is even knowable. */
  source: SelectionSource;
  /** Names the shelves in `source.shelves`, for the "out of which?" question. */
  shelfName: (id: string) => string;
  onMove: (shelfId: string, categoryId: string | null, removeFrom: string | null) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // When the selection spans several shelves, the move waits here until the reader says which
  // one it is leaving — or says to leave none.
  const [pendingTarget, setPendingTarget] = useState<{ shelfId: string; categoryId: string | null } | null>(null);
  if (!selected.length) return null;

  const close = () => {
    setOpen(false);
    setPendingTarget(null);
  };

  // EVERY hand shelf is a target, including the ones in no case. Listing only the shelves
  // inside cases left this menu empty on a library that has no cases — which is every library
  // until someone makes one, and Select's whole purpose is to move books somewhere.
  //
  // A shelf's CATEGORIES are targets in their own right, so "move these into Category Y" is one
  // action rather than a move followed by a second pass in the management panel.
  type Target = { key: string; shelfId: string; categoryId: string | null; name: string; ink: string | null; sub: boolean };
  const targets: Target[] = [];
  const addShelf = (s: ShelfNode, prefix: string, ink: string | null) => {
    if (s.auto_rule) return; // a rule shelf fills itself; it cannot be moved into
    targets.push({ key: s.id, shelfId: s.id, categoryId: null, name: prefix + s.name, ink, sub: false });
    for (const k of s.categories) {
      targets.push({ key: `${s.id}::${k.id}`, shelfId: s.id, categoryId: k.id, name: k.name, ink, sub: true });
    }
  };
  for (const c of cases) for (const s of c.shelves) addShelf(s, `${c.name} · `, s.ink ?? c.ink);
  for (const s of loose) addShelf(s, "", s.ink);

  /** Decide what to do with a chosen destination, given how well the source is known. */
  const choose = (target: Target) => {
    if (source.kind === "ambiguous") {
      // DO NOT GUESS. Two shelves' worth of books were selected; stripping "the other one" is
      // how a deliberate second placement gets destroyed. Ask instead.
      setPendingTarget({ shelfId: target.shelfId, categoryId: target.categoryId });
      return;
    }
    onMove(target.shelfId, target.categoryId, source.shelfId);
    close();
  };

  const panel: React.CSSProperties = {
    position: "absolute",
    bottom: "calc(100% + 8px)",
    insetInlineEnd: 0,
    zIndex: 60,
    width: 268,
    maxHeight: 300,
    overflowY: "auto",
    background: "var(--chr)",
    border: "1px solid var(--brd)",
    borderRadius: 12,
    boxShadow: "var(--sh4)",
    padding: 6,
    animation: "sard-rise .12s ease-out",
  };

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
                  width: "var(--icon-sm)",
                  height: "var(--icon-lg)",
                  borderRadius: 2,
                  background: paint?.bg ?? "var(--lbox)",
                  boxShadow: "var(--sh1)",
                }}
              />
            );
          })}
        </div>
        <div style={{ width: 1, height: "var(--ctl-xs)", background: "var(--brd)" }} />
        <div style={{ position: "relative" }}>
          <button
            onClick={() => (open ? close() : setOpen(true))}
            style={{
              height: "var(--ctl-md)",
              padding: "0 13px",
              borderRadius: "var(--r-md)",
              background: "var(--acc)",
              color: "var(--pap)",
              font: "600 .75rem var(--ui)",
            }}
          >
            {t("lib.moveTo")}
          </button>
          {open && (
            <>
              <Backdrop onClose={close} />
              {pendingTarget ? (
                // THE AMBIGUOUS CASE, asked rather than assumed. The books came from more than one
                // shelf, so the reader names the one they are leaving — or chooses to leave none,
                // which is an honest "add" and is labelled as one.
                <div style={panel}>
                  <div style={{ ...legend, textTransform: "none", letterSpacing: 0, lineHeight: 1.45 }}>
                    {t("lib.moveOutOfWhich", { n: String(source.shelves.length) })}
                  </div>
                  {source.shelves.map((id) => (
                    <button
                      key={id}
                      className="libd-hov"
                      onClick={() => {
                        onMove(pendingTarget.shelfId, pendingTarget.categoryId, id);
                        close();
                      }}
                      style={{ ...menuItem(false), justifyContent: "flex-start" }}
                    >
                      {shelfName(id)}
                    </button>
                  ))}
                  <div style={{ height: 1, background: "var(--brd)", margin: "5px 4px" }} />
                  <button
                    className="libd-hov"
                    onClick={() => {
                      onMove(pendingTarget.shelfId, pendingTarget.categoryId, null);
                      close();
                    }}
                    style={{ ...menuItem(false), justifyContent: "flex-start", color: "var(--mut)" }}
                  >
                    {t("lib.keepWhereTheyAre")}
                  </button>
                </div>
              ) : (
                <div style={panel}>
                  {source.shelfId && (
                    <div style={{ ...legend, textTransform: "none", letterSpacing: 0, lineHeight: 1.45 }}>
                      {t("lib.movingOutOf", { name: shelfName(source.shelfId) })}
                    </div>
                  )}
                  {targets.map((m) => (
                    <button
                      key={m.key}
                      className="libd-hov"
                      onClick={() => choose(m)}
                      style={{
                        ...menuItem(false),
                        justifyContent: "flex-start",
                        ...(m.sub ? { paddingInlineStart: 26 } : {}),
                      }}
                    >
                      <span
                        style={{
                          width: m.sub ? 5 : 8,
                          height: m.sub ? 5 : 8,
                          borderRadius: m.sub ? "50%" : 2,
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
              )}
            </>
          )}
        </div>
        <button
          className="libd-hov libd-hov-txt"
          onClick={onClear}
          style={{
            height: "var(--ctl-md)",
            padding: "0 12px",
            borderRadius: "var(--r-md)",
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
