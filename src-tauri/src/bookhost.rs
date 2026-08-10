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
/// SHAPE: `default-src 'none'` plus an explicit allowance per resource kind. That default is the
/// point — a directive nobody thought about fails closed rather than inheriting something permissive.
/// It is also the trap: an OMITTED directive falls back to `'none'`, so every kind of resource a book
/// legitimately loads has to be named here or the reader silently renders nothing. The first draft of
/// this policy named only `script-src`, `style-src` and `connect-src`, which meant `img-src`,
/// `font-src`, `media-src` and `frame-src` all resolved to `'none'` — that policy could not have
/// displayed a single image, loaded a single face, or even created the section iframe.
///
/// PRINCIPLE: the content-loading directives MIRROR the application CSP in `tauri.conf.json`, because
/// today the book document inherits that policy; matching it is what keeps rendering behaviour
/// identical. The privilege directives (`default-src`, `script-src`, `connect-src`) are STRICTER than
/// the application's. Same content capability, less privilege — never the reverse. Anything wider
/// than the application policy would be an expansion of what a book can reach, which this origin
/// exists to prevent.
///
/// Per directive:
/// - `script-src 'self'` — the host bootstrap and the engine, served from this origin only.
/// - `style-src` — `'unsafe-inline'` and `blob:` because foliate rewrites book stylesheets into blobs
///   and Sard injects its reading CSS inline; identical to the application policy.
/// - `img-src` — `blob:`/`data:` carry EPUB images (foliate blobs them) and the PDF page canvas, which
///   `pdf.js` copies to an `<img>` via `toDataURL` (VENDOR patch 4, RAWY-85). `asset:` carries images
///   that live in app data.
/// - `font-src` — `'self'` for the bundled faces served at `/fonts/*`, `blob:`/`data:` for faces
///   embedded in the book, and `asset:` for USER-INSTALLED fonts: `fonts.ts:95` builds
///   `@font-face { src: url(convertFileSrc(...)) }` and `FoliateController::writeFonts` writes that
///   sheet into each content document. Without `asset:` every custom font silently disappears.
/// - `media-src blob:` — exactly the application's value, no wider.
/// - `frame-src 'self' blob:` — the paginator CREATES the section iframe from this document. Omit
///   this and the reader has no iframe to render into at all.
///
/// `connect-src 'self' blob:` is required rather than `'none'`: pdf.js fetches its own stylesheets
/// (`pdf.js:10,13` call `fetchText(pdfjsPath(...))`), so a blanket refusal would break the PDF path.
/// `blob:` carries the BOOK. Its bytes are transferred in over the command channel and turned into a
/// blob URL here, deliberately instead of serving the file from this origin — serving it would give
/// this origin a filesystem route, which is the one thing the allow-list exists to deny and which
/// `serves_only_the_allow_listed_bundle` asserts it does not have. A blob URL can only be created by
/// script already running in this origin, so it grants no reach that was not already granted.
///
/// MEASURED, WebKitGTK only: with this policy a fetch to the application origin and to a
/// CORS-permissive third origin both fail and both raise a `connect-src` violation, while a
/// same-origin fetch succeeds. A WebSocket to another origin throws `SecurityError` with the same
/// violation. Enforcement on WKWebView and WebView2 is UNKNOWN and must be measured there.
///
/// UNKNOWN, and NOT decided by this policy: whether an `asset:` response is CORS-readable as a FONT
/// from this origin. CSP permitting a load is not the same as the fetch succeeding — a CORS refusal
/// has a different signature (no `securitypolicyviolation` event) and must be measured separately.
const CSP: &str = "default-src 'none'; \
                   script-src 'self'; \
                   style-src 'self' 'unsafe-inline' blob:; \
                   img-src 'self' asset: http://asset.localhost https://asset.localhost blob: data:; \
                   font-src 'self' asset: http://asset.localhost https://asset.localhost blob: data:; \
                   media-src blob:; \
                   frame-src 'self' blob:; \
                   connect-src 'self' blob:";

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
        // The reading engine, built for this origin. One fixed name, because an allow-list cannot
        // name a hashed one — and widening this to `/assets/*.js` to accommodate hashing would serve
        // the APPLICATION's bundle from the book's origin too. `inlineDynamicImports` in the host
        // build is what makes one name sufficient: there are no sibling chunks to fetch.
        "/bundle.js" => Some("reader-host/bundle.js".into()),
        _ => {
            if let Some(rest) = p.strip_prefix("/foliate-js/") {
                // The engine's own modules. `FoliateController.ensureFoliateDefined` injects
                // `<script src="/foliate-js/view.js">` against the DOCUMENT's origin, and view.js
                // then imports its siblings relatively — so once the engine runs here, the whole
                // module graph has to resolve here. Extensions are still allow-listed: this serves
                // JavaScript and its assets, never an arbitrary bundle path.
                return safe_path(
                    rest,
                    &["js", "mjs", "css", "json", "bcmap", "pfb", "ttf", "otf", "woff", "woff2", "wasm"],
                )
                .map(|r| format!("foliate-js/{r}"));
            }
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

/// The same rule over a nested path: every directory segment conservative, the last one a file whose
/// extension is on the list.
///
/// Depth is not the security property and never was — the per-segment character set is. A directory
/// segment may not contain a dot, so `..` cannot BE a segment, and the caller has already refused any
/// path containing `..` at all. What keeps this tight is that every segment must be alphanumeric with
/// `_`/`-`, and the leaf must end in an allow-listed extension.
///
/// It used to stop at one directory level, which was enough for `pdfjs/cmaps/…`. The engine's own
/// tree is deeper (`vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap`), and capping the depth would have meant
/// a second near-identical function whose rules could drift from this one.
fn safe_path(rest: &str, exts: &[&str]) -> Option<String> {
    let parts: Vec<&str> = rest.split('/').collect();
    let (leaf, dirs) = parts.split_last()?;
    for dir in dirs {
        let ok = !dir.is_empty()
            && dir
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
        if !ok {
            return None;
        }
    }
    let leaf = safe_segment(leaf, exts)?;
    Some(if dirs.is_empty() { leaf } else { format!("{}/{leaf}", dirs.join("/")) })
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

    /// The engine's own module graph. `ensureFoliateDefined` injects `/foliate-js/view.js` against
    /// the DOCUMENT's origin and view.js imports its siblings relatively, so every one of these has
    /// to resolve here or the engine cannot start in the host at all.
    #[test]
    fn serves_the_engine_the_host_runs() {
        for (req, want) in [
            ("/bundle.js", "reader-host/bundle.js"),
            ("/foliate-js/view.js", "foliate-js/view.js"),
            ("/foliate-js/epub.js", "foliate-js/epub.js"),
            ("/foliate-js/paginator.js", "foliate-js/paginator.js"),
            ("/foliate-js/fixed-layout.js", "foliate-js/fixed-layout.js"),
            ("/foliate-js/pdf.js", "foliate-js/pdf.js"),
            (
                "/foliate-js/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap",
                "foliate-js/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap",
            ),
            ("/foliate-js/vendor/pdfjs/pdf.mjs", "foliate-js/vendor/pdfjs/pdf.mjs"),
        ] {
            assert_eq!(resolve(req).as_deref(), Some(want), "{req}");
        }
    }

    /// Serving a whole subtree is where an allow-list is easiest to get wrong, so the refusals are
    /// named as explicitly as the permissions.
    #[test]
    fn the_engine_subtree_is_not_a_way_out_of_the_bundle() {
        for p in [
            "/foliate-js/../sard.db",
            "/foliate-js/vendor/../../secret.js",
            "/foliate-js/view.js.map",       // source maps are not on the extension list
            "/foliate-js/VENDOR.txt",        // nor is anything that is not code or an asset
            "/foliate-js/",                  // no leaf
            "/foliate-js/sub dir/view.js",   // space is not in the segment character set
            "/foliate-js/.hidden/view.js",   // a dot cannot appear in a directory segment
            "/bundle.js.map",
            "/reader-host/bundle.js",        // the mapped name is not also a request path
        ] {
            assert!(resolve(p).is_none(), "should refuse {p}");
        }
    }

    #[test]
    fn refuses_everything_else() {
        for p in [
            "/../../etc/passwd",
            "/fonts/../../secret",
            "/fonts/sub/dir/x.ttf",
            "/fonts/book.epub",
            "/pdfjs/../../../epub.js",
            // `/foliate-js/view.js` USED TO BE ON THIS LIST and is deliberately no longer refused.
            // It was correct while the host served a static bundle and ran no engine; the host now
            // runs the engine, and `ensureFoliateDefined` injects exactly that script against this
            // origin, so refusing it means the reader cannot start here at all. The assertion moved
            // rather than vanished: `serves_the_engine_the_host_runs` pins what the subtree serves,
            // and `the_engine_subtree_is_not_a_way_out_of_the_bundle` pins what it still refuses.
            // Every other entry below is unchanged.
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

    /// Split a CSP into `directive -> value`, so a test can reason about one directive at a time
    /// instead of substring-matching the whole string. Substring matching is what let the missing
    /// directives through: asserting what IS present can never notice what is absent.
    fn directives(csp: &str) -> std::collections::HashMap<String, String> {
        csp.split(';')
            .filter_map(|part| {
                let part = part.trim();
                if part.is_empty() {
                    return None;
                }
                let (name, value) = part.split_once(char::is_whitespace)?;
                Some((
                    name.to_ascii_lowercase(),
                    value.split_whitespace().collect::<Vec<_>>().join(" "),
                ))
            })
            .collect()
    }

    fn app_csp() -> String {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"),
        )
        .expect("tauri.conf.json is readable");
        let conf: serde_json::Value = serde_json::from_str(&raw).expect("tauri.conf.json parses");
        conf["app"]["security"]["csp"]
            .as_str()
            .expect("the application CSP is a string")
            .to_string()
    }

    #[test]
    fn csp_is_the_policy_that_was_measured() {
        let d = directives(CSP);
        assert_eq!(d.get("default-src").map(String::as_str), Some("'none'"));
        assert_eq!(d.get("script-src").map(String::as_str), Some("'self'"));
        assert_eq!(d.get("connect-src").map(String::as_str), Some("'self' blob:"));
    }

    /// The book arrives as bytes and becomes a blob URL in this origin, so `connect-src` has to admit
    /// `blob:` — and must not admit anything that would let it be fetched from somewhere else instead.
    #[test]
    fn connect_src_admits_the_book_blob_and_nothing_remote() {
        let connect = directives(CSP).remove("connect-src").expect("declared");
        assert!(connect.split_whitespace().any(|t| t == "blob:"), "the book needs blob:");
        for forbidden in ["*", "http:", "https:", "ws:", "wss:", "data:", "asset:"] {
            assert!(
                !connect.split_whitespace().any(|t| t == forbidden),
                "connect-src must not admit {forbidden}"
            );
        }
    }

    /// `default-src 'none'` means an OMITTED directive resolves to `'none'`. Every resource kind the
    /// reader actually loads must therefore be named explicitly. This is the test the first draft of
    /// the policy did not have: it shipped without `img-src`, `font-src`, `media-src` or `frame-src`,
    /// so it could not have rendered an image, loaded a custom face, or created the section iframe —
    /// and the assertions of the day, which only checked that four directives were PRESENT, all passed.
    #[test]
    fn every_resource_kind_the_reader_loads_is_named_explicitly() {
        let d = directives(CSP);
        for required in ["style-src", "img-src", "font-src", "media-src", "frame-src"] {
            assert!(
                d.contains_key(required),
                "{required} is absent, so it falls back to default-src 'none' and that resource \
                 kind cannot load at all"
            );
        }
    }

    /// The content-loading directives must MIRROR the application policy, in both directions.
    ///
    /// Narrower than the application = the reader renders differently here than it does today, which
    /// is the behaviour change this whole origin is supposed to avoid. Wider = a book reaches
    /// something it cannot currently reach, which is the security property this origin exists for.
    /// Equality is the only value that satisfies both, so the test asserts equality rather than
    /// containment and reads the application policy from `tauri.conf.json` rather than duplicating it.
    /// The application may embed the host; the host may not embed another one.
    ///
    /// `frame-src` is the one content directive that legitimately DIFFERS between the two policies.
    /// The application needs `sardhost://localhost` to put the reader on screen — omitting it is
    /// what left a real Linux machine with a blank reader. The host needs no such permission: it
    /// frames book sections from `blob:` and nothing else, and granting it would let book content
    /// nest a second host document for no benefit at all.
    #[test]
    fn the_host_may_not_embed_another_host() {
        let host = directives(CSP).remove("frame-src").expect("declared");
        let app = directives(&app_csp()).remove("frame-src").expect("declared");
        assert!(
            app.contains("sardhost"),
            "the application must be able to embed the host, or the reader cannot start on WebKit"
        );
        assert!(
            !host.contains("sardhost"),
            "the host must not be able to embed another host"
        );
        // Identical once that one permission is removed: no other difference has crept in.
        assert_eq!(host, app.replace(" sardhost://localhost", ""));
    }

    #[test]
    fn content_directives_mirror_the_application_policy() {
        let host = directives(CSP);
        let app = directives(&app_csp());
        // `frame-src` is covered by `the_host_may_not_embed_another_host`, which pins the one
        // permission the application has and the host must not.
        for kind in ["style-src", "img-src", "font-src", "media-src"] {
            let a = app.get(kind).unwrap_or_else(|| panic!("app CSP declares {kind}"));
            let h = host.get(kind).unwrap_or_else(|| panic!("host CSP declares {kind}"));
            assert_eq!(h, a, "{kind} must match the application policy exactly");
        }
    }

    /// Proof that the guard above can actually fail.
    ///
    /// An assertion that passes on correct input tells you nothing until you have seen it reject bad
    /// input. This replays the EXACT policy that shipped in the first draft and shows the check
    /// rejecting it — so the guard is known to bite, not merely known to pass. Keeping the defective
    /// string here as a fixture also documents the mistake precisely, which a comment cannot.
    #[test]
    fn the_guard_rejects_the_defective_first_draft() {
        const FIRST_DRAFT: &str = "default-src 'none'; \
                                   script-src 'self'; \
                                   style-src 'self' 'unsafe-inline' blob:; \
                                   connect-src 'self'";
        let d = directives(FIRST_DRAFT);
        let missing: Vec<&str> = ["style-src", "img-src", "font-src", "media-src", "frame-src"]
            .into_iter()
            .filter(|k| !d.contains_key(*k))
            .collect();
        assert_eq!(
            missing,
            vec!["img-src", "font-src", "media-src", "frame-src"],
            "the first draft omitted exactly these four, and the guard must notice every one"
        );
        // And the policy in force must not be that string.
        assert_ne!(CSP, FIRST_DRAFT);
    }

    /// The privilege directives must be STRICTER than the application's, never merely equal.
    #[test]
    fn privilege_directives_are_stricter_than_the_application() {
        let host = directives(CSP);
        let app = directives(&app_csp());
        assert_eq!(host.get("default-src").map(String::as_str), Some("'none'"));
        assert_ne!(
            app.get("default-src").map(String::as_str),
            Some("'none'"),
            "if the application ever tightens to 'none' this comparison stops meaning anything"
        );
        let app_connect = app.get("connect-src").expect("app CSP declares connect-src");
        let host_connect = host.get("connect-src").expect("host CSP declares connect-src");
        assert!(
            host_connect.split_whitespace().count() < app_connect.split_whitespace().count(),
            "host connect-src ({host_connect}) must be narrower than the app's ({app_connect})"
        );
        for forbidden in ["ipc:", "http://ipc.localhost"] {
            assert!(
                !host_connect.contains(forbidden),
                "the host origin must never be able to reach {forbidden}"
            );
        }
    }
}
