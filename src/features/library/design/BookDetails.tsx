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
  shelfPlaceBook,
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
import { useDialog } from "../../../components/useDialog";


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
  placement: { caseNode: CaseNode | null; shelf: ShelfNode; categoryId: string | null } | null;
  /** The Library toast — a failed organisation write says so rather than doing nothing visible. */
  notify: (msg: string) => void;
  onClose: () => void;
  /** Re-read the library after any write. */
  onChanged: () => void;
  /** The library's own Crop/Fit setting, which a book with no per-book fit follows. */
  libraryCoverMode: CoverMode;
}

export function BookDetails(props: BookDetailsProps) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
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
   * Joining the stack also means a press outside answers here first, and that a book menu opened
   * behind it cannot outlive it.
   */
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => openTransient(props.onClose, () => dialogRef.current), [props.onClose]);
  /**
   * ESCAPE AND THE OUTSIDE PRESS ARE ALREADY THIS DIALOG'S OWN — `openTransient` owns the stack that
   * closes the nearest layer first. So no `onDismiss` here: two handlers for one key would be two
   * chances to close the wrong thing. What was missing is everything else a modal owes a keyboard —
   * the trap, and giving focus back to the tile that opened it.
   */
  const dlg = useDialog({ label: shown, initialFocus: "none" });
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
  const place = props.placement;
  const [pickedCase, setPickedCase] = useState<string | null | undefined>(undefined);
  useEffect(() => setPickedCase(undefined), [book.id]);

  const effectiveCaseId = pickedCase !== undefined ? pickedCase : (place?.caseNode?.id ?? null);
  const effectiveCase = effectiveCaseId ? (props.cases.find((c) => c.id === effectiveCaseId) ?? null) : null;
  // A rule shelf fills itself, so it can never be a destination — at any level.
  const shelvesOf = (c: CaseNode | null) =>
    (c ? c.shelves : props.loose).filter((s) => !s.auto_rule);

  const moveTo = async (shelfId: string, categoryId: string | null) => {
    setBusy(true);
    // Join the target FIRST: if that fails the book is still where it was, rather than nowhere.
    try {
      await shelfPlaceBook(shelfId, book.id, categoryId, 0);
    } catch (e) {
      console.error(e);
      setBusy(false);
      props.notify(t("lib.writeFailed"));
      props.onChanged();
      return;
    }
    // Leave ONLY the shelf this book was shown as sitting on. Any other shelf it belongs to is a
    // placement someone made deliberately and is none of this move's business.
    if (place && place.shelf.id !== shelfId) {
      try {
        await collectionRemoveBook(place.shelf.id, book.id);
      } catch (e) {
        console.error(e);
        props.notify(t("lib.movedButNotRemoved"));
      }
    }
    setBusy(false);
    props.onChanged();
  };

  const unfile = async () => {
    if (!place) return;
    setBusy(true);
    try {
      await collectionRemoveBook(place.shelf.id, book.id);
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
  const awaitingShelf = awaitsShelfChoice(currentCaseId, effectiveCaseId, shelvesOf(effectiveCase).length);
  const chooseShelfHere = effectiveCase
    ? t("lib.chooseShelfInCase", { name: effectiveCase.name })
    : t("lib.chooseLooseShelf");

  awaitingShelfRef.current = awaitingShelf ? chooseShelfHere : null;
  if (refused && !awaitingShelf) setRefused(false);

  const levels: {
    label: string;
    options: React.ReactNode;
    empty: string | null;
    note?: string;
    required?: boolean;
  }[] = [
    {
      label: t("lib.caseWord"),
      // Choosing a case does NOT write. It narrows the level below it, which is what makes
      // Case → Shelf → Category a hierarchy rather than three independent guesses.
      empty: props.cases.length ? null : t("lib.noCasesYet"),
      note: t("lib.caseNarrowsOnly"),
      options: (
        <>
          <button style={chip(effectiveCaseId === null)} onClick={() => setPickedCase(null)}>
            {t("lib.unfiled")}
          </button>
          {props.cases.map((c) => (
            <button key={c.id} style={chip(effectiveCaseId === c.id)} onClick={() => setPickedCase(c.id)}>
              {c.ink && <span style={{ width: 7, height: 7, borderRadius: 2, background: c.ink }} />}
              {c.name}
            </button>
          ))}
        </>
      ),
    },
    {
      label: t("lib.shelfWord"),
      // The shelves OF THE CHOSEN CASE — so "Case A + a shelf of Case B" cannot be expressed.
      // A case with nothing in it says so, instead of leaving a level that looks broken.
      empty: shelvesOf(effectiveCase).length
        ? null
        : effectiveCase
          ? t("lib.caseHasNoShelves")
          : t("lib.noShelves"),
      note: awaitingShelf ? chooseShelfHere : undefined,
      required: awaitingShelf,
      options: (
        <>
          {shelvesOf(effectiveCase).map((s) => {
            const on = place?.shelf.id === s.id;
            return (
              <button key={s.id} style={chip(on)} onClick={() => (on ? unfile() : moveTo(s.id, null))}>
                {on ? `${s.name}  ✕` : s.name}
              </button>
            );
          })}
        </>
      ),
    },
    {
      label: t("lib.categoryWord"),
      empty: place && place.shelf.categories.length ? null : t("lib.shelfHasNoCategories"),
      options: place && place.shelf.categories.length ? (
        <>
          <button style={chip(!place.categoryId)} onClick={() => moveTo(place.shelf.id, null)}>
            {t("lib.uncategorised")}
          </button>
          {place.shelf.categories.map((k) => (
            <button
              key={k.id}
              style={chip(place.categoryId === k.id)}
              onClick={() => moveTo(place.shelf.id, k.id)}
            >
              {k.name}
            </button>
          ))}
        </>
      ) : null,
    },
  ];

  return (
    <div
      onClick={props.onClose}
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
        ref={(node) => { dialogRef.current = node; dlg.ref(node); }}
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
            className="libd-hov libd-hov-txt"
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
                  ) : (
                    <span
                      style={{
                        transform: "rotate(-90deg)",
                        whiteSpace: "nowrap",
                        maxWidth: 168,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        color: spineMode === "none" ? "var(--faint)" : ink,
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
                  <span style={{ font: "400 .625rem/1.5 var(--ui)", color: "var(--faint)", textWrap: "pretty" }}>
                    {t("lib.spineNote")}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ---- where it lives ---- */}
          <div>
            <div style={legend}>{t("lib.assignment")}</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                flexWrap: "wrap",
                marginBottom: 14,
                padding: "9px 12px",
                borderRadius: "var(--r-md)",
                background: "var(--pap)",
                border: "1px solid var(--brd)",
              }}
            >
              <span style={{ font: "600 .8125rem var(--ui)", color: place ? "var(--txt)" : "var(--faint)" }}>
                {place?.caseNode?.name ?? t("lib.unfiled")}
              </span>
              <span style={{ color: "var(--faint)", fontSize: 10 }}>{rtl ? "‹" : "›"}</span>
              <span style={{ font: "500 .8125rem var(--ui)", color: place ? "var(--txt)" : "var(--faint)" }}>
                {place?.shelf.name ?? "—"}
              </span>
              <span style={{ color: "var(--faint)", fontSize: 10 }}>{rtl ? "‹" : "›"}</span>
              <span style={{ font: "400 .8125rem var(--ui)", color: "var(--mut)" }}>
                {place
                  ? place.shelf.categories.length
                    ? place.shelf.categories.find((k) => k.id === place.categoryId)?.name ?? t("lib.uncategorised")
                    : "—"
                  : "—"}
              </span>
            </div>

            {levels.map((lv) => (
              <div
                key={lv.label}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "var(--sp-5)",
                  padding: "8px 0",
                  borderTop: "1px solid var(--brd)",
                }}
              >
                <span
                  style={{
                    flex: "none",
                    width: 74,
                    paddingTop: 7,
                    font: "600 .625rem var(--ui)",
                    letterSpacing: ".12em",
                    textTransform: "uppercase",
                    // A level that still needs an answer says so in its own label, so the
                    // requirement is visible before the reader reaches for Save.
                    color: lv.required ? "var(--acc)" : "var(--faint)",
                  }}
                >
                  {lv.label}
                </span>
                <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
                  {lv.empty ? (
                    <span style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", paddingTop: 8 }}>
                      {lv.empty}
                    </span>
                  ) : (
                    lv.options
                  )}
                  {lv.note && (
                    <span
                      style={{
                        flexBasis: "100%",
                        font: "400 .75rem/1.5 var(--ui)",
                        color: lv.required ? "var(--acc)" : "var(--faint)",
                        paddingTop: 2,
                        textWrap: "pretty",
                      }}
                    >
                      {lv.note}
                    </span>
                  )}
                </div>
              </div>
            ))}

            <div style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", paddingTop: 10 }}>
              {place ? t("lib.toggleHint") : t("lib.notFiledHint")}
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
