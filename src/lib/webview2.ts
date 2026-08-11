// RESILIENCE-1 / WP-1 — the one place that knows how a user fixes an outdated WebView2.
//
// Shared by the startup gate, the reader's error card and the Library's import notice, so the
// "update your runtime" recovery path is identical wherever it is offered — and so the URL is
// written once rather than three times.

/** Microsoft's Evergreen WebView2 Runtime download page. */
export const WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/";

/**
 * Is "update your runtime" an action this user can actually take?
 *
 * ONLY ON WEBVIEW2. The recovery below opens Microsoft's download page, which repairs exactly one
 * situation: a Windows machine whose Evergreen runtime is old. Everywhere else it is a dead end
 * dressed as a fix — on Android the WebView is updated by the store on its own schedule and the app
 * cannot install one, and on iOS the engine is part of the operating system. Offering the button
 * there would tell a user to do something impossible, which is worse than saying nothing.
 *
 * Asked of the ENGINE rather than the operating system, for the same reason `needsReaderHost` is:
 * WebView2 identifies itself with an `Edg/` token, and that token is what makes the download page the
 * correct answer. A Chromium-based engine that is not WebView2 is not fixed by it.
 */
export function canUpdateRuntime(ua: string = navigator.userAgent): boolean {
  return /Edg\//.test(ua);
}

/**
 * Open the download page in the user's real browser.
 *
 * Never throws: a failed launch must not turn a recovery action into a new error. The URL is also
 * shown in the Details block, so the path forward survives even if the opener plugin refuses.
 */
export async function openWebView2Help(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(WEBVIEW2_URL);
  } catch {
    /* the URL is visible in Details — not a dead end */
  }
}
