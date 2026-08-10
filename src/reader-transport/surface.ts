// How every method of the reading engine crosses — or cannot cross — a process-like boundary.
//
// WHY THIS FILE EXISTS AT ALL. On Windows the application calls `FoliateController` directly and
// none of this applies. On WebKit the engine runs inside the reader host, in a different origin, and
// every call has to travel over a `MessagePort`. A port carries structured-cloneable values and
// nothing else, and it is asynchronous in both directions — two facts that decide, per method,
// whether it can be forwarded mechanically, needs mirrored state, or cannot cross at all.
//
// It is a MAP, not an abstraction. Nothing here wraps or re-implements the engine; it records what
// the engine's own signatures already imply, so the hosted transport can be generated from it rather
// than hand-written 72 times, and so `readerSurface.test.ts` can fail the build the day the engine
// grows a method nobody classified.

/** How a member of the engine's surface behaves across the host boundary. */
export type Crossing =
  /** Returns a promise already, or returns nothing. Forwarded verbatim; the reply resolves it. */
  | "async"
  /** Returns synchronously from state the host can push ahead of the call. Served from the mirror. */
  | "mirrored"
  /** Decided in the application from a SHARED pure module plus mirrored state — never re-implemented. */
  | "decided-locally"
  /** The application registers a callback; the host pushes an event and the application invokes it. */
  | "callback"
  /** The host registers a callback and expects a SYNCHRONOUS answer. A port cannot answer in time. */
  | "sync-callback"
  /** Signature carries a live DOM object. It cannot be cloned, so it does not cross. */
  | "dom-bound";

/**
 * The classification, one entry per public member of `FoliateController`.
 *
 * Only the entries that are NOT plain `async` are listed. Everything absent from this table is
 * forwarded mechanically, which is why the table stays short and the guard test compares it against
 * the real class rather than against a second hand-written list.
 */
export const CROSSING: Readonly<Record<string, Crossing>> = Object.freeze({
  // ---- served from mirrored state -------------------------------------------------------------
  // MEASURED: each of these reads controller state and touches no DOM, so the host can push a
  // snapshot after every command and the application can answer from it without waiting.
  currentSectionIndex: "mirrored",
  atChapterStart: "mirrored",
  isTtsChapterOnScreen: "mirrored",
  bookmarkVisible: "mirrored",
  hasNextSection: "mirrored",
  getToc: "mirrored",
  tocHrefSectionMap: "mirrored",
  targetSectionIndex: "mirrored",
  getTtsCursor: "mirrored",
  pdfTextQuality: "mirrored",
  pdfRenderedScale: "mirrored",
  pdfHasSpeakableText: "mirrored",

  // ---- decided in the application ---------------------------------------------------------------
  // `handleNavKey` is called from a keydown listener and its answer drives `preventDefault()`, so it
  // cannot wait for a round trip. It does not need to: its decision is `navIntent(key)` — a pure
  // module that already exists on its own, with its own tests, precisely so there is ONE copy — plus
  // `isFixedLayout`, which is mirrored, plus the arrow callback, which the APPLICATION registered and
  // therefore already holds. The side effect it triggers is forwarded and not waited on.
  handleNavKey: "decided-locally",
  // Reads a live layout property of the host document.
  openingUnderTopBar: "mirrored",

  // ---- application-registered callbacks; the host pushes the event ------------------------------
  onSelection: "callback",
  onShowAnnotation: "callback",
  onActivity: "callback",
  onZoomIntent: "callback",
  onScrollIntent: "callback",
  onReadingRedraw: "callback",
  onRelocate: "callback",
  onReferenceHit: "callback",

  // ---- the host asks the application and needs the answer NOW -----------------------------------
  // The engine calls these mid-gesture and branches on what comes back, so an asynchronous reply is
  // not merely slower, it arrives after the decision has been made. Both are resolved the same way
  // `handleNavKey` is: the application owns the callback, so it consults it itself and forwards only
  // the consequence. Neither is re-implemented anywhere.
  onArrow: "sync-callback",
  onSpace: "sync-callback",

  // ---- carries a live DOM object ----------------------------------------------------------------
  // `open` takes the container to render into. Hosted, the host supplies its own and the parameter
  // never travels.
  open: "dom-bound",
  // `range` is OPTIONAL on SelectionInfo and its absence is an established path: RAWY-227 documents a
  // 24-character normalised text match as the fallback, with the chapter top as last resort. Hosted,
  // the range stays in the host and the documented fallback runs — the same code the application
  // already executes today whenever a selection arrives without one.
  ttsUnitIndexForRange: "dom-bound",
  // Returns ranges. Its only consumer is `window.__sardPdfTts`, a diagnostic hook, and it uses them
  // solely to COUNT how many units carry one.
  getChapterUnits: "dom-bound",
  // Called only from inside the engine; never reached from the application.
  highlightAtPoint: "dom-bound",
  referenceAtPoint: "dom-bound",
  // Returns a string synchronously, built by walking the live section layout. The application calls
  // it once, inside a `setTimeout`, to store a developer snapshot in settings (Reader.tsx:1127) —
  // never on a path a reader can feel. Hosted it becomes a round trip like any other read; it is
  // listed here so that fact is a decision rather than an oversight.
  diagnose: "dom-bound",
});

/** Members that must never be forwarded blindly, because a port cannot carry what they carry. */
export const NEEDS_SPECIAL_HANDLING: ReadonlySet<Crossing> = new Set<Crossing>([
  "mirrored",
  "decided-locally",
  "callback",
  "sync-callback",
  "dom-bound",
]);
