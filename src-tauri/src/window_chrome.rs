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

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetSystemMenu(hwnd: *mut core::ffi::c_void, revert: i32) -> *mut core::ffi::c_void;
    fn TrackPopupMenu(menu: *mut core::ffi::c_void, flags: u32, x: i32, y: i32, reserved: i32, hwnd: *mut core::ffi::c_void, rect: *const core::ffi::c_void) -> i32;
    fn PostMessageW(hwnd: *mut core::ffi::c_void, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn SetForegroundWindow(hwnd: *mut core::ffi::c_void) -> i32;
    fn GetWindowLongPtrW(hwnd: *mut core::ffi::c_void, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: *mut core::ffi::c_void, index: i32, value: isize) -> isize;
    fn SetWindowPos(hwnd: *mut core::ffi::c_void, after: *mut core::ffi::c_void, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn IsZoomed(hwnd: *mut core::ffi::c_void) -> i32;
    fn MonitorFromWindow(hwnd: *mut core::ffi::c_void, flags: u32) -> *mut core::ffi::c_void;
    fn GetMonitorInfoW(monitor: *mut core::ffi::c_void, info: *mut MonitorInfo) -> i32;
    fn GetDpiForWindow(hwnd: *mut core::ffi::c_void) -> u32;
    fn AdjustWindowRectExForDpi(rect: *mut Rect, style: u32, menu: i32, ex_style: u32, dpi: u32) -> i32;
}
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
#[cfg(target_os = "windows")]
#[repr(C)]
struct MonitorInfo { size: u32, monitor: Rect, work: Rect, flags: u32 }

/// THE WINDOW MENU, on a right-click of the title bar the application draws.
///
/// The window is undecorated, so there is no caption for Windows to answer a right-click on — but the
/// window still has its system menu (Alt+Space shows it, unchanged), and this shows that same menu at
/// the point the reader clicked, exactly as a native caption would. Nothing is invented: the menu is
/// the OS's own (`GetSystemMenu`), its items are enabled by the OS for the window's current state, and
/// the choice is handed back to the window as the `WM_SYSCOMMAND` the OS would have sent. `x`/`y` are
/// physical screen pixels. Run on the window's own thread, which is where a popup menu must be
/// tracked from.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn show_window_menu(window: tauri::Window, x: i32, y: i32) -> i32 {
    let Ok(hwnd) = window.hwnd() else { return 0 };
    let h = hwnd.0;
    // TPM_RETURNCMD (0x0100): the chosen command comes back instead of being sent, so it can be posted
    // as the WM_SYSCOMMAND (0x0112) a native caption would have delivered. TPM_RIGHTBUTTON (0x0002)
    // lets the menu be worked with either button, as the native one can. A synchronous command runs
    // on the window's own thread, which is where a popup menu must be tracked from; the window is
    // made foreground first, because a popup tracked for a window that is not foreground closes at
    // once.
    const TPM_RETURNCMD: u32 = 0x0100;
    const TPM_RIGHTBUTTON: u32 = 0x0002;
    const WM_SYSCOMMAND: u32 = 0x0112;
    unsafe {
        let menu = GetSystemMenu(h, 0);
        if menu.is_null() {
            return 0;
        }
        let _ = SetForegroundWindow(h);
        let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, h, core::ptr::null());
        if cmd != 0 {
            let _ = PostMessageW(h, WM_SYSCOMMAND, cmd as usize, 0);
        }
        cmd
    }
}

/// No-op on non-Windows platforms.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn show_window_menu(_window: tauri::Window, _x: i32, _y: i32) -> i32 { 0 }

/// FULLSCREEN, ENTERED FROM WHATEVER STATE THE WINDOW IS IN.
///
/// THE DEFECT THIS EXISTS FOR. On Windows the frame-less window computes its own client area
/// (`WM_NCCALCSIZE`, in tao), and for a MAXIMIZED window it pins that area to the monitor's work
/// area so a maximized window never covers the taskbar. Entering fullscreen does not clear the
/// window's maximized style, so from a maximized window the client area stayed at work-area size
/// while the window itself grew to the monitor: no `WM_SIZE`, so the webview was never resized and
/// the page never heard a `resize` — the frame stayed on screen and the taskbar's height at the
/// bottom of the screen was never painted. Measured: window 1920×1080, viewport 1920×1040, a black
/// band at the bottom. A window the OS decorates never takes that path, which is why this appeared
/// with the application's own frame.
///
/// THE SEQUENCE, AND WHY IT IS THIS ONE. The first correction left the maximized state before going
/// fullscreen (`ShowWindow(SW_RESTORE)`), and that was visible: the window sat at its restored size
/// for a frame or two, whatever was behind it showing through, then jumped to the monitor — the
/// "shake" — and came back the same way. Captured frame by frame, both directions. So nothing here
/// moves the window through its restored rectangle:
///
///   ENTER: tao's own fullscreen first (the window goes to the monitor, the maximized placement is
///   saved for the way back), then the maximized STYLE is cleared in place and the frame recomputed
///   (`SWP_FRAMECHANGED`, no move, no size): `WM_NCCALCSIZE` now hands the client the whole window,
///   `WM_SIZE` follows, the webview is resized, tao's own maximized flag follows the message. The
///   window's bounds change exactly once.
///
///   EXIT (`window_fullscreen_exit`): the window is re-maximized FIRST, while still fullscreen, so
///   that when tao restores the saved placement the window is already zoomed and Windows has no
///   restored rectangle to pass through — restoring the placement of a window that is not zoomed
///   visits that rectangle (measured: a restored-size frame, a white frame, a torn one). Maximizing
///   a window that still wears the borderless style gives it the whole monitor as its maximized
///   rectangle, and the placement restore leaves a zoomed window where it is; so the last step puts
///   the window on the rectangle Windows itself gives a maximized window of its style — the work
///   area grown by the frame (`AdjustWindowRectExForDpi`) — one bounds change, monitor to work area.
///
/// DWM's minimize/maximize transition is switched off for the window for the fullscreen session
/// (`DWMWA_TRANSITIONS_FORCEDISABLED`), so the one `SW_MAXIMIZE` on the way out does not animate a
/// 40px shrink; it is switched back on once the window is back. Each half runs synchronously on the
/// window's thread as one command, which is what keeps its steps ordered. Returns whether the window
/// was maximized, for the exit to hand back.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn window_fullscreen(window: tauri::Window, on: bool) -> Result<bool, String> {
    const GWL_STYLE: i32 = -16;
    const WS_MAXIMIZE: isize = 0x0100_0000;
    // SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    const SWP_FRAME_ONLY: u32 = 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010;
    let e = |err: tauri::Error| err.to_string();
    if !on {
        return window_fullscreen_exit(window, false).map(|_| false);
    }
    let Ok(hwnd) = window.hwnd() else { return Err("no window".into()) };
    let h = hwnd.0;
    dwm_transitions(h, false);
    window.set_fullscreen(true).map_err(e)?;
    let zoomed = unsafe { IsZoomed(h) } != 0;
    if zoomed {
        unsafe {
            let style = GetWindowLongPtrW(h, GWL_STYLE);
            SetWindowLongPtrW(h, GWL_STYLE, style & !WS_MAXIMIZE);
            SetWindowPos(h, core::ptr::null_mut(), 0, 0, 0, 0, SWP_FRAME_ONLY);
        }
    }
    announce(&window);
    Ok(zoomed)
}

/// The exit half of `window_fullscreen`; `remaximize` is what entry returned.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn window_fullscreen_exit(window: tauri::Window, remaximize: bool) -> Result<(), String> {
    let e = |err: tauri::Error| err.to_string();
    let Ok(hwnd) = window.hwnd() else { return Err("no window".into()) };
    let h = hwnd.0;
    if remaximize {
        window.maximize().map_err(e)?;
    }
    window.set_fullscreen(false).map_err(e)?;
    if remaximize {
        unsafe {
            const MONITOR_DEFAULTTONEAREST: u32 = 2;
            const GWL_STYLE: i32 = -16;
            const GWL_EXSTYLE: i32 = -20;
            const SWP_NOZORDER_NOACTIVATE: u32 = 0x0004 | 0x0010;
            let mut info = MonitorInfo { size: core::mem::size_of::<MonitorInfo>() as u32, monitor: Rect::default(), work: Rect::default(), flags: 0 };
            if GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut info) != 0 {
                let mut r = info.work;
                let style = GetWindowLongPtrW(h, GWL_STYLE) as u32;
                let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
                if AdjustWindowRectExForDpi(&mut r, style, 0, ex, GetDpiForWindow(h)) != 0 {
                    SetWindowPos(h, core::ptr::null_mut(), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER_NOACTIVATE);
                }
            }
        }
    }
    dwm_transitions(h, true);
    announce(&window);
    Ok(())
}

/// The page learns of the window's state from its `resize` events, and a fullscreen exit that lands
/// back on a maximized window changes the client area not at all (work area before, work area
/// after) — so the command that changed the state says so. Not polling: one event per transition.
fn announce(window: &tauri::Window) {
    use tauri::Emitter;
    let _ = window.emit_to(window.label(), "sard://window-state", ());
}

#[cfg(target_os = "windows")]
fn dwm_transitions(h: *mut core::ffi::c_void, enabled: bool) {
    const DWMWA_TRANSITIONS_FORCEDISABLED: u32 = 3;
    let v: i32 = if enabled { 0 } else { 1 };
    unsafe { DwmSetWindowAttribute(h, DWMWA_TRANSITIONS_FORCEDISABLED, &v as *const i32 as *const _, 4) };
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn window_fullscreen(window: tauri::Window, on: bool) -> Result<bool, String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())?;
    announce(&window);
    Ok(false)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn window_fullscreen_exit(window: tauri::Window, _remaximize: bool) -> Result<(), String> {
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    announce(&window);
    Ok(())
}

/// THE GROUND THE WINDOW SHOWS WHERE THE PAGE HAS NOT PAINTED YET.
///
/// When the window changes size — fullscreen in or out, a maximize — the newly exposed area is
/// painted by the platform before the page lays out into it: the webview's default background
/// (white) and the window's own (black). Measured as white and black bands for a frame or two at
/// every fullscreen transition. Both are set here to the theme's application ground, the same value
/// the page paints on `body`, so the exposed area is the colour the page is about to paint anyway
/// and the transition reads as continuous. Called from `applyTheme` with the theme's `surfaceBg`.
#[tauri::command]
pub fn set_window_ground(window: tauri::WebviewWindow, hex: String) -> Result<(), String> {
    let v = hex.trim().trim_start_matches('#');
    if v.len() != 6 {
        return Err("hex".into());
    }
    let c = |i: usize| u8::from_str_radix(&v[i..i + 2], 16).map_err(|_| "hex".to_string());
    let color = tauri::window::Color(c(0)?, c(2)?, c(4)?, 255);
    window.set_background_color(Some(color)).map_err(|e| e.to_string())
}
