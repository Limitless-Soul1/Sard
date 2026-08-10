// Which reader the application gets, and why it differs by platform.
//
// Windows takes the direct path: `new FoliateController()`, the same object it has always
// constructed, running in the application's own document. There is no measured defect there and
// nothing about the hosted path would improve it.
//
// WebKit takes the hosted path, for one measured reason: WebKitGTK does not deliver pointer events
// into an iframe sandboxed `allow-same-origin` without `allow-scripts`, and Blink does. Giving book
// content `allow-scripts` is only safe when the document it can reach holds nothing — which is what
// the reader host is.
//
// This is the ONLY place the platform is consulted on the frontend. Everything downstream — all 107
// call sites in `Reader.tsx` — sees the same surface either way.
import { FoliateController } from "../reader-engine/FoliateController";
import { hostedReader } from "./hosted";

/**
 * Is this a WebView that needs the reader host?
 *
 * Asked of the ENGINE, not of the operating system. What matters is the input-delivery behaviour of
 * the WebView, and that is a property of WebKit rather than of Linux or macOS: a Chromium-based
 * WebView on Linux would not need this, and asking "is this Linux?" would give it the host anyway.
 * WebKit is identified by the absence of Chrome/Chromium in a WebKit user agent — Blink's UA also
 * contains "AppleWebKit", so the negative is the discriminator.
 */
export function needsReaderHost(ua: string = navigator.userAgent): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

/**
 * Create the host inside the container the reader gave us, and complete the handshake.
 *
 * WHY THE CONTAINER, AND WHY SO LATE. The first version of this appended the frame to
 * `document.body` at `position:absolute; inset:0`, intending the reading area to move it into place
 * later. Nothing ever did — the accessor written for that was never called — so on a real Linux
 * machine the host became a full-window overlay: it covered the toolbar, which vanished, and showed
 * its own empty background, which read as a blank page. The reader was working the whole time,
 * behind it.
 *
 * Moving the frame afterwards is not an option and that is the reason this is deferred rather than
 * fixed in place: re-parenting an iframe reloads its document, which would destroy the host and the
 * port with it. So the frame is created where it belongs, once, at the moment the reader first has a
 * container to give — which is `open()`.
 */
export function mountHostIn(container: HTMLElement): Promise<{ port: MessagePort; frame: HTMLIFrameElement }> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "reader");
    // Fills the reading area it was given, and nothing beyond it.
    frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:transparent";

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return; // `e.origin` cannot authenticate; `e.source` can
      if (!(e.data as { __sardHostReady?: boolean })?.__sardHostReady) return;
      removeEventListener("message", onMessage);
      const channel = new MessageChannel();
      frame.contentWindow?.postMessage({ __sardHostInit: true }, "*", [channel.port2]);
      resolve({ port: channel.port1, frame });
    };
    addEventListener("message", onMessage);
    frame.addEventListener("error", () => reject(new Error("the reader host failed to load")));

    // PROBE-ONLY hook on the throwaway branch; nothing sets this in a shipped build.
    const probe = (globalThis as { __sardHostSelfcheck?: boolean }).__sardHostSelfcheck;
    frame.src = probe ? "sardhost://localhost/?selfcheck=1" : "sardhost://localhost/";
    // In the container BEFORE it loads. See above: it can never be moved afterwards.
    container.replaceChildren(frame);
  });
}

/**
 * The reader for this platform.
 *
 * Windows resolves immediately with the object it has always used. The hosted reader is returned
 * immediately too — it has no host yet, and creates one the first time `open()` gives it somewhere
 * to put it.
 */
export async function createReader(): Promise<FoliateController> {
  if (!needsReaderHost()) return new FoliateController();
  return hostedReader();
}
