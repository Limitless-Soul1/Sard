// Book Details.
//
// SOURCE: the `bookModel` block of the reference bundles — byte-identical in `Sard Library
// (standalone).html` and `Sard Library - Vista (standalone).html`, so this dialog has one
// unambiguous source. It replaces Sard's older EditBook wherever the design's views open a book.
//
// Everything it edits is stored the way RAWY-19 already stored a cover fit: as a row in
// `metadata_overrides`, never a rewrite of the source EPUB. Clearing a control returns the book
// to what Sard derives for it rather than to a second stored default.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { BookRow, CaseNode, ShelfNode } from "../../../lib/ipc";
import {
  bookCommitCover,
  bookRevertCover,
  bookStageCover,
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
import { isFinished, progressPct } from "./model";

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** The dialog's palette, exactly as authored. */
const PALETTE = [
  "#2C3A42", "#9C5A3C", "#B5727B", "#2E5A55", "#16140F", "#D8C29A",
  "#5E6B49", "#3E4C6B", "#7A4B2E", "#3A5A4F", "#8C2F39", "#4A3B5E",
];

/** Light paints take dark ink; everything else takes the warm light ink. */
const inkFor = (bg: string) => (bg === "#D8C29A" || bg === "#F1E4C8" ? "#3A2E14" : "#F1E7D4");

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

const legend: React.CSSProperties = {
  font: "600 .625rem var(--ui)",
  letterSpacing: ".13em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 9,
};

const LANGS: [string, string][] = [
  ["en", "English"],
  ["ar", "العربية"],
  ["zh", "中文"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["fr", "Français"],
];

export interface BookDetailsProps {
  book: BookRow;
  cases: CaseNode[];
  loose: ShelfNode[];
  /** Which shelf currently holds this book, and the case above it. */
  placement: { caseNode: CaseNode | null; shelf: ShelfNode; categoryId: string | null } | null;
  onClose: () => void;
  /** Re-read the library after any write. */
  onChanged: () => void;
}

export function BookDetails(props: BookDetailsProps) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
  const num = (n: number) => localeNum(n, lang);
  const [book, setBook] = useState<BookRow>(props.book);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBook(props.book);
    const m = resolveBookMeta(props.book);
    setTitle(m.title ?? "");
    setAuthor(m.author ?? "");
  }, [props.book]);

  const meta = resolveBookMeta(book);
  const shown = displayTitle(meta, t);
  const arabic = book.dir === "rtl" || ARABIC.test(shown);
  const paint = book.cover_paint ?? autoCoverPaint(shown).bg;
  const ink = book.cover_paint ? inkFor(book.cover_paint) : autoCoverPaint(shown).ink;
  const src = coverSrc(book);
  const typeset = book.cover_mode === "typeset" || !src;
  const spineMode = book.spine_mode ?? "typeset";
  const pct = progressPct(book);
  const done = isFinished(book);

  const patch = async (p: Parameters<typeof bookUpdate>[1]) => {
    setBusy(true);
    const next = await bookUpdate(book.id, p).catch(() => null);
    setBusy(false);
    if (next) setBook(next);
    props.onChanged();
  };

  const commitText = () => {
    const m = resolveBookMeta(book);
    if (title.trim() !== (m.title ?? "")) patch({ title: title.trim() });
    else if (author.trim() !== (m.author ?? "")) patch({ author: author.trim() });
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

  const revertCover = async () => {
    setBusy(true);
    const next = await bookRevertCover(book.id).catch(() => null);
    if (next) setBook(next);
    setBusy(false);
    props.onChanged();
  };

  // ---- the assignment path -------------------------------------------------
  const place = props.placement;
  const shelvesOf = (c: CaseNode | null) =>
    (c ? c.shelves : props.loose).filter((s) => !s.auto_rule);

  const moveTo = async (shelfId: string, categoryId: string | null) => {
    setBusy(true);
    // Leave every hand shelf this book currently sits on, then join the target.
    if (place && place.shelf.id !== shelfId) {
      await collectionRemoveBook(place.shelf.id, book.id).catch(() => {});
    }
    await shelfPlaceBook(shelfId, book.id, categoryId, 0).catch(() => {});
    setBusy(false);
    props.onChanged();
  };

  const unfile = async () => {
    if (!place) return;
    setBusy(true);
    await collectionRemoveBook(place.shelf.id, book.id).catch(() => {});
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
        borderRadius: 3,
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
              font: arabic ? "700 .875rem/1.4 var(--ar)" : "600 .8125rem/1.25 var(--book)",
            }}
          >
            {shown}
          </div>
        </>
      ) : (
        <img src={src ?? undefined} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      )}
    </div>
  );

  const levels: { label: string; options: React.ReactNode; empty: string | null }[] = [
    {
      label: t("lib.caseWord"),
      empty: null,
      options: (
        <>
          {props.cases.map((c) => {
            const on = place?.caseNode?.id === c.id;
            return (
              <button
                key={c.id}
                style={chip(on)}
                onClick={() => {
                  if (on) return unfile();
                  const first = shelvesOf(c)[0];
                  if (first) moveTo(first.id, null);
                }}
              >
                {c.ink && <span style={{ width: 7, height: 7, borderRadius: 2, background: c.ink }} />}
                {c.name}
              </button>
            );
          })}
        </>
      ),
    },
    {
      label: t("lib.shelfWord"),
      empty: shelvesOf(place?.caseNode ?? null).length ? null : t("lib.chooseCaseFirst"),
      options: (
        <>
          {shelvesOf(place?.caseNode ?? null).map((s) => {
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
        className="libd-root"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "static",
          display: "block",
          width: "min(640px,92%)",
          maxHeight: "88%",
          overflowY: "auto",
          background: "var(--chr)",
          border: "1px solid var(--brd)",
          borderRadius: 16,
          boxShadow: "var(--sh4)",
          animation: "sard-rise .16s ease-out",
          opacity: busy ? 0.75 : 1,
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
            <input
              value={title}
              dir="auto"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              style={{
                width: "100%",
                background: "var(--soft)",
                border: "1px solid var(--brd)",
                borderRadius: 8,
                padding: "7px 10px",
                outline: "none",
                font: arabic ? "700 1.125rem var(--ar)" : "600 1rem var(--ui)",
                color: "var(--txt)",
              }}
            />
            <input
              value={author}
              dir="auto"
              onChange={(e) => setAuthor(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              style={{
                width: "100%",
                marginTop: 7,
                background: "var(--soft)",
                border: "1px solid var(--brd)",
                borderRadius: 8,
                padding: "6px 10px",
                outline: "none",
                font: arabic ? "400 1rem var(--ar)" : "400 .8125rem var(--ui)",
                color: "var(--mut)",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 12,
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
            style={{ flex: "none", width: 30, height: 30, borderRadius: 9, color: "var(--mut)", fontSize: 14 }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "18px 24px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* ---- language ---- */}
          <div>
            <div style={legend}>{t("lib.language")}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {LANGS.map(([id, label]) => (
                <button
                  key={id}
                  style={chip(book.language === id)}
                  onClick={() => patch({ language: book.language === id ? "" : id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ---- cover and spine ---- */}
          <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 250 }}>
              <div style={legend}>{t("lib.cover")}</div>
              <div style={{ font: "400 .6875rem var(--ui)", color: "var(--faint)", margin: "-4px 0 9px" }}>
                {t("lib.coverUse")}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
                <button style={chip(typeset)} onClick={() => patch({ coverMode: "typeset" })}>
                  {t("lib.coverTypeset")}
                </button>
                <button
                  style={{ ...chip(!typeset), opacity: src ? 1 : 0.5 }}
                  disabled={!src}
                  onClick={() => patch({ coverMode: "file" })}
                >
                  {t("lib.coverFromFile")}
                </button>
                <button style={chip(false)} onClick={chooseCover}>
                  {t("lib.coverCustom")}
                </button>
                {src && (
                  <button style={chip(false)} onClick={revertCover}>
                    {t("edit.revertCover")}
                  </button>
                )}
              </div>

              {/* COVER SIZING — how a cover fills its frame. RAWY-19's per-book override. */}
              <div style={{ ...legend, marginTop: 4 }}>{t("lib.coverSizing")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
                {(["crop", "fit"] as const).map((m) => (
                  <button key={m} style={chip(book.cover_fit === m)} onClick={() => patch({ coverFit: m })}>
                    {t(m === "crop" ? "lib.cover.crop" : "lib.cover.fit")}
                  </button>
                ))}
                <button style={chip(!book.cover_fit)} onClick={() => patch({ coverFit: "" })}>
                  {t("lib.coverSizeDefault")}
                </button>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {PALETTE.map((k) => (
                  <button
                    key={k}
                    aria-label={k}
                    onClick={() => patch({ coverPaint: k, coverMode: "typeset" })}
                    style={{
                      width: 22,
                      height: 30,
                      borderRadius: 3,
                      background: k,
                      boxShadow:
                        book.cover_paint === k
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
                    width: 44,
                    height: 176,
                    borderRadius: 2,
                    boxShadow: "var(--sh2)",
                    display: "grid",
                    placeItems: "center",
                    overflow: "hidden",
                    background: spineMode === "none" ? "var(--lbox)" : paint,
                  }}
                >
                  <span
                    style={{
                      transform: "rotate(-90deg)",
                      whiteSpace: "nowrap",
                      maxWidth: 168,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: spineMode === "none" ? "var(--faint)" : ink,
                      font: arabic ? "700 .8125rem var(--ar)" : "500 .75rem var(--ui)",
                    }}
                  >
                    {shown}
                  </span>
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <button style={chip(spineMode === "typeset")} onClick={() => patch({ spineMode: "typeset" })}>
                    {t("lib.coverTypeset")}
                  </button>
                  <button style={chip(spineMode === "none")} onClick={() => patch({ spineMode: "none" })}>
                    {t("lib.spinePlain")}
                  </button>
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
                borderRadius: 9,
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
                  gap: 12,
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
                    color: "var(--faint)",
                  }}
                >
                  {lv.label}
                </span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
                  {lv.empty ? (
                    <span style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", paddingTop: 8 }}>
                      {lv.empty}
                    </span>
                  ) : (
                    lv.options
                  )}
                </div>
              </div>
            ))}

            <div style={{ font: "400 .75rem var(--ui)", color: "var(--faint)", paddingTop: 10 }}>
              {place ? t("lib.toggleHint") : t("lib.notFiledHint")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
