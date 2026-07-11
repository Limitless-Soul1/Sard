//! In-app update CHECK (RAWY-168, updater Phase 1). This is a check-and-notify ONLY path — it does
//! NOT download or install anything (that would be Phase 2). It fetches a tiny static JSON manifest
//! over HTTP (Rust-side, via the same `ureq` the TTS voice download uses), compares the manifest's
//! version against the running app's version, and returns the result for the Settings → About UI to
//! show ("up to date" / "update available → open the release page" / "couldn't check").
//!
//! SECURITY (RAWY-64/D30 posture): the network call happens HERE in Rust, never in the WebView; the
//! UI only opens the release URL in the OS browser via the opener plugin. No remote code runs in-app.

use std::io::Read;
use std::time::Duration;

/// The update manifest URL — the ONE place to configure the update source.
///
/// PLACEHOLDER (RAWY-168): the Sard repo is PRIVATE during development, so there is no public release
/// feed yet — this is intentionally EMPTY. While it is empty the feature degrades gracefully (the
/// check returns `configured: false` and the UI shows a quiet "couldn't check", never an error).
///
/// TODO(owner): when the repo goes PUBLIC, set this to a small static JSON manifest served over HTTPS
/// — e.g. a file committed to the repo and read raw:
///     "https://raw.githubusercontent.com/Limitless-Soul1/Sard/main/latest.json"
/// whose body is:  { "version": "0.6.0", "url": "https://github.com/Limitless-Soul1/Sard/releases/latest", "notes": "…" }
/// No other code change is needed — just this one string.
const UPDATE_MANIFEST_URL: &str = "";

/// The manifest shape (a tiny static JSON). `url`/`notes` are optional so a minimal manifest works.
#[derive(serde::Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    notes: String,
}

/// What the Settings UI needs to render the result. `configured` is false when the manifest URL is the
/// empty placeholder (no public feed yet) — the UI then shows the same quiet "couldn't check".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current: String,
    latest: String,
    is_newer: bool,
    url: String,
    notes: String,
    configured: bool,
}

/// Parse a semver-ish string into a comparable (major, minor, patch) tuple. Tolerant: strips a leading
/// `v`, drops any `-pre`/`+build` suffix, and treats missing/garbage parts as 0. Numeric compare, so
/// `0.10.0 > 0.9.0` is correct (unlike a string compare).
fn semver_tuple(s: &str) -> (u64, u64, u64) {
    let core = s.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or("");
    let mut it = core.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

/// Check for a newer version. Fetches the manifest URL (if configured), compares versions, and returns
/// the result. Never panics on a network/parse failure — returns a clean `Err` the UI shows quietly.
/// No download, no install.
#[tauri::command]
pub fn check_for_update() -> Result<UpdateCheck, String> {
    // The running app's version, from the SAME source RAWY-167 set (Cargo.toml), at compile time.
    let current = env!("CARGO_PKG_VERSION").to_string();

    // No feed configured yet (private repo) → degrade gracefully, no network call.
    if UPDATE_MANIFEST_URL.trim().is_empty() {
        return Ok(UpdateCheck {
            current,
            latest: String::new(),
            is_newer: false,
            url: String::new(),
            notes: String::new(),
            configured: false,
        });
    }

    // Short timeouts so an unreachable feed fails fast + quietly (mirrors tts.rs's ureq usage).
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(10)))
            .build(),
    );
    let resp = agent
        .get(UPDATE_MANIFEST_URL)
        .call()
        .map_err(|e| format!("update check failed: {e}"))?;
    // Bounded read (64 KB) — a manifest is tiny; never slurp an unexpectedly huge body.
    let mut body = String::new();
    resp.into_body()
        .into_reader()
        .take(64 * 1024)
        .read_to_string(&mut body)
        .map_err(|e| format!("update read failed: {e}"))?;
    let m: Manifest = serde_json::from_str(&body).map_err(|e| format!("update manifest parse: {e}"))?;

    let is_newer = semver_tuple(&m.version) > semver_tuple(&current);
    Ok(UpdateCheck {
        current,
        latest: m.version,
        is_newer,
        url: m.url,
        notes: m.notes,
        configured: true,
    })
}
