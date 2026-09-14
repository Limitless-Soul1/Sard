// THE SHELF, THEN THE BOOK.
//
// Bookmarks open on BOOKS, not on a flat list of saved positions — the change this file exists for.
// What was here before was one list of every bookmark in the library, newest first, each row saying
// «book · chapter · 68% · last week». A reader asks «where was I in *this*» before «what did I save
// recently», and a single run of sixty places across four books answers neither question: the book
// you want is scattered through it, and the order tells you about the clock rather than about the
// reading.
//
// So the shelf is the books, and each book wears its own saved places as ribbons over the head of
// its cover — one silk per place, in the dye it was marked in, standing at the depth it sits at.
// The count, the spread and the palette of a book's reading are all readable without opening
// anything. Open one and the same ribbons become the record: each place led by its silk, the words
// it was saved at beside it, chapter and date beneath. The silk on the shelf is the silk on the row:
// one object at two sizes.
//
// EVERY BOOK IS ON THE SHELF, including the ones holding nothing. A shelf that hid them would
// disagree with the library standing next to it, and a reader looking for a book they have not
// marked would conclude Sard had lost it.
//
// The order is the LIBRARY's order, read from the same settings the library reads. A book does not
// climb the shelf for being marked; the shelf is a view of the library, not a leaderboard.

import { useEffect, useMemo, useState } from "react";
import { SelectionBar, SelectionBox, useListSelection } from "../../components/listSelection";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useI18n } from "../../i18n";
import { localeNum, uiDateTimeFormat, uiRelativeTimeFormat } from "../../lib/format";
import {
  bookmarkDelete, bookmarksAll, libraryListBooks, settingsGet,
  type BookRow, type BookmarkItem, type SortKey, type SortOrder,
} from "../../lib/ipc";
import { useBookmarkStyle } from "../../lib/bookmarkStyle";
import { isArabicText } from "../../lib/typography";
import { pluralAr } from "./refs/model";
import { byDepth, silks } from "./bookmarks/silks";
import type { OpenTarget } from "./Library";
import "../../styles/bookmarks.css";

/** A saved place, with everything the shelf and the record need already resolved. */
interface Place extends BookmarkItem {
  depth: number;
  dye: string;
}

/**
 * A cover arrives as an ABSOLUTE filesystem path — `resolve_cover` makes it one at the IPC boundary,
 * so every surface gets a real file rather than a stored relative fragment. A webview cannot load a
 * file path; it needs the asset URL. Without this the shelf drew a wall of broken-image marks, which
 * is exactly how it first rendered.
 */
const coverSrc = (p: string | null): string | null => (p ? convertFileSrc(p) : null);

function relTime(sec: number | null, lang: string): string {
  if (!sec) return "";
  const days = Math.round((Date.now() / 1000 - sec) / 86400);
  const rtf = uiRelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(days) < 1) return rtf.format(0, "day");
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  return uiDateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric" }).format(new Date(sec * 1000));
}

export function BookmarksShelf({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang } = useI18n();
  const ar = lang === "ar";
  const num = (n: number) => localeNum(n, lang);
  // The dye a place was marked in. A place saved before the reader could choose one has none, and
  // resolves to the colour currently in force — never to an invented choice.
  const globalDye = useBookmarkStyle((s) => s.color);

  const [marks, setMarks] = useState<BookmarkItem[]>([]);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Places lifted but not yet committed — they hold their row, and their undo. */
  const [lifted, setLifted] = useState<Record<string, true>>({});
  const [find, setFind] = useState("");

  useEffect(() => {
    void (async () => {
      // The library's own order, from the library's own settings — so the shelf and the library
      // agree about which book comes first.
      const [sort, order] = await Promise.all([
        settingsGet("lib_sort").catch(() => null),
        settingsGet("lib_order").catch(() => null),
      ]);
      // A stored value Sard no longer offers must not empty the shelf — fall back to the library's
      // own default rather than passing a key the query cannot answer.
      const KEYS: SortKey[] = ["title", "author", "format", "date_read", "date_added"];
      const key: SortKey = KEYS.includes(sort as SortKey) ? (sort as SortKey) : "date_read";
      const dir: SortOrder = order === "asc" ? "asc" : "desc";
      const [rows, shelf] = await Promise.all([
        bookmarksAll().catch(() => [] as BookmarkItem[]),
        libraryListBooks({ sort: key, order: dir }).catch(() => [] as BookRow[]),
      ]);
      setMarks(rows);
      setBooks(shelf);
      setLoaded(true);
    })();
  }, []);

  /** Every book, in library order, carrying the places that have survived. */
  const withPlaces = useMemo(() => {
    const byBook = new Map<string, Place[]>();
    for (const m of marks) {
      if (lifted[m.id]) continue;
      const list = byBook.get(m.book_id) ?? [];
      list.push({ ...m, depth: m.fraction ?? 0, dye: m.color || globalDye });
      byBook.set(m.book_id, list);
    }
    return books.map((b) => ({ book: b, places: byDepth(byBook.get(b.id) ?? []) }));
  }, [marks, books, lifted, globalDye]);

  /**
   * THE SHELF IS THE BOOKS THAT HOLD SOMETHING. Every book stood here at first, bare ones included —
   * the reference's rule, so that the shelf could not disagree with the library. On a real library it
   * disagreed differently: thirty-nine covers, one of them marked, and the view read as the library
   * with a tally under it rather than as a record of saved places. A book joins the moment it holds a
   * place and leaves when its last one is lifted; the library itself is untouched and still shows
   * everything.
   */
  const shelf = useMemo(() => withPlaces.filter((s) => s.places.length > 0), [withPlaces]);

  const totalPlaces = shelf.reduce((a, s) => a + s.places.length, 0);
  const totalBooks = shelf.length;

  // Resolved from the UNFILTERED set on purpose: lifting the last place in a book must not pull the
  // record out from under the reader before they have decided whether to undo it.
  const current = openId ? withPlaces.find((s) => s.book.id === openId) ?? null : null;
  // The place the reader actually stopped at is the deepest surviving one — one per book.
  const lastId = current?.places.length ? current.places[current.places.length - 1].id : null;

  /** Lifted rows stay visible whatever is being searched, so an undo is never hidden by a filter. */
  const rows = useMemo(() => {
    if (!current) return [] as Place[];
    const all = current.places.slice();
    for (const m of marks) {
      if (m.book_id === current.book.id && lifted[m.id]) {
        all.push({ ...m, depth: m.fraction ?? 0, dye: m.color || globalDye });
      }
    }
    const q = find.trim();
    const sorted = byDepth(all);
    if (!q) return sorted;
    return sorted.filter(
      (p) =>
        lifted[p.id] ||
        (p.label ?? "").includes(q) ||
        (p.chapter_label ?? "").includes(q),
    );
  }, [current, marks, lifted, find, globalDye]);

  // CHOOSING SEVERAL PLACES. What "all" means is the rows the search has left, and a place already
  // lifted is not among them — it is on its way out and holds its own undo.
  const sel = useListSelection(rows.filter((p) => !lifted[p.id]).map((p) => p.id));

  const open = (p: Place) =>
    onOpen({ id: p.book_id, filePath: p.file_path, dir: p.book_dir, cfi: p.cfi });

  /** Lifting is reversible in place; the row keeps its position and holds the undo. */
  const lift = (id: string) => setLifted((m) => ({ ...m, [id]: true }));
  const undo = (id: string) =>
    setLifted((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  /** Leaving the view is what commits a lift — no timed toast, no dialogue. */
  const commit = () => {
    const ids = Object.keys(lifted);
    if (!ids.length) return;
    for (const id of ids) void bookmarkDelete(id).catch(() => {});
    setMarks((rows2) => rows2.filter((r) => !lifted[r.id]));
    setLifted({});
  };
  const toShelf = () => { commit(); setOpenId(null); setFind(""); };

  const tally = (n: number) =>
    n === 0
      ? t("bm.none")
      : ar
        ? pluralAr(n, { one: t("bm.one"), two: t("bm.two"), few: t("bm.few"), many: t("bm.many") }, num)
        : `${num(n)} ${n === 1 ? t("bm.one") : t("bm.few")}`;

  if (!loaded) return <div className="bm" />;

  // ── the record for one book ────────────────────────────────────────────────────────────────────
  if (current) {
    const headSilks = silks(current.places.map((p) => ({ id: p.id, depth: p.depth })));
    return (
      <div className="bm">
        {/* THE BOOK IS ONE THING; THE PLACES ARE ANOTHER.
            One card used to hold both, and the identity read as the lid of the list rather than as
            the book the list belongs to. They are two surfaces now, and the identity is a CHIP that
            hugs what it holds — the same part References & Replacements already uses to say "this is
            the book you are looking at", so the two surfaces answer the same question the same way.
            The way back, the identity and the search are ONE band, packed and aligned to the column
            the places are drawn in. They used to be two rows with a `flex: 1` spacer between the chip
            and the search, and since the chip hugs its content that spacer had nothing to push against
            but background image — which is what left the search marooned out in the artwork. The
            search still stands beside the chip rather than inside it: it acts on the places, not on
            the book. */}
        <div className="bm-idrow">
          {/* The way back leads the band: it is where the eye starts on an RTL row, and framed it
              reads as a control rather than as a caption laid over the artwork. */}
          <button className="bm-back" onClick={toShelf}>
            <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5l-5 5 5 5" />
            </svg>
            {t("bm.back")}
          </button>
          <div className="bm-cur">
            <div className="bm-cur-book">
              <div className="bm-cur-cover">
                {coverSrc(current.book.cover_path) ? <img src={coverSrc(current.book.cover_path)!} alt="" /> : <span className="bm-cover-bare" />}
              </div>
              {current.places.map((p, i) => (
                <span
                  key={p.id}
                  className="bm-silk bm-silk-head"
                  style={{ top: headSilks[i].headLift, insetInlineStart: headSilks[i].pos, height: headSilks[i].headLen, background: p.dye }}
                />
              ))}
            </div>
            <div className="bm-cur-txt">
              <span className="bm-eyebrow">{t("bm.eyebrow")}</span>
              <h1 className="bm-cur-title"><bdi>{current.book.title}</bdi></h1>
              <span className="bm-cur-note">{tally(current.places.length)}</span>
            </div>
          </div>
          <label className="bm-find">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
              <circle cx="8.6" cy="8.6" r="5" /><path d="M12.4 12.4 17 17" />
            </svg>
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("bm.search")} />
          </label>
          {/* The shelf's own removal is a LIFT: reversible in place, committed by leaving. Several
              at once means several lifts, each still holding its undo — not a harsher second
              meaning for the same word. */}
          <SelectionBar
            sel={sel}
            total={rows.length}
            actions={[{
              key: "lift",
              // NOT a trash: this shelf lifts a place off the page and holds the undo on the row. A
              // destructive mark would promise something harsher than what the action does.
              icon: "bookmark" as const,
              label: t("bm.lift"),
              run: () => {
                setLifted((m) => {
                  const next = { ...m };
                  for (const id of sel.selected) next[id] = true;
                  return next;
                });
                sel.exit();
              },
            }]}
          />
        </div>

          <div className="bm-record">
          {rows.map((p) => {
            const gone = !!lifted[p.id];
            const where = p.chapter_label || t("bm.somewhere");
            return (
              <div
                key={p.id}
                className={`bm-row${gone ? " gone" : ""}${p.id === lastId && !gone ? " last" : ""}${sel.has(p.id) ? " sel-on" : ""}`}
                // While the mode is on, the row CHOOSES. A lifted row is out of the mode's reach:
                // it is already leaving, and its undo is the only thing left to press on it.
                onClick={gone ? undefined : sel.on ? () => sel.toggle(p.id) : () => open(p)}
                role={gone ? undefined : "button"}
                tabIndex={gone ? undefined : 0}
              >
                {sel.on && !gone && (
                  <SelectionBox on={sel.has(p.id)} onToggle={() => sel.toggle(p.id)} label={p.label ?? where} />
                )}
                <div className="bm-row-mark">
                  <span className="bm-silk bm-silk-row" style={{ background: gone ? undefined : p.dye }} />
                  <span className="bm-folio">{p.fraction != null ? `${num(Math.round(p.fraction * 100))}%` : ""}</span>
                </div>
                <div className="bm-row-body">
                  {gone ? (
                    <span className="bm-gone">{t("bm.liftedFrom", { where })}</span>
                  ) : p.label ? (
                    <span className={`bm-words${isArabicText(p.label) ? " ar" : ""}`}><bdi>{p.label}</bdi></span>
                  ) : (
                    // A place saved before Sard captured the words it was saved at. Its chapter is
                    // what it truthfully has, said plainly rather than dressed as an excerpt.
                    <span className="bm-words bm-words-bare"><bdi>{where}</bdi></span>
                  )}
                  <div className="bm-row-meta">
                    {p.id === lastId && !gone && (
                      <>
                        <span className="bm-last">{t("bm.last")}</span>
                        <span className="bm-tick" aria-hidden />
                      </>
                    )}
                    {p.label && <><span><bdi>{where}</bdi></span><span className="bm-tick" aria-hidden /></>}
                    <span>{relTime(p.created_at, lang)}</span>
                  </div>
                </div>
                <div className="bm-row-acts" onClick={(e) => e.stopPropagation()}>
                  {gone ? (
                    <button className="bm-undo" onClick={() => undo(p.id)}>{t("bm.undo")}</button>
                  ) : (
                    !sel.on && (
                    <>
                      <button className="bm-act strong" onClick={() => open(p)}>{t("bm.open")}</button>
                      <button className="bm-act" onClick={() => lift(p.id)}>{t("bm.lift")}</button>
                    </>
                    )
                  )}
                </div>
              </div>
            );
          })}

          {rows.length === 0 && (
            <div className="bm-empty">
              <span className="bm-empty-silk" aria-hidden />
              <span className="bm-empty-title">{find.trim() ? t("bm.noMatch", { q: find.trim() }) : t("bm.bookEmpty")}</span>
              <span className="bm-empty-body">{find.trim() ? t("bm.noMatchBody") : t("bm.bookEmptyBody")}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── the shelf ──────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="bm">
      <header className="bm-head bm-head-shelf">
        {/* Title and count on one ground — see `ui-page-title`. */}
        <span className="ui-page-title">
          <h1 className="bm-title">{t("panel.bookmarks")}</h1>
          <span className="bm-note">
            {totalPlaces === 0
              ? t("bm.shelfNone")
              : t("bm.shelfNote", { places: tally(totalPlaces), books: num(totalBooks) })}
          </span>
        </span>
      </header>

      <div className="bm-shelf">
        {shelf.map(({ book, places }) => {
          const set = silks(places.map((p) => ({ id: p.id, depth: p.depth })));
          return (
            <button key={book.id} className="bm-book" onClick={() => setOpenId(book.id)}>
              <span className="bm-board">
                <span className="bm-cover">
                  {coverSrc(book.cover_path) ? <img src={coverSrc(book.cover_path)!} alt="" /> : <span className="bm-cover-bare" />}
                  <span className="bm-edge" aria-hidden />
                </span>
                {places.map((p, i) => (
                  <span
                    key={p.id}
                    className="bm-silk"
                    style={{
                      top: set[i].lift,
                      insetInlineStart: set[i].pos,
                      height: set[i].len,
                      background: p.dye,
                      transitionDelay: set[i].delay,
                    }}
                  />
                ))}
              </span>
              <span className="bm-name"><bdi>{book.title}</bdi></span>
              <span className={`bm-tally${places.length ? " has" : ""}`}>{tally(places.length)}</span>
            </button>
          );
        })}
        {shelf.length === 0 && (
          <div className="bm-empty">
            <span className="bm-empty-silk" aria-hidden />
            <span className="bm-empty-title">{t("bm.shelfNone")}</span>
            <span className="bm-empty-body">{t("bm.bookEmptyBody")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
