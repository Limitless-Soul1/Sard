// RESILIENCE-1 / WP-1 — the one place that knows how a user fixes an outdated WebView2.
//
// Shared by the startup gate, the reader's error card and the Library's import notice, so the
// "update your runtime" recovery path is identical wherever it is offered — and so the URL is
// written once rather than three times.

/** Microsoft's Evergreen WebView2 Runtime download page. */
export const WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/";

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
