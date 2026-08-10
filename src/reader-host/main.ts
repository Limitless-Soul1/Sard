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

// DIAGNOSTIC: the host has no Tauri API, so its trace rides the port back to the application.
function htrace(line: string, detail?: unknown): void {
  const text = detail === undefined ? line : `${line} ${JSON.stringify(detail).slice(0, 700)}`;
  try {
    channel?.postMessage({ kind: "trace", line: text });
  } catch {
    /* before the port exists there is nothing to send to */
  }
}

/** What the section actually is, inside the host, where the application cannot look. */
function sectionReport(): unknown {
  const view = document.querySelector("foliate-view") as unknown as {
    renderer?: { getContents?: () => { doc?: Document; index?: number }[] };
    book?: { sections?: unknown[] };
  } | null;
  const contents = (() => { try { return view?.renderer?.getContents?.() ?? []; } catch { return []; } })();
  const doc = contents[0]?.doc;
  const body = doc?.body;
  const el = document.querySelector("foliate-view");
  const rect = (n: Element | null) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = (n: Element | null) => { if (!n) return null; const c = getComputedStyle(n); return { display: c.display, visibility: c.visibility, opacity: c.opacity, background: c.backgroundColor, color: c.color, overflow: c.overflow, position: c.position, zIndex: c.zIndex }; };
  const frameEl = (() => { try { return doc?.defaultView?.frameElement ?? null; } catch { return null; } })();
  return {
    sections: view?.book?.sections?.length ?? -1,
    contents: contents.length,
    sectionIndex: contents[0]?.index ?? -1,
    hasBody: !!body,
    textLen: (body?.textContent ?? "").trim().length,
    bodyRect: rect(body ?? null),
    bodyStyle: cs(body ?? null),
    htmlStyle: cs(doc?.documentElement ?? null),
    sectionIframe: { rect: rect(frameEl), style: cs(frameEl), sandbox: frameEl?.getAttribute("sandbox") ?? null },
    foliateView: { rect: rect(el), style: cs(el) },
    hostBody: { rect: rect(document.body), style: cs(document.body) },
    hostDoc: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
    stylesheetsInSection: doc ? doc.styleSheets.length : -1,
  };
}

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

// The in-flight search, so an abort from the application can reach it.
let searchAbort: AbortController | null = null;

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
    isScrolled: safe(() => controller.isScrolled, true),
    readingScrollTop: safe(() => controller.readingScrollTop, 0),
    pdfPageCount: safe(() => controller.pdfPageCount, 0),
    furthestPosition: safe(() => controller.furthestPosition, null),
    dir: safe(() => controller.dir, undefined),
    title: safe(() => controller.title, undefined),
    author: safe(() => controller.author, undefined),
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

  // ARRAYS STAY ARRAYS. Rebuilding one through `Object.entries` produces `{0:…,1:…}` — no `.length`,
  // no iteration, no `map`. MEASURED on WebKitGTK: `getCurrentChapterSentences` came back as an
  // object and `.length` was undefined, so a caller counting sentences silently got nothing. Every
  // forwarded method that returns a list was affected.
  if (Array.isArray(value)) return value.map((v) => cloneable(v));

  // A Map does not survive structured cloning either; entries do, and `tocHrefSectionMap` already
  // travels that way in the mirror.
  if (value instanceof Map) return [...value].map(([k, v]) => [cloneable(k), cloneable(v)]);
  if (value instanceof Set) return [...value].map((v) => cloneable(v));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v instanceof Range || v instanceof Node || typeof v === "function") continue;
    out[k] = cloneable(v);
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
    const stage = ensureStage();
    htrace("host.open start", { bytes: msg.bytes.byteLength, stage: { w: stage.clientWidth, h: stage.clientHeight }, opts: msg.opts });
    try {
      await controller.open(bookUrl, stage, msg.opts as never);
    } catch (e) {
      htrace("host.open THREW", String(e).slice(0, 400));
      throw e;
    }
    htrace("host.open done", { toc: safe(() => controller.getToc().length, -1), ...(sectionReport() as object) });
    // And again after a paint, because layout right after open is not what the reader sees.
    requestAnimationFrame(() => requestAnimationFrame(() => htrace("host.afterPaint", sectionReport())));
    return { opened: true };
  }

  // Search reports progress WHILE it runs, and its callbacks cannot cross. The application keeps
  // them; the host supplies its own and pushes each batch, so hits still arrive progressively.
  if (msg.method === "searchBook") {
    searchAbort?.abort();
    searchAbort = new AbortController();
    return cloneable(
      await controller.searchBook(String(msg.args[0] ?? ""), {
        signal: searchAbort.signal,
        onProgress: (f) => push({ kind: "event", name: "search-progress", args: [f] }),
        onBatch: (hits) => push({ kind: "event", name: "search-batch", args: [cloneable(hits)] }),
      }),
    );
  }
  if (msg.method === "__searchAbort") {
    searchAbort?.abort();
    return { aborted: true };
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
  htrace("host.attach", { origin: location.origin, doc: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }, ua: navigator.userAgent.slice(0, 120) });
  addEventListener("error", (e) => htrace("host.jserror", `${e.message} @${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => htrace("host.unhandled", String((e as PromiseRejectionEvent).reason).slice(0, 300)));
  addEventListener("securitypolicyviolation", (e) => htrace("host.csp", `${e.violatedDirective} blocked ${String(e.blockedURI).slice(0, 120)}`));
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
