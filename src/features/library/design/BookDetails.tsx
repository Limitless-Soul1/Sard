// Book Details.
//
// SOURCE: the `bookModel` block of the reference bundles — byte-identical in `Sard Library
// (standalone).html` and `Sard Library - Vista (standalone).html`, so this dialog has one
// unambiguous source. It replaces Sard's older EditBook wherever the design's views open a book.
//
// Everything it edits is stored the way RAWY-19 already stored a cover fit: as a row in
// `metadata_overrides`, never a rewrite of the source EPUB. Clearing a control returns the book
// to what Sard derives for it rather than to a second stored default.

import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { BookRow, CaseNode, ShelfNode } from "../../../lib/ipc";
import {
  bookClearSpine,
  bookCommitCover,
  bookCommitSpine,
  bookRevertCover,
  bookStageCover,
  bookStageSpine,
  bookUpdate,
  collectionRemoveBook,
  libraryAddBookToShelf,
  libraryPlaceBook,
  progressSave,
} from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { openTransient } from "./transient";
import { useSettledBusy } from "./busy";
import {
  awaitsShelfChoice, isFinished, progressPct } from "./model";
import { coverPresentation, type CoverMode } from "./coverPresentation";
import { displayFace, labelFace, scriptOf } from "../../../lib/typography";

import {
  draftFromBook,
  draftWithNoPaint,
  draftWithOriginalCover,
  draftWithPaint,
  isDirty,
  patchFromDraft,
  previewRow,
  type BookDraft,
} from "./bookEdits";
import { useScrimDismiss, useDialog } from "../../../components/useDialog";
import { Icon } from "../../../components/Icon";


/** The dialog's palette, exactly as authored. */
const PALETTE = [
  "#2C3A42", "#9C5A3C", "#B5727B", "#2E5A55", "#16140F", "#D8C29A",
  "#5E6B49", "#3E4C6B", "#7A4B2E", "#3A5A4F", "#8C2F39", "#4A3B5E",
];

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "svg", "bmp", "ico"];

const chip = (on: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 30,
  padding: "0 12px",
  borderRadius: 9,
  font: "500 .75rem var(--ui)",
  border: `1px solid ${on ? "var(--acc)" : "var(--brd)"}`,
  color: on ? "var(--acc)" : "var(--mut)",
  background: on ? "var(--act)" : "var(--pap)",
});

/** A standing label above a field — visible whether or not the field has a value. */
const fieldLabel: React.CSSProperties = {
  display: "block",
  marginBottom: 4,
  font: "600 .625rem var(--ui)",
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: "var(--faint)",
  textAlign: "start",
};

const legend: React.CSSProperties = {
  font: "600 .625rem var(--ui)",
  letterSpacing: ".13em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 9,
};

export interface BookDetailsProps {
  book: BookRow;
  cases: CaseNode[];
  loose: ShelfNode[];
  /** Which shelf currently holds this book, and the case above it. */
  /**
   * EVERY SHELF THIS BOOK IS ON, in the arrangement's order. Empty for a book on no shelf.
   *
   * Plural because a book may sit on «روايات عربية» and «المفضلة» at once and must be shown on
   * both. It was a single placement, which forced whoever computed it to choose one of several and
   * present it as the answer — and a panel that then offered «move» against that choice would
   * destroy a membership the reader never named.
   */
  placements: { caseNode: CaseNode | null; shelf: ShelfNode; categoryId: string | null }[];
  /** The Library toast — a failed organisation write says so rather than doing nothing visible. */
  notify: (msg: string) => void;
  onClose: () => void;
  /** Re-read the library after any write. */
  onChanged: () => void;
  /** The library's own Crop/Fit setting, which a book with no per-book fit follows. */
  libraryCoverMode: CoverMode;
}


/**
 * THE DESTINATIONS, AS PART OF THE SECTION RATHER THAN A CARD OVER IT.
 *
 * It was a floating panel: absolutely positioned, on the menu surface, with a shadow and a flip for
 * when it ran off the window. Inside an already-floating dialog that reads as a second, unrelated
 * rectangle — it overlapped the controls beneath it, it had to guess which way to open, and its
 * relationship to the button that summoned it was something the reader had to infer from proximity.
 *
 * Opening IN THE FLOW removes all of that. There is no anchoring, no collision, no stacking order
 * and no way for it to escape the dialog, because it is inside the dialog's own column and the
 * dialog scrolls it like everything else. What is left to design is the only thing that mattered:
 * the hierarchy.
 *
 * CABINET → SHELF, IN SARD'S OWN IDIOM. The sidebar already draws this relationship — a cabinet
 * with its ink, and its shelves indented off a rail beneath it — so the chooser draws it the same
 * way rather than inventing a second grammar for the same fact. A flat list of shelf names with a
 * heading above them, which is what this was, reads as one column of equals: «روايات» sat in the
 * same place and nearly the same weight as «test1» underneath it.
 *
 * The ink dot is what finally separates two shelves called «المفضّلة»: they hang off different
 * rails, under different colours.
 */
function Chooser(props: {
  groups: { id: string; name: string; ink: string | null; items: { id: string; name: string }[] }[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
  /** Show the search field once the list is at least this long. */
  searchFrom: number;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  // BRING IT INTO VIEW. It opens in the dialog's own column, below a button that may itself be near
  // the foot of the scroll — so without this the panel appears somewhere the reader cannot see and
  // the press looks as though it did nothing.
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  // Escape closes it. Nothing else is needed: it is in the flow, so a press elsewhere is a press on
  // whatever it lands on, and the button that opened it is a toggle.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); }
    };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [props.onClose]);

  const total = props.groups.reduce((n, g) => n + g.items.length, 0);
  const needle = q.trim().toLowerCase();
  const shown = props.groups
    .map((g) => ({
      ...g,
      items: needle
        ? g.items.filter((it) => it.name.toLowerCase().includes(needle) || g.name.toLowerCase().includes(needle))
        : g.items,
    }))
    .filter((g) => g.items.length);

  return (
    <div
      ref={box}
      data-chooser="1"
      style={{
        marginTop: 8,
        border: "1px solid var(--brd)",
        borderRadius: "var(--r-md)",
        background: "var(--pap)",
        overflow: "hidden",
        animation: "sard-rise .12s ease-out",
      }}
    >
      {total >= props.searchFrom && (
        <div style={{ padding: "8px 8px 4px" }}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("lib.searchShelves")}
            style={{
              width: "100%",
              height: 30,
              padding: "0 10px",
              borderRadius: 8,
              border: "1px solid var(--brd)",
              background: "var(--chr)",
              color: "var(--txt)",
              font: "500 .75rem var(--ui)",
            }}
          />
        </div>
      )}
      <div className="libd-quietscroll" style={{ maxHeight: 236, overflowY: "auto", padding: "4px 0 8px" }}>
        {shown.length === 0 && (
          <div style={{ padding: "10px 13px", font: "400 .75rem var(--ui)", color: "var(--faint)" }}>
            {t("lib.noMatchingShelf")}
          </div>
        )}
        {shown.map((g) => (
          <div key={g.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 13px 4px" }}>
              {/* THE CABINET'S OWN INK, the same 7px square the tree and the case chips carry. */}
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: g.ink ?? "var(--faint)",
                }}
              />
              <span
                style={{
                  font: "600 .6875rem var(--ui)",
                  color: "var(--mut)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {g.name}
              </span>
            </div>
            {/* THE SHELVES HANG OFF A RAIL, indented under their cabinet — the sidebar's own
                arrangement, so the relationship needs no explaining. */}
            <div
              style={{
                marginInlineStart: 16,
                paddingInlineStart: 6,
                borderInlineStart: "1px solid var(--brd)",
              }}
            >
              {g.items.map((it) => (
                <button
                  key={it.id || "none"}
                  className="libd-hov"
                  data-pick={it.id}
                  onClick={() => props.onPick(it.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "none",
                    textAlign: "start",
                    cursor: "pointer",
                    font: "500 .8125rem var(--ui)",
                    background: props.current === it.id ? "var(--act)" : "transparent",
                    color: props.current === it.id ? "var(--txt)" : "var(--txt)",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BookDetails(props: BookDetailsProps) {
  const { t, lang } = useI18n();
  const num = (n: number) => localeNum(n, lang);
  const [book, setBook] = useState<BookRow>(props.book);
  // Every field edit lands HERE, not in the database. Save writes the difference; Cancel throws
  // it away. Image and shelf actions still act immediately — those move files and memberships,
  // which is not something a buffer can hold honestly.
  const [draft, setDraft] = useState<BookDraft>(() => draftFromBook(props.book));
  const [busy, setBusy] = useState(false);
  // `busy` stays the truth about whether a write is running; this is whether it has run long enough
  // to be worth showing. A shelf change against a local database finishes in about eleven
  // milliseconds, and dimming for eleven milliseconds is a flash rather than feedback — see
  // `useSettledBusy`, which is where the reasoning and the threshold live.
  const showBusy = useSettledBusy(busy);

  useEffect(() => {
    setBook(props.book);
    setDraft(draftFromBook(props.book));
  }, [props.book]);

  const edit = (next: Partial<BookDraft>) => setDraft((d) => ({ ...d, ...next }));

  // The dialog previews the DRAFT, so every control shows its effect before it is saved.
  const preview = previewRow(book, draft);
  const meta = resolveBookMeta(preview);
  const shown = displayTitle(meta, t);

  /**
   * THE PANEL ANSWERS TO ESCAPE, like every other surface that covers the library.
   *
   * Measured before this existed: Escape did nothing at all here. Vista's own handler already
   * defers while this panel is open — `if (detailsFor || …) return` — precisely so the key is not
   * spent navigating out from under an open dialog. But nothing then consumed it, so the most
   * modal surface in the library was the one surface the key could not close.
   *
   * Joining the stack also means a book menu opened behind it cannot outlive it. It does NOT mean
   * the stack takes the press outside: that listener sees only the press, and this sheet needs both
   * ends of the gesture to tell a dismissal from a title dragged a pixel too far. The scrim below
   * owns it.
   */
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    // NOT by an outside press: the scrim below owns that gesture, and it needs both ends of it.
    () => openTransient(props.onClose, () => dialogRef.current, { outsidePress: false }),
    [props.onClose],
  );
  /**
   * ESCAPE IS ALREADY THIS DIALOG'S OWN — `openTransient` owns the stack that closes the nearest
   * layer first. So no `onDismiss` here: two handlers for one key would be two chances to close
   * the wrong thing. What was missing is everything else a modal owes a keyboard —
   * the trap, and giving focus back to the tile that opened it.
   */
  const dlg = useDialog({ label: shown, initialFocus: "none" });
  // The backdrop takes a press only when the gesture began there and ends clear of the sheet.
  const scrim = useScrimDismiss(props.onClose);

  const arabic = scriptOf(shown, book.dir) === "arabic";
  const derived = autoCoverPaint(shown);
  const src = coverSrc(book);
  const jacketSrc = draft.coverMode === "typeset" ? null : src;
  const pres = coverPresentation(preview, !!src, derived, props.libraryCoverMode);
  const paint = pres.paint;
  const ink = pres.ink;
  const typeset = pres.kind === "typeset";
  const spineMode = draft.spineMode;
  const spineSrc = book.spine_image ? convertFileSrc(book.spine_image) : null;
  const pct = progressPct(book);
  const done = isFinished(book);
  const dirty = isDirty(draft, book);
  // `save` is declared above the placement rows that compute it, so the message reaches it by ref.
  const awaitingShelfRef = useRef<string | null>(null);
  // Raised when Save is pressed over an unfinished placement, so the footer can answer the press
  // rather than the dialog simply not closing.
  const [refused, setRefused] = useState(false);

  const save = async () => {
    // A pending case choice is not a placement, and Save may not pretend it was. The dialog stays
    // open and says what is still needed, rather than closing over a move that never happened.
    if (awaitingShelfRef.current) {
      setRefused(true);
      return;
    }
    const p = patchFromDraft(draft, book);
    if (Object.keys(p).length === 0) {
      props.onClose();
      return;
    }
    setBusy(true);
    const next = await bookUpdate(book.id, p).catch(() => null);
    setBusy(false);
    if (next) setBook(next);
    props.onChanged();
    props.onClose();
  };

  const cancel = () => {
    setDraft(draftFromBook(book));
    props.onClose();
  };

  const chooseCover = async () => {
    const sel = await openDialog({ multiple: false, filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }] });
    if (typeof sel !== "string") return;
    setBusy(true);
    try {
      const staged = await bookStageCover(book.id, sel);
      const next = await bookCommitCover(book.id, staged.rel);
      if (next) setBook(next);
      // Choosing an image means showing it.
      await bookUpdate(book.id, { coverMode: "file" }).catch(() => {});
      props.onChanged();
    } catch {
      /* the staging path reports its own failure; the dialog simply stays open */
    }
    setBusy(false);
  };

  const chooseSpine = async () => {
    const sel = await openDialog({ multiple: false, filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }] });
    if (typeof sel !== "string") return;
    setBusy(true);
    try {
      const staged = await bookStageSpine(book.id, sel);
      const next = await bookCommitSpine(book.id, staged.rel);
      if (next) setBook(next);
      props.onChanged();
    } catch {
      /* staging reports its own failure; the dialog stays open on the current spine */
    }
    setBusy(false);
  };

  const clearSpine = async () => {
    setBusy(true);
    const next = await bookClearSpine(book.id).catch(() => null);
    if (next) setBook(next);
    setBusy(false);
    props.onChanged();
  };

  /**
   * "Restore original" — the whole jacket, not just the file.
   *
   * It reverts the cover image to the one extracted from the book AND clears the chosen paint,
   * mode and fit in the draft. Reverting only the file left those three still in force, so the
   * jacket visibly did not return to its original state and the button read as doing nothing.
   */
  const restoreOriginal = async () => {
    setBusy(true);
    const next = await bookRevertCover(book.id).catch(() => null);
    if (next) setBook(next);
    setBusy(false);
    setDraft((d) => draftWithOriginalCover(d));
    props.onChanged();
  };

  // ---- the assignment path -------------------------------------------------
  //
  // Case → Shelf → Category, and the first of those three needs A STATE OF ITS OWN.
  //
  // It had none: every level read straight off `placement`, i.e. off where the book ALREADY sat.
  // So choosing a case could not be a step — it had to be a write, and the code made it one by
  // silently filing the book onto whatever shelf happened to be first in that case. Which meant a
  // case with no shelves yet (or only rule shelves) had no first shelf, the click did nothing at
  // all, and the case was rendered but not selectable. It also meant the shelf list could never
  // show a case's shelves until the book was already in that case — the dependency ran backwards.
  //
  // `pickedCase` is that missing step: `undefined` follows the book, `null` means "not in a case",
  // a string names one. Choosing a case only narrows the shelf list; the write happens when a
  // SHELF is chosen, which is the level that actually corresponds to a membership row.
  const places = props.placements;
  /**
   * THE THREE STATES THIS PANEL HAS TO TELL APART.
   *
   * `place` alone cannot: it is null both for a book on NO shelf and for a book on SEVERAL, and the
   * panel read that null as «not filed» everywhere. A book on two shelves was therefore shown its
   * own memberships and told, underneath them, that it was not on any shelf yet — and «خارج
   * الخزائن» was lit in the cabinet row because no single cabinet could be named.
   *
   * The count is the honest source. Nothing below asks `place` a question it cannot answer.
   */
  const multi = places.length > 1;
  const unfiled = places.length === 0;
  /**
   * THE MEMBERSHIP THE PANEL'S SINGLE-DESTINATION CONTROLS ACT ON — and null unless there is
   * exactly one.
   *
   * The case/shelf/category picker below edits ONE destination: it can say «put it there» and has
   * no way to say «and also there». That is still the right shape for a book on one shelf, and for
   * such a book everything here behaves exactly as it did. For a book on several there is no single
   * destination to edit, so this is null and those controls fall quiet — the memberships are shown
   * and removed individually above, and «add to another shelf» below is the additive verb.
   */
  const place = places.length === 1 ? places[0] : null;
  const [pickedCase, setPickedCase] = useState<string | null | undefined>(undefined);
  useEffect(() => setPickedCase(undefined), [book.id]);

  // `undefined` is «the reader has chosen nothing», and for a book across several cabinets that is
  // the only true answer. It matches no chip, so none is lit — where `null` would have lit «خارج
  // الخزائن» and told the reader the book is outside every cabinet while listing it inside two.
  const effectiveCaseId: string | null | undefined =
    pickedCase !== undefined ? pickedCase : multi ? undefined : (place?.caseNode?.id ?? null);
  const effectiveCase = effectiveCaseId ? (props.cases.find((c) => c.id === effectiveCaseId) ?? null) : null;
  // A rule shelf fills itself, so it can never be a destination — at any level.
  const shelvesOf = (c: CaseNode | null) =>
    (c ? c.shelves : props.loose).filter((s) => !s.auto_rule);

  /**
   * EVERY SHELF IN THE LIBRARY THAT CAN HOLD A BOOK, with the cabinet that contains it.
   *
   * The additive row used to offer `shelvesOf(effectiveCase)` — the shelves of the chosen cabinet —
   * and a multi-shelf book has no chosen cabinet, so it was offered the LOOSE shelves and nothing
   * else. Measured: a book on two shelves of «خزانة الروايات» was offered «بسيب» and «أرشيف».
   * Adding is not a hierarchy: it names one shelf, so it lists them all and carries each one's
   * cabinet, which is also what tells two shelves of the same name apart.
   */
  const everyShelf: { shelf: ShelfNode; caseNode: CaseNode | null }[] = [
    ...props.cases.flatMap((c) => c.shelves.map((sh) => ({ shelf: sh, caseNode: c }))),
    ...props.loose.map((sh) => ({ shelf: sh, caseNode: null })),
  ].filter((e) => !e.shelf.auto_rule);
  const addable = everyShelf.filter((e) => !places.some((pl) => pl.shelf.id === e.shelf.id));

  /** Which popover is open: the destination list, or one membership's categories. */
  const [choosing, setChoosing] = useState<null | { mode: "add" } | { mode: "move"; from: string }>(null);
  const [catFor, setCatFor] = useState<string | null>(null);
  useEffect(() => { setChoosing(null); setCatFor(null); }, [book.id]);

  /**
   * The destinations, grouped by the cabinet that holds them.
   *
   * `exclude` is the shelf a MOVE is leaving: it is not a destination for itself, and the shelves
   * the book is already on are not destinations at all — adding to one is a no-op and moving to one
   * would read as a move that did nothing.
   */
  const destinationGroups = (exclude: string | null) => {
    const free = everyShelf.filter(
      (e) => e.shelf.id !== exclude && !places.some((pl) => pl.shelf.id === e.shelf.id),
    );
    const out: { id: string; name: string; ink: string | null; items: { id: string; name: string }[] }[] = [];
    for (const c of props.cases) {
      const items = free.filter((e) => e.caseNode?.id === c.id).map((e) => ({ id: e.shelf.id, name: e.shelf.name }));
      if (items.length) out.push({ id: c.id, name: c.name, ink: c.ink ?? null, items });
    }
    const loose = free.filter((e) => !e.caseNode).map((e) => ({ id: e.shelf.id, name: e.shelf.name }));
    if (loose.length) out.push({ id: "__loose", name: t("lib.unfiled"), ink: null, items: loose });
    return out;
  };

  /** MOVE ONE MEMBERSHIP: arrive at the chosen shelf, leave the row's own — and no other. */
  const moveMembership = async (from: string, to: ShelfNode) => {
    setBusy(true);
    try {
      await libraryPlaceBook(book.id, to.id, null, null, from);
    } catch (e) {
      console.error(e);
      props.notify(t("lib.writeFailed"));
    }
    setBusy(false);
    props.onChanged();
  };

  /** The category of ONE membership. `libraryAddBookToShelf` against a shelf the book is already
      on writes the category alone and leaves the rank, which is what re-grouping means. */
  const setCategory = async (shelfId: string, categoryId: string | null) => {
    setBusy(true);
    try {
      await libraryAddBookToShelf(book.id, shelfId, categoryId);
    } catch (e) {
      console.error(e);
      props.notify(t("lib.writeFailed"));
    }
    setBusy(false);
    props.onChanged();
  };


  /**
   * TAKE THE BOOK OFF ONE SHELF — that shelf, and no other.
   *
   * Named rather than implied. It used to remove «the» shelf the book was on, which only had a
   * meaning while a book had one. The book itself is untouched: one row, one file, one reading
   * position, and every other shelf it is on keeps it.
   */
  const removeFrom = async (shelfId: string) => {
    setBusy(true);
    try {
      await collectionRemoveBook(shelfId, book.id);
    } catch (e) {
      console.error(e);
      props.notify(t("lib.writeFailed"));
    }
    setBusy(false);
    props.onChanged();
  };

  /**
   * ADD THE BOOK TO ANOTHER SHELF, KEEPING EVERY SHELF IT IS ALREADY ON.
   *
   * The additive verb, and a separate call from the move above rather than the same one with a
   * flag — `libraryAddBookToShelf` against `shelfPlaceBook`. Nothing is removed, nothing is
   * duplicated: the same canonical book gains one more membership, which is what makes it appear
   * on that shelf as well as where it already was.
   *
   * Idempotent from underneath, so the action can be offered without first knowing the answer: the
   * primary key is (book, shelf), and the reply says whether anything was actually written.
   */
  const addToShelf = async (shelf: ShelfNode) => {
    setBusy(true);
    try {
      const res = await libraryAddBookToShelf(book.id, shelf.id, null);
      props.notify(
        t(res.placed.changed ? "lib.addedToShelf" : "lib.alreadyOnShelf").replace("{shelf}", shelf.name),
      );
    } catch (e) {
      console.error(e);
      props.notify(t("lib.writeFailed"));
    }
    setBusy(false);
    props.onChanged();
  };

  const toggleRead = async () => {
    await progressSave(book.id, "", done ? 0 : 1).catch(() => {});
    props.onChanged();
  };

  const jacket = (w: number, h: number) => (
    <div
      style={{
        flex: "none",
        width: w,
        height: h,
        borderRadius: "var(--r-xs)",
        boxShadow: "var(--sh2)",
        position: "relative",
        overflow: "hidden",
        background: typeset ? paint : "var(--lbox)",
      }}
    >
      {typeset ? (
        <>
          <div style={{ position: "absolute", inset: 6, border: "1px solid rgba(255,255,255,.16)" }} />
          <div
            style={{
              position: "absolute",
              insetInline: "9%",
              top: "15%",
              textAlign: "center",
              color: ink,
              font: `${arabic ? 700 : 600} ${arabic ? ".875rem/1.4" : ".8125rem/1.25"} ${displayFace(arabic)}`,
            }}
          >
            {shown}
          </div>
        </>
      ) : (
        // The PREVIEW honours the pending fit, which is what makes Crop / Contain / Default
        // visibly different before Save rather than three buttons that look the same.
        <img
          src={jacketSrc ?? undefined}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: pres.objectFit, display: "block" }}
        />
      )}
    </div>
  );

  // A CASE IS NOT A DESTINATION, and the dialog has to say so.
  //
  // Choosing a case only narrows the shelves below it — a case contains shelves, so it cannot answer
  // "which shelf?". The two rows used to look like one destination control with Save underneath, so
  // picking a case and pressing Save read as "file it there" and did nothing at all, silently.
  // `awaitingShelf` is that state, named: the reader has aimed at a case the book is not in and has
  // not yet chosen a shelf inside it.
  const currentCaseId = place?.caseNode?.id ?? null;
  // Nothing chosen is not a pending choice: a book across several cabinets starts with no chip
  // lit, and that is a resting state rather than a half-finished one.
  const awaitingShelf =
    effectiveCaseId === undefined
      ? false
      : awaitsShelfChoice(currentCaseId, effectiveCaseId, shelvesOf(effectiveCase).length);
  const chooseShelfHere = effectiveCase
    ? t("lib.chooseShelfInCase", { name: effectiveCase.name })
    : t("lib.chooseLooseShelf");

  awaitingShelfRef.current = awaitingShelf ? chooseShelfHere : null;
  if (refused && !awaitingShelf) setRefused(false);


  return (
    <div
      // The backdrop dismisses only a gesture that BEGAN on it and ends clear of the sheet — see
      // `useScrimDismiss`. Editing a title and releasing a pixel past the field used to close the
      // whole sheet, because a click is dispatched at the common ancestor of press and release.
      {...scrim.scrimProps}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 170,
        background: "rgba(0,0,0,.34)",
        display: "grid",
        placeItems: "center",
        animation: "sard-fade .14s ease-out",
      }}
    >
      <div
        className="libd-dialog"
        ref={(node) => { dialogRef.current = node; dlg.ref(node); scrim.panelRef(node); }}
        // It behaves as a modal — it covers the library, takes the press outside, and answers to
        // Escape — so it has to SAY it is one. Without this a screen reader announces an anonymous
        // group and never tells the reader that the surface behind it has gone inert.
        {...dlg.props}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "block",
          width: "min(640px,92%)",
          maxHeight: "88%",
          overflowY: "auto",
          background: "var(--chr)",
          border: "1px solid var(--brd)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--sh4)",
          animation: "sard-rise .16s ease-out",
          opacity: showBusy ? 0.75 : 1,
          // A step is a flash; a fade is a state. Only ever seen when the write is genuinely slow.
          transition: "opacity .12s ease-out",
        }}
      >
        {/* ---- head: jacket, editable name, the book's own facts ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 20,
            padding: "22px 24px 18px",
            borderBottom: "1px solid var(--brd)",
          }}
        >
          {jacket(96, 144)}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...legend, marginBottom: 10 }}>{t("lib.bookDetails")}</div>
            {/* Both fields carry a STANDING label, not a placeholder. A placeholder disappears the
                moment the reader types and is absent again once they clear the field, which is
                exactly when "which box is the author?" needs answering. `htmlFor`/`id` ties each
                label to its box for a screen reader too, and both follow the UI direction. */}
            <label htmlFor="bd-title" style={fieldLabel}>
              {t("lib.fieldTitle")}
            </label>
            <input
              id="bd-title"
              value={draft.title}
              dir="auto"
              onChange={(e) => edit({ title: e.target.value })}
              style={{
                width: "100%",
                background: "var(--soft)",
                border: "1px solid var(--brd)",
                borderRadius: "var(--r-md)",
                padding: "7px 10px",
                outline: "none",
                font: `${arabic ? 700 : 600} ${arabic ? "1.125rem" : "1rem"} ${labelFace(arabic)}`,
                color: "var(--txt)",
              }}
            />
            <label htmlFor="bd-author" style={{ ...fieldLabel, marginTop: 9 }}>
              {t("lib.fieldAuthor")}
            </label>
            <input
              id="bd-author"
              value={draft.author}
              dir="auto"
              onChange={(e) => edit({ author: e.target.value })}
              style={{
                width: "100%",
                background: "var(--soft)",
                border: "1px solid var(--brd)",
                borderRadius: "var(--r-md)",
                padding: "6px 10px",
                outline: "none",
                font: `${arabic ? "400 1rem" : "400 .8125rem"} ${labelFace(arabic)}`,
                color: "var(--mut)",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: "var(--sp-5)",
                font: "500 .6875rem var(--ui)",
                color: "var(--faint)",
                flexWrap: "wrap",
              }}
            >
              <span>{(book.format ?? "").toUpperCase()}</span>
              <span>·</span>
              <span>{t("lib.pagesApprox", { n: num(Math.max(1, Math.round((book.size_bytes ?? 0) / 1400))) })}</span>
              <span>·</span>
              <span style={{ color: done ? "var(--done)" : undefined }}>
                {done ? t("lib.finished") : `${num(pct)}%`}
              </span>
              <button className="libd-hov-fade" onClick={toggleRead} style={{ color: "var(--acc)", font: "500 .6875rem var(--ui)" }}>
                {done ? t("lib.markUnread") : t("lib.markRead")}
              </button>
            </div>
          </div>
          <button
            className="libd-hov libd-hov-txt ui-close"
            onClick={props.onClose}
            aria-label={t("panel.close")}
            style={{ flex: "none", width: "var(--ctl-md)", height: "var(--ctl-md)", borderRadius: "var(--r-md)", color: "var(--mut)", fontSize: 14 }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "18px 24px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* ---- cover and spine ---- */}

          <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 250 }}>
              <div style={legend}>{t("lib.cover")}</div>
              <div style={{ font: "400 .6875rem var(--ui)", color: "var(--faint)", margin: "-4px 0 9px" }}>
                {t("lib.coverUse")}
              </div>
              <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", marginBottom: 9 }}>
                <button style={chip(typeset)} onClick={() => edit({ coverMode: "typeset" })}>
                  {t("lib.coverTypeset")}
                </button>
                <button
                  style={{ ...chip(!typeset), opacity: src ? 1 : 0.5 }}
                  disabled={!src}
                  onClick={() => edit({ coverMode: "file" })}
                >
                  {t("lib.coverFromFile")}
                </button>
                <button style={chip(false)} onClick={chooseCover}>
                  {t("lib.coverCustom")}
                </button>
                {src && (
                  <button style={chip(false)} onClick={restoreOriginal}>
                    {t("edit.revertCover")}
                  </button>
                )}
              </div>

              {/* COVER SIZING — how a cover fills its frame. RAWY-19's per-book override. */}
              <div style={{ ...legend, marginTop: "var(--sp-2)" }}>{t("lib.coverSizing")}</div>
              <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", marginBottom: 9 }}>
                {(["crop", "fit"] as const).map((m) => (
                  <button key={m} style={chip(draft.coverFit === m)} onClick={() => edit({ coverFit: m })}>
                    {t(m === "crop" ? "lib.cover.crop" : "lib.cover.fit")}
                  </button>
                ))}
                {/* Default is a real third state — no per-book fit, so the book follows the
                    library's own Crop/Fit setting rather than pinning one of its own. */}
                <button style={chip(draft.coverFit === null)} onClick={() => edit({ coverFit: null })}>
                  {t("lib.coverSizeDefault")}
                </button>
              </div>

              <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", alignItems: "center" }}>
                {/* The FIRST swatch is "no chosen paint" — it clears the override and returns the
                    book to the colour Sard derives from its title. Without it the palette was a
                    one-way door: every swatch set a paint and none could unset one. It shows that
                    derived colour, struck through, so the state it returns to is legible. */}
                <button
                  title={t("lib.coverPaintNone")}
                  aria-label={t("lib.coverPaintNone")}
                  aria-pressed={draft.coverPaint === null}
                  onClick={() => setDraft(draftWithNoPaint)}
                  style={{
                    position: "relative",
                    width: "var(--ctl-xs)",
                    height: "var(--ctl-md)",
                    borderRadius: "var(--r-xs)",
                    background: derived.bg,
                    boxShadow:
                      draft.coverPaint === null
                        ? "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)"
                        : "var(--sh1)",
                    overflow: "hidden",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      insetInline: -4,
                      top: "50%",
                      height: 1.5,
                      background: "rgba(255,255,255,.85)",
                      transform: "rotate(-52deg)",
                    }}
                  />
                </button>

                <span style={{ width: 1, height: "var(--ctl-xs)", background: "var(--brd)", flex: "none" }} />

                {PALETTE.map((k) => (
                  <button
                    key={k}
                    aria-label={k}
                    aria-pressed={draft.coverPaint === k}
                    onClick={() => setDraft((d) => draftWithPaint(d, k))}
                    style={{
                      width: "var(--ctl-xs)",
                      height: "var(--ctl-md)",
                      borderRadius: "var(--r-xs)",
                      background: k,
                      boxShadow:
                        draft.coverPaint === k
                          ? "0 0 0 2px var(--chr), 0 0 0 3.5px var(--txt)"
                          : "var(--sh1)",
                    }}
                  />
                ))}
              </div>
            </div>

            <div style={{ flex: "none", width: 250 }}>
              <div style={legend}>{t("lib.spine")}</div>
              <div style={{ font: "400 .6875rem var(--ui)", color: "var(--faint)", margin: "-4px 0 9px" }}>
                {t("lib.spineUse")}
              </div>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div
                  style={{
                    flex: "none",
                    width: "var(--ctl-2xl)",
                    height: 176,
                    borderRadius: 2,
                    boxShadow: "var(--sh2)",
                    display: "grid",
                    placeItems: "center",
                    overflow: "hidden",
                    background: spineMode === "none" ? "var(--lbox)" : paint,
                  }}
                >
                  {spineSrc ? (
                    <img
                      src={spineSrc}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  ) : spineMode === "none" ? null : (
                    <span
                      style={{
                        transform: "rotate(-90deg)",
                        whiteSpace: "nowrap",
                        maxWidth: 168,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        // The plain spine draws nothing at all now, so the only spine that reaches
                        // here is the typeset one and it uses the book's own ink.
                        color: ink,
                        font: `${arabic ? 700 : 500} ${arabic ? ".8125rem" : ".75rem"} ${labelFace(arabic)}`,
                      }}
                    >
                      {shown}
                    </span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
                  <button
                    style={chip(!spineSrc && spineMode === "typeset")}
                    onClick={() => edit({ spineMode: "typeset" })}
                  >
                    {t("lib.coverTypeset")}
                  </button>
                  <button
                    style={chip(!spineSrc && spineMode === "none")}
                    onClick={() => edit({ spineMode: "none" })}
                  >
                    {t("lib.spinePlain")}
                  </button>
                  {/* A chosen image OVERRIDES the two drawn modes, which is why it reads as
                      selected while one is set and why removing it hands the spine back to them. */}
                  <button style={chip(!!spineSrc)} onClick={chooseSpine}>
                    {spineSrc ? t("lib.spineReplace") : t("lib.spineChoose")}
                  </button>
                  {spineSrc && (
                    <button style={chip(false)} onClick={clearSpine}>
                      {t("lib.spineRemove")}
                    </button>
                  )}
                  {/* WHICH IS WHICH. Two chips named "Typeset by Sard" and "Plain" do not say what
                      they differ in, and that difference is the whole of the choice. */}
                  <span style={{ font: "400 .625rem/1.5 var(--ui)", color: "var(--faint)", textWrap: "pretty" }}>
                    {t("lib.spineModeNote")}
                  </span>
                  <span style={{ font: "400 .625rem/1.5 var(--ui)", color: "var(--faint)", textWrap: "pretty" }}>
                    {t("lib.spineNote")}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ---- where it lives ---- */}

          {/* ---- WHERE THE BOOK IS FILED ----------------------------------------------------
              Two questions, asked in order and answered in two different shapes.

              «أين يوجد الكتاب؟» is a fact, so it is a list: one row per shelf, the shelf named
              plainly with its cabinet quietly beneath it. «أين يمكن أن يوضع؟» is an action, so it
              is one button that opens a list of destinations — not a wall of them laid out on the
              panel. Those were four rows of chips competing for the same glance: the cabinet row,
              the shelf row, the category row and an add row that grew one chip per shelf in the
              library. A reader had to decode which row meant «where it is» and which meant «where
              it could go», and the two were drawn identically.

              Nothing a row shows is a destination, and nothing the button offers is already held.
              That is the whole distinction, and it is now carried by shape rather than by wording. */}
          <div>
            <div style={legend}>{t("lib.assignment")}</div>

            <div
              style={{
                border: "1px solid var(--brd)",
                borderRadius: "var(--r-md)",
                background: "var(--pap)",
                overflow: "hidden",
              }}
            >
              {places.length === 0 ? (
                <div style={{ padding: "11px 13px", font: "500 .8125rem var(--ui)", color: "var(--faint)" }}>
                  {t("lib.unfiled")}
                </div>
              ) : (
                places.map((pl, i) => {
                  const cat = pl.shelf.categories.find((k) => k.id === pl.categoryId) ?? null;
                  return (
                    <div
                      key={pl.shelf.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 13px",
                        borderTop: i ? "1px solid var(--brd)" : undefined,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            font: "600 .8125rem/1.35 var(--ui)",
                            color: "var(--txt)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {pl.shelf.name}
                        </div>
                        {/* THE HIERARCHY UNDER THE NAME, NOT BESIDE IT. Three names separated by
                            chevrons read as a path to be parsed, and wrapped badly when any of them
                            was long. A shelf with its cabinet beneath it reads as one fact, and the
                            long-name case becomes an ellipsis rather than a second line. */}
                        <div
                          style={{
                            font: "400 .6875rem/1.4 var(--ui)",
                            color: "var(--faint)",
                            marginTop: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {pl.caseNode?.name ?? t("lib.unfiled")}
                          {pl.shelf.categories.length > 0 && (
                            <>
                              {" · "}
                              <button
                                className="libd-hov-txt"
                                onClick={() => setCatFor(catFor === pl.shelf.id ? null : pl.shelf.id)}
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  padding: 0,
                                  font: "inherit",
                                  color: "var(--mut)",
                                  cursor: "pointer",
                                }}
                              >
                                {cat ? cat.name : t("lib.uncategorised")}
                              </button>
                            </>
                          )}
                        </div>
                        {catFor === pl.shelf.id && (
                          <Chooser
                            groups={[{ id: pl.shelf.id, name: pl.shelf.name, ink: pl.caseNode?.ink ?? null,
                              items: [{ id: "", name: t("lib.uncategorised") },
                                      ...pl.shelf.categories.map((k) => ({ id: k.id, name: k.name }))] }]}
                            current={pl.categoryId ?? ""}
                            onPick={(id) => { setCatFor(null); void setCategory(pl.shelf.id, id || null); }}
                            onClose={() => setCatFor(null)}
                            searchFrom={999}
                          />
                        )}
                      </div>

                      {/* MOVE BELONGS TO A ROW, because a move leaves ONE shelf and this row is the
                          shelf it leaves. It used to live in a Case → Shelf picker that had no way
                          to say which membership it was acting on, so it only ever worked for a
                          book that had exactly one. */}
                      <button
                        className="libd-hov libd-hov-txt"
                        data-move-from={pl.shelf.id}
                        onClick={() => setChoosing({ mode: "move", from: pl.shelf.id })}
                        title={t("lib.moveTo")}
                        style={{
                          flex: "none",
                          font: "500 .6875rem var(--ui)",
                          color: "var(--mut)",
                          background: "transparent",
                          border: "1px solid var(--brd)",
                          borderRadius: "var(--r-sm)",
                          padding: "3px 9px",
                          cursor: "pointer",
                        }}
                      >
                        {t("lib.moveTo")}
                      </button>
                      <button
                        className="libd-hov libd-hov-txt"
                        aria-label={`${t("lib.removeFromThisShelf")} — ${pl.shelf.name}`}
                        title={t("lib.removeFromThisShelf")}
                        data-remove-shelf={pl.shelf.id}
                        onClick={() => removeFrom(pl.shelf.id)}
                        style={{
                          flex: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "var(--ctl-xs)",
                          height: "var(--ctl-xs)",
                          borderRadius: "var(--r-sm)",
                          border: "1px solid transparent",
                          background: "transparent",
                          color: "var(--faint)",
                          cursor: "pointer",
                        }}
                      >
                        <Icon name="close" size="sm" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* ONE BUTTON, NOT A WALL. A library with thirty shelves used to put thirty chips on
                this panel; the destinations now live behind this and arrive grouped by cabinet,
                with a search once there are enough of them to need one. */}
            <div style={{ marginTop: 10 }}>
              <button
                data-add-open="1"
                onClick={() => setChoosing(choosing?.mode === "add" ? null : { mode: "add" })}
                disabled={addable.length === 0}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  height: 30,
                  padding: "0 12px",
                  borderRadius: 9,
                  font: "500 .75rem var(--ui)",
                  border: "1px solid var(--brd)",
                  background: "var(--pap)",
                  color: addable.length ? "var(--acc)" : "var(--faint)",
                  cursor: addable.length ? "pointer" : "default",
                }}
              >
                <span aria-hidden style={{ font: "600 .875rem var(--ui)" }}>+</span>
                {places.length ? t("lib.addToAnotherShelf") : t("lib.addToShelf")}
              </button>
              {addable.length === 0 && (
                <span style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", marginInlineStart: 10 }}>
                  {t("lib.onEveryShelfAlready")}
                </span>
              )}
              {choosing && (
                <Chooser
                  groups={destinationGroups(choosing.mode === "move" ? choosing.from : null)}
                  current=""
                  onPick={(id) => {
                    const target = everyShelf.find((e) => e.shelf.id === id);
                    const c = choosing;
                    setChoosing(null);
                    if (!target) return;
                    if (c.mode === "move") void moveMembership(c.from, target.shelf);
                    else void addToShelf(target.shelf);
                  }}
                  onClose={() => setChoosing(null)}
                  searchFrom={9}
                />
              )}
            </div>

            <div style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", paddingTop: 10 }}>
              {unfiled
                ? t("lib.notFiledHint")
                : multi
                  ? t("lib.onSeveralShelvesHint").replace("{n}", String(places.length))
                  : t("lib.onOneShelfHint")}
            </div>
          </div>

        </div>

        {/* ---- the editing footer ----
            An editor owes a reader two endings. Save writes only what changed; Cancel throws the
            buffer away and leaves the book as it was. Shelf moves and image choices have already
            been applied — they move files and memberships, which a buffer cannot hold honestly —
            so the footer says which of its changes are still pending. */}
        <div
          style={{
            position: "sticky",
            bottom: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "13px 24px",
            borderTop: "1px solid var(--brd)",
            background: "var(--chr)",
          }}
        >
          <span
            style={{
              flex: 1,
              font: "400 .75rem var(--ui)",
              color: awaitingShelfRef.current && refused ? "var(--acc)" : "var(--faint)",
            }}
          >
            {awaitingShelfRef.current && refused
              ? awaitingShelfRef.current
              : dirty
                ? t("lib.unsavedChanges")
                : t("lib.noChanges")}
          </span>
          <button
            className="libd-hov libd-hov-txt"
            onClick={cancel}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--brd)",
              font: "500 .8125rem var(--ui)",
              color: "var(--mut)",
            }}
          >
            {t("lib.cancel")}
          </button>
          <button
            className="libd-hov-bright"
            onClick={save}
            disabled={busy}
            style={{
              height: 32,
              padding: "0 18px",
              borderRadius: "var(--r-md)",
              background: dirty ? "var(--acc)" : "var(--soft)",
              color: dirty ? "var(--pap)" : "var(--mut)",
              border: dirty ? "none" : "1px solid var(--brd)",
              font: "600 .8125rem var(--ui)",
              opacity: showBusy ? 0.6 : 1,
              transition: "opacity .12s ease-out",
            }}
          >
            {t("lib.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
