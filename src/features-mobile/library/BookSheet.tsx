// THE BOOK SHEET — design C5, "tap for details, long-press for the same sheet".
//
// The desk answers "what is this book, and what have I done in it" across a details pane, a shelf
// picker and a context menu. The design's phone answer is one sheet: the book above, the way back into
// it, and then everything the book owns as rows that lead somewhere.
//
// WHAT IS REAL HERE, and all of it is the product's:
//   * cover, title and author — `coverSrc` and `resolveBookMeta`, the same helpers the library rows use
//   * "EPUB · added 4 Feb" — `format` and `added_at` off the row
//   * progress and "last read" — `fraction` and `last_opened_at`
//   * "Highlights & notes · 31" — `annotationsAll()` counted for this book
//   * "Contents · 14 chapters" — the book's OWN table of contents (see `bookToc`)
//   * "Add to shelf" — `collectionsList` + `collectionAddBook` / `collectionRemoveBook` (design L3)
//   * "Remove from library" — `bookDelete`, behind the confirmation the desk also requires
//
// TWO ROWS THE DESIGN DRAWS ARE NOT HERE, and neither is faked:
//   * PAGE NUMBERS ("412 pages", "Continue — page 254"). foliate builds no global pagination and Sard
//     has no page model, so a number here would be Sard's invention presented as the book's. The sheet
//     states the location in the unit the product actually has — the percentage — and the design's
//     intent, "say where you are", is kept.
//   * MARK AS FINISHED. There is no completion concept to write to: `read_at` is the last-read date.
//     A control that cannot store its own result is the RAWY-193/205 defect, so it is absent.

import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, uiDateTimeFormat } from "../../lib/format";
import { displayAuthorOrUnknown, displayTitle, resolveBookMeta } from "../../lib/bookMeta";
import { coverSrc } from "../../features/library/coverSrc";
import { annotationsAll, bookDelete, type BookRow } from "../../lib/ipc";
import { Icon } from "../components/Icon";
import { chapterCount } from "./bookToc";

export function BookSheet({
  book,
  onContinue,
  onOpenMarks,
  onAddToShelf,
  onRemoved,
  onClose,
}: {
  book: BookRow;
  onContinue: () => void;
  onOpenMarks: () => void;
  onAddToShelf: () => void;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const meta = resolveBookMeta(book);
  const src = coverSrc(book);
  const [marks, setMarks] = useState<number | null>(null);
  const [chapters, setChapters] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    annotationsAll()
      .then((rows) => alive && setMarks(rows.filter((r) => r.book_id === book.id).length))
      .catch(() => {});
    // Costs an unzip, so it is asked for only now that a sheet is actually open.
    chapterCount(book.id, book.file_path)
      .then((n) => alive && setChapters(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [book.id, book.file_path]);

  const pct = book.fraction != null ? Math.round(book.fraction * 100) : null;
  const when = (sec: number | null) =>
    sec ? uiDateTimeFormat(lang, { month: "short", day: "numeric" }).format(new Date(sec * 1000)) : "";
  const num = (v: number) => localeDigits(String(v), lang);

  return (
    <>
      <div className="mh-scrim" onClick={onClose} />
      <div className="mh-sheet mb-sheet" role="dialog" aria-modal="true" aria-label={displayTitle(meta, t)}>
        <div className="mh-grab" />

        <div className="mb-top">
          {src ? (
            <img className="mb-cover" src={src} alt="" />
          ) : (
            <span className="mb-cover mb-cover--plain" aria-hidden="true" />
          )}
          <div className="mb-facts">
            <div className="mb-title" dir="auto">
              {displayTitle(meta, t)}
            </div>
            <div className="mb-author" dir="auto">
              {displayAuthorOrUnknown(meta, t)}
            </div>
            {/* The design's spec line, minus the page count it asks for and Sard cannot supply. */}
            <div className="mb-meta">
              {(book.format ?? "").toUpperCase()}
              {book.added_at ? ` · ${t("m.book.added").replace("{when}", when(book.added_at))}` : ""}
            </div>
            <div className="mb-bar" aria-hidden="true">
              <span className="mb-bar-fill" style={{ inlineSize: `${pct ?? 0}%` }} />
            </div>
            {/* "last read <when>" only when there IS a when: a book can carry progress with no opened
                timestamp, and "last read " with nothing after it is worse than saying less. */}
            <div className="mb-progress">
              {pct == null
                ? t("m.book.notStarted")
                : book.last_opened_at
                  ? t("m.book.lastRead").replace("{p}", num(pct)).replace("{when}", when(book.last_opened_at))
                  : `${num(pct)}%`}
            </div>
          </div>
        </div>

        {/* The design's primary action states WHERE it will resume. In percent, because that is the
            location Sard can honestly report. */}
        <button type="button" className="mb-continue" onClick={onContinue}>
          {pct == null ? t("m.continue") : `${t("m.continue")} — ${num(pct)}%`}
        </button>

        <div className="mb-rows">
          <button type="button" className="mb-row" onClick={onOpenMarks}>
            <Icon name="note" />
            <span className="mb-row-label">{t("lib.nav.highlights")}</span>
            {marks != null ? <span className="mb-row-val">{num(marks)}</span> : null}
            <Icon name="chevronForward" />
          </button>

          {/* The count is the book's own TOC. Absent rather than zero when it could not be read. */}
          <button type="button" className="mb-row" onClick={onContinue}>
            <Icon name="contents" />
            <span className="mb-row-label">{t("panel.contents")}</span>
            {chapters != null ? (
              <span className="mb-row-val">{t("m.book.chapters").replace("{n}", num(chapters))}</span>
            ) : null}
            <Icon name="chevronForward" />
          </button>

          <button type="button" className="mb-row" onClick={onAddToShelf}>
            <Icon name="addToShelf" />
            <span className="mb-row-label">{t("m.book.addToShelf")}</span>
            <Icon name="chevronForward" />
          </button>
        </div>

        {confirm ? (
          <div className="mb-confirm">
            <p className="mb-confirm-text">{t("m.book.removeConfirm")}</p>
            <div className="mb-confirm-acts">
              <button type="button" className="mn-btn" onClick={() => setConfirm(false)} disabled={busy}>
                {t("note.cancel")}
              </button>
              <button
                type="button"
                className="mn-btn mn-btn--danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  bookDelete(book.id)
                    .then(() => onRemoved())
                    .catch((e) => {
                      console.error(e);
                      setBusy(false);
                    });
                }}
              >
                {t("lib.shelf.deleteYes")}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="mb-remove" onClick={() => setConfirm(true)}>
            <Icon name="trash" />
            {t("m.book.remove")}
          </button>
        )}
      </div>
    </>
  );
}
