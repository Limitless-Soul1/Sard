// The case management panel.
//
// SOURCE: the `editorOpen` / `editorModel` block of `Sard Library (standalone).html`. "Manage"
// on a case opens THIS — a panel that manages the case and everything inside it — not a context
// menu. The reference's own structure, kept: a head carrying the case's name and its ink
// palette; a body of shelf blocks, each with a grip, an editable name, its order chip and its
// categories; and a foot with New shelf, the carry status, Delete case and Done.
//
// Arrangement is DRAG, as the reference does it: press a book, hold briefly, move, release.
// `pointerup` places when the pointer actually travelled, and a plain click still places for
// anyone who prefers that — the reference supports both and neither replaces the other.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BookRow, CaseNode, LibraryTree, ShelfItem, ShelfNode } from "../../../lib/ipc";
import {
  caseDelete,
  caseRename,
  caseSetInk,
  categoryCreate,
  categoryDelete,
  categoryRename,
  categoryReorder,
  collectionDelete,
  collectionRemoveBook,
  collectionRename,
  shelfCreate,
  shelfPlaceBook,
  shelfReorder,
  shelfSetCase,
  shelfSetOrder,
  type ShelfOrder,
} from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { autoCoverPaint } from "../AutoCover";
import { dropIndex, isFinished, pctText, groupShelf, type BookGroup } from "./model";

/** The case inks, shared with the sidebar's picker. */
const INKS = ["#BFA8D6", "#8DC3BA", "#9DC0D6", "#E8C36A", "#D69C9C", "#A8C08D", "#C9A88D", "#9C8DC3"];

const ORDER_CYCLE: ShelfOrder[] = ["hand", "title", "author", "added", "progress"];

/** What is currently in the reader's hand. */
type Hand =
  | { kind: "book"; id: string; fromShelf: string }
  | { kind: "shelf"; id: string }
  | { kind: "category"; id: string; shelf: string }
  | null;

interface Target {
  shelfId: string;
  catId: string | null;
  index: number;
}

export interface CaseEditorProps {
  caseNode: CaseNode;
  /**
   * True when `caseNode` is the synthesised "Not in a case" group rather than a real case.
   *
   * An unfiled shelf is still a shelf the reader made and has to be able to manage. The reference
   * sidebar deliberately gives a shelf row no ⋯ — management belongs to this panel — but it also
   * has no un-cased shelves at all, so it says nothing about them. Rather than bolt controls onto
   * the sidebar row and break the design that was just matched to the reference, the Unfiled
   * heading opens THIS panel over its own shelves. The case-specific parts (name, colour, delete)
   * stand down, because there is no case here to name, colour or delete.
   */
  unfiled?: boolean;
  /** The real cases, so a shelf can be filed into one from here. */
  cases: CaseNode[];
  /** Every book, by id, for the chips. */
  byId: Map<string, BookRow>;
  /** Each shelf's ordered membership. */
  items: Record<string, ShelfItem[]>;
  onTree: (t: LibraryTree) => void;
  /** Re-read everything after a write. */
  onChanged: () => void;
  onClose: () => void;
  onOpenBookDetails: (b: BookRow) => void;
  /** The Library's toast — every deletion and every failed write is announced through it. */
  notify: (msg: string) => void;
}

export function CaseEditor(props: CaseEditorProps) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
  const num = (n: number) => localeNum(n, lang);
  const c = props.caseNode;

  const [hand, setHand] = useState<Hand>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [creatingShelf, setCreatingShelf] = useState(false);
  const [creatingCatIn, setCreatingCatIn] = useState<string | null>(null);
  const [confirmShelf, setConfirmShelf] = useState<string | null>(null);
  const [confirmCat, setConfirmCat] = useState<{ shelf: string; cat: string } | null>(null);
  // Deleting a case is two clicks, on two different targets, with the consequences in between.
  const [confirmCase, setConfirmCase] = useState(false);
  /** Which shelf is choosing the case it belongs to. */
  const [movingShelf, setMovingShelf] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState(c.name);
  const [busy, setBusy] = useState(false);

  // The live list elements, so a pointer position can be turned into a shelf and an index.
  const lists = useRef(new Map<string, HTMLElement>());
  const holdRef = useRef<number | null>(null);
  const draggedRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  // The shelf/category drag: declared here, with the other pointer state, because the panel's
  // own Escape handler has to be able to see it.
  const rowStart = useRef<{ kind: "shelf" | "category"; id: string; shelf?: string; y: number; moved: boolean; cancelled?: boolean } | null>(null);
  const [rowDrag, setRowDrag] = useState<{ kind: "shelf" | "category"; id: string; shelf?: string } | null>(null);
  const [rowDropAt, setRowDropAt] = useState<number | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const rowGhost = useRef<HTMLDivElement | null>(null);

  useEffect(() => setName(c.name), [c.id, c.name]);

  const key = (shelfId: string, catId: string | null) => `${shelfId}::${catId ?? ""}`;

  const shelfBooks = useCallback(
    // `keepEmpty`: this is the panel where a category is managed, so one holding nothing still
    // has to appear — otherwise it exists, is unreachable, and cannot even be deleted.
    (s: ShelfNode): BookGroup[] => groupShelf(s, props.items[s.id] ?? [], props.byId, true),
    [props.items, props.byId],
  );

  const canTake = (s: ShelfNode) => !s.auto_rule && s.order_rule === "hand";

  // ---- drag ------------------------------------------------------------------
  /** Turn a pointer position into the nearest list and an insertion index within it. */
  const hitTest = useCallback(
    (x: number, y: number): Target | null => {
      let best: string | null = null;
      let bestDist = Infinity;
      for (const [k, el] of lists.current) {
        const r = el.getBoundingClientRect();
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = dx + dy;
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      }
      if (!best) return null;
      const el = lists.current.get(best)!;
      const kids = Array.from(el.children).filter((n) => !(n as HTMLElement).dataset.slot);
      let idx = kids.length;
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect();
        if (y < r.bottom) {
          const mid = r.left + r.width / 2;
          if (rtl ? x > mid : x < mid) {
            idx = i;
            break;
          }
        }
      }
      const [shelfId, catId] = best.split("::");
      return { shelfId, catId: catId || null, index: idx };
    },
    [rtl],
  );

  const place = useCallback(
    async (to: Target | null) => {
      const h = hand;
      setHand(null);
      setTarget(null);
      if (!h || h.kind !== "book" || !to) return;
      setBusy(true);
      // Leaving another shelf is a real move, not a copy.
      if (h.fromShelf !== to.shelfId) {
        await collectionRemoveBook(h.fromShelf, h.id).catch(() => {});
      }
      const tree = await shelfPlaceBook(to.shelfId, h.id, to.catId, to.index).catch(() => null);
      setBusy(false);
      if (tree) props.onTree(tree);
      props.onChanged();
    },
    [hand, props],
  );

  // Window-level pointer handling, so a drag that leaves the book still tracks and still lands.
  useEffect(() => {
    if (!hand || hand.kind !== "book") return;
    const move = (e: PointerEvent) => {
      draggedRef.current = true;
      const g = ghostRef.current;
      if (g) g.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px) rotate(-3deg)`;
      setTarget(hitTest(e.clientX, e.clientY));
    };
    const up = (e: PointerEvent) => {
      if (draggedRef.current) {
        draggedRef.current = false;
        place(hitTest(e.clientX, e.clientY));
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, false);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, false);
    };
  }, [hand, hitTest, place]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A drag in progress consumes Escape — cancelling the drag, not closing the panel. Without
      // this, cancelling a shelf drag threw the reader out of the panel they were working in.
      if (rowStart.current) {
        e.preventDefault();
        return;
      }
      if (hand) {
        e.preventDefault();
        setHand(null);
        setTarget(null);
      } else props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hand, props]);

  // ---- writes ----------------------------------------------------------------
  // Every write goes through here, and a write that fails SAYS SO. Swallowing the rejection made
  // a failed rename or reorder indistinguishable from one the reader had not actually performed —
  // the panel simply sat there. `notify` is the Library's own toast.
  const run = async (fn: () => Promise<LibraryTree>): Promise<boolean> => {
    setBusy(true);
    let tree: LibraryTree | null = null;
    let ok = true;
    try {
      tree = await fn();
    } catch (e) {
      console.error(e);
      ok = false;
      props.notify(t("lib.writeFailed"));
    }
    setBusy(false);
    if (tree) props.onTree(tree);
    props.onChanged();
    return ok;
  };

  /** Delete a shelf, first moving its books to another shelf when one is chosen. */
  const removeShelf = async (s: ShelfNode, moveTo: string | null) => {
    setBusy(true);
    let ok = true;
    try {
      if (moveTo) {
        for (const g of shelfBooks(s)) {
          for (const b of g.books) await shelfPlaceBook(moveTo, b.id, null, 0);
        }
      }
      await collectionDelete(s.id);
    } catch (e) {
      console.error(e);
      ok = false;
    }
    setBusy(false);
    setConfirmShelf(null);
    props.notify(ok ? t("lib.shelf.deleted", { name: s.name }) : t("lib.writeFailed"));
    props.onChanged();
  };

  /** Delete a category, moving its books into another category of the same shelf. */
  const removeCategory = async (s: ShelfNode, catId: string, moveTo: string | null) => {
    setBusy(true);
    let tree: LibraryTree | null = null;
    let ok = true;
    try {
      const run2 = shelfBooks(s).find((g) => g.categoryId === catId);
      if (run2) {
        for (const b of run2.books) await shelfPlaceBook(s.id, b.id, moveTo, 0);
      }
      tree = await categoryDelete(catId);
    } catch (e) {
      console.error(e);
      ok = false;
    }
    setBusy(false);
    setConfirmCat(null);
    if (tree) props.onTree(tree);
    props.notify(ok ? t("lib.category.deleted") : t("lib.writeFailed"));
    props.onChanged();
  };

  /**
   * The shelf and category grips, dragged rather than clicked-and-clicked.
   *
   * Identical in behaviour to the case grip in the sidebar, and for the same reason: ⠿ means
   * "take hold of this" everywhere it appears, so it must not mean lift-and-then-find-a-rail on
   * one level of the hierarchy and press-and-drag on another. A plain click still lifts, exactly
   * as before — the two are the same operation reached two ways, and neither is taken away.
   *
   * Rows are measured from their own elements, so the insertion bar tracks the pointer even
   * though shelves are tall blocks of very different heights.
   */

  /** The ids a dragged row is ordered among — its siblings, and only those. */
  const siblingsOf = useCallback(
    (st: { kind: "shelf" | "category"; id: string; shelf?: string }): string[] => {
      if (st.kind === "shelf") return c.shelves.map((x) => x.id);
      const sh = c.shelves.find((x) => x.id === st.shelf);
      return sh ? sh.categories.map((k) => k.id) : [];
    },
    [c.shelves],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const st = rowStart.current;
      if (!st) return;
      if (!st.moved && Math.abs(e.clientY - st.y) < 4) return;
      if (!st.moved) {
        st.moved = true;
        setRowDrag({ kind: st.kind, id: st.id, shelf: st.shelf });
        setHand(null); // a drag supersedes any lift
      }
      const ids = siblingsOf(st);
      const from = ids.indexOf(st.id);
      const mids = ids.map((id) => {
        const el = rowRefs.current.get(`${st.kind}:${id}`);
        if (!el) return Number.POSITIVE_INFINITY;
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      setRowDropAt(dropIndex(e.clientY, mids, from));
      const g = rowGhost.current;
      if (g) g.style.transform = `translate(${e.clientX + 12}px, ${e.clientY - 10}px)`;
    };
    const cancel = () => {
      rowStart.current = null;
      setRowDrag(null);
      setRowDropAt(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !rowStart.current) return;
      // Mark it cancelled but KEEP the ref: both this and the panel's own Escape handler are on
      // the window, their order is registration-dependent, and clearing the ref here let the
      // panel conclude no drag was running and close itself.  clears it.
      rowStart.current.cancelled = true;
      setRowDrag(null);
      setRowDropAt(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [siblingsOf]);

  /** What a grip does on press and on release. `onLift` is the unchanged click behaviour. */
  const gripHandlers = (
    kind: "shelf" | "category",
    id: string,
    onLift: () => void,
    shelf?: string,
  ) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault(); // no text selection, and no click reaching the row beneath
      rowStart.current = { kind, id, shelf, y: e.clientY, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    onPointerUp: async (e: React.PointerEvent) => {
      e.stopPropagation();
      const st = rowStart.current;
      rowStart.current = null;
      if (st?.cancelled) return; // Escape already put it back
      if (!st?.moved) {
        onLift();
        return;
      }
      const at = rowDropAt;
      setRowDrag(null);
      setRowDropAt(null);
      if (at == null) return;
      if (kind === "shelf") await run(() => shelfReorder(id, at));
      else await run(() => categoryReorder(id, at));
    },
  });

  /** The insertion bar, shared by both levels so they read identically. */
  const insertionBar = (
    <span
      style={{
        display: "block",
        height: 2,
        margin: "4px 0",
        borderRadius: 1,
        background: "var(--acc)",
        boxShadow: "0 0 0 3px color-mix(in srgb, var(--acc) 22%, transparent)",
      }}
    />
  );

  const grip = (active: boolean, hidden?: boolean): React.CSSProperties => ({
    flex: "none",
    width: 20,
    height: 22,
    borderRadius: 6,
    fontSize: 10,
    color: active ? "var(--acc)" : "var(--faint)",
    background: active ? "var(--act)" : "transparent",
    cursor: "grab",
    visibility: hidden ? "hidden" : undefined,
  });

  const chip = (on: boolean): React.CSSProperties => ({
    font: "500 .6875rem var(--ui)",
    borderRadius: 20,
    padding: "3px 10px",
    whiteSpace: "nowrap",
    border: `1px solid ${on ? "var(--acc)" : "var(--brd)"}`,
    color: on ? "var(--acc)" : "var(--mut)",
    background: on ? "var(--act)" : "transparent",
  });

  const handBook = hand?.kind === "book" ? props.byId.get(hand.id) ?? null : null;

  return (
    <div
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 150,
        background: "rgba(0,0,0,.34)",
        display: "grid",
        placeItems: "center",
        animation: "sard-fade .14s ease-out",
      }}
    >
      <div
        className="libd-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(860px,94%)",
          height: "min(760px,90%)",
          display: "flex",
          flexDirection: "column",
          background: "var(--chr)",
          border: "1px solid var(--brd)",
          borderInlineStart: `4px solid ${c.ink ?? "var(--acc)"}`,
          borderRadius: "4px 16px 16px 4px",
          boxShadow: "var(--sh4)",
          overflow: "hidden",
          animation: "sard-rise .16s ease-out",
          opacity: busy ? 0.75 : 1,
        }}
      >
        {/* ---- head: the case's own identity ---- */}
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--brd)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                font: "600 .625rem var(--ui)",
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: "var(--faint)",
                marginBottom: 7,
              }}
            >
              {props.unfiled ? t("lib.managingUnfiled") : t("lib.managing")}
            </div>
            {props.unfiled ? (
              // Nothing to rename: "Not in a case" is a place, not an object the reader owns.
              <div
                style={{
                  padding: "7px 0",
                  font: rtl ? "700 1.125rem var(--ar)" : "600 1.0625rem var(--book)",
                  color: "var(--txt)",
                }}
              >
                {t("lib.unfiled")}
              </div>
            ) : (
              <input
                value={name}
                dir="auto"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name !== c.name && run(() => caseRename(c.id, name.trim()))}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                style={{
                  width: "100%",
                  background: "var(--soft)",
                  border: "1px solid var(--brd)",
                  borderRadius: 8,
                  padding: "7px 10px",
                  font: rtl ? "700 1.125rem var(--ar)" : "600 1.0625rem var(--book)",
                  color: "var(--txt)",
                  outline: "none",
                }}
              />
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 9, flexWrap: "wrap" }}>
              <span style={{ font: "500 .75rem var(--ui)", color: "var(--faint)" }}>
                {t("lib.shelfCount", { n: num(c.count) })} ·{" "}
                {t("lib.shelvesCount", { n: num(c.shelves.length) })}
              </span>
              {/* No colour picker here: an unfiled group has no ink of its own to set. */}
              <div style={{ display: props.unfiled ? "none" : "flex", alignItems: "center", gap: 6 }}>
                <button
                  title={t("lib.inkNone")}
                  aria-label={t("lib.inkNone")}
                  onClick={() => run(() => caseSetInk(c.id, null))}
                  style={{
                    position: "relative",
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    background: "var(--soft)",
                    boxShadow: !c.ink ? "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)" : "0 0 0 1px var(--brd)",
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
                    onClick={() => run(() => caseSetInk(c.id, k))}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      background: k,
                      boxShadow:
                        c.ink === k ? "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)" : "0 0 0 1px var(--brd)",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <button
            className="libd-hov libd-hov-txt"
            onClick={props.onClose}
            aria-label={t("panel.close")}
            style={{ flex: "none", width: 30, height: 30, borderRadius: 9, color: "var(--mut)", fontSize: 14 }}
          >
            ✕
          </button>
        </div>

        {/* ---- body: shelves, their categories, their books ---- */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 24px 18px" }}>
          {c.shelves.map((s, gi) => {
            const takeable = canTake(s);
            const groups = shelfBooks(s);
            const total = groups.reduce((n, g) => n + g.books.length, 0);
            const shelfHeld = hand?.kind === "shelf" && hand.id === s.id;
            return (
              <div
                key={s.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(`shelf:${s.id}`, el);
                  else rowRefs.current.delete(`shelf:${s.id}`);
                }}
                style={{
                  padding: "10px 0 14px",
                  borderBottom: "1px solid var(--brd)",
                  opacity: shelfHeld || (rowDrag?.kind === "shelf" && rowDrag.id === s.id) ? 0.4 : 1,
                  ...(s.auto_rule ? { background: "var(--soft)", borderRadius: 10, paddingInline: 12 } : {}),
                }}
              >
                {/* where a dragged shelf would land */}
                {rowDrag?.kind === "shelf" && rowDropAt === gi && insertionBar}
                {/* a place-here rail while another shelf is in hand */}
                {hand?.kind === "shelf" && hand.id !== s.id && (
                  <button
                    onClick={() => run(() => shelfReorder(hand.id, gi)).then(() => setHand(null))}
                    style={{ display: "block", width: "100%", padding: "6px 0" }}
                    aria-label={t("lib.placeHere")}
                  >
                    <span style={{ display: "block", height: 2, borderRadius: 1, background: "var(--acc)" }} />
                  </button>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 0 9px" }}>
                  <button
                    title={t("lib.moveShelfHint")}
                    aria-label={t("lib.moveShelfHint")}
                    {...gripHandlers("shelf", s.id, () =>
                      setHand(shelfHeld ? null : { kind: "shelf", id: s.id }),
                    )}
                    style={{
                      ...grip(shelfHeld || (rowDrag?.kind === "shelf" && rowDrag.id === s.id)),
                      cursor: rowDrag?.kind === "shelf" && rowDrag.id === s.id ? "grabbing" : "grab",
                      touchAction: "none",
                    }}
                  >
                    ⠿
                  </button>
                  <ShelfName shelf={s} onRename={(v) => run(() => collectionRename(s.id, v) as never)} />
                  <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)", whiteSpace: "nowrap" }}>
                    {num(total)}
                  </span>
                  <span style={{ flex: 1 }} />
                  {s.auto_rule ? (
                    <span style={chip(false)}>{t("lib.automatic")}</span>
                  ) : (
                    <button
                      title={t("lib.orderOfThisShelf")}
                      onClick={() => {
                        const next = ORDER_CYCLE[(ORDER_CYCLE.indexOf(s.order_rule) + 1) % ORDER_CYCLE.length];
                        run(() => shelfSetOrder(s.id, next));
                      }}
                      style={chip(s.order_rule === "hand")}
                    >
                      {s.order_rule === "hand" ? t("lib.byHand") : `⇅ ${t(`lib.sort.${s.order_rule}` as never)}`}
                    </button>
                  )}
                  {/* WHICH CASE HOLDS THIS SHELF. The one control that stops a shelf becoming an
                      object the reader can see but not file — and the only place it is needed,
                      since this panel is now reachable for cased and unfiled shelves alike. */}
                  <button
                    className="libd-hov"
                    title={t("lib.moveShelfToCase")}
                    onClick={() => {
                      setConfirmShelf(null);
                      setMovingShelf(movingShelf === s.id ? null : s.id);
                    }}
                    style={chip(movingShelf === s.id)}
                  >
                    {s.case_id ? (props.cases.find((x) => x.id === s.case_id)?.name ?? c.name) : t("lib.unfiled")}
                  </button>
                  <button
                    title={t("lib.shelf.delete")}
                    aria-label={t("lib.shelf.delete")}
                    onClick={() => {
                      setMovingShelf(null);
                      setConfirmShelf(confirmShelf === s.id ? null : s.id);
                    }}
                    style={{ width: 24, height: 24, borderRadius: 7, color: "var(--faint)", fontSize: 12 }}
                  >
                    ✕
                  </button>
                </div>

                {movingShelf === s.id && (
                  <ConfirmBar
                    text={t("lib.moveShelfToCase")}
                    targets={[
                      { id: "", label: t("lib.unfiled") },
                      ...props.cases.filter((x) => x.id !== s.case_id).map((x) => ({ id: x.id, label: x.name })),
                    ].filter((x) => !(x.id === "" && !s.case_id))}
                    onPick={async (id) => {
                      setMovingShelf(null);
                      await run(() => shelfSetCase(s.id, id || null));
                    }}
                    onCancel={() => setMovingShelf(null)}
                  />
                )}

                {s.auto_rule && (
                  <div style={{ font: "400 .6875rem var(--ui)", color: "var(--faint)", padding: "0 0 9px" }}>
                    {t("lib.ruleFixed")}
                  </div>
                )}

                {confirmShelf === s.id && (
                  <ConfirmBar
                    text={t("lib.deleteShelfQ")}
                    targets={[
                      { id: "", label: t("lib.keepInLibrary") },
                      ...c.shelves.filter((x) => x.id !== s.id && !x.auto_rule).map((x) => ({ id: x.id, label: x.name })),
                    ]}
                    onPick={(id) => removeShelf(s, id || null)}
                    onCancel={() => setConfirmShelf(null)}
                  />
                )}

                {groups.map((g, ki) => {
                  const k = key(s.id, g.categoryId);
                  // Ordered among CATEGORIES, not among groups: `ki` counts the un-categorised run as
                  // well, and that run is not a category the backend can place anything next to.
                  const catIndex = g.categoryId ? s.categories.findIndex((x) => x.id === g.categoryId) : -1;
                  const held = hand?.kind === "category" && hand.id === g.categoryId && hand.shelf === s.id;
                  const showSlot =
                    hand?.kind === "category" && hand.shelf === s.id && hand.id !== g.categoryId && !!g.categoryId;
                  return (
                    <div
                      key={g.categoryId ?? "__loose"}
                      ref={(el) => {
                        if (!g.categoryId) return;
                        if (el) rowRefs.current.set(`category:${g.categoryId}`, el);
                        else rowRefs.current.delete(`category:${g.categoryId}`);
                      }}
                      style={
                        rowDrag?.kind === "category" && rowDrag.id === g.categoryId ? { opacity: 0.4 } : undefined
                      }
                    >
                      {/* where a dragged category would land, among this shelf's categories only */}
                      {rowDrag?.kind === "category" &&
                        rowDrag.shelf === s.id &&
                        rowDropAt === catIndex &&
                        insertionBar}
                      {showSlot && (
                        <button
                          onClick={() =>
                            run(() => categoryReorder(hand.id, ki)).then(() => setHand(null))
                          }
                          style={{ display: "block", width: "100%", padding: "5px 0" }}
                          aria-label={t("lib.placeHere")}
                        >
                          <span style={{ display: "block", height: 2, borderRadius: 1, background: "var(--acc)" }} />
                        </button>
                      )}
                      {g.name != null && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0 7px" }}>
                          <button
                            title={t("lib.moveCategoryHint")}
                            aria-label={t("lib.moveCategoryHint")}
                            {...gripHandlers(
                              "category",
                              g.categoryId ?? "",
                              () => setHand(held ? null : { kind: "category", id: g.categoryId!, shelf: s.id }),
                              s.id,
                            )}
                            style={{
                              ...grip(held || (rowDrag?.kind === "category" && rowDrag.id === g.categoryId), !g.categoryId),
                              cursor:
                                rowDrag?.kind === "category" && rowDrag.id === g.categoryId ? "grabbing" : "grab",
                              touchAction: "none",
                            }}
                          >
                            ⠿
                          </button>
                          <CatName
                            name={g.name}
                            disabled={!g.categoryId}
                            onRename={(v) => g.categoryId && run(() => categoryRename(g.categoryId!, v))}
                          />
                          <span style={{ font: "500 .625rem var(--ui)", color: "var(--faint)" }}>
                            {num(g.books.length)}
                          </span>
                          <span style={{ flex: 1, height: 1, background: "var(--rule)" }} />
                          {g.categoryId && (
                            <button
                              title={t("lib.deleteCategory")}
                              aria-label={t("lib.deleteCategory")}
                              onClick={() =>
                                setConfirmCat(
                                  confirmCat?.cat === g.categoryId ? null : { shelf: s.id, cat: g.categoryId! },
                                )
                              }
                              style={{ width: 22, height: 22, borderRadius: 6, color: "var(--faint)", fontSize: 11 }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      )}

                      {confirmCat?.cat === g.categoryId && (
                        <ConfirmBar
                          text={`${t("lib.deleteCategory")} · ${t("lib.moveBooksTo")}`}
                          targets={[
                            { id: "", label: t("lib.uncategorised") },
                            ...s.categories
                              .filter((x) => x.id !== g.categoryId)
                              .map((x) => ({ id: x.id, label: x.name })),
                          ]}
                          onPick={(id) => removeCategory(s, g.categoryId!, id || null)}
                          onCancel={() => setConfirmCat(null)}
                        />
                      )}

                      <div
                        ref={(el) => {
                          if (el) lists.current.set(k, el);
                          else lists.current.delete(k);
                        }}
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "stretch",
                          gap: 7,
                          minHeight: 44,
                          borderRadius: 9,
                          marginBottom: 10,
                          ...(hand?.kind === "book" && takeable
                            ? { outline: "1px dashed var(--brd)", outlineOffset: 6 }
                            : {}),
                          ...(hand?.kind === "book" && !takeable ? { opacity: 0.4 } : {}),
                        }}
                      >
                        {g.books.map((b, i) => (
                          <Chip
                            key={b.id}
                            book={b}
                            takeable={takeable}
                            held={hand?.kind === "book" && hand.id === b.id}
                            slotBefore={
                              target?.shelfId === s.id &&
                              target.catId === g.categoryId &&
                              target.index === i &&
                              hand?.kind === "book"
                            }
                            onLift={() => {
                              draggedRef.current = false;
                              setHand({ kind: "book", id: b.id, fromShelf: s.id });
                            }}
                            onHold={(ms) => {
                              if (holdRef.current) window.clearTimeout(holdRef.current);
                              holdRef.current = window.setTimeout(() => {
                                holdRef.current = null;
                                draggedRef.current = false;
                                setHand({ kind: "book", id: b.id, fromShelf: s.id });
                              }, ms);
                            }}
                            onRelease={() => {
                              if (holdRef.current) window.clearTimeout(holdRef.current);
                              holdRef.current = null;
                            }}
                            onDetails={() => props.onOpenBookDetails(b)}
                          />
                        ))}
                        {target?.shelfId === s.id &&
                          target.catId === g.categoryId &&
                          target.index >= g.books.length &&
                          hand?.kind === "book" && <DropSlot />}
                        {g.books.length === 0 && (
                          <span style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", padding: "6px 2px" }}>
                            {s.auto_rule ? t("lib.shelfRow.empty") : t("lib.emptyShelf")}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {!s.auto_rule &&
                  (creatingCatIn === s.id ? (
                    <input
                      autoFocus
                      value={draft}
                      dir="auto"
                      placeholder={t("lib.newCategory")}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        else if (e.key === "Escape") {
                          setCreatingCatIn(null);
                          setDraft("");
                        }
                      }}
                      onBlur={() => {
                        const v = draft.trim();
                        setCreatingCatIn(null);
                        setDraft("");
                        if (v) run(() => categoryCreate(s.id, v));
                      }}
                      style={{
                        marginTop: 10,
                        width: 240,
                        background: "var(--soft)",
                        border: "1px solid var(--brd)",
                        borderRadius: 8,
                        padding: "7px 10px",
                        font: "500 .8125rem var(--ui)",
                        outline: "none",
                      }}
                    />
                  ) : (
                    <button
                      className="libd-hov libd-hov-txt"
                      onClick={() => {
                        setDraft("");
                        setCreatingCatIn(s.id);
                      }}
                      style={{
                        marginTop: 10,
                        font: "500 .6875rem var(--ui)",
                        color: "var(--mut)",
                        border: "1px dashed var(--brd)",
                        borderRadius: 20,
                        padding: "4px 12px",
                      }}
                    >
                      {t("lib.newCategory")}
                    </button>
                  ))}
              </div>
            );
          })}

          {/* The bar's last position: after every shelf. Without it the bottom of the list is the
              one place a drag cannot reach. */}
          {rowDrag?.kind === "shelf" && rowDropAt === c.shelves.length - 1 && insertionBar}
          {hand?.kind === "shelf" && (
            <button
              onClick={() => run(() => shelfReorder(hand.id, c.shelves.length)).then(() => setHand(null))}
              style={{ display: "block", width: "100%", padding: "6px 0" }}
              aria-label={t("lib.placeHere")}
            >
              <span style={{ display: "block", height: 2, borderRadius: 1, background: "var(--acc)" }} />
            </button>
          )}

          {creatingShelf && (
            <input
              autoFocus
              value={draft}
              dir="auto"
              placeholder={t("lib.shelf.namePlaceholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  setCreatingShelf(false);
                  setDraft("");
                }
              }}
              onBlur={() => {
                const v = draft.trim();
                setCreatingShelf(false);
                setDraft("");
                if (v) run(() => shelfCreate(v, props.unfiled ? null : c.id));
              }}
              style={{
                marginTop: 12,
                width: 280,
                background: "var(--soft)",
                border: "1px solid var(--brd)",
                borderRadius: 8,
                padding: "8px 11px",
                font: "500 .8125rem var(--ui)",
                outline: "none",
              }}
            />
          )}
        </div>

        {/* ---- foot ---- */}
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "13px 24px",
            borderTop: "1px solid var(--brd)",
          }}
        >
          <button
            className="libd-hov"
            onClick={() => {
              setDraft("");
              setCreatingShelf(true);
            }}
            style={{
              height: 30,
              padding: "0 13px",
              borderRadius: 9,
              border: "1px solid var(--brd)",
              background: "var(--chr)",
              font: "500 .75rem var(--ui)",
            }}
          >
            {t("lib.newShelf")}
          </button>
          <span
            style={{
              flex: 1,
              font: "400 .75rem/1.4 var(--ui)",
              color: confirmCase ? "#c0503a" : hand ? "var(--acc)" : "var(--faint)",
            }}
          >
            {confirmCase
              ? t("lib.case.deleteConfirm")
              : hand?.kind === "book"
                ? `${t("lib.inHand")} · ${t("lib.editorHint")}`
                : hand
                  ? `${t("lib.inHand")} · ${t("lib.pickRow")}`
                  : t("lib.editorHint")}
          </span>
          {hand && (
            <button
              className="libd-hov libd-hov-txt"
              onClick={() => {
                setHand(null);
                setTarget(null);
              }}
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
          )}
          {/* No case to delete when this panel is standing in for the unfiled group. */}
          {!props.unfiled &&
            (confirmCase ? (
              <>
                <button
                  className="libd-hov"
                  onClick={() => setConfirmCase(false)}
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
                <button
                  className="libd-hov"
                  onClick={async () => {
                    let ok = true;
                    try {
                      await caseDelete(c.id);
                    } catch (e) {
                      console.error(e);
                      ok = false;
                    }
                    props.notify(ok ? t("lib.case.deleted", { name: c.name }) : t("lib.writeFailed"));
                    props.onChanged();
                    if (ok) props.onClose();
                    else setConfirmCase(false);
                  }}
                  style={{
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 9,
                    border: "1px solid #c0503a",
                    font: "600 .75rem var(--ui)",
                    color: "#c0503a",
                  }}
                >
                  {t("lib.case.deleteYes")}
                </button>
              </>
            ) : (
              <button
                className="libd-hov"
                onClick={() => setConfirmCase(true)}
                style={{ height: 30, padding: "0 12px", borderRadius: 9, font: "500 .75rem var(--ui)", color: "#c0503a" }}
              >
                {t("lib.deleteCase")}
              </button>
            ))}
          <button
            className="libd-hov-bright"
            onClick={props.onClose}
            style={{
              height: 30,
              padding: "0 16px",
              borderRadius: 9,
              background: "var(--acc)",
              color: "var(--pap)",
              font: "600 .75rem var(--ui)",
            }}
          >
            {t("lib.done")}
          </button>
        </div>
      </div>

      {/* The shelf or category in hand, following the pointer — the same ghost the case grip
          shows in the sidebar, so a drag reads as carrying something at every level. */}
      {rowDrag && (
        <div
          ref={rowGhost}
          aria-hidden
          style={{
            position: "fixed",
            insetBlockStart: 0,
            insetInlineStart: 0,
            zIndex: 210,
            pointerEvents: "none",
            padding: "5px 11px",
            borderRadius: 7,
            border: "1px solid var(--brd)",
            borderInlineStart: "3px solid var(--acc)",
            background: "var(--chr)",
            boxShadow: "var(--sh3)",
            font: "600 .8125rem var(--ui)",
            color: "var(--txt)",
            opacity: 0.95,
          }}
        >
          {rowDrag.kind === "shelf"
            ? (c.shelves.find((x) => x.id === rowDrag.id)?.name ?? "")
            : (c.shelves
                .find((x) => x.id === rowDrag.shelf)
                ?.categories.find((k) => k.id === rowDrag.id)?.name ?? "")}
        </div>
      )}

      {/* the ghost that follows the pointer while a book is carried */}
      {handBook && (
        <div
          ref={ghostRef}
          aria-hidden
          style={{
            position: "fixed",
            insetBlockStart: 0,
            insetInlineStart: 0,
            zIndex: 200,
            pointerEvents: "none",
            width: 22,
            height: 32,
            borderRadius: 2,
            boxShadow: "var(--sh3)",
            background: autoCoverPaint(displayTitle(resolveBookMeta(handBook), t)).bg,
          }}
        />
      )}
    </div>
  );
}

function DropSlot() {
  return (
    <div
      data-slot="1"
      style={{
        flex: "none",
        width: 56,
        height: 44,
        borderRadius: 8,
        border: "2px dashed var(--acc)",
        background: "var(--act)",
        animation: "sard-open .14s ease-out",
      }}
    />
  );
}

/** One book, as the editor draws it: a small row, not a cover. */
function Chip({
  book,
  takeable,
  held,
  slotBefore,
  onLift,
  onHold,
  onRelease,
  onDetails,
}: {
  book: BookRow;
  takeable: boolean;
  held: boolean;
  slotBefore: boolean;
  onLift: () => void;
  onHold: (ms: number) => void;
  onRelease: () => void;
  onDetails: () => void;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const meta = resolveBookMeta(book);
  const title = displayTitle(meta, t);
  const paint = autoCoverPaint(title);
  return (
    <>
      {slotBefore && <DropSlot />}
      <div
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => {
          setHover(false);
          onRelease();
        }}
        onPointerDown={() => takeable && onHold(180)}
        onPointerUp={onRelease}
        onClick={(e) => {
          if (!takeable) return;
          e.stopPropagation();
          onLift();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          maxWidth: 250,
          padding: "5px 7px 5px 5px",
          borderRadius: 8,
          border: `1px solid ${hover && takeable ? "var(--acc)" : "var(--brd)"}`,
          background: hover ? "var(--hov)" : "var(--pap)",
          textAlign: "start",
          cursor: takeable ? "grab" : "default",
          opacity: held ? 0.25 : 1,
        }}
      >
        <span
          style={{
            flex: "none",
            width: 22,
            height: 32,
            borderRadius: 2,
            boxShadow: "var(--sh1)",
            background: paint.bg,
          }}
        />
        <span
          dir="auto"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            font: "500 .75rem var(--ui)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            font: "500 .625rem var(--ui)",
            color: isFinished(book) ? "var(--done)" : "var(--faint)",
          }}
        >
          {pctText(book, t("lib.finished"))}
        </span>
        {hover && (
          <button
            title={t("lib.bookActions")}
            aria-label={t("lib.bookActions")}
            onClick={(e) => {
              e.stopPropagation();
              onDetails();
            }}
            style={{ flex: "none", width: 20, height: 20, borderRadius: 6, color: "var(--mut)", fontSize: 12 }}
          >
            ⋯
          </button>
        )}
      </div>
    </>
  );
}

function ConfirmBar({
  text,
  targets,
  onPick,
  onCancel,
}: {
  text: string;
  targets: { id: string; label: string }[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        margin: "0 0 12px",
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--act)",
        border: "1px solid var(--acc)",
      }}
    >
      <span style={{ font: "500 .75rem var(--ui)", color: "var(--txt)" }}>{text}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {targets.map((x) => (
          <button
            key={x.id || "__none"}
            className="libd-hov"
            onClick={() => onPick(x.id)}
            style={{
              height: 28,
              padding: "0 11px",
              borderRadius: 8,
              border: "1px solid var(--brd)",
              background: "var(--chr)",
              font: "500 .75rem var(--ui)",
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <button onClick={onCancel} style={{ font: "500 .75rem var(--ui)", color: "var(--mut)" }}>
        {t("lib.cancel")}
      </button>
    </div>
  );
}

function ShelfName({ shelf, onRename }: { shelf: ShelfNode; onRename: (v: string) => void }) {
  const [v, setV] = useState(shelf.name);
  useEffect(() => setV(shelf.name), [shelf.id, shelf.name]);
  return (
    <input
      value={v}
      dir="auto"
      disabled={!!shelf.auto_rule}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== shelf.name && onRename(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      style={{
        minWidth: 0,
        flex: "0 1 240px",
        background: "var(--soft)",
        border: "1px solid var(--brd)",
        borderRadius: 7,
        padding: "5px 9px",
        font: "600 .8125rem var(--ui)",
        color: "var(--txt)",
        outline: "none",
        opacity: shelf.auto_rule ? 0.6 : 1,
      }}
    />
  );
}

function CatName({
  name,
  disabled,
  onRename,
}: {
  name: string;
  disabled: boolean;
  onRename: (v: string) => void;
}) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <input
      value={v}
      dir="auto"
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== name && onRename(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      style={{
        minWidth: 0,
        flex: "0 1 200px",
        background: disabled ? "transparent" : "var(--soft)",
        border: `1px solid ${disabled ? "transparent" : "var(--brd)"}`,
        borderRadius: 6,
        padding: "3px 7px",
        font: "600 .6875rem var(--ui)",
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: "var(--mut)",
        outline: "none",
      }}
    />
  );
}
