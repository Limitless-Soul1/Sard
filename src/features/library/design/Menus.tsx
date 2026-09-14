// The design's popovers, the carry ghost, and the selection tray.
//
// SOURCE: `Sard Library - Vista (standalone).html` — these are chrome, not book presentation,
// so they come from the chrome's file. The shelf popover's contents are the design's own:
// six ordering rules, then a rule, then Rename and Delete shelf.

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BookRow, CaseNode, ShelfNode, ShelfOrder } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import type { TKey } from "../../../i18n/locales/en";
import { autoCoverPaint } from "../AutoCover";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { localeNum } from "../../../lib/format";
import type { SelectionSource } from "./model";
import { openTransient } from "./transient";
import { overlayHost } from "./overlay";
import { Icon } from "../../../components/Icon";

/**
 * THE DESIGN'S MENU ROW — ITS SHAPE, AND NOTHING IT IS WEARING.
 *
 * It used to return `background` and `color` too, and that is why none of these menus answered a
 * pointer: an inline declaration outranks every selector, so `.libd-menu-item:hover` — which has
 * existed all along — was overruled before it could paint. Measured in the running library: rest,
 * hover and held were one identical colour on every row of both menus.
 *
 * Ground, ink and edge now live in the stylesheet, where a hover, a press and a keyboard focus can
 * reach them. What stays here is layout, which no state changes. The chosen value on a page of
 * choices is said with `is-on` rather than with a colour written in by hand.
 *
 * The comfortable height a finger needs is a `min-height` on `.libd-menu-item` rather than more
 * padding here: this helper is shared with surfaces outside these two menus, and they should not
 * move because a menu wanted a bigger target.
 */
export const menuItem = (): React.CSSProperties => ({
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 9,
  justifyContent: "space-between",
  padding: "7px 10px",
  borderRadius: 8,
  font: "500 .8125rem var(--ui)",
  textAlign: "start",
});

/** `is-on` says which value a page of choices is currently at. */
const rowClass = (on = false) => `libd-menu-item${on ? " is-on" : ""}`;

/** The nearest ancestor that scrolls — what an anchored surface has to ride with, or let go of. */
function nearestScroller(from: Element | null): HTMLElement | null {
  let n = from?.parentElement ?? null;
  while (n && n !== document.documentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
    n = n.parentElement;
  }
  return null;
}

/**
 * A MENU THAT IS NOT CUT IN HALF BY THE COLUMN IT OPENED FROM.
 *
 * It used to be drawn where it was declared — `position: absolute` inside the ⋯ button's own
 * wrapper — and flipped above the trigger when it would not fit below. The flip worked. It was
 * also beside the point, because the thing cutting the menu was never the window.
 *
 * MEASURED, at 860x640, on a shelf near the foot of the sidebar: the panel sat at top 15, bottom
 * 329, and the sidebar's shelf list — a `div` with `overflow: auto` — ran from 270 to 518. The menu
 * was therefore CLIPPED BY 255px AT ITS TOP by an ancestor that scrolls. Everything above «إعادة
 * تسمية» was drawn into a region the browser then threw away: `elementFromPoint` at the centre of
 * «لون الرفّ», «ترتيب الكتب» and «الخزانة» returned a shelf row each time, because what the reader
 * could see at those coordinates WAS a shelf row. The rows had coordinates and no pixels.
 *
 * A z-index cannot answer that. Paint order decides what covers what; `overflow` decides what
 * EXISTS, and an `overflow: auto` ancestor removes its descendants outside its padding box no
 * matter what they are ranked. The only way out is to stop being its descendant.
 *
 * So the panel is portalled into the library's overlay host — the element this shell already keeps
 * for exactly this, inside `.libd-root` so every design token still resolves, and outside every
 * column that scrolls. It is then positioned in VIEWPORT coordinates against the trigger's own
 * rectangle, which is what `position: fixed` reads and what the trigger reports wherever it is.
 * The flip survives, the cap survives, and the clipping cannot.
 */
function useAnchoredMenu(width: number, onClose: () => void) {
  /** The panel itself, in the overlay host. */
  const ref = useRef<HTMLDivElement | null>(null);
  /** A marker left WHERE THE TRIGGER IS, so the panel can still find what it belongs to. */
  const mark = useRef<HTMLSpanElement | null>(null);
  // Hidden until it has been measured, so it is never seen in the corner on its way to its trigger.
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const place = useCallback(() => {
    const el = ref.current;
    const anchor = mark.current?.parentElement;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const GAP = 6, EDGE = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    // The natural height, read before any cap is applied to it.
    const want = el.scrollHeight;
    const below = vh - a.bottom - GAP - EDGE;
    const above = a.top - GAP - EDGE;
    const up = below < Math.min(want, 160) && above > below;
    // Never taller than the side it opened on: a menu that runs past the window edge is a menu with
    // rows nobody can reach, and the row it loses first is the last one.
    const room = Math.max(140, Math.round(up ? above : below));
    const h = Math.min(want, room);
    const top = up
      ? Math.max(EDGE, a.top - GAP - h)
      : Math.min(a.bottom + GAP, vh - EDGE - h);
    // IT HANGS FROM THE TRIGGER'S INLINE-END, whichever physical edge that is here. Read, not
    // assumed: the library runs right-to-left by default, and this menu is drawn on both sides.
    const rtl = getComputedStyle(document.documentElement).direction === "rtl";
    const left = rtl ? a.left : a.right - width;
    setStyle({
      position: "fixed",
      top: Math.round(Math.max(EDGE, top)),
      left: Math.round(Math.max(EDGE, Math.min(left, vw - width - EDGE))),
      maxHeight: room,
      overflowY: "auto",
      visibility: "visible",
    });
  }, [width]);

  useLayoutEffect(() => {
    place();
    // The panel changes size in use — the palette unfolds, a page swaps for a longer one — and a
    // menu that fitted when it opened can stop fitting without anything else happening.
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [place]);

  /**
   * IT NO LONGER MOVES WITH THE SIDEBAR, because it is no longer inside it — so it is told when the
   * sidebar moves. And when the row it belongs to scrolls out of that column there is nothing left
   * to hang from, so the menu goes too rather than floating over the library unattached.
   */
  useEffect(() => {
    const again = () => {
      const anchor = mark.current?.parentElement;
      const sc = anchor ? nearestScroller(anchor) : null;
      if (anchor && sc) {
        const a = anchor.getBoundingClientRect(), r = sc.getBoundingClientRect();
        if (a.bottom < r.top + 2 || a.top > r.bottom - 2) { onClose(); return; }
      }
      place();
    };
    window.addEventListener("resize", again);
    document.addEventListener("scroll", again, true);
    return () => {
      window.removeEventListener("resize", again);
      document.removeEventListener("scroll", again, true);
    };
  }, [place, onClose]);

  return { ref, mark, style };
}

/** How the menu LOOKS. Where it goes is `useAnchoredMenu`'s answer, and arrives as a second style. */
const panel = (width: number): React.CSSProperties => ({
  position: "fixed",
  top: 0,
  left: 0,
  zIndex: 60,
  width,
  background: "var(--chr)",
  border: "1px solid var(--brd)",
  borderRadius: 12,
  boxShadow: "var(--sh4)",
  padding: 6,
  animation: "sard-rise .12s ease-out",
});

/**
 * A SECTION LABEL, QUIET — and no longer in tracked capitals.
 *
 * Arabic has no capitals, and `letter-spacing` severs its cursive joins: «التنظيم» and «اللون»
 * were being drawn as loose disconnected letters, in the language this library is built for. The
 * project already knows this — `.libd-place-cat` marks a category with a rule for exactly this
 * reason — so the styling moves to `.libd-menu-legend`, which says the same thing in a way both
 * scripts can read.
 */
const Legend = ({ children }: { children: React.ReactNode }) => (
  <div className="libd-menu-legend">{children}</div>
);

/** A rule between groups. Used where a group ends, not between every row. */
const Rule = () => <div className="libd-menu-rule" />;

/** Click-away, shared by every popover here. */
// The full-screen backdrop is gone. `transient.ts` now answers the outside press and Escape for
// every transient surface at once, and a per-menu overlay is exactly what stopped a click from
// reaching the NEXT menu's button. What is left is a marker the stack can measure the menu by.
function Backdrop({ onClose, surface }: { onClose: () => void; surface?: () => Element | null }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // WHAT COUNTS AS "INSIDE" MOVED WITH THE PANEL. The stack decides an outside press by asking the
  // surface for its own element, and this used to hand it the trigger's wrapper — which contained
  // the menu, until the menu was portalled out of the sidebar. Without `surface`, every press ON a
  // menu row would now read as a press outside it and shut the menu before the row could act.
  useEffect(
    () => openTransient(onClose, () => surface?.() ?? ref.current?.parentElement ?? null),
    [onClose, surface],
  );
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
        style={{ ...menuItem(), justifyContent: "flex-start", color: "#c0503a" }}
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
  const menu = useAnchoredMenu(226, onClose);
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

  /**
   * A row that states a setting's current value and opens onto the choices.
   *
   * «ترتيب الكتب    يدويّ» read as two words sharing a line, because that is all it was: a label
   * and a value in the same ink, at the same weight, with air between them. The value and its
   * caret now share a quiet ground, so the pair is visibly ONE thing that opens — and the ground
   * lifts with the row, so the target is still the whole row and not the pill.
   */
  const settingRow = (label: string, value: string, to: "order" | "case") => (
    <button
      className="libd-menu-item"
      aria-haspopup="true"
      onClick={() => setPage(to)}
      style={{ ...menuItem(), justifyContent: "space-between", gap: "var(--sp-3)" }}
    >
      <span style={{ flex: "none" }}>{label}</span>
      <span className="libd-menu-val">
        <span>{value}</span>
        {/* Points the way the reader's writing goes, so "onward" is onward in both directions. */}
        <span aria-hidden style={{ display: "flex" }}>
          <Icon name="caretDown" size="sm" />
        </span>
      </span>
    </button>
  );

  const backRow = (title: string) => (
    <button
      className="libd-menu-item"
      onClick={() => setPage("root")}
      style={{ ...menuItem(), justifyContent: "flex-start", gap: "var(--sp-3)" }}
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
      {/* The marker stays where the trigger is; the panel is drawn in the overlay host. */}
      <span ref={menu.mark} hidden />
      <Backdrop onClose={onClose} surface={() => menu.ref.current} />
      {createPortal(
      <div ref={menu.ref} className="libd-quietscroll" style={{ ...panel(226), ...menu.style }}>
        {page === "root" && (
          <>
            <Legend>{t("lib.manageShelf")}</Legend>

            <button
              className="libd-menu-item"
              aria-expanded={palette}
              onClick={() => setPalette((v) => !v)}
              style={{ ...menuItem(), justifyContent: "space-between", gap: "var(--sp-3)" }}
            >
              <span style={{ flex: "none" }}>{t("lib.menu.shelfColour")}</span>
              {/* THE SAME GRAMMAR AS A SETTING ROW, because it is one: a label, the value it is
                  currently at, and a mark saying it opens. The value here is the colour itself. */}
              <span className="libd-menu-val" style={{ flex: "none" }}>
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

            <Rule />
            <Legend>{t("lib.menu.organisation")}</Legend>
            {settingRow(t("lib.menu.bookOrder"), t(orderNow.key), "order")}
            {settingRow(t("lib.caseWord"), caseNow ? caseNow.name : t("lib.unfiled"), "case")}

            {/* ---- WHERE THE SHELF SITS AMONG ITS SIBLINGS.
                    It said «تحريك هذا الرفّ» — "move this shelf" — beside two arrows, which is
                    true and says nothing: moved where, and among what? A shelf can only move up
                    or down among the shelves it shares a parent with, and the row now says so.
                    It is kept because it is the ONLY way to reorder shelves from here: dragging
                    one exists in the management panel and nowhere else. */}
            {/* THE ROW SAYS WHERE IT SITS; THE TWO STEPPERS MOVE IT. Kept apart deliberately: the
                words cannot be pressed, so they must not answer the pointer, and the things that
                can be pressed must. The arrows were bare glyphs at 22px — below any reasonable
                finger, and drawn in a typeface rather than in the icon set the rest of the menu
                uses. They are now the library's own carets at 28px. */}
            <div className="libd-menu-static" style={{ ...menuItem(), justifyContent: "space-between", gap: "var(--sp-3)" }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {caseNow ? t("lib.menu.positionIn", { name: caseNow.name }) : t("lib.menu.positionLoose")}
              </span>
              <span style={{ display: "inline-flex", gap: 2, flex: "none" }}>
                <button
                  className="libd-menu-step"
                  title={t("lib.menu.earlier")}
                  aria-label={t("lib.menu.earlier")}
                  onClick={() => { onMove(-1); onClose(); }}
                >
                  <Icon name="caretUp" size="sm" />
                </button>
                <button
                  className="libd-menu-step"
                  title={t("lib.menu.later")}
                  aria-label={t("lib.menu.later")}
                  onClick={() => { onMove(1); onClose(); }}
                >
                  <Icon name="caretDown" size="sm" />
                </button>
              </span>
            </div>

            <Rule />
            <button
              className="libd-menu-item"
              onClick={() => { onRename(); onClose(); }}
              style={{ ...menuItem(), justifyContent: "flex-start" }}
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
            <Rule />
            {ORDER_DEFS.map((o) => (
              <button
                key={o.id}
                className={rowClass(shelf.order_rule === o.id)}
                onClick={() => { onOrder(o.id); onClose(); }}
                style={menuItem()}
              >
                <span>{t(o.key)}</span>
                {chosen(shelf.order_rule === o.id)}
              </button>
            ))}
            <div className="libd-menu-legend" style={{ lineHeight: 1.5, fontWeight: 500 }}>
              {t("lib.menu.byHandNote")}
            </div>
          </>
        )}

        {/* ---- WHICH CASE HOLDS THIS SHELF. `shelf_set_case` has always existed; before it was
                reachable here, a shelf made inside a case could never leave it. */}
        {page === "case" && (
          <>
            {backRow(t("lib.caseWord"))}
            <Rule />
            <button
              className={rowClass(!shelf.case_id)}
              onClick={() => { onSetCase(null); onClose(); }}
              style={menuItem()}
            >
              <span>{t("lib.unfiled")}</span>
              {chosen(!shelf.case_id)}
            </button>
            {cases.map((cs) => (
              <button
                key={cs.id}
                className={rowClass(shelf.case_id === cs.id)}
                onClick={() => { onSetCase(cs.id); onClose(); }}
                style={menuItem()}
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
      </div>,
      overlayHost(menu.mark.current),
      )}
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

/**
 * A TYPED COLOUR, READ STRICTLY AND NORMALISED ONCE.
 *
 * `#RRGGBB` is what the column stores and what every swatch above is written as, so that is what
 * this returns — from `#A45B32`, from `a45b32`, and from the three-digit shorthand a reader is as
 * likely to type as not. Anything else is `null`, and a caller that gets `null` writes NOTHING:
 * a half-typed value must never reach the shelf, which is the difference between a field that
 * validates and a field that corrupts.
 */
export function inkFromText(raw: string): string | null {
  const t = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(t)) {
    return ("#" + t[0] + t[0] + t[1] + t[1] + t[2] + t[2]).toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(t)) return ("#" + t).toUpperCase();
  return null;
}

export function InkPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (ink: string | null) => void;
}) {
  const { t } = useI18n();
  /**
   * WHAT THE FIELD IS SHOWING WHILE IT IS BEING TYPED IN.
   *
   * Kept apart from the stored colour on purpose: «#A4» is a state the field must be able to be in
   * and the shelf must not. The stored value is written only when the text parses, and the field is
   * put back to the stored value when it is left — so an abandoned or invalid edit is forgotten
   * rather than committed, and reopening the menu always shows the colour the shelf actually has.
   */
  const custom = value && !INKS.includes(value) ? value : null;
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? custom ?? "";
  const parsed = inkFromText(text);
  const bad = text.trim().length > 0 && !parsed;
  const commit = () => {
    const hex = inkFromText(text);
    if (hex) onPick(hex);
    setDraft(null);
  };
  return (
    <div>
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", padding: "6px 10px 8px", alignItems: "center" }}>
      {/* THE SWATCHES ANSWER THE POINTER AND THE KEYBOARD TOO.
          They carried no class at all, so a reader tabbing into the cabinet menu — where this row
          is always open — landed on the browser's own 1px ring, measured as `1px auto`, and moving
          over a colour did nothing. They are the one control here that is already a colour, so the
          hover is the brightness lift the library uses for coloured things rather than a ground. */}
      <button
        className="libd-ink-swatch"
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
          className="libd-ink-swatch"
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
      {/* THE COLOUR THE READER TYPED, shown among the ones Sard offers rather than somewhere else —
          it is the same kind of thing, so it stands in the same row and is chosen the same way. */}
      {custom && (
        <button
          className="libd-ink-swatch"
          aria-label={custom}
          aria-pressed
          title={custom}
          onClick={() => onPick(custom)}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            background: custom,
            boxShadow: "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)",
          }}
        />
      )}
    </div>
    {/* A HEX, TYPED — NOT THE PLATFORM'S COLOUR DIALOG.
        `<input type="color">` would have been one line and would have left Sard entirely, which is
        the defect `InkCustom` exists to have fixed everywhere else. `InkCustom` itself is the
        Reader's answer and is the wrong size for this surface: its panel is at least 15rem against
        a menu 220px wide, and it would be a floating layer inside a floating layer. The field is
        the same idea at this menu's scale — and it commits on Enter or on leaving, so a reader who
        types four characters and looks away has changed nothing. */}
    <div className="libd-ink-hex">
      <span aria-hidden className="libd-ink-hex-dot" style={{ background: parsed ?? "transparent" }} />
      <input
        className={`libd-ink-hex-field${bad ? " is-bad" : ""}`}
        value={text}
        spellCheck={false}
        inputMode="text"
        dir="ltr"
        aria-label={t("lib.inkHex")}
        aria-invalid={bad || undefined}
        placeholder="#A45B32"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          // Escape belongs to the menu, but an edit in progress is the nearer thing to abandon.
          else if (e.key === "Escape" && draft !== null) { e.stopPropagation(); setDraft(null); }
        }}
        onBlur={commit}
      />
    </div>
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
  const menu = useAnchoredMenu(220, onClose);
  /**
   * THE SAME CONTROL THE SHELF HAS, for the same setting.
   *
   * The cabinet laid its palette out permanently, under a «اللون» heading: nine swatches always
   * open in a menu of seven rows, so the loudest thing in it was a setting nobody had asked to
   * change, and the same concept was presented two different ways a few rows apart. It is a value
   * with a current state and a chooser behind it — which is exactly what the shelf's «لون الرفّ»
   * row already says — so it says it the same way, and the palette arrives when it is asked for.
   */
  const [palette, setPalette] = useState(false);
  /**
   * `.libd-hov` was the wrong class here and would not have worked anyway: it supplies a hover
   * ground and nothing else — no press, no keyboard — and at (0,2,0) it loses to the chrome's own
   * button reset, which is the omission its own comment in the stylesheet records. The rows of the
   * two menus are the same kind of thing, so they now wear the same class.
   */
  const row = (label: string, run: () => void) => (
    <button
      className="libd-menu-item"
      onClick={() => {
        run();
        onClose();
      }}
      style={{ ...menuItem(), justifyContent: "flex-start" }}
    >
      {label}
    </button>
  );
  return (
    <>
      <span ref={menu.mark} hidden />
      <Backdrop onClose={onClose} surface={() => menu.ref.current} />
      {createPortal(
      <div ref={menu.ref} className="libd-quietscroll" style={{ ...panel(220), ...menu.style }}>
        <Legend>{t("lib.managing")}</Legend>
        {/* The management PANEL, from the sidebar. It used to be reachable only from a case card,
            which exists in Covers and Spines — so in Grid, Details and Vista the categories, the
            shelf grips and the move-books-out-first delete were all unreachable. The sidebar is
            present in every view, so the entry belongs here too. */}
        {row(t("lib.manage"), onManage)}
        <Rule />
        <button
          className="libd-menu-item"
          aria-expanded={palette}
          onClick={() => setPalette((v) => !v)}
          style={{ ...menuItem(), justifyContent: "space-between", gap: "var(--sp-3)" }}
        >
          <span style={{ flex: "none" }}>{t("lib.menu.caseColour")}</span>
          <span className="libd-menu-val" style={{ flex: "none" }}>
            <span
              aria-hidden
              style={{
                position: "relative",
                width: "var(--icon-sm)",
                height: "var(--icon-sm)",
                borderRadius: "var(--r-xs)",
                background: ink ?? "var(--soft)",
                boxShadow: "0 0 0 1px var(--brd)",
                overflow: "hidden",
              }}
            >
              {!ink && (
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
                transform: palette ? "rotate(180deg)" : "none",
                transition: "transform .16s ease-out",
              }}
            >
              <Icon name="caretDown" size="sm" />
            </span>
          </span>
        </button>
        {palette && (
          <div style={{ margin: "0 -6px" }}>
            <InkPicker value={ink} onPick={onInk} />
          </div>
        )}
        <Rule />
        {row(t("lib.shelf.rename"), onRename)}
        {row(t("lib.newShelf"), onNewShelf)}
        {row(`${t("lib.newShelf")} · ${t("lib.automatic")}`, onNewRuleShelf)}
        <Rule />
        {/* WHERE THIS CABINET SITS AMONG THE OTHERS.
            It was two rows carrying the SAME words — «تحريك هذه الخزانة», twice — told apart only
            by a bare ↑ or ↓ glyph at the head of the label. Two identical labels in a column is the
            one thing a menu cannot afford: it has to be read twice to be scanned once, and the
            arrow doing all the work was a typeface character rather than the icon set the rest of
            the menu uses.

            The shelf menu already had the answer for exactly this question, so the cabinet borrows
            it rather than inventing a second one: the row STATES the position and two steppers
            change it. Both actions survive unchanged — `onMoveUp` and `onMoveDown` are the same
            calls, on the same cabinet, in the same order. */}
        <div className="libd-menu-static" style={{ ...menuItem(), justifyContent: "space-between", gap: "var(--sp-3)" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("lib.moveCase")}
          </span>
          <span style={{ display: "inline-flex", gap: 2, flex: "none" }}>
            <button
              className="libd-menu-step"
              title={t("lib.menu.earlier")}
              aria-label={t("lib.menu.earlier")}
              onClick={() => { onMoveUp(); onClose(); }}
            >
              <Icon name="caretUp" size="sm" />
            </button>
            <button
              className="libd-menu-step"
              title={t("lib.menu.later")}
              aria-label={t("lib.menu.later")}
              onClick={() => { onMoveDown(); onClose(); }}
            >
              <Icon name="caretDown" size="sm" />
            </button>
          </span>
        </div>
        <Rule />
        <DangerRow
          label={t("lib.deleteCase")}
          confirmText={t("lib.case.deleteConfirm")}
          confirmLabel={t("lib.case.deleteYes")}
          onConfirm={() => {
            onDelete();
            onClose();
          }}
        />
      </div>,
      overlayHost(menu.mark.current),
      )}
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
  cases,
  loose,
  source,
  shelfName,
  onMove,
  onDelete,
  onClear,
}: {
  selected: string[];
  cases: CaseNode[];
  loose: ShelfNode[];
  /** Which shelf this move should take the books OUT of, and whether that is even knowable. */
  source: SelectionSource;
  /** Names the shelves in `source.shelves`, for the "out of which?" question. */
  shelfName: (id: string) => string;
  onMove: (shelfId: string, categoryId: string | null, removeFrom: string | null) => void;
  /**
   * DELETE THE CHOSEN BOOKS — through the library's own confirmation, which names what is going and
   * takes the files with it. The tray raises the question and does not answer it: one deletion path
   * for one book and for twenty, or the two drift and only one of them is the one that was tested.
   */
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t, lang } = useI18n();
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
  /**
   * THREE LEVELS, TOLD APART. The case used to be FOLDED INTO the shelf's own label — «فلسفة ·
   * كتب وروايات» — so a case, a shelf and a category arrived as one flat run of near-identical
   * rows and the reader had to parse a `·` to work out which was which. The case is a GROUP
   * here, printed once as the heading its shelves sit under, exactly as the sidebar prints it;
   * a shelf is a row with a square of its own colour; a category is indented under its shelf
   * with the smaller round mark. Same targets, same `onMove` arguments — only the reading.
   */
  type Target = { key: string; shelfId: string; categoryId: string | null; name: string; ink: string | null; sub: boolean; group: string | null };
  const targets: Target[] = [];
  const addShelf = (s: ShelfNode, group: string | null, ink: string | null) => {
    if (s.auto_rule) return; // a rule shelf fills itself; it cannot be moved into
    targets.push({ key: s.id, shelfId: s.id, categoryId: null, name: s.name, ink, sub: false, group });
    for (const k of s.categories) {
      targets.push({ key: `${s.id}::${k.id}`, shelfId: s.id, categoryId: k.id, name: k.name, ink, sub: true, group });
    }
  };
  for (const c of cases) for (const s of c.shelves) addShelf(s, c.name, s.ink ?? c.ink);
  for (const s of loose) addShelf(s, null, s.ink);
  /** With no case anywhere, «خارج الخزائن» would be a heading over the only group there is. */
  const anyCase = targets.some((x) => x.group !== null);

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

  /**
   * THE TRAY, IN THREE GROUPS.
   *
   * WHAT WAS WRONG WITH IT. The whole surface was inline style, and inline style has no states:
   * measured in the running library, «حذف الكتاب» and «تمّ» were being drawn on
   * rgb(240,240,240) with a 2px rgb(0,0,0) edge — Windows' own ButtonFace, not Sard's, because
   * this tray hangs beside `.libd-stage` rather than inside it and the appearance reset never
   * reached it. Nothing had a hover ground, a pressed state or a focus ring. The count was a
   * plain 13px span at the far edge, four 14×20 paint blocks stood in for the books, and the
   * plate's own padding was physical (`9px 10px 9px 16px`), so in Arabic its wider side landed
   * on the wrong edge.
   *
   * WHAT IT IS NOW. `.libd-seltray` in library-design.css: the quantity, then what may be done
   * to it, then the way out, separated by hairlines rather than by boxes, one control height for
   * all three, and every rule in logical properties so Arabic and English are the same
   * composition mirrored. The ranking is carried by the controls themselves — accent fill for
   * the move, a danger tint for the deletion, nothing at all for «تمّ».
   *
   * The cover chips are gone. They were capped at four however many books were chosen, so at
   * five they were simply untrue, and they were the noisiest thing on a surface whose subject —
   * the ticked tiles — is already on screen behind it.
   *
   * NOTHING BELOW TOUCHES THE SELECTION. `onMove`, `onDelete` and `onClear` are called exactly
   * as before, with exactly the same arguments, and the mode, the ticks and the tiles are not
   * this component's business.
   */
  return (
    <div className="libd-seltray">
      <div className="libd-seltray-plate" role="toolbar" aria-label={t("lib.select")}>
        {/* WHAT IS CHOSEN. The figure is the readable half; the word after it is its caption. */}
        <div className="libd-seltray-count">
          <span className="libd-seltray-n">{localeNum(selected.length, lang)}</span>
          <span className="libd-seltray-lbl">{t("lib.selected")}</span>
        </div>

        <span className="libd-seltray-rule" aria-hidden />

        {/* WHAT MAY BE DONE TO IT — one group, because these two are the operations. */}
        <div className="libd-seltray-ops">
          <div className="libd-seltray-anchor">
            <button
              className="libd-seltray-move"
              onClick={() => (open ? close() : setOpen(true))}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              {t("lib.moveTo")}
            </button>
            {open && (
              <>
                <Backdrop onClose={close} />
                {pendingTarget ? (
                  // THE AMBIGUOUS CASE, asked rather than assumed. The books came from more than
                  // one shelf, so the reader names the one they are leaving — or chooses to leave
                  // none, which is an honest "add" and is labelled as one.
                  <div className="libd-seltray-menu" role="menu">
                    <div className="libd-menu-legend libd-seltray-note">
                      {t("lib.moveOutOfWhich", { n: String(source.shelves.length) })}
                    </div>
                    {source.shelves.map((id) => (
                      <button
                        key={id}
                        className="libd-menu-item"
                        role="menuitem"
                        onClick={() => {
                          onMove(pendingTarget.shelfId, pendingTarget.categoryId, id);
                          close();
                        }}
                        style={{ ...menuItem(), justifyContent: "flex-start" }}
                      >
                        {shelfName(id)}
                      </button>
                    ))}
                    <Rule />
                    <button
                      className="libd-menu-item"
                      role="menuitem"
                      onClick={() => {
                        onMove(pendingTarget.shelfId, pendingTarget.categoryId, null);
                        close();
                      }}
                      style={{ ...menuItem(), justifyContent: "flex-start" }}
                    >
                      {t("lib.keepWhereTheyAre")}
                    </button>
                  </div>
                ) : (
                  <div className="libd-seltray-menu" role="menu">
                    {source.shelfId && (
                      <div className="libd-menu-legend libd-seltray-note">
                        {t("lib.movingOutOf", { name: shelfName(source.shelfId) })}
                      </div>
                    )}
                    {targets.map((m, i) => {
                      const prev = i > 0 ? targets[i - 1].group : undefined;
                      const heading =
                        m.group !== prev ? (m.group ?? (anyCase ? t("lib.unfiled") : null)) : null;
                      return (
                        <Fragment key={m.key}>
                          {heading !== null && (
                            <div className="libd-menu-legend libd-seltray-group" dir="auto">
                              {heading}
                            </div>
                          )}
                          <button
                            className="libd-menu-item"
                            role="menuitem"
                            onClick={() => choose(m)}
                            style={{
                              ...menuItem(),
                              justifyContent: "flex-start",
                              ...(m.sub ? { paddingInlineStart: 26 } : {}),
                            }}
                          >
                            <span
                              className={`libd-seltray-ink${m.sub ? " is-sub" : ""}`}
                              style={{ background: m.ink ?? "var(--faint)" }}
                            />
                            {/* `dir="auto"` so each shelf name reads in ITS OWN direction: an Arabic
                                shelf in an English library, or the reverse, is ordinary in a
                                bilingual collection. */}
                            <span className="libd-seltray-target" dir="auto">{m.name}</span>
                          </button>
                        </Fragment>
                      );
                    })}
                    {targets.length === 0 && (
                      <div className="libd-menu-legend libd-seltray-note">{t("lib.noShelves")}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* THE OTHER THING A READER MEANS BY CHOOSING SEVERAL BOOKS. The ⋯ menu on one book has
              offered «حذف الكتاب» since the beginning; choosing twenty and being offered only a
              move was the collection whose selection did not match its own semantics. Beside the
              move, not hidden behind it, and it asks before it acts because the confirmation is
              the library's — which is also why this control carries the danger TINT and not the
              solid fill: the fill belongs to the press that actually deletes. */}
          <button className="libd-seltray-del" onClick={onDelete}>
            {t("edit.delete")}
          </button>
        </div>

        <span className="libd-seltray-rule" aria-hidden />

        {/* THE WAY OUT, set apart from the operations rather than queued behind them. */}
        <button className="libd-seltray-done" onClick={onClear}>
          {t("lib.done")}
        </button>
      </div>
    </div>
  );
}
