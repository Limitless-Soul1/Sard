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
//!
//! ## The partial file is opened as itself, and proved to be the store's own
//!
//! Every byte a download writes goes to `partial/<id>.part`. A link left at that name must never be
//! written through — it would put the downloaded bytes in some other file — and checking the path and
//! then opening it is not enough, because the name can change in between. So:
//!
//! * **A new download** removes whatever has the name, as a NAME (which never follows a link), and then
//!   creates the file new. Creation fails, rather than open anything, if something is there again.
//! * **A resumed download** opens what is there without following a link.
//! * **In both cases the open handle is then examined — not the path a second time.** It must be a plain
//!   file, with no other name anywhere (a hard link would share its bytes with a file elsewhere), at
//!   exactly the expected place. That one handle is the file whose bytes are hashed and the file the new
//!   bytes are appended to.
//! * On Windows the handle also keeps the file from being replaced, renamed or deleted, and the folders
//!   above it from being renamed, for as long as the download holds it.
//!
//! What cannot be proved is refused with `DownloadError::UnsafePartial`, before anything is requested
//! and before anything is written.
//!
//! Three limits remain:
//!
//! * Elsewhere than Windows, nothing can hold a file against being renamed, and a handle cannot be asked
//!   where it is. The proof there is that the handle is the very file the name leads to, that the file
//!   has one name, and that the path has no link in it. A folder redirected at the last moment can leave
//!   an empty file where it led; nothing is written to it.
//! * Once the download lets go of the file to move it into place, the store's check of that move is by
//!   path again.
//! * A file Windows has marked with a reparse point for some other reason — a cloud-sync placeholder,
//!   say — is refused like a link. The translation directory is not somewhere that happens.

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
    /// Run at the last moment before the partial file is created or opened: its name has been looked at
    /// (and, for a new download, cleared). A test uses it to change what is there in between.
    #[cfg(test)]
    pub(crate) before_open: Option<TestHook>,
    /// Run once the partial file is open and proved, before the first byte is asked for.
    #[cfg(test)]
    pub(crate) after_open: Option<TestHook>,
}

#[cfg(test)]
pub(crate) type TestHook = std::sync::Arc<dyn Fn() + Send + Sync>;

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
            #[cfg(test)]
            before_open: None,
            #[cfg(test)]
            after_open: None,
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
            before_open: None,
            after_open: None,
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
    /// What has the unfinished download's name is not a plain file of the store's own — a link, a
    /// folder, a file that also has a name somewhere else, or something in a folder that has been
    /// redirected. Nothing was requested and nothing was written. Discarding the unfinished download
    /// removes a link or an extra name without touching what it leads to; a folder there, or a
    /// redirected folder above it, has to be put right by hand.
    UnsafePartial { detail: String },
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
            Self::UnsafePartial { detail } => write!(f, "the unfinished download cannot be used safely: {detail}"),
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
    // file would otherwise present itself as an interrupted download waiting to be resumed. Only a
    // plain, empty file is that. A link with the name is not this download's to clear: a refusal
    // changes nothing.
    if result.is_err() && matches!(named(&part), Ok(Named::File(0))) {
        let _ = store.discard_partial(a);
    }
    result
}

/// What has a name, looked at without following a link.
enum Named {
    Nothing,
    /// A plain file, and its length.
    File(u64),
    Folder,
    /// A link of any kind, or anything else that is neither a plain file nor a folder.
    Other,
}

fn named(path: &Path) -> io::Result<Named> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Named::Nothing),
        Err(e) => Err(e),
        Ok(m) if m.file_type().is_file() => Ok(Named::File(m.len())),
        Ok(m) if m.is_dir() => Ok(Named::Folder),
        Ok(_) => Ok(Named::Other),
    }
}

fn unsafe_partial(detail: impl Into<String>) -> DownloadError {
    DownloadError::UnsafePartial { detail: detail.into() }
}

/// Create the partial file of a new download: a new file, never one that was already there, and never
/// anything a link leads to.
fn create_partial(part: &Path, policy: &Policy) -> Result<fs::File, DownloadError> {
    #[cfg(not(test))]
    let _ = policy;
    // The folder it goes in must be the store's own. (The store resolved its root when it was opened,
    // so a path that resolves to anything but itself has a link in it.)
    let folder = part.parent().unwrap_or(part);
    match fs::canonicalize(folder) {
        Ok(resolved) if resolved == folder => {}
        Ok(_) => return Err(unsafe_partial("the folder for unfinished downloads has been redirected")),
        Err(e) => return Err(DownloadError::Io { kept_bytes: 0, detail: e.to_string() }),
    }
    match named(part).map_err(|e| DownloadError::Io { kept_bytes: 0, detail: e.to_string() })? {
        Named::Nothing => {}
        // An unfinished download is never started over on its own account.
        Named::File(bytes) => return Err(DownloadError::PartialExists { bytes }),
        // Not the store's: it never puts a folder there, and what is in one is not its to delete.
        Named::Folder => return Err(unsafe_partial("a folder has its name")),
        // A link, or something stranger: the NAME goes. What a link leads to is not touched.
        Named::Other => remove_name(part).map_err(|e| unsafe_partial(format!("what has its name could not be removed: {e}")))?,
    }
    #[cfg(test)]
    if let Some(hook) = &policy.before_open {
        hook();
    }
    let file = open_new(part).map_err(|e| match e.kind() {
        io::ErrorKind::AlreadyExists => unsafe_partial("something took its name while it was being created"),
        _ => DownloadError::Io { kept_bytes: 0, detail: e.to_string() },
    })?;
    // The name has been dealt with; the folders above it could still have been redirected in the
    // moment before the file was created. The handle says where the file really is.
    match prove_own(&file, part, PARTIAL_PLACE) {
        Ok(_) => Ok(file),
        Err(why) => {
            delete_created(file);
            Err(unsafe_partial(why))
        }
    }
}

/// Open the partial file of an unfinished download, as itself, and prove it is the store's own. Returns
/// the handle — the one that is hashed and appended to — and the file's length.
fn open_partial_to_resume(part: &Path, policy: &Policy) -> Result<(fs::File, u64), DownloadError> {
    #[cfg(not(test))]
    let _ = policy;
    let bytes = match named(part).map_err(|e| DownloadError::Io { kept_bytes: 0, detail: e.to_string() })? {
        Named::Nothing => return Err(DownloadError::NothingToResume),
        Named::Folder => return Err(unsafe_partial("a folder has its name")),
        Named::Other => return Err(unsafe_partial("a link, or something else that is not a file, has its name")),
        Named::File(bytes) => bytes,
    };
    #[cfg(test)]
    if let Some(hook) = &policy.before_open {
        hook();
    }
    // What was just looked at may no longer be what has the name. Nothing above is relied on: the file
    // is opened without following a link, and everything is then read from the handle.
    let file = match open_existing(part) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(DownloadError::NothingToResume),
        Err(e) => return Err(DownloadError::Io { kept_bytes: bytes, detail: e.to_string() }),
    };
    let len = prove_own(&file, part, PARTIAL_PLACE).map_err(unsafe_partial)?;
    Ok((file, len))
}

/// Remove whatever has this name — the name itself, never what a link there leads to.
fn remove_name(path: &Path) -> io::Result<()> {
    fs::remove_file(path).or_else(|_| fs::remove_dir(path))
}

/// Create `path` as a new file, or fail: nothing that already has the name is ever opened.
fn open_new(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    // "New" is what `delete_created` relies on: a file this call returns did not exist before it.
    options.append(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_WRITE, FILE_WRITE_DATA};
        // What appending needs, and the right to delete — used only to take back a file that turns out
        // to have been created somewhere it should not be.
        options.access_mode((FILE_GENERIC_WRITE.0 & !FILE_WRITE_DATA.0) | DELETE.0);
    }
    hold(&mut options);
    options.open(path)
}

fn open_existing(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true).append(true);
    hold(&mut options);
    options.open(path)
}

/// On Windows: open the name itself, never what a link there leads to, and let no one else write to,
/// delete or rename the file while this handle is open. Reading it stays allowed.
#[cfg(windows)]
fn hold(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};
    options.share_mode(FILE_SHARE_READ.0).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
}

/// Elsewhere there is nothing to add: creating a file new never follows a link, and a file that is
/// opened is proved afterwards to be the one that has the name.
#[cfg(not(windows))]
fn hold(_options: &mut OpenOptions) {}

const NOT_A_PLAIN_FILE: &str = "it is a link or a folder, not a plain file";
const HAS_ANOTHER_NAME: &str = "the file also has a name somewhere else";
/// Where an unfinished download must be, as `prove_own` names it when it is not there.
const PARTIAL_PLACE: &str = "the folder for unfinished downloads";

fn not_in_its_place(place: &str) -> String {
    format!("it is not in {place}")
}

/// Prove, from the open handle, that this is a plain file with no other name, at exactly `expected` — which
/// is in `place`, as the reason names it otherwise. Returns its length. (Also how the engine's launch proves
/// the model it holds.)
#[cfg(windows)]
pub(crate) fn prove_own(file: &fs::File, expected: &Path, place: &str) -> Result<u64, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_NAME_NORMALIZED,
    };
    let handle = HANDLE(file.as_raw_handle());
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is open for as long as `file` is borrowed, and `info` is the structure the call fills.
    unsafe { GetFileInformationByHandle(handle, &mut info) }.map_err(|e| e.to_string())?;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0) != 0 {
        return Err(NOT_A_PLAIN_FILE.into());
    }
    if info.nNumberOfLinks != 1 {
        return Err(HAS_ANOTHER_NAME.into());
    }
    // Where the file really is, in the same resolved form the store's root is kept in.
    let mut name = vec![0u16; 512];
    let actual = loop {
        // SAFETY: the buffer is valid for its whole length, which is what the call is given.
        let n = unsafe { GetFinalPathNameByHandleW(handle, &mut name, FILE_NAME_NORMALIZED) } as usize;
        if n == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        if n < name.len() {
            break std::path::PathBuf::from(std::ffi::OsString::from_wide(&name[..n]));
        }
        name.resize(n + 1, 0);
    };
    if actual != expected {
        return Err(not_in_its_place(place));
    }
    Ok((u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow))
}

/// Prove that this handle is the very file `expected` names: a plain file, the same one, with no other
/// name, at a path with no link in it. Returns its length.
#[cfg(unix)]
pub(crate) fn prove_own(file: &fs::File, expected: &Path, place: &str) -> Result<u64, String> {
    use std::os::unix::fs::MetadataExt;
    let held = file.metadata().map_err(|e| e.to_string())?;
    let at_the_name = fs::symlink_metadata(expected).map_err(|e| e.to_string())?;
    if !held.file_type().is_file() || !at_the_name.file_type().is_file() {
        return Err(NOT_A_PLAIN_FILE.into());
    }
    if (held.dev(), held.ino()) != (at_the_name.dev(), at_the_name.ino()) {
        return Err("it is not the file that has its name".into());
    }
    if held.nlink() != 1 {
        return Err(HAS_ANOTHER_NAME.into());
    }
    if !fs::canonicalize(expected).is_ok_and(|resolved| resolved == expected) {
        return Err(not_in_its_place(place));
    }
    Ok(held.len())
}

/// Nothing is known here about how to prove it, so nothing is accepted.
#[cfg(not(any(windows, unix)))]
pub(crate) fn prove_own(_file: &fs::File, _expected: &Path, _place: &str) -> Result<u64, String> {
    Err("unfinished downloads cannot be checked on this platform".into())
}

/// Take back a file this download created a moment ago (`open_new`) and found to be somewhere it should
/// not be. It is empty: nothing has been written to it. Deleted through its own handle where that is
/// possible, so that no path — which is what cannot be trusted at this point — is used to find it.
fn delete_created(file: fs::File) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO};
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the handle is open, with the right to delete; `info` is the structure this class takes.
        let _ = unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                &info as *const FILE_DISPOSITION_INFO as *const core::ffi::c_void,
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
    }
    drop(file);
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
    // An unfinished download that is being resumed is opened here, once, as itself. This handle is what
    // is measured, hashed and appended to: nothing below goes back to the path.
    let resumed = match mode {
        Mode::Start => {
            if let Named::File(bytes) = named(&part).map_err(io_err(0))? {
                return Err(DownloadError::PartialExists { bytes });
            }
            None
        }
        Mode::Resume => Some(open_partial_to_resume(&part, policy)?),
    };
    let mut have = resumed.as_ref().map_or(0, |(_, bytes)| *bytes);
    if have > a.size {
        // It has to be let go of before it can be deleted.
        drop(resumed);
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
    let mut out = match resumed {
        Some((mut file, _)) => {
            let mut buf = vec![0u8; 8 << 20];
            let mut hashed = 0u64;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(DownloadError::Cancelled { kept_bytes: have });
                }
                let n = file.read(&mut buf).map_err(io_err(have))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                hashed += n as u64;
            }
            // The hash has to cover exactly the bytes the next request continues from.
            if hashed != have {
                return Err(DownloadError::Io { kept_bytes: hashed, detail: "the unfinished download changed while it was being read".into() });
            }
            file
        }
        None => create_partial(&part, policy)?,
    };
    #[cfg(test)]
    if let Some(hook) = &policy.after_open {
        hook();
    }
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
