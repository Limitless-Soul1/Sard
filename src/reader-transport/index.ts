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

/** The host document, mounted once and kept for the life of the window. */
let hostFrame: HTMLIFrameElement | null = null;

function mountHost(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    hostFrame = frame;
    frame.setAttribute("title", "reader");
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return; // `e.origin` cannot authenticate; `e.source` can
      if (!(e.data as { __sardHostReady?: boolean })?.__sardHostReady) return;
      removeEventListener("message", onMessage);
      const channel = new MessageChannel();
      frame.contentWindow?.postMessage({ __sardHostInit: true }, "*", [channel.port2]);
      resolve(channel.port1);
    };
    addEventListener("message", onMessage);
    frame.addEventListener("error", () => reject(new Error("the reader host failed to load")));
    frame.src = "sardhost://localhost/";
    document.body.appendChild(frame);
  });
}

/**
 * The reader for this platform.
 *
 * Windows resolves immediately with the object it has always used. The hosted path has to wait for
 * the host document to announce itself, which is why this is asynchronous on both — a signature that
 * differs by platform would push the difference into the caller.
 */
export async function createReader(): Promise<FoliateController> {
  if (!needsReaderHost()) return new FoliateController();
  return hostedReader(await mountHost());
}

/** The frame the host runs in, for the reading area to place. Null on the direct path. */
export function readerHostFrame(): HTMLIFrameElement | null {
  return hostFrame;
}
