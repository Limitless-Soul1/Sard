// WHERE THE FRONTEND IS ALLOWED TO ASK WHAT IT IS RUNNING ON.
//
// ONE MODULE, so an OS name appears in one place instead of being sprinkled through the chrome. Every
// scattered `if (isAndroid)` is a place the next platform has to be remembered, and the reason this
// file exists at all is that the desktop architecture work found exactly that failure mode worth
// preventing before it starts.
//
// WHAT DOES NOT BELONG HERE. The reader already asks a better question in `reader-transport/index.ts`:
// `needsReaderHost()` asks about the ENGINE's input behaviour, not the operating system, because that
// is what actually decides the answer there. Prefer a capability question wherever one exists — this
// module is for the cases where the honest question really is "is this a phone".

/**
 * Is this a mobile web view — Android or iOS?
 *
 * Asked of the user agent because there is nothing better available in the web context: Tauri exposes
 * no platform to the frontend synchronously, and a probe would have to be awaited before the first
 * render. The strings are stable and this is used only for chrome decisions, never for anything that
 * would corrupt data if it were wrong.
 */
export function isMobile(ua: string = navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

/**
 * Does this window have a native title bar whose caption Sard can theme?
 *
 * Only a desktop window does. On Android and iOS the application draws to the whole screen and the
 * system bars are not the app's to paint, so the `set_titlebar_theme` command has nothing to act on —
 * calling it would be an IPC round trip on every light/dark change that could only ever no-op.
 */
export function hasNativeTitlebar(ua: string = navigator.userAgent): boolean {
  return !isMobile(ua);
}
