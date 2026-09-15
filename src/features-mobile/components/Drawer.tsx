// THE PLACES DRAWER — design C2.
//
// WHAT IT REPLACES. A four-item bottom bar that spent a measured 56.7px of chrome plus a 24px safe
// inset — about 10% of an 829px viewport — permanently, to advertise three destinations a reader
// visits a few times a session. The design's argument is quoted in `navigation.ts`; the accessibility
// half of it is the decisive one, since a bar cannot hold «التظليلات والملاحظات» on one line at large
// text sizes and a full-width row can.
//
// OPENED FROM THE HEADER, NEVER FROM THE EDGE. Android owns both screen edges and delivers an edge
// swipe as Back, so binding the drawer to that gesture would make root Back mean "open drawer". See
// `openDrawer` for the whole argument. Back CLOSES the drawer, because it is a stack entry.
//
// WHAT IS REAL HERE. The shelves are `collectionsList()`, their counts are the collection's own
// `count`, the marks total is `annotationsAll()`, the card count is `photocardsList()`, the language
// toggle is `setLang`, and the version is `appInfo()`. Nothing on this surface is decorative.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { annotationsAll, bookmarksAll, collectionCreate, collectionsList, photocardsList, type CollectionRow } from "../../lib/ipc";
import { localeDigits } from "../../lib/format";
import { Icon, type IconName } from "./Icon";
import type { Place } from "../app/navigation";

interface Props {
  active: Place;
  onGo: (p: Place) => void;
  /** A shelf is a destination of its own (design L1), not a filter applied to the library in place. */
  onOpenShelf: (id: string, name: string) => void;
  onClose: () => void;
}

/** Long enough for a real Arabic shelf name, short enough that a row still reads as one line. */
const SHELF_NAME_MAX = 60;

/** The design lists four; Sard has five, because it ships a cross-book bookmarks shelf. */
const PLACE_ROWS: { place: Place; icon: IconName; key: string }[] = [
  { place: "library", icon: "book", key: "lib.nav.library" },
  { place: "highlights", icon: "note", key: "lib.nav.highlights" },
  { place: "bookmarks", icon: "bookmark", key: "lib.nav.bookmarks" },
  { place: "settings", icon: "settings", key: "reader.settings" },
];

export function Drawer({ active, onGo, onOpenShelf, onClose }: Props) {
  const { t, lang, setLang } = useI18n();
  const [shelves, setShelves] = useState<CollectionRow[]>([]);
  const [marks, setMarks] = useState<number | null>(null);
  const [marksBook, setMarksBook] = useState<number | null>(null);
  const [cards, setCards] = useState<number | null>(null);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Apply-on-success, the store's own rule everywhere else: the row appears when the write resolves,
  // never before, so a failed create cannot leave a shelf on screen that does not exist.
  const create = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      setShelves(await collectionCreate(clean));
      setName("");
      setMaking(false);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    // Counts are what make the drawer an index rather than a menu — the design writes each row's
    // current value beside it so most questions are answered without opening anything.
    collectionsList().then((c) => alive && setShelves(c)).catch(() => {});
    annotationsAll().then((a) => alive && setMarks(a.length)).catch(() => {});
    bookmarksAll().then((b) => alive && setMarksBook(b.length)).catch(() => {});
    photocardsList().then((p) => alive && setCards(p.length)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Focus moves into the drawer so a keyboard or switch user is not left behind on the library, and
  // so the panel is where Escape and screen-reader navigation start.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  // A zero is noise: an empty place says so when it is opened, and a column of "0"s reads as clutter
  // rather than as information. Only a real count earns a badge.
  const count = (n: number | null) => (n ? <span className="md-count">{localeDigits(String(n))}</span> : null);

  return (
    <div className="md-scrim" onClick={onClose}>
      <div
        className="md-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("lib.nav.library")}
        tabIndex={-1}
        ref={panel}
        // The scrim closes; the panel must not close when the panel itself is used.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="md-top" />

        <div className="md-wordmark">
          <span className="md-wordmark-latin">Sard</span>
          <span className="md-wordmark-rule" aria-hidden="true" />
          <span className="md-wordmark-ar">سَرْد</span>
        </div>

        <nav className="md-places">
          {PLACE_ROWS.map((r) => (
            <button
              key={r.place}
              type="button"
              className={`md-place${r.place === active ? " on" : ""}`}
              aria-current={r.place === active ? "page" : undefined}
              onClick={() => onGo(r.place)}
            >
              <Icon name={r.icon} />
              <span className="md-place-label">{t(r.key as Parameters<typeof t>[0])}</span>
              {r.place === "highlights" ? count(marks) : null}
              {r.place === "bookmarks" ? count(marksBook) : null}
            </button>
          ))}
          {/* Photo cards is a place in the design and a real surface in Sard, but it has no screen on
              mobile yet. It is listed with its real count and left disabled rather than silently
              dropped, so the drawer tells the truth about what exists. */}
          <button type="button" className="md-place" disabled aria-disabled="true">
            <Icon name="photoCard" />
            <span className="md-place-label">{t("photo.title")}</span>
            {count(cards)}
          </button>
        </nav>

        <div className="md-section">{t("lib.shelves")}</div>
        <div className="md-shelves">
          {shelves.length === 0 && !making ? (
            <p className="md-empty">{t("lib.noShelves")}</p>
          ) : (
            shelves.map((s) => (
              <button key={s.id} type="button" className="md-shelf" onClick={() => onOpenShelf(s.id, s.name)}>
                <span className="md-shelf-name" dir="auto">
                  {s.name}
                </span>
                <span className="md-count">{localeDigits(String(s.count))}</span>
              </button>
            ))
          )}

          {/* NEW SHELF — the design draws it as the last row of the shelf list, and L3 draws the same
              affordance inline: a field and a Create beside it, rather than a dialog on top of a drawer.
              It writes through `collectionCreate`, which returns the whole list, so the drawer's counts
              come back from the same call that made the shelf — there is no second fetch to drift. */}
          {making ? (
            <form
              className="md-newshelf"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                className="md-newshelf-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("lib.shelf.namePlaceholder")}
                aria-label={t("lib.shelf.namePlaceholder")}
                dir="auto"
                autoFocus
                maxLength={SHELF_NAME_MAX}
              />
              <button type="submit" className="md-newshelf-go" disabled={!name.trim() || busy}>
                {t("lib.shelf.create")}
              </button>
            </form>
          ) : (
            <button type="button" className="md-shelf md-shelf--new" onClick={() => setMaking(true)}>
              {/* The string already carries the design's leading "+", so the row does not draw a second one. */}
              <span className="md-shelf-name">{t("lib.newShelf")}</span>
            </button>
          )}
        </div>

        <div className="md-foot">
          {/* The design draws "English · العربية" as one control. It is the real `setLang` — the same
              switch the first-run picker writes — with the INACTIVE language emphasised, so the row
              reads as the thing it will do rather than as a label of where you already are.
              The design's "v2.4" beside it is not drawn: `app_info` carries no version field, and a
              number typed into the UI would be a number that could go stale. */}
          <button type="button" className="md-lang" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>
            <span className={lang === "ar" ? "md-lang-off" : "md-lang-on"}>English</span>
            <span className="md-lang-dot" aria-hidden="true">·</span>
            <span className={lang === "ar" ? "md-lang-on" : "md-lang-off"}>العربية</span>
          </button>
        </div>
      </div>
    </div>
  );
}
