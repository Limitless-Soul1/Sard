//! RAWY-196: Sard owns its keyboard and pointer surface — no browser chrome, no browser shortcuts.
//!
//! WebView2 *is* Chromium, so an app built on it inherits Chromium's UI for free, whether it wants it
//! or not. Measured on the shipped 0.5.1 release build, all of this was live inside a book:
//!   - Ctrl+F / F3   -> the WebView2 FIND BAR floated over the reading view (the reported bug).
//!   - Ctrl+P        -> the webview NAVIGATED to `edge://print/`. Sard was simply gone; Escape came
//!                      back but reloaded the whole SPA. This was the worst of them.
//!   - Ctrl+R / F5   -> reloaded the app: the reader was torn down and the user landed in the library.
//!   - right-click   -> the raw browser menu (Back / Refresh / Save as / Print), which is a GATEWAY:
//!                      a user who knows no shortcuts could still destroy their session by accident.
//!   - F7            -> Chromium's "Turn on caret browsing?" dialog.
//! (Browser zoom and devtools were already off — `zoomHotkeysEnabled` defaults false, and Tauri only
//! enables devtools in debug. Both are re-asserted here so a config change cannot silently undo them:
//! a second zoom system competing with D6's CSS zoom is exactly what makes typography unreasonable.)
//!
//! None of these are reachable from Tauri's config: `AreBrowserAcceleratorKeysEnabled` and
//! `AreDefaultContextMenusEnabled` exist only on wry's Windows builder trait (and default to TRUE),
//! which Tauri does not surface. So they are set after creation through `with_webview` ->
//! `PlatformWebview::controller()` -> `ICoreWebView2Settings` / `ICoreWebView2Settings3`.
//!
//! Suppressing the accelerators does NOT stop keys reaching the page — it only stops the BROWSER from
//! acting on them. Every Sard-owned shortcut (F11, Escape, arrows, Space, Ctrl+F, "/", Tab focus,
//! Ctrl+A/C copy) still fires; only Chromium's own handling is removed.

/// Strip WebView2's browser chrome from the window. Windows-only; a no-op elsewhere.
#[cfg(target_os = "windows")]
pub fn harden(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    // A DEBUG build keeps the accelerators, the context menu and devtools: F12 and right-click ->
    // Inspect are the developer's only way in, and removing the accelerators would leave no way to
    // open devtools at all. The RELEASE binary — the one the owner runs, and the one STEP 3 verifies
    // — ships none of it.
    let dev = cfg!(debug_assertions);

    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };

        let _ = settings.SetAreDefaultContextMenusEnabled(dev);
        let _ = settings.SetAreDevToolsEnabled(dev);
        let _ = settings.SetIsStatusBarEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);

        // The big one: the find bar, reload, print, caret browsing. `ICoreWebView2Settings3` is a
        // runtime QueryInterface — on a WebView2 runtime too old to expose it the cast fails, and we
        // leave the accelerators as they were rather than refusing to start.
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(dev);
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn harden(_window: &tauri::WebviewWindow) {}
