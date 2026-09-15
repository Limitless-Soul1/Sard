// SEARCH — design C3, "one field, results grouped by kind".
//
// The desk searches books in one place and marks in another; the design's phone answer is a single
// field whose results are SEPARATED BY WHAT THEY ARE — books, then what you wrote in them, then the
// shelves they sit on — so one query answers "where is that thing" whatever kind of thing it was.
//
// EVERY GROUP IS AN EXISTING QUERY:
//   * Books — `libraryListBooks({ search })`, matched in SQL, exactly as the desk's library search does.
//   * In your notes — `annotationsAll()`, the same cross-book collection the marks place reads. The
//     match runs over the passage, the note body and its title, because a reader looking for a phrase
//     does not care which of the three they put it in.
//   * Shelves — `collectionsList()`, matched on the name, with the collection's own count.
//
// A RESULT IS A WAY BACK IN, never just a report: a book opens, a mark opens its book AT its locator
// (`BookRef.cfi`, the same path G2 uses), and a shelf opens the shelf. Nothing here is a dead row.
//
// THE CARD TAKES THE MARK'S OWN INK. The design tints a highlight's card amber and a note's blue —
// those are the two examples' own colours, not two fixed styles, so each card is tinted from the
// item's `color` through `colorValue`. A mark looks in the results like it looks on the page.

import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { resolveTheme, useTheme } from "../../theme";
import { colorValue } from "../../features/reader/highlightColors";
import { displayAuthorOrUnknown, displayTitle, resolveBookMeta } from "../../lib/bookMeta";
import { coverSrc } from "../../features/library/coverSrc";
import {
  annoIsNote,
  annotationsAll,
  collectionsList,
  libraryListBooks,
  type AnnoItem,
  type BookRow,
  type CollectionRow,
} from "../../lib/ipc";
import { Icon } from "../components/Icon";
import type { BookRef } from "../app/navigation";

/** Below this, a query is noise: one letter matches most of a library and answers nothing. */
const MIN_QUERY = 2;

export function MobileSearch({
  onOpenBook,
  onOpenAt,
  onOpenShelf,
  onClose,
}: {
  onOpenBook: (b: BookRow) => void;
  onOpenAt: (b: BookRef) => void;
  onOpenShelf: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const hl = resolveTheme(useTheme((s) => s.themeId)).colors.highlight;
  const [q, setQ] = useState("");
  const [books, setBooks] = useState<BookRow[]>([]);
  const [marks, setMarks] = useState<AnnoItem[]>([]);
  const [shelves, setShelves] = useState<CollectionRow[]>([]);
  const field = useRef<HTMLInputElement>(null);

  // The field is why the reader came here, so it is where the caret starts.
  useEffect(() => {
    field.current?.focus();
  }, []);

  // Marks and shelves are whole-collection reads, so they are fetched ONCE and matched in memory —
  // a query per keystroke over the same rows would be the same answer at a cost.
  useEffect(() => {
    let alive = true;
    annotationsAll().then((r) => alive && setMarks(r)).catch(() => {});
    collectionsList().then((r) => alive && setShelves(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Books ARE matched in SQL, because the library query already does it and the list can be long.
  const query = q.trim();
  useEffect(() => {
    if (query.length < MIN_QUERY) {
      setBooks([]);
      return;
    }
    let alive = true;
    libraryListBooks({ sort: "date_read", order: "desc", search: query })
      .then((r) => alive && setBooks(r))
      .catch(() => alive && setBooks([]));
    return () => {
      alive = false;
    };
  }, [query]);

  const needle = query.toLowerCase();
  const markHits = useMemo(
    () =>
      needle.length < MIN_QUERY
        ? []
        : marks.filter((m) =>
            [m.text, m.note, m.note_title].some((s) => (s ?? "").toLowerCase().includes(needle)),
          ),
    [marks, needle],
  );
  const shelfHits = useMemo(
    () => (needle.length < MIN_QUERY ? [] : shelves.filter((s) => s.name.toLowerCase().includes(needle))),
    [shelves, needle],
  );

  const nothing = query.length >= MIN_QUERY && books.length === 0 && markHits.length === 0 && shelfHits.length === 0;
  const n = (v: number) => localeDigits(String(v), lang);

  return (
    <div className="msr-root">
      {/* One field and a way out, as the design draws it. */}
      <div className="msr-bar">
        <div className="msr-field">
          <Icon name="search" />
          <input
            ref={field}
            className="msr-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("lib.search")}
            aria-label={t("search.title")}
            dir="auto"
            type="search"
            enterKeyHint="search"
          />
          {q ? (
            <button type="button" className="msr-clear" onClick={() => setQ("")} aria-label={t("note.cancel")}>
              <Icon name="close" />
            </button>
          ) : null}
        </div>
        <button type="button" className="msr-cancel" onClick={onClose}>
          {t("note.cancel")}
        </button>
      </div>

      <div className="msr-scroll">
        {books.length > 0 ? (
          <>
            <div className="msr-group">{t("m.search.books").replace("{n}", n(books.length))}</div>
            {books.map((b) => (
              <BookHit key={b.id} book={b} onOpen={() => onOpenBook(b)} />
            ))}
          </>
        ) : null}

        {markHits.length > 0 ? (
          <>
            <div className="msr-group">{t("m.search.notes").replace("{n}", n(markHits.length))}</div>
            {markHits.map((m) => {
              const ink = colorValue(m.color, hl);
              const body = annoIsNote(m) ? (m.note ?? m.note_title ?? m.text ?? "") : (m.text ?? "");
              return (
                <button
                  key={m.id}
                  type="button"
                  className="msr-mark"
                  // The mark's ink, at the design's weights: a wash for the card and a firmer edge.
                  style={{
                    background: `color-mix(in srgb, ${ink} 28%, transparent)`,
                    borderColor: `color-mix(in srgb, ${ink} 50%, transparent)`,
                  }}
                  onClick={() => onOpenAt({ id: m.book_id, filePath: m.file_path, cfi: m.cfi, title: m.book_title })}
                >
                  <span className="msr-mark-text" dir="auto">
                    {body}
                  </span>
                  <span className="msr-mark-where" dir="auto">
                    {annoIsNote(m) ? `${t("panel.notes")} · ` : ""}
                    {m.book_title ?? ""}
                    {m.chapter_label ? ` · ${m.chapter_label}` : ""}
                  </span>
                </button>
              );
            })}
          </>
        ) : null}

        {shelfHits.length > 0 ? (
          <>
            <div className="msr-group">{t("m.search.shelves").replace("{n}", n(shelfHits.length))}</div>
            {shelfHits.map((s) => (
              <button key={s.id} type="button" className="msr-shelf" onClick={() => onOpenShelf(s.id, s.name)}>
                <span className="msr-shelf-name" dir="auto">
                  {s.name}
                </span>
                <span className="msr-shelf-count">{t("m.search.shelfCount").replace("{n}", n(s.count))}</span>
              </button>
            ))}
          </>
        ) : null}

        {nothing ? (
          <div className="ml-empty">
            <div className="ml-empty-title">{t("inbox.empty.none")}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A book result: the design's small cover, title, and author with progress beside it. */
function BookHit({ book, onOpen }: { book: BookRow; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const meta = resolveBookMeta(book);
  const src = coverSrc(book);
  const pct = book.fraction != null ? Math.round(book.fraction * 100) : null;
  return (
    <button type="button" className="msr-book" onClick={onOpen}>
      {src ? (
        <img className="msr-book-cover" src={src} alt="" />
      ) : (
        <span className="msr-book-cover msr-book-cover--plain" aria-hidden="true" />
      )}
      <span className="msr-book-body">
        <span className="msr-book-title" dir="auto">
          {displayTitle(meta, t)}
        </span>
        <span className="msr-book-sub" dir="auto">
          {displayAuthorOrUnknown(meta, t)}
          {pct != null ? ` · ${localeDigits(String(pct), lang)}%` : ""}
        </span>
      </span>
    </button>
  );
}
