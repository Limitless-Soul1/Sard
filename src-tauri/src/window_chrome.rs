//! RAWY-118: theme the native window title bar to match the app theme (Windows).
//!
//! The window uses native OS decorations, whose caption on Windows follows the SYSTEM dark-mode
//! setting — a fixed near-black bar that ignores Sard's own theme, so it read as an out-of-place
//! black band above the reader's top bar. Two Windows quirks made this fiddly, both settled by
//! measurement on the target machine (Win10 19045):
//!   1. The JS `getCurrentWindow().setTheme()` (tao/wry) does NOT repaint the caption after creation.
//!   2. Even `DwmSetWindowAttribute(USE_IMMERSIVE_DARK_MODE)` succeeds (S_OK) but the caption keeps
//!      its stale colour until the window's frame actually RECOMPOSITES — a `SWP_FRAMECHANGED` flag
//!      is not enough; only a real geometry change (a move/resize) forces DWM to redraw the caption.
//! So we set the attribute and then nudge the window 1px and back to force the recomposite.
//!
//! This gives a DARK caption for dark themes and a LIGHT caption for light themes. It is NOT the exact
//! Ivory/Charcoal colour: an arbitrary caption colour needs Windows 11's DWMWA_CAPTION_COLOR (returns
//! E_INVALIDARG on Win10), and a pixel-exact match would need a custom (borderless) title bar —
//! deferred as a possible future enhancement. On non-Windows platforms this is a no-op.

#[cfg(target_os = "windows")]
#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

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

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetWindowRect(hwnd: *mut core::ffi::c_void, rect: *mut Rect) -> i32;
    fn SetWindowPos(
        hwnd: *mut core::ffi::c_void,
        after: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
}

/// Set the native title-bar caption dark or light to match the current theme. Called from the
/// frontend's `applyTheme` (and re-applied shortly after startup + on window focus — see App.tsx),
/// so the caption tracks the theme through the WebView2 startup that re-themes it.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_titlebar_theme(window: tauri::Window, dark: bool) {
    let Ok(hwnd) = window.hwnd() else { return };
    let h = hwnd.0;
    // DWMWA_USE_IMMERSIVE_DARK_MODE = 20 on Windows 10 20H1+ (build 19041+, incl. 22H2 / 19045) and
    // Windows 11; it was 19 on the earlier 1809–1909 builds. Try 20, and on failure (S_OK is 0) fall
    // back to 19 so older builds are covered too.
    let on: i32 = if dark { 1 } else { 0 };
    let pv = &on as *const i32 as *const core::ffi::c_void;
    let cb = core::mem::size_of::<i32>() as u32;
    unsafe {
        if DwmSetWindowAttribute(h, 20, pv, cb) != 0 {
            let _ = DwmSetWindowAttribute(h, 19, pv, cb);
        }
        // The attribute alone does not recomposite the caption; a real move does. Nudge the window
        // 1px right and back — imperceptible, and it forces DWM to redraw the caption in the new mode.
        // SWP_NOSIZE(1)|SWP_NOZORDER(4)|SWP_NOACTIVATE(0x10) = 0x15 (move only; no resize/reorder/focus).
        let mut rc = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(h, &mut rc) != 0 {
            let null = core::ptr::null_mut();
            let _ = SetWindowPos(h, null, rc.left + 1, rc.top, 0, 0, 0x15);
            let _ = SetWindowPos(h, null, rc.left, rc.top, 0, 0, 0x15);
        }
    }
}

/// No-op on non-Windows platforms — the OS draws the caption to its own theme there.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_titlebar_theme(_window: tauri::Window, _dark: bool) {}
