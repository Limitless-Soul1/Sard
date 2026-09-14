// The wire between the application and the reader host.
//
// Everything here has to survive structured cloning, because that is all a `MessagePort` carries.
// That single constraint is why the shapes are this plain: no class instances, no DOM nodes, no
// functions. Where the engine's own signature cannot satisfy it, `surface.ts` records the exception
// and the transport handles it explicitly rather than letting it fail at run time on one platform.

/** Sent when the host document has loaded and is ready to be given a port. */
export interface HostReady {
  __sardHostReady: true;
}

/** The application's half of the handshake; carries `port2` in the transfer list. */
export interface HostInit {
  __sardHostInit: true;
}

/** A mechanically forwarded method call. */
export interface CallMsg {
  id: number;
  kind: "call";
  method: string;
  args: unknown[];
}

/** Opening a book: the bytes travel as a transferable, not as a copy. */
export interface OpenMsg {
  id: number;
  kind: "open";
  bytes: ArrayBuffer;
  opts: unknown;
}

export type Request = CallMsg | OpenMsg;

/**
 * A request before the transport stamps its id on it.
 *
 * Distributed over the union deliberately. `Omit<Request, "id">` collapses a union to the keys its
 * members SHARE, so `method` and `bytes` both disappear and every construction site fails to
 * type-check — which is what happened first.
 */
export type RequestBody = Omit<CallMsg, "id"> | Omit<OpenMsg, "id">;

/** A reply to one request. `value` is whatever the method returned, after cloning. */
export interface Reply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Everything the application can read SYNCHRONOUSLY, pushed by the host after every command.
 *
 * WHY A SNAPSHOT AT ALL. Thirteen engine members return a value synchronously, and the application
 * reads them from places that cannot await — a React render body, a keydown handler whose answer
 * drives `preventDefault()`. Making them asynchronous would change their signatures and with them
 * all 107 call sites in `Reader.tsx`, which is precisely the churn this seam exists to avoid. So the
 * host sends the answers ahead of the questions.
 *
 * The arg-taking reads are represented as their FULL domain where the domain is bounded — the TTS
 * cursors as an array, the TOC map as entries — rather than as a function, because a function cannot
 * cross and re-deriving one in the application would be a second copy of engine logic.
 */
export interface Mirror {
  currentSectionIndex: number;
  atChapterStart: boolean;
  isTtsChapterOnScreen: boolean;
  hasNextSection: boolean;
  openingUnderTopBar: boolean;
  pdfTextQuality: unknown;
  pdfRenderedScale: number;
  pdfHasSpeakableText: boolean;
  /**
   * The engine's public GETTERS. They are read as properties, not called, so the proxy cannot answer
   * them with a forwarding function — it did, and `ctrl.isFixedLayout` came back as a function that
   * JSON.stringify turned into undefined. Every one of them is mirrored.
   */
  isFixedLayout: boolean;
  isScrolled: boolean;
  readingScrollTop: number;
  pdfPageCount: number;
  furthestPosition: string | null;
  dir: string | undefined;
  title: string | undefined;
  author: string | undefined;
  toc: unknown[];
  /** `tocHrefSectionMap()` with its default argument, as entries — a Map does not survive cloning. */
  tocHrefSection: [string, number][];
  /** `getTtsCursor(i)` for every retained unit; the application indexes into it. */
  ttsCursors: (unknown | null)[];
}

/** An engine event the application registered a callback for. */
export interface EventMsg {
  kind: "event";
  name: string;
  args: unknown[];
}

/** A pushed mirror. */
export interface StateMsg {
  kind: "state";
  mirror: Mirror;
}

export type Push = EventMsg | StateMsg;

/** The callback-registering members the host pushes events for. */
export const EVENT_NAMES = [
  "onSelection",
  "onShowAnnotation",
  "onActivity",
  "onZoomIntent",
  "onScrollIntent",
  "onReadingRedraw",
  "onRelocate",
  "onReferenceHit",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];
