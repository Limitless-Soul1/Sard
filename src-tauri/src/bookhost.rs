//! The reader-host ORIGIN — step 1 of the origin-isolation work.
//!
//! # Why this exists
//!
//! Measured on WebKitGTK 2.52.3: the browser delivers no pointer, wheel or key events into an
//! iframe whose scripts are disabled. Sard's book frame carries `sandbox="allow-same-origin"` and
//! nothing else (`paginator.js:252`), so on WebKit the reader receives no input at all. Enabling
//! scripts fixes that, and — measured in the same matrix — immediately hands book content
//! `window.parent.__TAURI_INTERNALS__`, the app document and app globals when the book shares the
//! application's origin.
//!
//! No sandbox configuration provides all three of: the driving code can read the section document,
//! real input arrives, and privileged surfaces stay unreachable. The boundary therefore has to move
//! rather than the book: the reading engine will run in THIS origin, which holds no Tauri API, and
//! the application stays outside it.
//!
//! # What step 1 does, and deliberately does not do
//!
//! This module serves a static, allow-listed bundle from an isolated origin. It does not move
//! foliate-js, does not transfer book bytes, does not add `allow-scripts`, and creates no
//! communication channel. Those are later steps and each has its own evidence gate.
//!
//! # Why the asset resolver, and not the filesystem
//!
//! Every response comes from `AssetResolver`, which reads the FRONTEND BUNDLE compiled into the
//! binary. It has no notion of a filesystem path, so this handler **structurally cannot** serve a
//! book, a database, or anything else on disk — there is no code path that could be pointed at one.
//! That is a stronger guarantee than validating paths would be, and it is the reason for the choice.

use std::borrow::Cow;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext};

/// The scheme. Resolves to a distinct origin on every supported webview, which is the entire point:
/// `http://sardhost.localhost` on WebView2, `sardhost://localhost` on WebKitGTK and WKWebView.
pub const SCHEME: &str = "sardhost";

/// The policy this origin ships under.
///
/// `connect-src 'self'` is required rather than `'none'`: pdf.js fetches its own stylesheets
/// (`pdf.js:10,13` call `fetchText(pdfjsPath(...))`), so a blanket refusal would break the PDF path.
///
/// MEASURED, WebKitGTK only: with this policy a fetch to the application origin and to a
/// CORS-permissive third origin both fail and both raise a `connect-src` violation, while a
/// same-origin fetch succeeds. A WebSocket to another origin throws `SecurityError` with the same
/// violation. Enforcement on WKWebView and WebView2 is UNKNOWN and must be measured there.
const CSP: &str = "default-src 'none'; \
                   script-src 'self'; \
                   style-src 'self' 'unsafe-inline' blob:; \
                   connect-src 'self'";

/// Map a request path onto a bundle path, or refuse.
///
/// An allow-list, not a sanitiser: anything not named here has no route at all. A rejected path is
/// rejected because it was never listed, so there is no traversal to defeat.
fn resolve(path: &str) -> Option<String> {
    // Refuse traversal shapes outright, even though the allow-list below would already reject them.
    // Two independent reasons to say no is the cheap kind of defence.
    if path.contains("..") || path.contains('\\') || path.contains("//") {
        return None;
    }
    let p = path.split('?').next().unwrap_or(path);
    match p {
        "" | "/" | "/index.html" => Some("reader-host/index.html".into()),
        "/host.js" => Some("reader-host/host.js".into()),
        _ => {
            if let Some(name) = p.strip_prefix("/fonts/") {
                // Bundled faces only. `absFontUrl` (injectedCss.ts:179) pins @font-face to
                // `location.origin`, so once the engine runs here these must resolve here.
                return safe_segment(name, &["ttf", "otf", "woff", "woff2"])
                    .map(|n| format!("fonts/{n}"));
            }
            if let Some(rest) = p.strip_prefix("/pdfjs/") {
                // pdf.js resolves cmaps, standard fonts and its worker against `import.meta.url`
                // (`pdf.js:1`), so they must be reachable from this origin too.
                return safe_path(rest, &["bcmap", "mjs", "js", "css", "pfb", "ttf", "otf", "json"])
                    .map(|r| format!("foliate-js/vendor/pdfjs/{r}"));
            }
            None
        }
    }
}

/// One path segment, conservative character set, extension on the list.
fn safe_segment(name: &str, exts: &[&str]) -> Option<String> {
    if name.is_empty()
        || name.contains('/')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    exts.contains(&ext.as_str()).then(|| name.to_string())
}

/// The same rule, but permitting a single directory level (`cmaps/…`, `standard_fonts/…`).
fn safe_path(rest: &str, exts: &[&str]) -> Option<String> {
    let mut parts = rest.split('/');
    let first = parts.next()?;
    match parts.next() {
        None => safe_segment(first, exts),
        Some(name) if parts.next().is_none() => {
            let dir_ok = !first.is_empty()
                && first
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
            if !dir_ok {
                return None;
            }
            safe_segment(name, exts).map(|n| format!("{first}/{n}"))
        }
        _ => None, // deeper than the bundle needs
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("bcmap") => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn refuse(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Borrowed(b"" as &[u8]))
        .expect("static response")
}

/// Serve one request from the compiled frontend bundle, or refuse it.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if request.method() != tauri::http::Method::GET {
        return refuse(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = request.uri().path().to_string();
    let Some(asset_path) = resolve(&path) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    let Some(asset) = ctx.app_handle().asset_resolver().get(asset_path.clone()) else {
        return refuse(StatusCode::NOT_FOUND);
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_for(&asset_path))
        // No cross-origin reader is wanted: this origin exists to be isolated, not shared.
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("X-Content-Type-Options", "nosniff");
    if asset_path.ends_with(".html") {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, CSP);
    }
    builder
        .body(Cow::Owned(asset.bytes))
        .unwrap_or_else(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_the_allow_listed_bundle() {
        assert_eq!(resolve("/").as_deref(), Some("reader-host/index.html"));
        assert_eq!(resolve("/index.html").as_deref(), Some("reader-host/index.html"));
        assert_eq!(resolve("/host.js").as_deref(), Some("reader-host/host.js"));
        assert_eq!(resolve("/fonts/Amiri-Regular.ttf").as_deref(), Some("fonts/Amiri-Regular.ttf"));
        assert_eq!(
            resolve("/pdfjs/cmaps/UniJIS-UCS2-H.bcmap").as_deref(),
            Some("foliate-js/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap")
        );
    }

    #[test]
    fn refuses_everything_else() {
        for p in [
            "/../../etc/passwd",
            "/fonts/../../secret",
            "/fonts/sub/dir/x.ttf",
            "/fonts/book.epub",
            "/pdfjs/../../../epub.js",
            "/foliate-js/view.js",
            "/library/book.epub",
            "/sard.db",
            "//evil",
            "/fonts/",
            "/host.js.map",
        ] {
            assert!(resolve(p).is_none(), "should refuse {p}");
        }
    }

    /// The guarantee that matters: no request shape names a filesystem location. Every accepted
    /// path maps into the compiled bundle, so a book on disk has no route through this origin.
    #[test]
    fn no_accepted_path_escapes_the_bundle() {
        for p in ["/", "/index.html", "/host.js", "/fonts/Amiri-Regular.ttf", "/pdfjs/pdf.worker.mjs"] {
            let mapped = resolve(p).expect("allow-listed");
            assert!(!mapped.starts_with('/') && !mapped.contains(".."), "{p} -> {mapped}");
        }
    }

    #[test]
    fn csp_is_the_policy_that_was_measured() {
        assert!(CSP.contains("default-src 'none'"));
        assert!(CSP.contains("script-src 'self'"));
        assert!(CSP.contains("style-src 'self' 'unsafe-inline' blob:"));
        assert!(CSP.contains("connect-src 'self'"));
    }
}
