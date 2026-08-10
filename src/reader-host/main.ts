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
// application document, no database handle and no secret. D30's intent ("a book must not reach
// anything that matters") holds; only the mechanism moved from the sandbox attribute to the origin.
//
// MEASURED from inside this origin, real Tauri app, real WebKitGTK: `parent.__TAURI_INTERNALS__`,
// `parent.document`, `parent.location.href` and every `top.*` equivalent raise SecurityError, the
// application cannot read back into here, and a cross-origin fetch raises a `connect-src` violation.
//
// This file is built by `scripts/build-reader-host.mjs` into ONE self-contained bundle and is not
// emitted at all for a Windows target.
import { FoliateController } from "../reader-engine/FoliateController";

// ---------------------------------------------------------------------------------------------
// The section sandbox. Set BEFORE the engine can create a single iframe.
// ---------------------------------------------------------------------------------------------
// Read by the two vendored call sites (paginator.js, fixed-layout.js — VENDOR patch 1b). Setting it
// here rather than in the engine keeps the decision with the only code that knows where it is: this
// bundle exists solely on the hosted path, so its presence IS the condition. Nothing sets it in the
// application origin, where the fallback keeps today's exact value.
(globalThis as { __sardSectionSandbox?: string }).__sardSectionSandbox =
  "allow-same-origin allow-scripts";

// ---------------------------------------------------------------------------------------------
// The command channel.
// ---------------------------------------------------------------------------------------------
// A MessagePort held in a closure and never written to any global. MEASURED: a port left reachable
// on the global was hijacked in a proof-of-concept and its forged messages were accepted on the
// trusted channel, so reachability is the whole property — `messagePortsOnGlobal: none` is a Step 1
// exit criterion, and this is what keeps it true.
//
// The handshake is authenticated on `e.source`, not `e.origin`. MEASURED: `e.origin` cannot
// distinguish the application from book content that forged a message, and `e.source` can.
type Cmd =
  | { id: number; cmd: "open"; bytes: ArrayBuffer; opts: OpenArgs }
  | { id: number; cmd: "navKey"; key: string }
  | { id: number; cmd: "state" };

// Only the fields the host needs to open a book. Deliberately not a re-declaration of the engine's
// OpenOptions: this is the wire, and a wire that mirrors an internal type drifts with it silently.
interface OpenArgs {
  style: unknown;
  theme?: unknown;
  flags?: unknown;
  dir?: string | null;
  flow?: "scrolled" | "paged";
  resumeCfi?: string | null;
  resumeFraction?: number | null;
}

const controller = new FoliateController();
let stage: HTMLElement | null = null;
let bookUrl: string | null = null;

function ensureStage(): HTMLElement {
  if (stage) return stage;
  const el = document.createElement("div");
  el.className = "page-host"; // the selector the engine and the harness both look for
  document.body.replaceChildren(el);
  stage = el;
  return el;
}

async function run(msg: Cmd): Promise<unknown> {
  switch (msg.cmd) {
    case "open": {
      // The bytes arrive transferred, not copied. MEASURED equivalent to serving the file from the
      // host origin (1257 ms vs 1278 ms on a 14.1 MB EPUB), and chosen over it because serving a
      // file would give this origin a filesystem route — the one thing bookhost.rs is built to
      // refuse, and what its `/library/book.epub -> 404` test asserts.
      //
      // A blob URL rather than a File: foliate's `makeBook` sniffs `%PDF-` from the bytes
      // themselves, so format detection does not depend on a filename and the engine needs no
      // change to accept this. The three places the engine matches `.pdf` against the source are
      // diagnostic labels only, compiled out of a release build.
      if (bookUrl) URL.revokeObjectURL(bookUrl);
      bookUrl = URL.createObjectURL(new Blob([msg.bytes]));
      await controller.open(bookUrl, ensureStage(), msg.opts as never);
      return { opened: true };
    }
    // The engine has no next()/prev(); `handleNavKey` IS its navigation entry point, and it is the
    // one the application already calls (Reader.tsx:1587). Forwarding the key rather than inventing
    // a next/prev pair keeps the hosted surface the same surface, so nothing here has to decide what
    // a page turn means — including which direction "forward" is in an RTL book.
    case "navKey":
      return { handled: controller.handleNavKey(msg.key) };
    case "state":
      return {
        section: controller.currentSectionIndex(),
        toc: controller.getToc().length,
        atChapterStart: controller.atChapterStart(),
      };
  }
}

function attach(port: MessagePort): void {
  port.onmessage = (e: MessageEvent<Cmd>) => {
    const msg = e.data;
    void (async () => {
      try {
        port.postMessage({ id: msg.id, ok: true, value: await run(msg) });
      } catch (err) {
        port.postMessage({ id: msg.id, ok: false, error: String(err) });
      }
    })();
  };
  port.start();
}

addEventListener("message", (e: MessageEvent) => {
  // `e.source` is the only trustworthy discriminator here — see above. Book content lives in a
  // descendant frame, so it can never satisfy this.
  if (e.source !== parent) return;
  const data = e.data as { __sardHostInit?: boolean } | null;
  if (!data?.__sardHostInit) return;
  const port = e.ports[0];
  if (!port) return;
  attach(port);
  port.postMessage({ id: 0, ok: true, value: { ready: true, origin: location.origin } });
});

// Tell the application the host is live and listening. It cannot be told over the port, because the
// port is what this announces the readiness to send.
parent.postMessage({ __sardHostReady: true }, "*");
