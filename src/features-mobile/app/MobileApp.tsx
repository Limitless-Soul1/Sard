// The mobile application shell.
//
// A SIBLING OF `App.tsx`, NOT A MODE OF IT. The two share the reading session, the stores, the domain
// logic, the IPC surface, the tokens and every string — and share no markup. That is the structural
// half of ADR-0005: making a port difficult rather than merely discouraged.
//
// NAVIGATION IS A DRAWER, NOT A BAR. The design's argument is quoted in `navigation.ts`. The drawer is
// a STACK ENTRY, so Back closes it and nothing else; and it is opened only from the library header,
// never from the screen edge, because Android delivers an edge swipe as Back and binding it there
// would cost a second press to leave the app.

import { useEffect, useState } from "react";

// Loaded HERE, not in App.tsx: a desktop build never imports this module, so it never parses a byte
// of mobile layout.
import "../../styles/mobile.css";

import { initTheme } from "../../theme";
import type { BookRow } from "../../lib/ipc";
import { Drawer } from "../components/Drawer";
import { MobileLibrary } from "../library/MobileLibrary";
import { MobileMarks } from "../library/MobileMarks";
import { MobileSearch } from "../library/MobileSearch";
import { BookSheet } from "../library/BookSheet";
import { AddToShelfSheet } from "../library/AddToShelfSheet";
import { MobileBookmarks } from "../library/MobileBookmarks";
import { MobileSettings } from "../settings/MobileSettings";
import type { Screen } from "./navigation";
import {
  useActivePlace,
  useNav,
  useNavPlatformBridge,
  useOpenSheet,
  useReaderScreen,
  useTop,
} from "./useNavigation";

export function MobileApp() {
  const screen = useTop();
  const place = useActivePlace();
  const sheet = useOpenSheet();
  const readerScreen = useReaderScreen();
  const nav = useNav();

  // The same theme system as desktop: 16 themes, one token set, applied to `:root`. Nothing about it
  // is mobile-specific, which is why there is no mobile theme code — only mobile layout.
  useEffect(() => {
    void initTheme();
  }, []);

  // Android Back, and surviving a killed WebView.
  useNavPlatformBridge();

  // C5 is a stack entry carrying its book, so Back closes exactly it and a process death can rebuild it.
  // The ENTRY gives Back its meaning; the row itself is component state, so `navigation.ts` keeps its
  // independence from the library's data model. A process death drops the row and the sheet simply
  // does not reopen — the reader lands on the library, which is where they were.
  const [details, setDetails] = useState<BookRow | null>(null);
  const [shelfFor, setShelfFor] = useState<BookRow | null>(null);

  const openBook = (b: BookRow) => {
    // Pushed, not replaced: Back from the reader returns to the shelf the reader came from.
    nav.push({
      kind: "reader",
      book: { id: b.id, filePath: b.file_path, format: b.format, title: b.title, author: b.author },
    });
  };

  // The drawer floats OVER whichever place is beneath it, so that place keeps rendering and returns
  // without a remount when the drawer closes.
  const beneath = screen.kind === "drawer" ? place : screen.kind;
  // The drawer floats OVER a shelf too, so the shelf must be found beneath it exactly as the reader is
  // — otherwise opening the drawer from a shelf would blank the surface it is drawn over.
  const shelfScreen =
    screen.kind === "shelf"
      ? screen
      : screen.kind === "drawer"
        ? (nav.stack.filter((s) => s.kind === "shelf").pop() as Extract<Screen, { kind: "shelf" }> | undefined) ?? null
        : null;

  // THE READER IS NOT A PLACE. It is full-bleed — no shell padding, no safe-area inset from the
  // shell, no chrome around it — so it replaces the whole surface rather than rendering inside
  // `mobile-main`. Back pops it, which returns to the library beneath exactly as before.
  //
  // It keeps rendering while a SHEET is open over it, which is rule 1: popping a sheet must return to
  // the same reader entry rather than re-mounting one, or the book would re-open and lose its place.
  if (readerScreen) {
    // THE READER IS NOT INTEGRATED IN THIS PHASE, and the route is kept rather than deleted so the
    // gap stays visible instead of silent. `MobileReader` is the only mobile component that needs
    // `useReaderSession` — a hook that exists solely because of a 2,100-line extraction out of the
    // desktop `Reader.tsx`. Re-performing that extraction against the current desktop reader is a
    // change to the desktop product, and that is the owner's decision, not this integration's.
    //
    // Keeping the route means the shell is still exercised end to end: opening a book pushes a real
    // stack entry, Back still pops it, and sheets still behave as stack entries over it.
    return (
      <div className="mobile-root mobile-root--bleed">
        <div className="m-reader-pending" role="status">
          <p>{readerScreen.book.title}</p>
          <button type="button" onClick={() => nav.back()} aria-label="back">
            &#8592;
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-root">
      <main className="mobile-main">
        {(beneath === "library" || (screen.kind === "sheet" && !shelfScreen)) && !shelfScreen && screen.kind !== "search" ? (
          <MobileLibrary
            onOpenBook={openBook}
            onOpenDrawer={nav.openDrawer}
            onOpenDetails={(b) => {
              setDetails(b);
              nav.push({ kind: "book", book: { id: b.id, filePath: b.file_path } });
            }}
            onOpenSearch={() => nav.push({ kind: "search" })}
            sortOpen={sheet === "sort"}
            onOpenSort={() => nav.openSheet("sort")}
            onCloseSort={() => nav.back()}
          />
        ) : null}

        {/* One shelf, open (design L1). The library surface scoped to a collection — same rows, same
            sort, one SQL filter. Its own header, Edit and stats arrive with L1 proper. */}
        {shelfScreen ? (
          <MobileLibrary
            onOpenBook={openBook}
            onOpenDrawer={nav.openDrawer}
            shelf={{ id: shelfScreen.id, name: shelfScreen.name }}
            onOpenDetails={(b) => {
              setDetails(b);
              nav.push({ kind: "book", book: { id: b.id, filePath: b.file_path } });
            }}
            onOpenSearch={() => nav.push({ kind: "search" })}
            sortOpen={sheet === "sort"}
            onOpenSort={() => nav.openSheet("sort")}
            onCloseSort={() => nav.back()}
          />
        ) : null}

        {/* C5 — the book sheet. A row in "All books" opens this rather than the book, which is the
            design's own rule ("tap for details, long-press for the same sheet"); Continue and Recent
            stay direct, because those are the carry-on-reading affordances. */}
        {screen.kind === "book" && details ? (
          <BookSheet
            book={details}
            onContinue={() => {
              nav.back();
              openBook(details);
            }}
            onOpenMarks={() => {
              nav.back();
              nav.openPlace("highlights");
            }}
            onAddToShelf={() => setShelfFor(details)}
            onRemoved={() => {
              setDetails(null);
              nav.back();
            }}
            onClose={() => nav.back()}
          />
        ) : null}

        {shelfFor ? (
          <AddToShelfSheet
            bookId={shelfFor.id}
            bookTitle={shelfFor.title ?? ""}
            memberOf={new Set()}
            onClose={() => setShelfFor(null)}
          />
        ) : null}

        {/* C3 — one field, results grouped by kind. A screen rather than a sheet: it takes the whole
            surface and the keyboard, and Back leaves it exactly as it leaves any other entry. */}
        {screen.kind === "search" ? (
          <MobileSearch
            onOpenBook={openBook}
            onOpenAt={(b) => nav.push({ kind: "reader", book: b })}
            onOpenShelf={(id, name) => nav.push({ kind: "shelf", id, name })}
            onClose={() => nav.back()}
          />
        ) : null}

        {/* G2 — every mark in the library, and the way back into the book that holds it. It opens the
            book AT the mark: `BookRef.cfi` is the locator the session already prefers over the saved
            position, so this needed no navigation of its own. */}
        {beneath === "highlights" ? <MobileMarks onOpenAt={(b) => nav.push({ kind: "reader", book: b })} /> : null}

        {/* The cross-book bookmarks shelf (RAWY-202). Same open path as G2 — a bookmark IS a locator, so
            `BookRef.cfi` carries it and the session prefers it over the saved position. */}
        {beneath === "bookmarks" ? (
          <MobileBookmarks onOpenAt={(b) => nav.push({ kind: "reader", book: b })} />
        ) : null}

        {/* G1 — app-wide, grouped, no tabs. The desk's sections become groups in one column; the hub
            keeps the in-book reading panel, and the two do not overlap. */}
        {beneath === "settings" ? <MobileSettings /> : null}
      </main>

      {screen.kind === "drawer" ? (
        <Drawer
          active={place}
          onGo={nav.openPlace}
          // A shelf is pushed, so Back returns to whatever the reader was looking at, and the drawer
          // closes with it rather than staying open behind the shelf.
          onOpenShelf={(id, name) => {
            nav.back();
            nav.push({ kind: "shelf", id, name });
          }}
          onClose={() => nav.back()}
        />
      ) : null}
    </div>
  );
}
