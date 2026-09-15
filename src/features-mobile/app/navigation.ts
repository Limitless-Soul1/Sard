// THE MOBILE BACK STACK.
//
// Sard has no router: on desktop `App.tsx` switches between Library and Reader with a piece of state,
// which is enough there because a desktop window has no system Back button. A phone does, and Android
// will close the application mid-book unless something answers it deterministically.
//
// WHY A STACK RATHER THAN A ROUTER. Sard's surfaces are not URLs. There is nothing to link to, nothing
// to deep-link from yet, and no server. What is actually needed is an ordered history that Back pops
// and that survives the WebView process being killed — which is a stack, not a routing table. A router
// would add a URL model nothing in the product asks for.
//
// FOUR RULES, and they are the whole design:
//
//   1. THE READING POSITION IS NEVER A STACK ENTRY. Popping back to the reader must not re-navigate
//      the book. The reader's position lives in the reading session and its saved progress; the stack
//      only remembers that the reader is the screen underneath.
//   2. SELECTION IS STATE, NOT NAVIGATION. Opening a sheet over a selection and dismissing it returns
//      to the same selection. Only an entry that explicitly consumes the selection clears it.
//   3. A SHEET IS A STACK ENTRY. Sheets, panels and dialogs are all pushed, so one Back gesture
//      dismisses exactly one of them, in the order they were opened.
//   4. THE STACK IS SERIALISABLE. Android may kill the WebView and restore it; every entry is plain
//      data so the stack can be written down and rebuilt.
//
// The platform delivers INTENT and never performs navigation: Android's Back arrives as an event, this
// module decides, and the reply says whether it was consumed. Only an unconsumed Back at the root
// leaves the application.

/** Where the reader can be sent. Plain data, so the whole stack can be persisted and restored. */
export interface BookRef {
  id: string;
  filePath: string;
  /** A locator to open at. Absent means "resume wherever the reader left off". */
  cfi?: string | null;
  format?: string | null;
  title?: string | null;
  author?: string | null;
}

/**
 * One entry in the back stack.
 *
 * A discriminated union rather than a string, because an entry has to carry enough to be rebuilt from
 * nothing after a process death — a bare name could not reopen the right book.
 */
export type Screen =
  | { kind: "library" }
  | { kind: "highlights" }
  | { kind: "bookmarks" }
  | { kind: "settings" }
  | { kind: "book"; book: BookRef }
  | { kind: "reader"; book: BookRef }
  /**
   * One shelf, open (design L1). It carries the collection's id AND its name because, like the reader,
   * it has to be rebuildable from the serialised stack alone after a process death — the id fetches the
   * books, and the name lets the screen title itself before that fetch returns.
   */
  | { kind: "shelf"; id: string; name: string }
  /** Library search (design C3). A SCREEN, not a sheet: it takes the whole surface and the keyboard. */
  | { kind: "search" }
  /** Sheets carry the surface they cover, so dismissing one restores exactly what was underneath. */
  | { kind: "sheet"; sheet: SheetKind }
  /**
   * The places drawer. An ENTRY rather than a piece of component state, for the same reason rule 3
   * makes a sheet one: Back must dismiss exactly the drawer and nothing else, and it must do so
   * without the shell having to special-case "is something open?" before it answers the platform.
   */
  | { kind: "drawer" };

export type SheetKind =
  | "contents"
  | "search"
  | "notes"
  | "reading-settings"
  | "book-details"
  | "import"
  /** The mobile reader's four-tab hub (design D3–D6). ONE entry for the whole sheet: which tab is
   *  showing is a filter within it, not a place — rule 2's "selection is state, not navigation". */
  | "hub"
  /**
   * The note editor (D8) and the reference sheet (R1). Entries for rule 3's reason: Back must dismiss
   * exactly the open sheet. MEASURED on the device when they were plain component state — Back walked
   * straight past them and left the book, so a reader who opened a note and changed their mind lost
   * their place. WHICH passage each is about stays in the reader; only "a sheet is open" is navigation.
   */
  | "note"
  | "reference"
  /** The library's sort & filter sheet (design C4) — an entry for rule 3's reason, like every other. */
  | "sort"
  /**
   * The selection sheet — the ink row and actions that appear over a live selection. An entry for the
   * SAME reason `note` and `reference` are, and it was the last transient surface left out: MEASURED on
   * the device, Back over a live selection walked straight past the sheet and closed the BOOK, which is
   * the harshest form of the defect above — the reader had not even opened anything yet, they had only
   * selected a word.
   *
   * The entry is a MIRROR of the platform's selection, never a second source of truth: it is pushed when
   * the engine raises a selection and popped when the engine reports it cleared, and popping it (by Back
   * or otherwise) clears the selection. So "is something selected" and "is the sheet open" cannot drift.
   */
  | "selection";

/**
 * The places the drawer lists.
 *
 * THESE WERE TABS. A four-item bottom bar spent ~10% of the viewport, permanently, advertising three
 * destinations a reader visits a few times a session — and at the largest accessibility text sizes an
 * Arabic label like «التظليلات والملاحظات» cannot hold one line in a quarter of the bar. The design's
 * drawer holds full-width rows that degrade gracefully instead, and it scales past four entries, which
 * a bar cannot. `library` is the only PERMANENT destination and is always the bottom of the stack.
 *
 * `bookmarks` is kept even though the design's own drawer omits it: Sard ships a cross-book bookmarks
 * shelf (RAWY-202), and a capability is not dropped because a prototype forgot it.
 */
export const PLACES = ["library", "highlights", "bookmarks", "settings"] as const;
export type Place = (typeof PLACES)[number];

export const isPlace = (s: Screen): s is Screen & { kind: Place } =>
  (PLACES as readonly string[]).includes(s.kind);

export interface NavState {
  /** Bottom of the stack is always a tab. Never empty. */
  stack: Screen[];
}

export const initialNav = (): NavState => ({ stack: [{ kind: "library" }] });

export const top = (n: NavState): Screen => n.stack[n.stack.length - 1];

/** The place the drawer should show as current — the deepest place in the stack. */
export function activePlace(n: NavState): Place {
  for (let i = n.stack.length - 1; i >= 0; i--) {
    const s = n.stack[i];
    if (isPlace(s)) return s.kind as Place;
  }
  return "library";
}

/** Is the drawer the top entry? The shell renders it from this rather than from its own state. */
export const drawerOpen = (n: NavState): boolean => top(n).kind === "drawer";

/** The sheet on top, or null. One reader of this replaces a component keeping its own "is it open?". */
export const openSheet = (n: NavState): SheetKind | null => {
  const t = top(n);
  return t.kind === "sheet" ? t.sheet : null;
};

/**
 * Push a sheet, or do nothing if that same sheet is already the top entry.
 *
 * The idempotence is the point: a double tap on the hub button must not stack two entries and then
 * demand two Backs to undo one gesture. Same one-deep discipline `openDrawer` uses.
 */
export function openSheetEntry(n: NavState, sheet: SheetKind): NavState {
  return openSheet(n) === sheet ? n : push(n, { kind: "sheet", sheet });
}

export function push(n: NavState, screen: Screen): NavState {
  return { stack: [...n.stack, screen] };
}

/**
 * Pop one entry. Returns `null` when there is nothing left to pop, which is the signal that Back was
 * NOT consumed and the platform may do its default thing (leave the application).
 */
export function pop(n: NavState): NavState | null {
  if (n.stack.length <= 1) return null;
  return { stack: n.stack.slice(0, -1) };
}

/**
 * Open the drawer.
 *
 * NOT BOUND TO THE EDGE GESTURE, and that is a deliberate deviation from the design. The design says
 * "edge-swipe from the leading edge — Back, everywhere. In the library it opens the places drawer",
 * but on Android the system owns both screen edges and delivers that swipe as a BACK event. Honouring
 * it literally would turn root Back into "open drawer" and cost a second press to leave the app —
 * re-introducing exactly the defect the Gate-2 fix removed. The drawer is opened from the header
 * affordance the design already draws, and Back keeps meaning what it meant.
 *
 * Opening twice is a no-op, so a double tap cannot stack two drawers and demand two Backs.
 */
export function openDrawer(n: NavState): NavState {
  return drawerOpen(n) ? n : push(n, { kind: "drawer" });
}

/**
 * Go to one of the drawer's places.
 *
 * The result is always `[library]` or `[library, place]` — never deeper, and never with the drawer
 * left underneath. Two things follow, both of which the reader can rely on without being taught:
 * Back from any place returns to the library, and Back from the library leaves the application. The
 * drawer that launched the navigation is consumed rather than buried, so Back never reopens a menu
 * the reader has already finished with.
 */
export function openPlace(n: NavState, place: Place): NavState {
  const root: Screen = { kind: "library" };
  if (place === "library") {
    // Already home with nothing above it — keep the same object so React skips the render.
    return n.stack.length === 1 && n.stack[0].kind === "library" ? n : { stack: [root] };
  }
  return { stack: [root, { kind: place } as Screen] };
}

/**
 * Replace the top entry.
 *
 * The Photo Card flow needs this: saving a card should land on the gallery WITHOUT leaving the
 * composer behind, because Back out of the gallery must not reopen a composer whose work is already
 * saved.
 */
export function replace(n: NavState, screen: Screen): NavState {
  return { stack: [...n.stack.slice(0, -1), screen] };
}

/** Is a reader open anywhere beneath the current screen? Sheets over the reader need to know. */
export const readerBeneath = (n: NavState): Extract<Screen, { kind: "reader" }> | null => {
  for (let i = n.stack.length - 1; i >= 0; i--) {
    const s = n.stack[i];
    if (s.kind === "reader") return s;
  }
  return null;
};

// ---- persistence -------------------------------------------------------------------------------
// Android can kill the WebView and restore it. Everything above is plain data precisely so this is a
// stringify, and so a restored stack is the same stack rather than an approximation of it.

const VALID_KINDS = new Set<Screen["kind"]>([...PLACES, "book", "reader", "shelf", "search", "sheet", "drawer"]);

export function serialise(n: NavState): string {
  return JSON.stringify(n.stack);
}

/**
 * Rebuild a stack, refusing anything that is not recognisably one.
 *
 * A restore that throws would lose the library as well as the stack, so a damaged or outdated value
 * means "start at the root" — never an exception, and never a half-built stack.
 */
export function deserialise(raw: string | null): NavState {
  if (!raw) return initialNav();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return initialNav();
    const stack = parsed.filter(
      (s): s is Screen =>
        !!s && typeof s === "object" && VALID_KINDS.has((s as Screen).kind),
    );
    if (!stack.length || !isPlace(stack[0])) return initialNav();
    // A drawer restored at the bottom would be a menu with nothing under it; one restored at all is a
    // menu the reader never asked to reopen. Neither is worth carrying across a process death.
    const settled = stack.filter((s) => s.kind !== "drawer");
    return settled.length ? { stack: settled } : initialNav();
  } catch {
    return initialNav();
  }
}
