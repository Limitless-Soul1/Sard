// The library's skeleton — the permanent body the views are drawn inside.
//
// SOURCE: `Sard Library - Vista (standalone).html`, whose chrome is the design of record.
// Sidebar geometry (244px, 18/12/12 padding), the cases tree with its discs and grips, the
// breadcrumb line, the title row with Select / Arrange by hand / Add books, and the console
// row with search, the view switcher, the density steps and the sort menu — all carried over
// with the design's own measurements.

import { useEffect, useRef, useState } from "react";
import type { CaseNode, ShelfNode } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { ProfileSwitcher } from "../../profiles/ProfileSwitcher";
import { localeNum } from "../../../lib/format";
import { Hoopoe } from "../Hoopoe";
import { CaseManageMenu } from "./Menus";
import { DENSITY_STEPS, DESIGN_SORTS, dropIndex, UNFILED_CASE_ID, type DesignSort, type DesignView } from "./model";
import { createEdgeScroller, type EdgeScroller } from "./dragScroll";
import { Icon } from "../../../components/Icon";

export type Section = "library" | "inbox" | "cards" | "bookmarks";

/** What the main pane is currently scoped to. */
export interface Scope {
  caseId: string | null;
  shelfId: string | null;
}

interface SidebarProps {
  section: Section;
  onSection: (s: Section) => void;
  cases: CaseNode[];
  loose: ShelfNode[];
  bookCount: number;
  /** Books started and not finished — the count the reference shows beside "Reading now". */
  readingCount: number;
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
  onNewCase: (name: string) => void;
  onNewShelf: (caseId: string | null, name: string) => void;
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
  onSettings: () => void;
  themeName: string;
  langName: string;
}

const navGlyph = (id: string): React.CSSProperties => ({
  flex: "none",
  width: 13,
  height: 13,
  border: "1.5px solid currentColor",
  borderRadius: id === "reading" ? "50%" : id === "inbox" ? 3 : 1,
  opacity: 0.85,
});

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
  const [creatingCase, setCreatingCase] = useState(false);
  const [creatingShelfIn, setCreatingShelfIn] = useState<string | null | false>(false);
  const [renamingCase, setRenamingCase] = useState<string | null>(null);
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
  const [draft, setDraft] = useState("");

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

  const nav: { id: Section | "reading"; label: string; count?: number }[] = [
    { id: "library", label: t("lib.nav.library"), count: props.bookCount },
    { id: "reading", label: t("lib.nav.readingNow"), count: props.readingCount },
    { id: "inbox", label: t("lib.nav.highlights") },
    { id: "bookmarks", label: t("lib.nav.bookmarks") },
    { id: "cards", label: t("lib.nav.cards") },
  ];

  const commit = (fn: (name: string) => void) => {
    const name = draft.trim();
    setDraft("");
    setCreatingCase(false);
    setCreatingShelfIn(false);
    if (name) fn(name);
  };

  const draftInput = (onCommit: () => void, placeholder: string, style: React.CSSProperties) => (
    <input
      autoFocus
      value={draft}
      dir="auto"
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") {
          setDraft("");
          setCreatingCase(false);
          setCreatingShelfIn(false);
        }
      }}
      onBlur={onCommit}
      style={{
        background: "var(--soft)",
        border: "1px solid var(--brd)",
        outline: "none",
        ...style,
      }}
    />
  );

  // The design's shelf row: a mark, the name, the count. Shelf management lives in the shelf's
  // own order popover in the main pane, which is where the design puts it — not here.
  const shelfRow = (s: ShelfNode) => {
    const active = props.scope.shelfId === s.id;
    return (
      // The reference's shelf row: padded 6/8/6/10, radius 6, `500 .75rem` in `--mut`, and on
      // selection it takes `--act` and `--txt`. No height is set — the padding decides it.
      <button
        key={s.id}
        className="libd-hov"
        onClick={() => props.onScope({ caseId: s.case_id ?? UNFILED_CASE_ID, shelfId: active ? null : s.id })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-4)",
          width: "100%",
          padding: "6px 8px 6px 10px",
          borderRadius: "var(--r-sm)",
          font: "500 .75rem var(--ui)",
          color: active ? "var(--txt)" : "var(--mut)",
          background: active ? "var(--act)" : "transparent",
        }}
      >
        {/* A rule shelf is an OUTLINED circle; a hand shelf is a filled square. The mark says
            which kind of shelf it is, and stays `--faint` in both states. */}
        <span
          style={{
            flex: "none",
            width: 6,
            height: 6,
            ...(s.auto_rule
              ? { borderRadius: "50%", border: "1.5px solid var(--faint)" }
              : { borderRadius: 1, background: "var(--faint)" }),
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
          <b style={{ font: "600 1.0625rem/1 var(--ui)" }}>Sard</b>
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
          <em style={{ font: "700 1.1875rem/1 var(--ar)", fontStyle: "normal" }}>سَرْد</em>
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
        {nav.map((n) => (
          <button
            key={n.id}
            className="libd-hov"
            disabled={n.id === "reading"}
            onClick={() => n.id !== "reading" && props.onSection(n.id as Section)}
            style={{
              // Library is active only AT the root. Every other section is active whenever it is
              // the section, because none of them can be focused into.
              ...navRow(n.id === props.section && (n.id !== "library" || props.atRoot)),
              opacity: n.id === "reading" ? 0.6 : undefined,
              cursor: n.id === "reading" ? "default" : "pointer",
            }}
          >
            <span style={navGlyph(n.id)} />
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
        <button
          className="libd-hov libd-hov-txt"
          title={t("lib.newCase")}
          aria-label={t("lib.newCase")}
          onClick={() => {
            setDraft("");
            setCreatingCase(true);
          }}
          style={{
            width: "var(--ctl-xs)",
            height: "var(--ctl-xs)",
            borderRadius: "var(--r-sm)",
            display: "grid",
            placeItems: "center",
            color: "var(--mut)",
            fontSize: 15,
            lineHeight: 1,
          }}
        >
          +
        </button>
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
          if (renamingCase === c.id) {
            return (
              <span key={c.id}>
                {draftInput(
                  () => {
                    const name = draft.trim();
                    setRenamingCase(null);
                    setDraft("");
                    if (name) props.onRenameCase(c.id, name);
                  },
                  t("lib.caseName"),
                  { margin: "4px 2px", borderRadius: 7, padding: "7px 9px", font: "500 .8125rem var(--ui)" },
                )}
              </span>
            );
          }
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
                  onClick={() => props.onScope({ caseId: c.id, shelfId: null })}
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
                      onRename={() => {
                        setDraft(c.name);
                        setRenamingCase(c.id);
                      }}
                      onNewShelf={() => {
                        setDraft("");
                        setCreatingShelfIn(c.id);
                      }}
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
                  {/* The reference reaches "new shelf" through the case's own ⋯ menu, which is
                      what opens this input — there is no standing button in the list, and adding
                      one duplicated an affordance the case row already carries. */}
                  {creatingShelfIn === c.id &&
                    draftInput(() => commit((n) => props.onNewShelf(c.id, n)), t("lib.shelf.namePlaceholder"), {
                      margin: "3px 8px 3px 10px",
                      borderRadius: 6,
                      padding: "5px 8px",
                      font: "500 .75rem var(--ui)",
                    })}
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

        {creatingCase &&
          draftInput(() => commit(props.onNewCase), t("lib.caseName"), {
            margin: "4px 2px",
            borderRadius: 7,
            padding: "7px 9px",
            font: "500 .8125rem var(--ui)",
          })}

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
                onClick={() => props.onScope({ caseId: UNFILED_CASE_ID, shelfId: null })}
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
          {(looseOpen || props.loose.length === 0) &&
            (creatingShelfIn === null ? (
            draftInput(() => commit((n) => props.onNewShelf(null, n)), t("lib.shelf.namePlaceholder"), {
              margin: "3px 8px 3px 10px",
              borderRadius: 6,
              padding: "5px 8px",
              font: "500 .75rem var(--ui)",
            })
          ) : (
            <button
              className="libd-hov-txt"
              onClick={() => {
                setDraft("");
                setCreatingShelfIn(null);
              }}
              style={{
                justifyContent: "flex-start",
                padding: "6px 10px",
                font: "500 .6875rem var(--ui)",
                color: "var(--faint)",
              }}
            >
              {t("lib.newShelf")}
            </button>
            ))}
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

interface HeaderProps {
  crumbs: { label: string; go: () => void }[];
  heading: string;
  subcount: string;
  mode: "browse" | "select" | "arrange";
  onToggleSelect: () => void;
  onToggleArrange: () => void;
  onAddBooks: () => void;
  importing: boolean;
  query: string;
  onQuery: (q: string) => void;
  view: DesignView;
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
  format: string | null;
  onFormat: (f: string | null) => void;
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

const VIEW_ICONS: Record<DesignView, string> = {
  grid: "linear-gradient(90deg,currentColor 45%,transparent 45%),linear-gradient(180deg,currentColor 45%,transparent 45%)",
  covers:
    "linear-gradient(90deg,currentColor 45%,transparent 45%),linear-gradient(180deg,currentColor 45%,transparent 45%)",
  spines: "repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 4px)",
  details: "repeating-linear-gradient(180deg,currentColor 0 2px,transparent 2px 5px)",
  vista: "radial-gradient(circle at 50% 70%, currentColor 30%, transparent 32%)",
};

export function Header(props: HeaderProps) {
  const { t } = useI18n();
  const [sortOpen, setSortOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);

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
  };

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
      className="libd-chrome"
      style={{
        flex: "none",
        position: "relative",
        zIndex: 3,
        padding: "18px 30px 0",
        backdropFilter: props.overEnvironment ? "blur(2px)" : undefined,
      }}
    >
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

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--sp-6)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-5)", minWidth: 0 }}>
          <h1
            dir="auto"
            style={{
              margin: 0,
              font: "600 1.5rem/1.2 var(--book)",
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
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <button onClick={props.onToggleSelect} style={ctlBtn(props.mode === "select")}>
            {t("lib.select")}
          </button>
          <button onClick={props.onToggleArrange} style={ctlBtn(props.mode === "arrange")}>
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
      </div>

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
              onClick={() => props.onView(v.id)}
              style={{
                ...ctlBtn(props.view === v.id),
                height: 28,
                padding: "0 10px",
                border: "none",
                background: props.view === v.id ? "var(--act)" : "transparent",
                color: props.view === v.id ? "var(--acc)" : "var(--mut)",
              }}
            >
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 12,
                  height: 12,
                  opacity: 0.85,
                  background: VIEW_ICONS[v.id],
                }}
              />
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

        {props.view !== "details" && props.view !== "grid" && (
          <div style={groupStyle}>
            {Array.from({ length: DENSITY_STEPS }, (_, i) => (
              <button
                key={i}
                onClick={() => props.onDensity(i)}
                aria-label={`${i + 1}`}
                title={`${i + 1}`}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "var(--r-md)",
                  background: props.density === i ? "var(--act)" : "transparent",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: 4 + i * 3,
                    height: 13,
                    borderRadius: 1,
                    background: props.density === i ? "var(--acc)" : "var(--faint)",
                  }}
                />
              </button>
            ))}
          </div>
        )}

        {/* RAWY-15's format filter, carried over from the old toolbar. It filters in SQL. */}
        <div style={{ position: "relative" }}>
          <button
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
              <div onClick={() => setFormatOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 69 }} />
              <div
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
          <button onClick={() => setSortOpen((v) => !v)} style={ctlBtn(false)}>
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
                onClick={() => setSortOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 69 }}
              />
              <div
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
                {DESIGN_SORTS.map((s) => (
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

        <div
          style={{
            font: "400 .75rem var(--ui)",
            color: "var(--faint)",
            flex: "1 1 220px",
            minWidth: 0,
            textWrap: "pretty",
          }}
        >
          {props.mode === "arrange" ? t("lib.arrangeHintOn") : t("lib.arrangeHintOff")}
        </div>
      </div>
    </header>
  );
}
