// RAWY-202: the cross-book Bookmarks shelf in the Library. Lists EVERY bookmark across all books —
// each with its book, chapter and reading position — filter by book, click to open that book at the
// bookmark's locator. A READ + NAVIGATE view over data that already exists: the backend `bookmarks_all`
// (BookmarkItem) was built long ago (RAWY-41) and had no consumer until now. Deliberately mirrors
// Inbox.tsx (highlights/notes) — same chrome, same book-filter dropdown, same open path — so it reuses
// the Library's visual language wholesale (the `inbox-*` classes). No new design, no new nav path.
//
// A bookmark has no text excerpt (`label` is never populated on creation), so a card shows
// book · chapter · % read · relative time — nothing faked. Deleted-book bookmarks never reach here
// (bookmarks_all INNER-JOINs books + the FK cascade removes them). A stale CFI opens through the
// reader's resilient resume/goto (RAWY-162), the same as a stale saved position — no crash.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, uiDateTimeFormat, uiRelativeTimeFormat } from "../../lib/format";
import { bookmarksAll, type BookmarkItem } from "../../lib/ipc";
import type { OpenTarget } from "./Library";

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

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
  const [items, setItems] = useState<BookmarkItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [book, setBook] = useState<string | null>(null);
  const [bookMenu, setBookMenu] = useState(false);

  useEffect(() => {
    bookmarksAll()
      .then((rows) => setItems(rows))
      .catch(console.error)
      .finally(() => setLoaded(true));
  }, []);

  // Distinct books present (for the "All books" filter) — same as Inbox.
  const books = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) if (!m.has(it.book_id)) m.set(it.book_id, it.book_title || "—");
    return [...m].map(([id, title]) => ({ id, title }));
  }, [items]);

  const filtered = book ? items.filter((it) => it.book_id === book) : items;

  // The open path (RAWY-162): the bookmark's own CFI becomes the reader's resumeCfi → ctrl.open. Exactly
  // what Inbox does for a highlight/note, and what the resume uses — so the shelf lands on the SAME
  // position as opening this bookmark from inside the book.
  const open = (it: BookmarkItem) =>
    onOpen({ id: it.book_id, filePath: it.file_path, dir: it.book_dir, cfi: it.cfi });

  const pct = (f: number | null): string | null =>
    f == null ? null : t("bm.percent", { p: localeDigits(String(Math.round(f * 100)), lang) });

  if (!loaded) return null;

  return (
    <div className="inbox">
      <header className="inbox-head">
        <div className="inbox-head-top">
          <div className="inbox-title-wrap">
            <h1 className="inbox-title">{t("lib.nav.bookmarks")}</h1>
            <span className="inbox-count">
              {t("inbox.count", { n: localeDigits(String(items.length), lang), m: localeDigits(String(books.length), lang) })}
            </span>
          </div>
        </div>

        <div className="inbox-filters">
          <div className="inbox-ctl-wrap">
            <button className="inbox-ctl" onClick={() => setBookMenu((o) => !o)}>
              {book ? books.find((b) => b.id === book)?.title ?? t("inbox.allBooks") : t("inbox.allBooks")} ▾
            </button>
            {bookMenu && (
              <>
                <div className="lib-clickaway" onClick={() => setBookMenu(false)} />
                <div className="lib-menu inbox-menu">
                  <button className={book === null ? "active" : ""} onClick={() => { setBook(null); setBookMenu(false); }}>
                    {t("inbox.allBooks")}
                  </button>
                  {books.map((b) => (
                    <button
                      key={b.id}
                      className={book === b.id ? "active" : ""}
                      dir={ARABIC.test(b.title) ? "rtl" : "ltr"}
                      onClick={() => { setBook(b.id); setBookMenu(false); }}
                    >
                      {b.title}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="inbox-empty">
          <div className="inbox-empty-mark" aria-hidden>⚑</div>
          <div className="inbox-empty-title">{items.length === 0 ? t("bm.empty.title") : t("inbox.empty.none")}</div>
          <div className="inbox-empty-sub">{items.length === 0 ? t("bm.empty.sub") : t("inbox.empty.noneSub")}</div>
        </div>
      ) : (
        <div className="inbox-list">
          {filtered.map((it) => {
            const arabic = it.book_dir === "rtl" || ARABIC.test(it.book_title ?? "");
            return (
              <button
                key={it.id}
                className="inbox-card bm-card"
                onClick={() => open(it)}
                dir={arabic ? "rtl" : "ltr"}
              >
                <span className="inbox-card-bar bm-bar" aria-hidden />
                <span className="inbox-card-body">
                  <span className={`inbox-card-text${arabic ? " ar" : ""}`}>{it.book_title || "—"}</span>
                  <span className="inbox-card-meta">
                    {[it.chapter_label, pct(it.fraction), relTime(it.created_at, lang)].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
