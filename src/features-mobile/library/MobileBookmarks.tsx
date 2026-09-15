// BOOKMARKS — the cross-book shelf (RAWY-202), on a phone.
//
// THE MOBILE DESIGN DOES NOT DRAW THIS SCREEN, and that is recorded rather than papered over: the
// drawer keeps the entry "even though the design's own drawer omits it — Sard ships a cross-book
// bookmarks shelf, and a capability is not dropped because a prototype forgot it". The mobile reader
// has been able to MAKE bookmarks since its top bar existed; this is the first place they can be read.
//
// So the layout is DERIVED, not invented. The desk states the relationship itself: `BookmarksShelf`
// "deliberately mirrors Inbox.tsx — same chrome, same book-filter dropdown, same open path". Mobile's
// highlights place (G2) is the mobile counterpart of Inbox, so this mirrors that, and the pair stands in
// the same relation on the phone as it does on the desk.
//
// WHAT A ROW MAY SHOW is not a choice either. The desk is explicit: "a bookmark has no text excerpt
// (`label` is never populated on creation), so a card shows book · chapter · % read · relative time —
// nothing faked." There is no passage to quote here and none is manufactured.
//
// The awkward cases are already answered upstream and are not re-solved here: a bookmark whose book was
// deleted never arrives (`bookmarks_all` INNER-JOINs books, and the FK cascade removes it), and a stale
// locator opens through the reader's resilient resume (RAWY-162) exactly as a stale saved position does.

import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { relTime } from "../lib/relTime";
import { bookmarksAll, type BookmarkItem } from "../../lib/ipc";
import type { BookRef } from "../app/navigation";

export function MobileBookmarks({ onOpenAt }: { onOpenAt: (b: BookRef) => void }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<BookmarkItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    bookmarksAll()
      .then((rows) => alive && setItems(rows))
      .catch(console.error)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  if (loaded && items.length === 0) {
    return (
      <div className="ml-empty">
        <div className="ml-empty-title">{t("bm.empty.title")}</div>
        <div>{t("bm.empty.sub")}</div>
      </div>
    );
  }

  return (
    <div className="mk-root">
      <div className="ml-allhead">
        <div className="ml-allhead-title">{t("lib.nav.bookmarks")}</div>
      </div>

      <div className="mk-list">
        {items.map((b) => (
          <button
            key={b.id}
            type="button"
            className="mk-row"
            onClick={() => onOpenAt({ id: b.book_id, filePath: b.file_path, cfi: b.cfi, title: b.book_title })}
          >
            {/* The ribbon is the bookmark's mark in the reader, so it identifies the row here. It takes
                the accent rather than an ink: a bookmark has no colour of its own to honour. */}
            <span className="mk-ink mk-ink--bm" aria-hidden="true" />
            <span className="mk-body">
              <span className="mk-meta" dir="auto">
                {b.book_title ?? ""}
                {b.chapter_label ? ` · ${b.chapter_label}` : ""}
                {b.created_at ? ` · ${relTime(b.created_at, lang)}` : ""}
              </span>
              {/* The position IS the content — there is nothing else a bookmark carries. */}
              {b.fraction != null ? (
                <span className="mk-text mk-text--quiet">
                  {t("bm.percent").replace("{p}", localeDigits(String(Math.round(b.fraction * 100)), lang))}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
