//! Downloading a catalog file: resumable, cancellable, and accepted only if it is byte-for-byte the
//! file the catalog names.
//!
//! ## How a download runs
//!
//! The file is fetched as a sequence of ranged requests (`CHUNK` bytes each) and appended to
//! `partial/<id>.part`, which is the ONLY resume state: after a crash, a cancel or a lost connection,
//! the bytes already on disk are hashed again and the next request starts where they end. Each chunk
//! request has its own body timeout, which is what turns a stalled connection into a retry instead of
//! a download that hangs for ever (the HTTP client offers no stall timeout of its own). When the last
//! byte has arrived, the size and the SHA-256 of the whole file are compared with the catalog; only a
//! match is moved into place. A mismatch deletes the partial file — there is no "almost right" model.
//!
//! ## What a download never does on its own
//!
//! * It never starts over an unfinished download, and never continues one, unless the caller says
//!   which: `Mode::Start` refuses when a partial download exists, `Mode::Resume` refuses when none
//!   does. Resuming is the user's decision, never a side effect of opening the app.
//! * It never follows a redirect blindly. Every URL — the catalog's and every `Location` — must be
//!   HTTPS on the default port, carry no user information, and name an allowed host. The check parses
//!   the URL; string matching accepts `https://huggingface.co:443@elsewhere/` as Hugging Face.
//! * It never asks for a compressed transfer. The hash is over the file's own bytes, and a ranged
//!   request against a content-encoded representation is not the same thing.
//!
//! The hash, not the host, is what makes a file acceptable: the allow-list limits where Sard connects
//! (which the privacy policy has to be able to state); the catalog's SHA-256 decides what is kept.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::catalog::Artifact;
use super::store::{hex, Store};

/// Bytes per ranged request.
const CHUNK: u64 = 16 * 1024 * 1024;
/// Hosts Sard may contact for a download, and their subdomains (the Hugging Face CDN and storage
/// bridge live under `hf.co`; GitHub serves release assets from its own asset hosts).
const ALLOWED_HOSTS: &[&str] = &[
    "huggingface.co",
    "hf.co",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];
const MAX_REDIRECTS: usize = 5;

/// How a download behaves. `production()` is the only policy the application uses.
#[derive(Clone)]
pub struct Policy {
    allowed_hosts: Vec<String>,
    allow_plain_http_loopback: bool,
    chunk: u64,
    connect_timeout: Duration,
    response_timeout: Duration,
    /// Body timeout per chunk. With `CHUNK` = 16 MiB and 180 s, a link slower than about 90 KB/s
    /// fails a chunk; the bytes it did deliver are kept and the next attempt continues from them.
    chunk_timeout: Duration,
    /// Attempts per chunk before the download stops as interrupted.
    attempts: u32,
    backoff: Vec<Duration>,
    /// Free space to leave on the volume beyond the bytes still to download.
    space_margin: u64,
    space_probe: fn(&Path) -> Option<u64>,
    #[cfg(test)]
    pub(crate) fault_write_after: Option<u64>,
}

impl Policy {
    pub fn production() -> Policy {
        Policy {
            allowed_hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(),
            allow_plain_http_loopback: false,
            chunk: CHUNK,
            connect_timeout: Duration::from_secs(20),
            response_timeout: Duration::from_secs(30),
            chunk_timeout: Duration::from_secs(180),
            attempts: 4,
            backoff: vec![Duration::from_secs(1), Duration::from_secs(4), Duration::from_secs(10)],
            space_margin: 512 * 1024 * 1024,
            space_probe: available_space,
            #[cfg(test)]
            fault_write_after: None,
        }
    }

    /// For tests only: plain HTTP to 127.0.0.1 on any port, small chunks, short waits.
    #[cfg(test)]
    pub(crate) fn loopback_for_tests() -> Policy {
        Policy {
            allowed_hosts: vec!["127.0.0.1".to_string()],
            allow_plain_http_loopback: true,
            chunk: 256 * 1024,
            connect_timeout: Duration::from_secs(5),
            response_timeout: Duration::from_secs(5),
            chunk_timeout: Duration::from_millis(1500),
            attempts: 3,
            backoff: vec![Duration::from_millis(20)],
            space_margin: 0,
            space_probe: |_| None,
            fault_write_after: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_space_probe(mut self, probe: fn(&Path) -> Option<u64>, margin: u64) -> Policy {
        self.space_probe = probe;
        self.space_margin = margin;
        self
    }
}

/// Whether to begin a new download or continue an unfinished one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Start,
    Resume,
}

/// Progress, reported after every chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// The file is already in place (installed, unverified or damaged). Verify or remove it first.
    AlreadyPresent,
    /// `Mode::Start` was asked for, but an unfinished download exists. The caller must choose to
    /// resume it or discard it.
    PartialExists { bytes: u64 },
    /// `Mode::Resume` was asked for, but there is nothing to resume.
    NothingToResume,
    /// Another download of the same file is running.
    Busy,
    InsufficientSpace { needed: u64, available: u64 },
    /// A URL failed the host, scheme or form check. Nothing was requested from it.
    UrlRefused(String),
    /// The connection failed after every attempt. The bytes received so far are kept.
    Network { kept_bytes: u64, detail: String },
    /// The server answered in a way that cannot be trusted to continue the file (no range support, a
    /// range other than the one asked for, too many bytes). Nothing from that answer was written.
    BadResponse { kept_bytes: u64, detail: String },
    /// The whole file arrived but is not the catalog's file. The partial download was deleted.
    ChecksumMismatch { expected: String, actual: String },
    /// The partial download is longer than the file itself. It was deleted.
    OversizedPartial { bytes: u64 },
    Cancelled { kept_bytes: u64 },
    Io { kept_bytes: u64, detail: String },
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyPresent => write!(f, "the file is already present"),
            Self::PartialExists { bytes } => write!(f, "an unfinished download of {bytes} bytes exists"),
            Self::NothingToResume => write!(f, "there is no unfinished download to resume"),
            Self::Busy => write!(f, "this file is already being downloaded"),
            Self::InsufficientSpace { needed, available } => write!(f, "{needed} bytes of free space needed, {available} available"),
            Self::UrlRefused(why) => write!(f, "refused URL: {why}"),
            Self::Network { kept_bytes, detail } => write!(f, "network error after {kept_bytes} bytes: {detail}"),
            Self::BadResponse { kept_bytes, detail } => write!(f, "unexpected server response after {kept_bytes} bytes: {detail}"),
            Self::ChecksumMismatch { expected, actual } => write!(f, "checksum mismatch: expected {expected}, got {actual}"),
            Self::OversizedPartial { bytes } => write!(f, "the unfinished download ({bytes} bytes) is larger than the file"),
            Self::Cancelled { kept_bytes } => write!(f, "cancelled after {kept_bytes} bytes"),
            Self::Io { kept_bytes, detail } => write!(f, "disk error after {kept_bytes} bytes: {detail}"),
        }
    }
}

impl std::error::Error for DownloadError {}

/// Partial files being written right now, so two downloads never append to the same file.
static ACTIVE: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct ActiveGuard(String);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut v) = ACTIVE.lock() {
            v.retain(|p| p != &self.0);
        }
    }
}

/// Download `a` into `store`. On success the file is verified and installed. On any error the state
/// is exactly what the error says: either the partial download is kept for a later, explicit resume,
/// or (checksum mismatch, oversized partial) it has been deleted.
pub fn download(
    store: &Store,
    a: &Artifact,
    mode: Mode,
    policy: &Policy,
    cancel: &AtomicBool,
    progress: impl FnMut(Progress),
) -> Result<(), DownloadError> {
    let part = store.partial_path(a);
    let key = part.to_string_lossy().into_owned();
    let _guard = {
        let mut active = ACTIVE.lock().map_err(|_| DownloadError::Busy)?;
        if active.contains(&key) {
            return Err(DownloadError::Busy);
        }
        active.push(key.clone());
        ActiveGuard(key)
    };
    let result = run(store, a, mode, policy, cancel, progress);
    // A download that failed before receiving a single byte leaves nothing behind: an empty partial
    // file would otherwise present itself as an interrupted download waiting to be resumed.
    if result.is_err() && matches!(store.partial_bytes(a), Ok(Some(0))) {
        let _ = store.discard_partial(a);
    }
    result
}

fn run(
    store: &Store,
    a: &Artifact,
    mode: Mode,
    policy: &Policy,
    cancel: &AtomicBool,
    mut progress: impl FnMut(Progress),
) -> Result<(), DownloadError> {
    let part = store.partial_path(a);
    let io_err = |kept: u64| move |e: io::Error| DownloadError::Io { kept_bytes: kept, detail: e.to_string() };
    if store.installed_path(a).exists() || store.record_path(a).exists() {
        return Err(DownloadError::AlreadyPresent);
    }
    let existing = store.partial_bytes(a).map_err(io_err(0))?;
    match (mode, existing) {
        (Mode::Start, Some(bytes)) => return Err(DownloadError::PartialExists { bytes }),
        (Mode::Resume, None) => return Err(DownloadError::NothingToResume),
        _ => {}
    }
    let mut have = existing.unwrap_or(0);
    if have > a.size {
        store.discard_partial(a).map_err(io_err(0))?;
        return Err(DownloadError::OversizedPartial { bytes: have });
    }
    for s in a.sources {
        check_url(policy, s.url).map_err(DownloadError::UrlRefused)?;
    }
    let source = a.sources.first().ok_or_else(|| DownloadError::UrlRefused("no source".into()))?.url;

    // Space for the rest of the file plus a margin, checked before the first byte is requested.
    let needed = (a.size - have).saturating_add(policy.space_margin);
    if let Some(available) = (policy.space_probe)(store.root()) {
        if available < needed {
            return Err(DownloadError::InsufficientSpace { needed, available });
        }
    }

    // The bytes already on disk are the only resume state; hash them again rather than trust anything.
    let mut hasher = Sha256::new();
    if have > 0 {
        let mut f = fs::File::open(&part).map_err(io_err(have))?;
        let mut buf = vec![0u8; 8 << 20];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(DownloadError::Cancelled { kept_bytes: have });
            }
            let n = f.read(&mut buf).map_err(io_err(have))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }
    let mut out = OpenOptions::new().create(true).append(true).open(&part).map_err(io_err(have))?;
    progress(Progress { done: have, total: a.size });

    let agent = agent(policy);
    let mut current_url: Option<String> = None;
    let mut buf = vec![0u8; 1 << 20];
    #[cfg(test)]
    let mut written_this_run: u64 = 0;
    while have < a.size {
        let to = (have + policy.chunk).min(a.size) - 1;
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            // After a failure, go back to the catalog's URL rather than reuse a resolved one: a
            // signed CDN link may have expired.
            let url = if attempt == 1 { current_url.clone().unwrap_or_else(|| source.to_string()) } else { source.to_string() };
            let resp = match fetch_range(&agent, policy, &url, have, to) {
                Ok(r) => r,
                Err(Fetch::Refused(why)) => return Err(DownloadError::UrlRefused(why)),
                Err(Fetch::Failed(detail)) => {
                    if attempt >= policy.attempts {
                        return Err(DownloadError::Network { kept_bytes: have, detail });
                    }
                    wait(policy, attempt, cancel).map_err(|_| DownloadError::Cancelled { kept_bytes: have })?;
                    continue;
                }
            };
            let (status, content_range, body, final_url) = resp;
            if status != 206 {
                // 5xx is worth another attempt; anything else is a server that cannot continue a file.
                if (500..600).contains(&status) && attempt < policy.attempts {
                    wait(policy, attempt, cancel).map_err(|_| DownloadError::Cancelled { kept_bytes: have })?;
                    continue;
                }
                return Err(DownloadError::BadResponse { kept_bytes: have, detail: format!("status {status} for bytes {have}-{to}") });
            }
            let expected_range = format!("bytes {have}-{to}/{}", a.size);
            if content_range.as_deref() != Some(expected_range.as_str()) {
                return Err(DownloadError::BadResponse {
                    kept_bytes: have,
                    detail: format!("asked for {expected_range}, got {content_range:?}"),
                });
            }
            current_url = Some(final_url);
            let want = to - have + 1;
            // Read at most one byte more than asked for, so an over-long body is detected, not stored.
            let mut reader = body.into_reader().take(want + 1);
            let mut got = 0u64;
            let mut read_failure: Option<String> = None;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    let _ = out.sync_data();
                    return Err(DownloadError::Cancelled { kept_bytes: have + got });
                }
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => {
                        read_failure = Some(e.to_string());
                        break;
                    }
                };
                if got + n as u64 > want {
                    let _ = out.sync_data();
                    return Err(DownloadError::BadResponse { kept_bytes: have + got, detail: "the server sent more than the range".into() });
                }
                #[cfg(test)]
                if let Some(limit) = policy.fault_write_after {
                    if written_this_run + n as u64 > limit {
                        let _ = out.sync_data();
                        return Err(DownloadError::Io { kept_bytes: have + got, detail: "simulated: no space left on device".into() });
                    }
                }
                out.write_all(&buf[..n]).map_err(io_err(have + got))?;
                hasher.update(&buf[..n]);
                got += n as u64;
                #[cfg(test)]
                {
                    written_this_run += n as u64;
                }
            }
            have += got;
            if got == want {
                break;
            }
            // A short chunk: keep what arrived (it is a correct prefix) and ask for the rest.
            if attempt >= policy.attempts {
                let _ = out.sync_data();
                let detail = read_failure.unwrap_or_else(|| format!("the connection closed after {got} of {want} bytes"));
                return Err(DownloadError::Network { kept_bytes: have, detail });
            }
            // The next attempt asks for [have, to]: the same chunk, from where the bytes stopped.
            wait(policy, attempt, cancel).map_err(|_| DownloadError::Cancelled { kept_bytes: have })?;
        }
        out.sync_data().map_err(io_err(have))?;
        progress(Progress { done: have, total: a.size });
    }
    drop(out);

    let actual = hex(&hasher.finalize());
    if actual != a.sha256 {
        let _ = store.discard_partial(a);
        return Err(DownloadError::ChecksumMismatch { expected: a.sha256.to_string(), actual });
    }
    store.install_verified_partial(a, source).map_err(io_err(have))?;
    Ok(())
}

pub(super) enum Fetch {
    Refused(String),
    Failed(String),
}

pub(super) type Fetched = (u16, Option<String>, ureq::Body, String);

/// One ranged GET, following redirects by hand so that every hop is checked.
pub(super) fn fetch_range(agent: &ureq::Agent, policy: &Policy, url: &str, from: u64, to: u64) -> Result<Fetched, Fetch> {
    let mut cur = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        check_url(policy, &cur).map_err(Fetch::Refused)?;
        let resp = agent
            .get(&cur)
            .header("Range", format!("bytes={from}-{to}"))
            .call()
            .map_err(|e| Fetch::Failed(e.to_string()))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            let next = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| Fetch::Failed(format!("redirect {status} without a location")))?;
            cur = next.to_string();
            continue;
        }
        let content_range = resp.headers().get("content-range").and_then(|v| v.to_str().ok()).map(str::to_string);
        return Ok((status, content_range, resp.into_body(), cur));
    }
    Err(Fetch::Failed("too many redirects".into()))
}

/// Accept a URL only if it is absolute HTTPS on the default port, carries no user information, and
/// names an allowed host or one of its subdomains.
pub fn check_url(policy: &Policy, url: &str) -> Result<(), String> {
    let uri: ureq::http::Uri = url.parse().map_err(|_| format!("not a URL: {}", redact(url)))?;
    let auth = uri.authority().ok_or_else(|| format!("no host: {}", redact(url)))?;
    if auth.as_str().contains('@') {
        return Err(format!("user information is not allowed: {}", redact(url)));
    }
    let host = auth.host().to_ascii_lowercase();
    match uri.scheme_str() {
        Some("https") => {
            if auth.port_u16().is_some_and(|p| p != 443) {
                return Err(format!("non-default port: {}", redact(url)));
            }
        }
        Some("http") if policy.allow_plain_http_loopback && host == "127.0.0.1" => {}
        _ => return Err(format!("only HTTPS is allowed: {}", redact(url))),
    }
    let allowed = policy.allowed_hosts.iter().any(|a| host == *a || host.ends_with(&format!(".{a}")));
    if allowed {
        Ok(())
    } else {
        Err(format!("host not allowed: {host}"))
    }
}

/// A URL without its query string, for messages: signed CDN links carry credentials in the query.
fn redact(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

pub(super) fn agent(policy: &Policy) -> ureq::Agent {
    // The same TLS set-up as the read-aloud client: rustls on aws-lc-rs, roots from the platform.
    let crypto = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::Rustls)
        .unversioned_rustls_crypto_provider(crypto)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .max_redirects(0)
        .http_status_as_error(false)
        .accept_encoding(ureq::config::AutoHeaderValue::None)
        .user_agent("Sard")
        .timeout_connect(Some(policy.connect_timeout))
        .timeout_recv_response(Some(policy.response_timeout))
        .timeout_recv_body(Some(policy.chunk_timeout))
        .build()
        .into()
}

/// Sleep before the next attempt, in short steps so a cancel is noticed promptly.
fn wait(policy: &Policy, attempt: u32, cancel: &AtomicBool) -> Result<(), ()> {
    let d = policy
        .backoff
        .get(attempt.saturating_sub(1) as usize)
        .or(policy.backoff.last())
        .copied()
        .unwrap_or_default();
    let step = Duration::from_millis(50);
    let mut slept = Duration::ZERO;
    while slept < d {
        if cancel.load(Ordering::Relaxed) {
            return Err(());
        }
        std::thread::sleep(step.min(d - slept));
        slept += step;
    }
    if cancel.load(Ordering::Relaxed) {
        Err(())
    } else {
        Ok(())
    }
}

/// Free bytes available to this user on the volume holding `dir`, where the platform can say.
#[cfg(windows)]
pub fn available_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call, and `free` is a valid u64.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

/// Not measured on this platform yet: the check is skipped, and a full disk surfaces as a write error
/// with the partial download kept.
#[cfg(not(windows))]
pub fn available_space(_dir: &Path) -> Option<u64> {
    None
}
