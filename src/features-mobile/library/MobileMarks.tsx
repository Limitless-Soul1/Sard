// HIGHLIGHTS & NOTES — design G2, "highlights & notes across the library".
//
// The reader has been able to MAKE marks for several milestones; this is the first place they can be
// READ outside the book that holds them. The drawer already counted them (`annotationsAll().length`),
// so until now it reported a number and led to a placeholder.
//
// IT INVENTS NOTHING. The collection, its shape, its ordering and the rule for what counts as a note
// are the product's, not this file's:
//
//   * `annotationsAll()` is the desk's own cross-book query — "every highlight + standalone note across
//     all books, newest first" — the same one the library Inbox (RAWY-27) and the reader's Annotations
//     panel use for their "all books" source. No parallel query, no second ordering.
//   * `annoIsNote` / `annoIsHighlight` decide which list a row belongs to. They are shared for a reason
//     recorded beside them: `annotations_all` folds a highlight's note INTO the highlight row, so
//     classifying on `kind` alone listed a highlighted passage that carries a note TWICE. Re-deriving
//     that rule here would be re-acquiring the bug.
//   * Opening a mark needs no new navigation. `BookRef` already carries `cfi` — "a locator to open at" —
//     and the session resolves `target.cfi ?? saved.cfi`, so a mark opens its book exactly where it was
//     made and a book with no mark still resumes where it was left.
//
// WHAT THIS FILE OWNS is presentation: the row the design draws (book, chapter · when, the passage, and
// the note beneath it when there is one), and the two filters that need no picker of their own.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { relTime } from "../lib/relTime";
import { resolveTheme, useTheme } from "../../theme";
import { colorValue } from "../../features/reader/highlightColors";
import { annoIsNote, annotationsAll, type AnnoItem } from "../../lib/ipc";
import type { BookRef } from "../app/navigation";

export function MobileMarks({ onOpenAt }: { onOpenAt: (b: BookRef) => void }) {
  const { t, lang } = useI18n();
  const hl = resolveTheme(useTheme((s) => s.themeId)).colors.highlight;
  const [items, setItems] = useState<AnnoItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notesOnly, setNotesOnly] = useState(false);

  useEffect(() => {
    let alive = true;
    annotationsAll()
      .then((rows) => alive && setItems(rows))
      .catch(console.error)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => (notesOnly ? items.filter(annoIsNote) : items), [items, notesOnly]);

  // Nothing at all versus nothing MATCHING are different situations and the strings already distinguish
  // them: one invites the reader to make a mark, the other tells them the filter is the reason.
  if (loaded && items.length === 0) {
    return (
      <div className="ml-empty">
        <div className="ml-empty-title">{t("inbox.empty.title")}</div>
        <div>{t("inbox.empty.sub")}</div>
      </div>
    );
  }

  return (
    <div className="mk-root">
      <div className="ml-allhead">
        <div className="ml-allhead-title">{t("lib.nav.highlights")}</div>
      </div>

      <div className="mk-chips">
        <button type="button" className={`ml-chip${notesOnly ? "" : " on"}`} onClick={() => setNotesOnly(false)}>
          {t("inbox.all")}
          <span className="mk-chip-n">{items.length}</span>
        </button>
        <button type="button" className={`ml-chip${notesOnly ? " on" : ""}`} onClick={() => setNotesOnly(true)}>
          {t("panel.notes")}
        </button>
      </div>

      {loaded && shown.length === 0 ? (
        <div className="ml-empty">
          <div className="ml-empty-title">{t("inbox.empty.none")}</div>
          <div>{t("inbox.empty.noneSub")}</div>
        </div>
      ) : null}

      <div className="mk-list">
        {shown.map((it) => (
          <button
            key={it.id}
            type="button"
            className="mk-row"
            // The mark's own location. A row that could not return the reader to the passage would be a
            // list of quotations rather than a way back into the book.
            onClick={() =>
              onOpenAt({ id: it.book_id, filePath: it.file_path, cfi: it.cfi, title: it.book_title })
            }
          >
            {/* The ink is the mark's identity in the reader, so it is what identifies it here too. */}
            <span className="mk-ink" style={{ background: colorValue(it.color, hl) }} aria-hidden="true" />
            <span className="mk-body">
              <span className="mk-meta" dir="auto">
                {it.book_title ?? ""}
                {it.chapter_label ? ` · ${it.chapter_label}` : ""}
                {it.created_at ? ` · ${relTime(it.created_at, lang)}` : ""}
              </span>
              {/* Book-derived text takes its own direction, never the interface's. */}
              {it.text ? (
                <span className="mk-text" dir="auto">
                  {it.text}
                </span>
              ) : null}
              {(it.note_title ?? "").trim() ? (
                <span className="mk-note mk-note--title" dir="auto">
                  {it.note_title}
                </span>
              ) : null}
              {(it.note ?? "").trim() ? (
                <span className="mk-note" dir="auto">
                  {it.note}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
