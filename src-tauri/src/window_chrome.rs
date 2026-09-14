//! The native window title bar is BLACK, and stays black (Windows).
//!
//! The window uses native OS decorations, whose caption on Windows follows the SYSTEM dark-mode
//! setting unless an application says otherwise. Two Windows quirks make saying otherwise fiddly,
//! both settled by measurement on the target machine (Win10 19045):
//!   1. The JS `getCurrentWindow().setTheme()` (tao/wry) does NOT repaint the caption after creation.
//!   2. Even `DwmSetWindowAttribute(USE_IMMERSIVE_DARK_MODE)` succeeds (S_OK) but the caption keeps
//!      its stale colour until the window's frame actually RECOMPOSITES — a `SWP_FRAMECHANGED` flag
//!      is not enough; only a real geometry change (a move/resize) forces DWM to redraw the caption.
//! So we set the attributes and then nudge the window 1px and back to force the recomposite.
//!
//! WHY IT IS NOT THE THEME'S ANY MORE (RAWY-118 REVISED). This used to take the app theme's
//! dark/light and hand it to the caption, so choosing Ivory or Linen gave a LIGHT caption and
//! choosing Charcoal gave a dark one. That made the frame the one part of the window that changed
//! colour underneath the reader while they were only changing paper, and on a light theme the band
//! above the top bar read as a second, foreign surface. The frame is the OS's furniture, not part of
//! Sard's paper: it is now black on every one of the sixteen themes, and the app's own surfaces keep
//! their theme tokens exactly as before.
//!
//! Black is asked for twice, because Windows 10 and 11 answer different questions:
//!   • `DWMWA_USE_IMMERSIVE_DARK_MODE` — the only lever on Win10. Its dark caption is black when
//!     "show accent colour on title bars" is off (`HKCU\SOFTWARE\Microsoft\Windows\DWM
//!     \ColorPrevalence = 0`, the default); with that setting ON, Windows paints the ACTIVE caption
//!     in the accent colour and no per-window attribute overrides it on Win10.
//!   • `DWMWA_CAPTION_COLOR` / `DWMWA_TEXT_COLOR` / `DWMWA_BORDER_COLOR` — Windows 11 (build 22000+)
//!     only, and exact: a literal black caption with white text and a black border, which also wins
//!     over the accent setting. They return E_INVALIDARG on Win10, which is why they are attempted
//!     and ignored rather than relied on.
//! On non-Windows platforms this is a no-op: the OS draws the caption to its own theme there.

#[cfg(target_os = "windows")]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut core::ffi::c_void,
        attr: u32,
        pv: *const core::ffi::c_void,
        cb: u32,
    ) -> i32;
}

/// Paint the native title bar black. Called a moment after startup and whenever the window regains
/// focus (see App.tsx) — WebView2 re-themes the caption during its own startup, so one call at boot
/// does not stick. It takes no argument on purpose: there is no state here to get wrong, and nothing
/// about the app's theme reaches the frame any more.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_titlebar_theme(window: tauri::Window) {
    let Ok(hwnd) = window.hwnd() else { return };
    let h = hwnd.0;
    // DWMWA_USE_IMMERSIVE_DARK_MODE = 20 on Windows 10 20H1+ (build 19041+, incl. 22H2 / 19045) and
    // Windows 11; it was 19 on the earlier 1809–1909 builds. Try 20, and on failure (S_OK is 0) fall
    // back to 19 so older builds are covered too.
    let on: i32 = 1; // always: the frame is black on every theme
    let pv = &on as *const i32 as *const core::ffi::c_void;
    let cb = core::mem::size_of::<i32>() as u32;
    // COLORREF is 0x00BBGGRR, so black and white are the same word either way round.
    let black: u32 = 0x0000_0000;
    let white: u32 = 0x00FF_FFFF;
    let col = |v: &u32| v as *const u32 as *const core::ffi::c_void;
    let cb4 = core::mem::size_of::<u32>() as u32;
    unsafe {
        if DwmSetWindowAttribute(h, 20, pv, cb) != 0 {
            let _ = DwmSetWindowAttribute(h, 19, pv, cb);
        }
        // Windows 11 only: an exact black caption with white text, and a black window border so
        // the frame has no light edge left. DWMWA_BORDER_COLOR = 34, DWMWA_CAPTION_COLOR = 35,
        // DWMWA_TEXT_COLOR = 36. MEASURED on Win10 19045: all three return 0x80070057
        // (E_INVALIDARG) and change nothing, so they are attempted and ignored — the immersive
        // dark-mode attribute above is what produces black there.
        let _ = DwmSetWindowAttribute(h, 35, col(&black), cb4);
        let _ = DwmSetWindowAttribute(h, 36, col(&white), cb4);
        let _ = DwmSetWindowAttribute(h, 34, col(&black), cb4);
        // AND THEN MAKE DWM ACTUALLY REDRAW THE FRAME. Setting the attribute is not enough: DWM
        // keeps the caption it has already composited, and — worse — a light→dark change repaints
        // only PART of it, leaving the title text sitting in a stale light box. That box is real and
        // was measured on this machine: a 22%-wide sample of the caption's title region reads 1.1%
        // light pixels when the caption is clean and 4.9% while the patch is there.
        //
        // WHAT DOES NOT CLEAR IT, all measured after forcing the caption light and back:
        //   • a 1px window MOVE and back (what this code used to do)      — 4.9%, patch stays
        //   • a 1px window RESIZE and back                                 — 4.9%, patch stays
        //   • `RedrawWindow(RDW_INVALIDATE | RDW_FRAME | RDW_UPDATENOW)`   — 4.9%, patch stays
        //   • a move with `SWP_FRAMECHANGED`                               — 4.9%, patch stays
        // WHAT DOES: asking DWM to stop and restart non-client rendering, which throws away the
        // composited frame — 1.1%, clean, three times out of three, with no geometry change at all.
        // DWMWA_NCRENDERING_POLICY = 2, DWMNCRP_DISABLED = 1, DWMNCRP_USEWINDOWSTYLE = 0. It is left
        // at USEWINDOWSTYLE rather than pinned to ENABLED, so the window style keeps deciding and
        // this leaves no state behind.
        //
        // Dropping the move is a bonus: the old nudge shifted the reader's window by a pixel and
        // back every time the theme's polarity changed, and it never did the job it was there for.
        let disabled: i32 = 1;
        let use_style: i32 = 0;
        let _ = DwmSetWindowAttribute(h, 2, &disabled as *const i32 as *const core::ffi::c_void, cb);
        let _ = DwmSetWindowAttribute(h, 2, &use_style as *const i32 as *const core::ffi::c_void, cb);
    }
}

/// No-op on non-Windows platforms — the OS draws the caption to its own theme there.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_titlebar_theme(_window: tauri::Window) {}
