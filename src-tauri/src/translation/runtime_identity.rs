//! Which WebView2 runtime an edition records as the one that took its inputs.
//!
//! The authoritative version is `tauri::webview_version()`. On Windows that is the runtime a NEW WebView2 would use —
//! the one installed now. A WebView2 already running keeps the runtime it started with, so after an update installed
//! while Sard runs the two can differ, and the installed version would not describe the extraction. So the version is
//! also read from the very webview that ran the extraction — its environment's own browser version — and an edition
//! is made only when the two agree. If they differ, or either cannot be read, nothing is made: restarting Sard makes
//! them agree again. Nothing falls back to another source, and the page's own report of itself is never used.

use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    /// A version could not be read (`which`: `installed` or `running`).
    Unavailable { which: &'static str, detail: String },
    /// The webview that ran the extraction is not on the installed runtime.
    Mismatch { installed: String, running: String },
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::Unavailable { which, detail } => write!(f, "the {which} WebView2 version cannot be read: {detail}"),
            RuntimeError::Mismatch { installed, running } => {
                write!(f, "WebView2 {installed} is installed but this window runs {running}: restart Sard to make an edition")
            }
        }
    }
}

/// The version an edition records: the installed one, and only if the running webview's is exactly the same.
pub fn resolve(installed: Result<String, String>, running: Result<String, String>) -> Result<String, RuntimeError> {
    let read = |which: &'static str, v: Result<String, String>| match v {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) => Err(RuntimeError::Unavailable { which, detail: "empty".into() }),
        Err(detail) => Err(RuntimeError::Unavailable { which, detail }),
    };
    let installed = read("installed", installed)?;
    let running = read("running", running)?;
    if installed != running {
        return Err(RuntimeError::Mismatch { installed, running });
    }
    Ok(installed)
}

/// The authoritative version: the runtime installed now.
pub fn installed() -> Result<String, String> {
    tauri::webview_version().map_err(|e| e.to_string())
}

/// The version of the runtime `webview` itself runs on. It is read on the thread that owns the webview, so this
/// must not be called from that thread; it waits at most `wait`.
#[cfg(windows)]
pub fn running<R: tauri::Runtime>(webview: &tauri::Webview<R>, wait: Duration) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    webview
        .with_webview(move |w| {
            // SAFETY: the controller is the live one this webview hands its own closure, on its own thread.
            let _ = tx.send(unsafe { environment_version(&w.controller()) });
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(wait).map_err(|_| "the webview did not answer".to_string())?
}

#[cfg(windows)]
unsafe fn environment_version(controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller) -> Result<String, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{Interface, PWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;

    let core = controller.CoreWebView2().map_err(|e| e.to_string())?;
    let core = core.cast::<ICoreWebView2_2>().map_err(|e| e.to_string())?;
    let environment = core.Environment().map_err(|e| e.to_string())?;
    let mut version = PWSTR::null();
    environment.BrowserVersionString(&mut version).map_err(|e| e.to_string())?;
    let text = version.to_string().map_err(|e| e.to_string());
    CoTaskMemFree(Some(version.0 as *const _));
    text
}

/// Translation runs on WebView2 only.
#[cfg(not(windows))]
pub fn running<R: tauri::Runtime>(_webview: &tauri::Webview<R>, _wait: Duration) -> Result<String, String> {
    Err("translation runs on WebView2 only".into())
}
