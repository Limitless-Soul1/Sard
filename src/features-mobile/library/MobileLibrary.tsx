// THE LIBRARY — design C1: Continue, Recent, then every book as a row.
//
// WHY A LIST AND NOT THE GRID IT REPLACES. The design puts it plainly: "At phone width a grid shows 6
// covers and no titles; a row shows title, author, progress and Arabic titles unclipped." There is a
// second reason the design does not give and the device found: a row is UNIFORM BY CONSTRUCTION, which
// is exactly the contract the windowing assumes. The grid's cards measured 311–328px depending on
// whether a title took one line or two, against an assumed 260px pitch, and the drift left up to a
// third of the viewport blank and the last book of seventeen unreachable.
//
// THE GRID IS NOT GONE. `useVirtualGrid` stays untouched, because the design keeps a 2-up grid as an
// opt-in (C6). What changed is which surface is primary.
//
// WHAT IS SHARED, and it is nearly everything: `libraryListBooks` and the IPC surface, `resolveBookMeta`
// / `displayTitle` / `displayAuthorOrUnknown`, `coverSrc`, the stores, the tokens and the strings. This
// file is presentation. No domain logic is duplicated here, and none should be.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { annotationsAll, libraryListBooks, type BookRow } from "../../lib/ipc";
import { displayAuthorOrUnknown, displayTitle, resolveBookMeta } from "../../lib/bookMeta";
import { localeDigits } from "../../lib/format";
import { coverSrc } from "../../features/library/coverSrc";
import { useElementSize } from "../lib/useElementSize";
import { windowRows } from "./useVirtualRows";
import { Icon } from "../components/Icon";
import { DEFAULT_FILTERS, filtersAreDefault, SortFilterSheet, type Filters } from "./SortFilterSheet";

/** The chip shows the sort in force. Keys are the product's own; only the mapping lives here. */
const SORT_LABEL: Record<Filters["sort"], "lib.sort.dateRead" | "lib.sort.title" | "lib.sort.author" | "lib.sort.dateAdded" | "lib.col.progress"> = {
  date_read: "lib.sort.dateRead",
  title: "lib.sort.title",
  author: "lib.sort.author",
  date_added: "lib.sort.dateAdded",
  progress: "lib.col.progress",
};

/** How many books the Recent strip carries before it stops being a strip and starts being a list. */
const RECENT_MAX = 8;

/** Roughly how much non-list content sits above the windowed list. Approximate ON PURPOSE: the window
 *  carries two rows of overscan either side, which absorbs the error, and measuring two more elements
 *  on every scroll event would cost more than it buys. */
const bandsAbove = (hasContinue: boolean, hasRecent: boolean) =>
  (hasContinue ? 178 : 0) + (hasRecent ? 236 : 0) + 64;

interface Props {
  onOpenBook: (b: BookRow) => void;
  /** C5: a row in "All books" opens the book's SHEET, not the book — the design's own rule. Continue
   *  and Recent stay direct, because those are the "carry on reading" affordances. */
  onOpenDetails?: (b: BookRow) => void;
  onOpenDrawer: () => void;
  /**
   * One shelf, open (design L1). The SAME surface scoped to a collection rather than a second list:
   * `libraryListBooks` already filters by collection in SQL, so the shelf costs no new query, no new
   * row component and no second sort. Absent means the whole library.
   */
  shelf?: { id: string; name: string } | null;
  /** C4 is a stack entry, so the shell owns whether it is open and Back closes it. */
  onOpenSearch?: () => void;
  sortOpen?: boolean;
  onOpenSort?: () => void;
  onCloseSort?: () => void;
}

export function MobileLibrary({ onOpenBook, onOpenDetails, onOpenDrawer, shelf = null, onOpenSearch, sortOpen = false, onOpenSort, onCloseSort }: Props) {
  const { t } = useI18n();
  const [raw, setBooks] = useState<BookRow[] | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  /** Book ids that own at least one mark — the "With notes" filter, from the same cross-book query the
   *  marks place reads. Fetched once; a filter that needs it should not cost a query per keystroke. */
  const [marked, setMarked] = useState<Set<string> | null>(null);
  const [scroller, size] = useElementSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    let alive = true;
    // Most-recently-read first: on a phone the library is the way back into the book you are reading,
    // not a catalogue to browse. The design's own sort chip reads "Recent" for the same reason.
    // `progress` is not a SQL sort key, so the query asks for the default order and the list is sorted
    // by `fraction` below. Every other choice is sorted in SQL, where it belongs.
    const sqlSort = filters.sort === "progress" ? "date_read" : filters.sort;
    const order = filters.sort === "title" || filters.sort === "author" ? "asc" : "desc";
    libraryListBooks({ sort: sqlSort, order, collection: shelf?.id ?? null })
      .then((rows) => alive && setBooks(rows))
      .catch(() => alive && setBooks([]));
    return () => {
      alive = false;
    };
  }, [shelf?.id, filters.sort]);

  // Only fetched when a filter actually needs it.
  useEffect(() => {
    if (filters.show !== "notes" || marked) return;
    let alive = true;
    annotationsAll()
      .then((rows) => alive && setMarked(new Set(rows.map((r) => r.book_id))))
      .catch(() => alive && setMarked(new Set()));
    return () => {
      alive = false;
    };
  }, [filters.show, marked]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // THE FILTERS THAT SQL CANNOT ANSWER, applied to the list that arrived. Each reads a real column:
  // `fraction` for started/unstarted, `language` sniffed at import, and the marks set for "with notes".
  // Progress sorting happens here for the same reason — it is not a `SortKey`, but it is a real value.
  const books = useMemo(() => {
    let rows = raw ?? [];
    if (filters.show === "reading") rows = rows.filter((b) => (b.fraction ?? 0) > 0);
    else if (filters.show === "unread") rows = rows.filter((b) => !b.fraction);
    else if (filters.show === "notes") rows = marked ? rows.filter((b) => marked.has(b.id)) : [];
    if (filters.lang !== "any") rows = rows.filter((b) => (b.language ?? "").toLowerCase().startsWith(filters.lang));
    if (filters.sort === "progress") rows = [...rows].sort((a, b) => (b.fraction ?? 0) - (a.fraction ?? 0));
    return raw === null ? null : rows;
  }, [raw, filters.show, filters.lang, filters.sort, marked]);

  // The design's three bands come from one sorted list rather than three queries: Continue is the most
  // recently opened book, Recent is the rest of the opened ones, and every book still appears in "All
  // books" — so nothing is hidden by being featured.
  const { continueBook, recent } = useMemo(() => {
    const opened = (books ?? []).filter((b) => b.last_opened_at != null);
    return { continueBook: opened[0] ?? null, recent: opened.slice(1, RECENT_MAX + 1) };
  }, [books]);

  // THE SHEET OUTLIVES THE LIST. A filter that leaves nothing must not take its own undo away with it:
  // if the empty state replaced the whole surface, the reader would be looking at "nothing here" with
  // no way back to the choice that emptied it. So the sheet is rendered beside every branch below.
  const sheet = sortOpen ? (
    <SortFilterSheet
      value={filters}
      onChange={setFilters}
      onApply={() => onCloseSort?.()}
      resultCount={books?.length ?? 0}
    />
  ) : null;

  if (books === null)
    return (
      <>
        {sheet}
        <LoadingLibrary onOpenDrawer={onOpenDrawer} onOpenSearch={onOpenSearch} />
      </>
    );
  if (books.length === 0)
    return (
      <>
        {sheet}
        {/* Nothing at all versus nothing MATCHING: the first invites books, the second says the filter
            is the reason and leaves the chip in reach to change it. */}
        {filtersAreDefault(filters) ? (
          <EmptyLibrary onOpenDrawer={onOpenDrawer} onOpenSearch={onOpenSearch} shelf={shelf} />
        ) : (
          <div className="ml-root">
            <LibraryHeader onOpenDrawer={onOpenDrawer} onOpenSearch={onOpenSearch} />
            <div className="ml-allhead">
              <div className="ml-allhead-title">
                <h2 className="ml-alltitle" dir="auto">{shelf ? shelf.name : t("m.allBooks")}</h2>
                <span className="ml-allcount">{localeDigits("0")}</span>
              </div>
              <div className="ml-allhead-controls">
                <button type="button" className="ml-chip" onClick={onOpenSort}>
                  <Icon name="viewList" />
                  {t(SORT_LABEL[filters.sort])}
                </button>
              </div>
            </div>
            <div className="ml-empty">
              <div className="ml-empty-title">{t("inbox.empty.none")}</div>
              {/* The Inbox's hint names colour, tag and search — filters this sheet does not have. */}
              <p className="ml-quiet">{t("lib.empty.noMatchSub")}</p>
            </div>
          </div>
        )}
      </>
    );

  const win = windowRows(
    books.length,
    scrollTop - bandsAbove(!!continueBook, recent.length > 0),
    size.height,
  );
  const visible = books.slice(win.first, win.last + 1);

  return (
    <div className="ml-root">
      {sheet}
      <LibraryHeader onOpenDrawer={onOpenDrawer} onOpenSearch={onOpenSearch} />
      <div className="ml-scroll" ref={scroller} onScroll={onScroll}>
        {continueBook ? (
          <section className="ml-band">
            <h2 className="ml-eyebrow">{t("m.continue")}</h2>
            <ContinueCard book={continueBook} onOpen={onOpenBook} />
          </section>
        ) : null}

        {recent.length > 0 ? (
          <section className="ml-band ml-band--flush">
            <h2 className="ml-eyebrow ml-eyebrow--inset">{t("m.recent")}</h2>
            <ul className="ml-recent">
              {recent.map((b) => (
                <RecentCard key={b.id} book={b} onOpen={onOpenBook} />
              ))}
            </ul>
          </section>
        ) : null}

        <div className="ml-allhead">
          <div className="ml-allhead-title">
            <h2 className="ml-alltitle" dir="auto">{shelf ? shelf.name : t("m.allBooks")}</h2>
            <span className="ml-allcount">{localeDigits(String(books.length))}</span>
          </div>
          {/* The design's sort chip and grid toggle. Both are DRAWN because both are real surfaces in
              the design (C4, C6) and neither is built yet; both are DISABLED because a control that
              lies about what it does is worse than one that admits it is not ready. */}
          <div className="ml-allhead-controls">
            {/* C4's entry point. The chip carries the CURRENT sort, as the design draws it, so the
                library states its own order without the sheet being open. */}
            <button type="button" className="ml-chip" onClick={onOpenSort}>
              <Icon name="viewList" />
              {t(SORT_LABEL[filters.sort])}
            </button>
            <button
              type="button"
              className="ml-iconbtn ml-iconbtn--framed"
              disabled
              aria-disabled="true"
              aria-label={t("lib.view.grid")}
            >
              <Icon name="viewGrid" />
            </button>
          </div>
        </div>

        {/* The list is windowed, so what is in the DOM is a slice. Announce the real size, and where in
            it the rendered rows sit, rather than letting a screen reader report "12 items". The
            spacers carry the height of the rows that are not rendered, so the scrollbar reflects the
            whole library and the scroll position means what it says. */}
        <ul className="ml-list" aria-setsize={books.length}>
          <li className="ml-spacer" style={{ blockSize: win.padTop }} aria-hidden="true" />
          {visible.map((b, i) => (
            <BookListRow key={b.id} book={b} index={win.first + i} onOpen={onOpenDetails ?? onOpenBook} />
          ))}
          <li className="ml-spacer" style={{ blockSize: win.padBottom }} aria-hidden="true" />
        </ul>
      </div>
    </div>
  );
}

// ---- shell pieces -------------------------------------------------------------------------------

function LibraryHeader({ onOpenDrawer, onOpenSearch }: { onOpenDrawer: () => void; onOpenSearch?: () => void }) {
  const { t } = useI18n();
  return (
    <header className="ml-head">
      {/* The ONLY way into the drawer. Android owns the screen edges and delivers an edge swipe as a
          Back event, so the design's edge-swipe gesture is deliberately not bound — see `openDrawer`. */}
      <button type="button" className="ml-iconbtn" onClick={onOpenDrawer} aria-label={t("lib.shelves")}>
        <Icon name="menu" />
      </button>
      <div className="ml-wordmark">
        <span className="ml-wordmark-latin">Sard</span>
        <span className="ml-wordmark-rule" aria-hidden="true" />
        <span className="ml-wordmark-ar">سَرْد</span>
      </div>
      <button type="button" className="ml-iconbtn" onClick={onOpenSearch} aria-label={t("lib.search")}>
        <Icon name="search" />
      </button>
    </header>
  );
}

function LoadingLibrary({ onOpenDrawer, onOpenSearch }: { onOpenDrawer: () => void; onOpenSearch?: () => void }) {
  return (
    <div className="ml-root" aria-busy="true">
      <LibraryHeader onOpenDrawer={onOpenDrawer} onOpenSearch={onOpenSearch} />
      {/* Shape-matched skeletons at low ink, per the design's state table — "no spinners above the
          fold". They match the row geometry exactly so the page does not jump when books arrive. */}
      <div className="ml-scroll">
        <ul className="ml-list" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <li className="ml-row ml-row--skeleton" key={i}>
              <span className="ml-row-cover ml-skel" />
              <span className="ml-row-body">
                <span className="ml-skel ml-skel-line" />
                <span className="ml-skel ml-skel-line ml-skel-line--short" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function EmptyLibrary({ onOpenDrawer, onOpenSearch, shelf }: { onOpenDrawer: () => void; onOpenSearch?: () => void; shelf?: { id: string; name: string } | null }) {
  const { t } = useI18n();
  return (
    <div className="ml-root">
      <LibraryHeader onOpenDrawer={onOpenDrawer} onOpenSearch={onOpenSearch} />
      {/* An EMPTY SHELF is not an empty library, and the product already words the difference: one
          invites the reader to add books to Sard, the other tells them this shelf has none yet. Saying
          "your library is empty" over a library with books in it would simply be false. */}
      <div className="ml-empty">
        <h1 className="ml-empty-title">{t(shelf ? "lib.shelfEmpty.title" : "lib.empty.title")}</h1>
        {/* NOT `lib.empty.sub`: that string says "drag books onto this window", which a phone cannot
            do. Reusing desktop copy is how a mobile UI quietly becomes a port. */}
        <p className="ml-quiet">{t(shelf ? "lib.shelfEmpty.hint" : "lib.emptyMobile.sub")}</p>
      </div>
    </div>
  );
}

// ---- book pieces --------------------------------------------------------------------------------

/** A cover, or the design's plain plate with the title set on it where a book has no image. */
function Cover({ book, className }: { book: BookRow; className: string }) {
  const src = coverSrc(book);
  const meta = resolveBookMeta(book);
  return (
    <span className={src ? className : `${className} ml-cover--blank`}>
      {src ? (
        // `loading="lazy"` matters more here than on desktop: a fling can cross rows faster than they
        // decode, and an undecoded cover costs nothing but a blank.
        <img src={src} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="ml-cover-title" dir="auto">
          {meta.title ?? ""}
        </span>
      )}
    </span>
  );
}

const pct = (b: BookRow): number | null =>
  b.fraction != null && b.fraction > 0 ? Math.round(b.fraction * 100) : null;

function ContinueCard({ book, onOpen }: { book: BookRow; onOpen: (b: BookRow) => void }) {
  const { t } = useI18n();
  const meta = resolveBookMeta(book);
  const p = pct(book);
  return (
    <button type="button" className="ml-continue" onClick={() => onOpen(book)}>
      <Cover book={book} className="ml-continue-cover" />
      <span className="ml-continue-body">
        <span className="ml-continue-title" dir="auto">
          {displayTitle(meta, t)}
        </span>
        {/* The design shows the CHAPTER here. `library_list_books` returns none — a chapter is a
            reader-session fact, not a library one — so the author stands in rather than a fabricated
            location. The design's "about 22 min left" is omitted for the same reason: Sard computes no
            reading-time estimate anywhere, and drawing one would be inventing a feature. */}
        <span className="ml-continue-sub" dir="auto">
          {displayAuthorOrUnknown(meta, t)}
        </span>
        <span className="ml-bar" aria-hidden="true">
          <span className="ml-bar-fill" style={{ inlineSize: `${p ?? 0}%` }} />
        </span>
        <span className="ml-continue-foot">
          {p == null ? t("m.notStarted") : `${localeDigits(String(p))}%`}
        </span>
      </span>
    </button>
  );
}

function RecentCard({ book, onOpen }: { book: BookRow; onOpen: (b: BookRow) => void }) {
  const { t } = useI18n();
  const meta = resolveBookMeta(book);
  const p = pct(book);
  return (
    <li className="ml-recent-item">
      <button type="button" className="ml-recent-btn" onClick={() => onOpen(book)}>
        <Cover book={book} className="ml-recent-cover" />
        <span className="ml-recent-title" dir="auto">
          {displayTitle(meta, t)}
        </span>
        {p != null ? <span className="ml-recent-pct">{localeDigits(String(p))}%</span> : null}
      </button>
    </li>
  );
}

function BookListRow({
  book,
  index,
  onOpen,
}: {
  book: BookRow;
  index: number;
  onOpen: (b: BookRow) => void;
}) {
  const { t } = useI18n();
  const meta = resolveBookMeta(book);
  const p = pct(book);
  const finished = book.read_at != null;
  return (
    <li className="ml-row" aria-posinset={index + 1}>
      <button type="button" className="ml-row-btn" onClick={() => onOpen(book)}>
        <Cover book={book} className="ml-row-cover" />
        <span className="ml-row-body">
          <span className="ml-row-title" dir="auto">
            {displayTitle(meta, t)}
          </span>
          <span className="ml-row-author" dir="auto">
            {displayAuthorOrUnknown(meta, t)}
          </span>
          {/* The design's three row states, all of them backed: a bar and a percentage while reading,
              a quiet "Not started · EPUB" before, and a finished line after. `fraction` and `read_at`
              supply the first two; the format comes from the row itself. */}
          {finished ? (
            <span className="ml-row-status ml-row-status--done">{t("m.finished")}</span>
          ) : p != null ? (
            <span className="ml-row-progress">
              <span className="ml-bar ml-bar--short" aria-hidden="true">
                <span className="ml-bar-fill" style={{ inlineSize: `${p}%` }} />
              </span>
              <span className="ml-row-pct">{localeDigits(String(p))}%</span>
            </span>
          ) : (
            <span className="ml-row-status">
              {t("m.notStarted")}
              {book.format ? ` · ${book.format.toUpperCase()}` : ""}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
