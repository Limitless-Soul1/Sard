// The reader host — the reading engine, running in an origin that holds nothing worth stealing.
//
// WHY THIS EXISTS. MEASURED on WebKitGTK: an iframe sandboxed `allow-same-origin` without
// `allow-scripts` never delivers the pointer events the engine's parent-side listeners are waiting
// for. Blink does deliver them, which is why Windows has never needed any of this. Upstream
// foliate-js documents the same engine difference (WebKit bug 218086) and ships `allow-scripts`
// because of it; Sard removed it for D30.
//
// The resolution is enclosure, not surrender. Book content gets `allow-scripts` again — but the
// document it can reach is THIS one, served from `sardhost://`, which has no Tauri API, no
// application document, no database handle and no secret. D30's intent holds; only the mechanism
// moved from the sandbox attribute to the origin.
//
// MEASURED from inside this origin, real Tauri app, real WebKitGTK: `parent.__TAURI_INTERNALS__`,
// `parent.document`, `parent.location.href` and every `top.*` equivalent raise SecurityError, the
// application cannot read back in, and a cross-origin fetch raises a `connect-src` violation.
//
// Built by `scripts/build-reader-host.mjs` into ONE self-contained bundle, and not emitted at all
// for a Windows target.
import { FoliateController } from "../reader-engine/FoliateController";
import { EVENT_NAMES, type Mirror, type Reply, type Request } from "../reader-transport/protocol";

// ---------------------------------------------------------------------------------------------
// The section sandbox. Set BEFORE the engine can create a single iframe.
// ---------------------------------------------------------------------------------------------
// Read by the two vendored call sites (VENDOR patch 1b). Setting it here rather than in the engine
// keeps the decision with the only code that knows where it is: this bundle exists solely on the
// hosted path, so its presence IS the condition. Nothing sets it in the application origin, where
// the fallback keeps today's exact value.
(globalThis as { __sardSectionSandbox?: string }).__sardSectionSandbox =
  "allow-same-origin allow-scripts";

const controller = new FoliateController();

let stage: HTMLElement | null = null;
function ensureStage(): HTMLElement {
  if (stage?.isConnected) return stage;
  const el = document.createElement("div");
  el.className = "page-host"; // the selector the engine's own callers look for
  document.body.replaceChildren(el);
  stage = el;
  return el;
}

let bookUrl: string | null = null;

// ---------------------------------------------------------------------------------------------
// The mirror.
// ---------------------------------------------------------------------------------------------
// Thirteen engine members return synchronously, and the application reads several of them from
// places that cannot await. Their answers are pushed AHEAD of the question so their signatures — and
// therefore all 107 call sites — stay exactly as they are.
//
// A read that throws must not take the whole snapshot with it. Before a book is open, several of
// these have nothing to answer from, and a snapshot that fails to build is a reader that never gets
// its first state.
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * How far to walk the TTS cursors.
 *
 * `getTtsCursor(i)` answers null past the end and the engine exposes no count, so the walk stops at
 * the first null. The cap is a guard against a pathological chapter, not a real limit: the longest
 * corpus chapter is far below it, and exceeding it costs a fallback rather than a wrong answer.
 */
const TTS_CURSOR_CAP = 4000;

function buildMirror(): Mirror {
  const cursors: (unknown | null)[] = [];
  for (let i = 0; i < TTS_CURSOR_CAP; i++) {
    const c = safe(() => controller.getTtsCursor(i), null);
    if (c == null) break;
    cursors.push(c);
  }
  return {
    currentSectionIndex: safe(() => controller.currentSectionIndex(), 0),
    atChapterStart: safe(() => controller.atChapterStart(), true),
    isTtsChapterOnScreen: safe(() => controller.isTtsChapterOnScreen(), true),
    hasNextSection: safe(() => controller.hasNextSection(), false),
    openingUnderTopBar: safe(() => controller.openingUnderTopBar(), false),
    pdfTextQuality: safe(() => controller.pdfTextQuality() as unknown, null),
    pdfRenderedScale: safe(() => controller.pdfRenderedScale(), 1),
    pdfHasSpeakableText: safe(() => controller.pdfHasSpeakableText(), false),
    isFixedLayout: safe(() => controller.isFixedLayout, false),
    toc: safe(() => controller.getToc() as unknown[], []),
    // A Map does not survive structured cloning; entries do.
    tocHrefSection: safe(() => [...controller.tocHrefSectionMap()], []),
    ttsCursors: cursors,
  };
}

// ---------------------------------------------------------------------------------------------
// The channel.
// ---------------------------------------------------------------------------------------------
// The port is held in a closure and never written to any global. MEASURED: a port left reachable on
// the global was hijacked in a proof-of-concept and its forged messages were accepted on the trusted
// channel, so reachability is the whole property — "no MessagePort on the host global" is an exit
// criterion, and this is what keeps it true.
let channel: MessagePort | null = null;

function push(msg: unknown): void {
  channel?.postMessage(msg);
}

function pushState(): void {
  push({ kind: "state", mirror: buildMirror() });
}

/**
 * Strip anything a structured clone would refuse.
 *
 * `SelectionInfo` carries an optional live `Range` (RAWY-227) and a Range cannot cross. Posting the
 * object untouched would throw a DataCloneError and lose the WHOLE event, so the selection would
 * simply never reach the application — a silent, total failure of the selection toolbar.
 *
 * Dropping the range is not a behaviour change: the field is optional and its absence is an
 * established path. The engine's own comment says a 24-character normalised text match is the
 * fallback, with the chapter top as last resort, and `Reader.tsx:1822` implements exactly that.
 */
function cloneable(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v instanceof Range || v instanceof Node || typeof v === "function") continue;
    out[k] = typeof v === "object" && v !== null ? cloneable(v) : v;
  }
  return out;
}

function registerEvents(): void {
  for (const name of EVENT_NAMES) {
    const register = (controller as unknown as Record<string, (cb: (...a: unknown[]) => void) => void>)[name];
    if (typeof register !== "function") continue;
    register.call(controller, (...args: unknown[]) => {
      push({ kind: "event", name, args: args.map(cloneable) });
      // A callback firing means engine state may have moved — a relocate changes the section, a
      // selection can change what is on screen. Pushing here is what keeps the mirror's synchronous
      // answers true between commands.
      pushState();
    });
  }

  // `onSpace` is NOT one of the pushed callbacks, and the difference is measured rather than stylistic.
  //
  // `spaceCb` is invoked from two keydown listeners the ENGINE attaches (FoliateController:1663,
  // :1765), and those run here. The engine wants a boolean back immediately and branches on it; a
  // MessagePort cannot answer in time.
  //
  // So the host claims the key. Returning true makes the engine call `preventDefault()` and take no
  // further action, which is precisely the branch we want it to take, and the application decides
  // what the key MEANT on its own side. If its callback declines, it sends a page turn back. The
  // outcome is the engine's own `if (spaceCb()) preventDefault(); else next();` with the turn one
  // message later — not a synchronous answer faked across an asynchronous boundary.
  controller.onSpace(() => {
    push({ kind: "event", name: "space", args: [] });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// The dispatcher.
// ---------------------------------------------------------------------------------------------
async function run(msg: Request): Promise<unknown> {
  if (msg.kind === "open") {
    // The bytes arrive transferred, not copied. MEASURED equivalent to serving the file from this
    // origin (1257 ms vs 1278 ms on a 14.1 MB EPUB), and chosen over it because serving a file would
    // give this origin a filesystem route — the one thing `bookhost.rs` is built to refuse.
    //
    // A blob URL rather than a File: foliate's `makeBook` sniffs `%PDF-` from the bytes themselves,
    // so format detection does not depend on a filename and the engine needs no change to accept it.
    if (bookUrl) URL.revokeObjectURL(bookUrl);
    bookUrl = URL.createObjectURL(new Blob([msg.bytes]));
    await controller.open(bookUrl, ensureStage(), msg.opts as never);
    return { opened: true };
  }

  const fn = (controller as unknown as Record<string, unknown>)[msg.method];
  if (typeof fn !== "function") {
    // Loud, and named. A silent `undefined` here would surface as an unrelated failure somewhere in
    // the reader, on one platform only, with nothing pointing back to the transport.
    throw new Error(`the reading engine has no method "${msg.method}"`);
  }
  const value = await (fn as (...a: unknown[]) => unknown).apply(controller, msg.args);
  return cloneable(value);
}

function attach(port: MessagePort): void {
  channel = port;
  port.onmessage = (e: MessageEvent<Request>) => {
    const msg = e.data;
    void (async () => {
      const reply: Reply = { id: msg.id, ok: true };
      try {
        reply.value = await run(msg);
      } catch (err) {
        reply.ok = false;
        reply.error = err instanceof Error ? err.message : String(err);
      }
      port.postMessage(reply);
      // After every command, without exception. The mirror is what makes the application's
      // synchronous reads true, and a command that moved the engine without refreshing it would
      // leave the reader answering from a state that no longer exists.
      pushState();
    })();
  };
  port.start();
  registerEvents();
  pushState();
  port.postMessage({ id: 0, ok: true, value: { ready: true, origin: location.origin } } satisfies Reply);
}

addEventListener("message", (e: MessageEvent) => {
  // `e.source` is the only trustworthy discriminator. MEASURED: `e.origin` cannot distinguish the
  // application from book content that forged a message, and `e.source` can. Book content lives in a
  // descendant frame, so it can never satisfy this.
  if (e.source !== parent) return;
  if (!(e.data as { __sardHostInit?: boolean })?.__sardHostInit) return;
  const port = e.ports[0];
  if (!port || channel) return; // one channel, claimed once
  attach(port);
});

// Tell the application the host is live. It cannot be told over the port, because the port is what
// this announces the readiness to send.
parent.postMessage({ __sardHostReady: true }, "*");
