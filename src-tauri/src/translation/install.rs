//! Installing the inference engine from its verified runtime archive.
//!
//! ## What gets installed
//!
//! Exactly the files the engine spec lists — never "the archive" — into
//! `<root>/runtime/<id>/engine/`, plus the licence notices the build declares. Nothing else from the archive is
//! extracted. That matters beyond tidiness: ggml loads every backend library it finds next to the executable,
//! so a stray file in that directory is code the engine will run.
//!
//! ## How an installation is made trustworthy
//!
//! 1. The archive must already be installed by the verified download (S1). It is hashed again here, because
//!    nothing on disk is trusted between two steps.
//! 2. The archive's central directory is read directly — not through the zip library, which keys entries by
//!    name and so silently collapses duplicates — and the WHOLE archive is refused if any entry is unsafe:
//!    * a path, a drive or stream separator, or a control character;
//!    * a trailing dot or space, which Windows drops, so two different names would land on one file;
//!    * a reserved device name;
//!    * a link, a directory, or anything else that is not a plain file;
//!    * a duplicate, including a duplicate that differs only by case;
//!    * an entry the engine spec does not name, whether as a file to install or as one knowingly left out.
//! 3. Each listed file must be a plain file (not a link) of the pinned size. It is streamed into a fresh
//!    staging directory, through SHA-256, and compared with the pinned digest.
//! 4. Only when every file has matched: the old engine directory (if any) is moved aside, the staging
//!    directory takes its place, and the record is written LAST. A crash at any earlier point leaves a
//!    staging directory, which is never used and is cleared by the next installation, or a directory without
//!    a record (`Unverified`), which is never launched until it has been hashed again.
//!
//! ## What a deletion can reach
//!
//! This module deletes three kinds of thing: its record, a leftover of an unfinished installation, and the
//! engine directory. Each is a fixed name inside `<root>/runtime/<id>/`, and before anything is deleted that
//! path must resolve to exactly itself — which a link, a junction or any other redirection, at any level
//! above it, would prevent. Inside a directory being deleted, only plain files are removed, by name; a
//! subdirectory, a link or any other reparse point there stops the deletion instead of being followed.
//! Removing a name never follows a link, so the most a planted link can lose is itself.
//!
//! These are checks and then actions, not one atomic step. A program running as the same Windows user could
//! change a folder between the two — and could also simply delete the user's files itself. Nothing here runs
//! with more rights than the user has, so there is no boundary for such a program to cross.
//!
//! ## Between hashing and launching
//!
//! `verify` holds every file open from before it is hashed for as long as the caller keeps the result. On
//! Windows nothing can then write to, delete, rename or replace those files, or rename a folder above them,
//! whichever user tries: what was hashed is what gets loaded. A file ADDED to the directory is not prevented —
//! the directory belongs to the user, and any program of theirs may write there — so the caller checks the
//! directory's exact contents again (`check_unchanged`) at the last moment before the engine runs, and once
//! more before it is used.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::catalog::EngineSpec;
use super::slot::{self, Holder};
use super::store::{hex, random_hex, State as ArtifactState, Store};

pub const ENGINE_DIR: &str = "engine";
pub const ENGINE_RECORD: &str = "engine.json";
const STAGING_PREFIX: &str = ".staging-";
const OLD_PREFIX: &str = ".old-";
/// `FILE_ATTRIBUTE_REPARSE_POINT`: symbolic links, junctions and other redirections.
#[cfg(windows)]
const REPARSE_POINT: u32 = 0x400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// The runtime archive has not been downloaded and verified yet.
    ArchiveNotInstalled,
    /// The archive on disk is no longer the verified one.
    ArchiveChanged { expected: String, actual: String },
    UnreadableArchive(String),
    /// An entry anywhere in the archive is unsafe; the whole archive is refused.
    UnsafeEntry(String),
    DuplicateEntry(String),
    /// An entry that is neither installed nor known to be in this archive.
    UnexpectedEntry(String),
    MissingFile(String),
    NotAPlainFile(String),
    WrongSize { name: String, expected: u64, actual: u64 },
    WrongChecksum { name: String },
    /// The installed engine directory holds something that is not part of the engine.
    UnexpectedFile(String),
    /// A path resolves outside the translation directory, or through a link.
    PathRefused(String),
    /// The record is missing, unreadable, or describes another version of the engine.
    NotRecorded(String),
    /// The engine is running, or another installation is in progress.
    EngineBusy,
    Cancelled,
    Io(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ArchiveNotInstalled => write!(f, "the engine archive has not been downloaded"),
            Self::ArchiveChanged { expected, actual } => write!(f, "the engine archive changed: expected {expected}, found {actual}"),
            Self::UnreadableArchive(why) => write!(f, "the engine archive cannot be read: {why}"),
            Self::UnsafeEntry(name) => write!(f, "the engine archive contains an unsafe entry: {name:?}"),
            Self::DuplicateEntry(name) => write!(f, "the engine archive contains {name:?} more than once"),
            Self::UnexpectedEntry(name) => write!(f, "the engine archive contains an entry this version of Sard does not know: {name:?}"),
            Self::MissingFile(name) => write!(f, "the engine archive lacks {name}"),
            Self::NotAPlainFile(name) => write!(f, "{name} is not a plain file"),
            Self::WrongSize { name, expected, actual } => write!(f, "{name} is {actual} bytes, expected {expected}"),
            Self::WrongChecksum { name } => write!(f, "{name} does not match its pinned checksum"),
            Self::UnexpectedFile(name) => write!(f, "the engine directory contains something that is not part of the engine: {name:?}"),
            Self::PathRefused(why) => write!(f, "refused: {why}"),
            Self::NotRecorded(why) => write!(f, "the engine installation is not recorded: {why}"),
            Self::EngineBusy => write!(f, "the engine is in use"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Io(why) => write!(f, "disk error: {why}"),
        }
    }
}

impl std::error::Error for InstallError {}

fn io_err(e: io::Error) -> InstallError {
    InstallError::Io(e.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    NotInstalled,
    Installed,
    /// Files are present without a record; they are not used until `verify_installation` has hashed them.
    Unverified,
    Damaged { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct EngineRecord {
    archive_sha256: String,
    manifest_sha256: String,
    files: usize,
    installed_at_unix: u64,
}

/// An engine whose every file was hashed and matched just now — and is held open, so that it stays so.
///
/// One handle per file is kept for as long as this value lives. On Windows each handle denies writing,
/// deleting and renaming to every other handle, whoever opens it, and the folders above a held file cannot be
/// renamed either. So from the moment a file is hashed, what is on disk is what was hashed. What a held file
/// does NOT prevent is a new file being added beside it; `check_unchanged` looks for that.
#[derive(Debug)]
pub struct VerifiedEngine {
    pub dir: PathBuf,
    pub executable: PathBuf,
    held: Vec<fs::File>,
}

impl VerifiedEngine {
    /// How many files are held open.
    pub fn held(&self) -> usize {
        self.held.len()
    }
}

pub fn engine_dir(store: &Store, spec: &EngineSpec) -> PathBuf {
    store.artifact_dir(spec.archive).join(ENGINE_DIR)
}

fn record_path(store: &Store, spec: &EngineSpec) -> PathBuf {
    store.artifact_dir(spec.archive).join(ENGINE_RECORD)
}

/// Every file the engine directory must hold — the listed files and the notices — as (name, size, sha256).
fn expected_files(spec: &EngineSpec) -> Vec<(String, u64, String)> {
    let mut v: Vec<_> = spec.files.iter().map(|f| (f.name.to_string(), f.size, f.sha256.to_string())).collect();
    v.push((spec.notices_name.to_string(), spec.notices.len() as u64, hex(&Sha256::digest(spec.notices.as_bytes()))));
    v
}

/// A digest of the whole expected file set, so a record written for another engine version is recognised.
fn manifest_sha256(spec: &EngineSpec) -> String {
    let mut h = Sha256::new();
    h.update(spec.archive.sha256.as_bytes());
    for (name, size, sha) in expected_files(spec) {
        h.update(format!("{name}\t{size}\t{sha}\n").as_bytes());
    }
    hex(&h.finalize())
}

/// Fault injection for tests: stop the installation as a crash would, leaving whatever is on disk.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Faults {
    pub crash_after_files: Option<usize>,
    /// After the old engine has been moved aside, before the new one has taken its place.
    pub crash_between_moves: bool,
    pub crash_before_record: bool,
}

/// Install the engine from its verified archive. `cancel` is checked between files.
pub fn install(store: &Store, spec: &EngineSpec, cancel: &AtomicBool) -> Result<(), InstallError> {
    install_with(store, spec, cancel, Faults::default())
}

pub(crate) fn install_with(store: &Store, spec: &EngineSpec, cancel: &AtomicBool, faults: Faults) -> Result<(), InstallError> {
    let _slot = slot::claim(Holder::Install).map_err(|_| InstallError::EngineBusy)?;

    if store.state(spec.archive).map_err(io_err)? != ArtifactState::Installed {
        return Err(InstallError::ArchiveNotInstalled);
    }
    let base = store.artifact_dir(spec.archive);
    let archive_path = store.installed_path(spec.archive);
    guard_exact(store, &base)?;
    guard_exact(store, &archive_path)?;
    let bytes = fs::read(&archive_path).map_err(io_err)?;
    let actual = hex(&Sha256::digest(&bytes));
    if actual != spec.archive.sha256 {
        return Err(InstallError::ArchiveChanged { expected: spec.archive.sha256.to_string(), actual });
    }

    let names = central_directory_names(&bytes)?;
    let mut seen = HashSet::new();
    for name in &names {
        check_entry_name(name)?;
        if !seen.insert(name.to_lowercase()) {
            return Err(InstallError::DuplicateEntry(name.clone()));
        }
        if !spec.files.iter().any(|f| f.name == name) && !spec.unused.contains(&name.as_str()) {
            return Err(InstallError::UnexpectedEntry(name.clone()));
        }
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(&bytes[..])).map_err(|e| InstallError::UnreadableArchive(e.to_string()))?;
    // The entries were checked as read here; the files are extracted through the zip library. Both must have
    // read the same archive.
    if zip.len() != names.len() || names.iter().any(|n| zip.index_for_name(n).is_none()) {
        return Err(InstallError::UnreadableArchive("the central directory and the archive disagree on the entries".into()));
    }

    clear_leftovers(store, &base)?;
    let staging = base.join(format!("{STAGING_PREFIX}{}", random_hex(8).map_err(io_err)?));
    fs::create_dir(&staging).map_err(io_err)?;
    match stage(spec, &mut zip, &staging, cancel, faults) {
        Ok(()) => {}
        Err(StageEnd::Crash) => return Err(InstallError::Io("simulated crash during extraction".into())),
        Err(StageEnd::Error(e)) => {
            let _ = remove_tree(store, &staging);
            return Err(e);
        }
    }

    // Swap: unrecord the old engine, move it aside, move the new one in, and only then record it.
    remove_name(&record_path(store, spec))?;
    let dir = engine_dir(store, spec);
    let mut old = None;
    if fs::symlink_metadata(&dir).is_ok() {
        check_not_link(&dir)?;
        guard_exact(store, &dir)?;
        let aside = base.join(format!("{OLD_PREFIX}{}", random_hex(8).map_err(io_err)?));
        fs::rename(&dir, &aside).map_err(io_err)?;
        old = Some(aside);
    }
    if faults.crash_between_moves {
        return Err(InstallError::Io("simulated crash between the two moves".into()));
    }
    fs::rename(&staging, &dir).map_err(io_err)?;
    if faults.crash_before_record {
        return Err(InstallError::Io("simulated crash before the record".into()));
    }
    write_record(store, spec)?;
    if let Some(old) = old {
        remove_tree(store, &old)?;
    }
    Ok(())
}

enum StageEnd {
    Error(InstallError),
    Crash,
}

impl From<InstallError> for StageEnd {
    fn from(e: InstallError) -> Self {
        StageEnd::Error(e)
    }
}

fn stage(
    spec: &EngineSpec,
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    staging: &Path,
    cancel: &AtomicBool,
    faults: Faults,
) -> Result<(), StageEnd> {
    for (n, file) in spec.files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(InstallError::Cancelled.into());
        }
        if faults.crash_after_files == Some(n) {
            return Err(StageEnd::Crash);
        }
        let index = zip.index_for_name(file.name).ok_or_else(|| InstallError::MissingFile(file.name.into()))?;
        let mut entry = zip.by_index(index).map_err(|e| InstallError::UnreadableArchive(e.to_string()))?;
        if !entry.is_file() || entry.is_symlink() {
            return Err(InstallError::NotAPlainFile(file.name.into()).into());
        }
        if entry.size() != file.size {
            return Err(InstallError::WrongSize { name: file.name.into(), expected: file.size, actual: entry.size() }.into());
        }
        let mut out = OpenOptions::new().write(true).create_new(true).open(staging.join(file.name)).map_err(io_err)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut total = 0u64;
        // One byte past the pinned size is enough to know a stream is too long; nothing more is read.
        let mut limited = (&mut entry).take(file.size + 1);
        loop {
            let got = limited.read(&mut buf).map_err(|e| InstallError::UnreadableArchive(e.to_string()))?;
            if got == 0 {
                break;
            }
            total += got as u64;
            if total > file.size {
                return Err(InstallError::WrongSize { name: file.name.into(), expected: file.size, actual: total }.into());
            }
            hasher.update(&buf[..got]);
            out.write_all(&buf[..got]).map_err(io_err)?;
        }
        out.sync_all().map_err(io_err)?;
        if total != file.size {
            return Err(InstallError::WrongSize { name: file.name.into(), expected: file.size, actual: total }.into());
        }
        if hex(&hasher.finalize()) != file.sha256 {
            return Err(InstallError::WrongChecksum { name: file.name.into() }.into());
        }
    }
    let mut notices = OpenOptions::new().write(true).create_new(true).open(staging.join(spec.notices_name)).map_err(io_err)?;
    notices.write_all(spec.notices.as_bytes()).map_err(io_err)?;
    notices.sync_all().map_err(io_err)?;
    Ok(())
}

fn write_record(store: &Store, spec: &EngineSpec) -> Result<(), InstallError> {
    let record = EngineRecord {
        archive_sha256: spec.archive.sha256.to_string(),
        manifest_sha256: manifest_sha256(spec),
        files: expected_files(spec).len(),
        installed_at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let bytes = serde_json::to_vec_pretty(&record).map_err(|e| InstallError::Io(e.to_string()))?;
    let path = record_path(store, spec);
    let tmp = path.with_extension("json.tmp");
    // Never through a link. Whatever already has the temporary name is removed as a NAME (a link is not
    // followed), the file is created new (which fails rather than open anything that reappears), and the
    // rename replaces the record's own name, not what a link there might point to.
    remove_name(&tmp)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io_err)?;
    file.write_all(&bytes).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    drop(file);
    fs::rename(&tmp, &path).map_err(io_err)
}

/// Remove one name from a directory this module manages. Removing a name never follows a link: if the name
/// is a link, the link goes and its target is untouched. A name that is not there is not an error.
fn remove_name(path: &Path) -> Result<(), InstallError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

/// Refuse `path` unless it is exactly where it appears to be.
///
/// The store's root is fully resolved, and every path in this module is built from it with plain names. So a
/// path that no link, junction or other redirection touches — at ANY level — resolves to itself. Anything
/// else is refused: a redirection to somewhere outside the translation directory, and equally one to
/// somewhere else inside it.
fn guard_exact(store: &Store, path: &Path) -> Result<(), InstallError> {
    store.guard_existing(path).map_err(|e| InstallError::PathRefused(e.to_string()))?;
    let resolved = fs::canonicalize(path).map_err(io_err)?;
    if resolved != path {
        return Err(InstallError::PathRefused(format!("{} is reached through a link", path.display())));
    }
    Ok(())
}

fn read_record(store: &Store, spec: &EngineSpec) -> Result<EngineRecord, InstallError> {
    let path = record_path(store, spec);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(InstallError::NotRecorded("no record".into())),
        Err(e) => return Err(io_err(e)),
    };
    let record: EngineRecord = serde_json::from_slice(&bytes).map_err(|_| InstallError::NotRecorded("the record cannot be read".into()))?;
    if record.manifest_sha256 != manifest_sha256(spec) {
        return Err(InstallError::NotRecorded("the record describes another version of the engine".into()));
    }
    Ok(record)
}

/// The engine's state from metadata only: the record, and the names and sizes of the files.
pub fn state(store: &Store, spec: &EngineSpec) -> io::Result<EngineState> {
    let dir = engine_dir(store, spec);
    let dir_exists = fs::symlink_metadata(&dir).is_ok();
    match read_record(store, spec) {
        Ok(_) => Ok(match listing_problem(&dir, spec, false) {
            None => EngineState::Installed,
            Some(reason) => EngineState::Damaged { reason },
        }),
        Err(InstallError::NotRecorded(why)) if why == "no record" => {
            Ok(if dir_exists { EngineState::Unverified } else { EngineState::NotInstalled })
        }
        Err(InstallError::NotRecorded(why)) => Ok(EngineState::Damaged { reason: why }),
        Err(InstallError::Io(e)) => Err(io::Error::other(e)),
        Err(other) => Ok(EngineState::Damaged { reason: other.to_string() }),
    }
}

/// Check the installed engine in full — the record, the exact set of files, no links, every size and every
/// SHA-256 — and return where it is, with every file held open. This runs before every launch.
///
/// Each file is opened first and hashed through that same handle, so what is hashed is what is held; a file
/// that a writer already has open cannot be held at all, and is refused.
pub fn verify(store: &Store, spec: &EngineSpec) -> Result<VerifiedEngine, InstallError> {
    read_record(store, spec)?;
    let dir = engine_dir(store, spec);
    check_not_link(&dir)?;
    guard_exact(store, &dir)?;
    if let Some(reason) = listing_problem(&dir, spec, true) {
        return Err(InstallError::UnexpectedFile(reason));
    }
    let mut held = Vec::new();
    for (name, size, sha) in expected_files(spec) {
        let mut file = open_held(&dir.join(&name)).map_err(io_err)?;
        // Of the handle, not of the path: this is the file that is held.
        let meta = file.metadata().map_err(io_err)?;
        if !meta.is_file() || is_link(&meta) {
            return Err(InstallError::UnexpectedFile(format!("{name} is not a plain file")));
        }
        let (len, digest) = hash_open(&mut file).map_err(io_err)?;
        if len != size {
            return Err(InstallError::WrongSize { name, expected: size, actual: len });
        }
        if digest != sha {
            return Err(InstallError::WrongChecksum { name });
        }
        held.push(file);
    }
    Ok(VerifiedEngine { executable: dir.join(spec.executable), dir, held })
}

/// Whether the engine directory still holds exactly the engine's files, by name, size and kind — without
/// hashing them again. While a `VerifiedEngine` holds the files their contents cannot change, so what is left
/// to look for is something ADDED: the engine loads every backend library it finds beside itself.
pub fn check_unchanged(store: &Store, spec: &EngineSpec) -> Result<(), InstallError> {
    let dir = engine_dir(store, spec);
    check_not_link(&dir)?;
    guard_exact(store, &dir)?;
    match listing_problem(&dir, spec, true) {
        None => Ok(()),
        Some(reason) => Err(InstallError::UnexpectedFile(reason)),
    }
}

/// Open a file to hold it: for reading, and — on Windows — sharing it for reading only.
///
/// * No other handle can then open it for writing, delete it, or rename it or any folder above it.
/// * The open itself fails if some handle already has it open for writing.
/// * A link is opened as itself rather than followed, so the caller's check of the handle sees it.
///
/// The engine's files are held this way by `verify`, and the model by the engine's launch.
pub(crate) fn open_held(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

/// SHA-256 and length of an open file, read from its start.
fn hash_open(file: &mut fs::File) -> io::Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok((len, hex(&hasher.finalize())))
}

/// For an `Unverified` or `Damaged` engine: hash it; record it if it matches, or remove it if it does not.
pub fn verify_installation(store: &Store, spec: &EngineSpec) -> Result<EngineState, InstallError> {
    let _slot = slot::claim(Holder::Install).map_err(|_| InstallError::EngineBusy)?;
    let dir = engine_dir(store, spec);
    if fs::symlink_metadata(&dir).is_err() {
        return Ok(EngineState::NotInstalled);
    }
    check_not_link(&dir)?;
    guard_exact(store, &dir)?;
    let complete = listing_problem(&dir, spec, true).is_none()
        && expected_files(spec).iter().all(|(name, size, sha)| matches!(hash_path(&dir.join(name)), Ok((l, d)) if l == *size && d == *sha));
    if complete {
        write_record(store, spec)?;
        Ok(EngineState::Installed)
    } else {
        remove_name(&record_path(store, spec))?;
        remove_tree(store, &dir)?;
        Ok(EngineState::NotInstalled)
    }
}

/// Remove the installed engine (not the downloaded archive). Returns the bytes freed.
pub fn remove(store: &Store, spec: &EngineSpec) -> Result<u64, InstallError> {
    let _slot = slot::claim(Holder::Install).map_err(|_| InstallError::EngineBusy)?;
    let base = store.artifact_dir(spec.archive);
    if fs::symlink_metadata(&base).is_err() {
        return Ok(0);
    }
    guard_exact(store, &base)?;
    remove_name(&record_path(store, spec))?;
    let dir = engine_dir(store, spec);
    if fs::symlink_metadata(&dir).is_err() {
        return Ok(0);
    }
    remove_tree(store, &dir)
}

/// `None` if the directory holds exactly the expected names (and, with `strict`, nothing that is not a plain
/// file); otherwise what is wrong.
fn listing_problem(dir: &Path, spec: &EngineSpec, strict: bool) -> Option<String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => return Some(format!("the engine directory cannot be read: {e}")),
    };
    let expected = expected_files(spec);
    let mut found = HashSet::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return Some(e.to_string()),
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((_, size, _)) = expected.iter().find(|(n, _, _)| *n == name) else {
            return Some(name);
        };
        let meta = match fs::symlink_metadata(entry.path()) {
            Ok(m) => m,
            Err(e) => return Some(e.to_string()),
        };
        if strict && (!meta.is_file() || is_link(&meta)) {
            return Some(format!("{name} is not a plain file"));
        }
        if meta.len() != *size {
            return Some(format!("{name} is {} bytes, expected {size}", meta.len()));
        }
        found.insert(name);
    }
    expected.iter().find(|(n, _, _)| !found.contains(n)).map(|(n, _, _)| format!("{n} is missing"))
}

fn hash_path(path: &Path) -> io::Result<(u64, String)> {
    let never = AtomicBool::new(false);
    super::store::hash_file(path, &never).map(|r| r.unwrap_or_default())
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

fn check_not_link(path: &Path) -> Result<(), InstallError> {
    let meta = fs::symlink_metadata(path).map_err(io_err)?;
    if is_link(&meta) {
        return Err(InstallError::PathRefused(format!("{} is a link", path.display())));
    }
    Ok(())
}

/// Delete a directory this module created: the plain files directly inside it, then the directory itself.
///
/// What keeps this inside the managed directory:
/// * the directory must not be a link or any other reparse point, and must resolve to exactly itself — so no
///   folder above it is a redirection either;
/// * nothing is entered: a subdirectory, a link, or any reparse point inside it is refused, not followed;
/// * each file is removed by name, which never follows a link, and removes only that name — a hard link to a
///   file elsewhere loses this name and nothing else;
/// * the directory is removed only once it is empty.
fn remove_tree(store: &Store, dir: &Path) -> Result<u64, InstallError> {
    check_not_link(dir)?;
    guard_exact(store, dir)?;
    let mut freed = 0;
    for entry in fs::read_dir(dir).map_err(io_err)? {
        let path = entry.map_err(io_err)?.path();
        let meta = fs::symlink_metadata(&path).map_err(io_err)?;
        if is_link(&meta) || !meta.is_file() {
            return Err(InstallError::PathRefused(format!("{} is not a plain file", path.display())));
        }
        fs::remove_file(&path).map_err(io_err)?;
        freed += meta.len();
    }
    fs::remove_dir(dir).map_err(io_err)?;
    Ok(freed)
}

/// Clear staging and set-aside directories left by an installation that did not finish.
fn clear_leftovers(store: &Store, base: &Path) -> Result<(), InstallError> {
    let Ok(entries) = fs::read_dir(base) else { return Ok(()) };
    for entry in entries {
        let entry = entry.map_err(io_err)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(STAGING_PREFIX) || name.starts_with(OLD_PREFIX) {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(io_err)?;
            if meta.is_file() && !is_link(&meta) {
                // Not something an installation leaves — but left in place, it would fail every installation
                // after it. It carries a name reserved for leftovers, inside Sard's own directory, which the
                // caller has already shown to be exactly where it should be.
                remove_name(&path)?;
            } else {
                remove_tree(store, &path)?;
            }
        }
    }
    Ok(())
}

/// An entry name is acceptable only as a plain, unambiguous file name.
fn check_entry_name(name: &str) -> Result<(), InstallError> {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
        "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let unsafe_name = name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
        || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        || RESERVED.contains(&name.split('.').next().unwrap_or("").to_ascii_uppercase().as_str());
    if unsafe_name {
        Err(InstallError::UnsafeEntry(name.to_string()))
    } else {
        Ok(())
    }
}

/// The entry names of a ZIP archive, read from its central directory.
///
/// Only the plainest form of archive is accepted — the form the pinned archive has — because every liberty a
/// reader allows is a way for two readers to see two different archives:
/// * one part, not ZIP64;
/// * the end-of-central-directory record is the last thing in the file;
/// * the central directory sits immediately before it and is exactly as long as it says;
/// * every entry points at a local file header that is really there, before the central directory.
fn central_directory_names(b: &[u8]) -> Result<Vec<String>, InstallError> {
    let bad = |why: &str| InstallError::UnreadableArchive(why.to_string());
    let u16_at = |o: usize| b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize).ok_or_else(|| bad("truncated"));
    let u32_at = |o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize).ok_or_else(|| bad("truncated"));
    if b.len() < 22 {
        return Err(bad("too short to be an archive"));
    }
    let lowest = b.len().saturating_sub(22 + 0xFFFF);
    let eocd = (lowest..=b.len() - 22)
        .rev()
        .find(|&i| b[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| bad("no end-of-central-directory record"))?;
    let (disk, directory_disk, count_here, count) = (u16_at(eocd + 4)?, u16_at(eocd + 6)?, u16_at(eocd + 8)?, u16_at(eocd + 10)?);
    let (size, offset, archive_comment) = (u32_at(eocd + 12)?, u32_at(eocd + 16)?, u16_at(eocd + 20)?);
    if count == 0xFFFF || offset == 0xFFFF_FFFF || size == 0xFFFF_FFFF {
        return Err(bad("ZIP64 archives are not accepted"));
    }
    if disk != 0 || directory_disk != 0 || count_here != count {
        return Err(bad("archives in several parts are not accepted"));
    }
    if eocd + 22 + archive_comment != b.len() {
        return Err(bad("there is data after the end of the archive"));
    }
    if offset.checked_add(size) != Some(eocd) {
        return Err(bad("the central directory is not where the archive says it is"));
    }
    let mut names = Vec::with_capacity(count);
    let mut p = offset;
    for _ in 0..count {
        if b.get(p..p + 4) != Some(&[0x50, 0x4b, 0x01, 0x02][..]) {
            return Err(bad("a central directory header is malformed"));
        }
        let made_by_unix = u16_at(p + 4)? >> 8 == 3;
        let flags = u16_at(p + 8)?;
        let (name_len, extra_len, comment_len) = (u16_at(p + 28)?, u16_at(p + 30)?, u16_at(p + 32)?);
        let attributes = u32_at(p + 38)?;
        let local = u32_at(p + 42)?;
        if local >= offset || b.get(local..local + 4) != Some(&[0x50, 0x4b, 0x03, 0x04][..]) {
            return Err(bad("an entry does not point at a file in the archive"));
        }
        let raw = b.get(p + 46..p + 46 + name_len).ok_or_else(|| bad("truncated name"))?;
        // Names are UTF-8 only when the archive says so (bit 11); otherwise only ASCII is unambiguous.
        let name = if flags & 0x800 != 0 || raw.is_ascii() {
            std::str::from_utf8(raw).map_err(|_| InstallError::UnsafeEntry(String::from_utf8_lossy(raw).into_owned()))?
        } else {
            return Err(InstallError::UnsafeEntry(String::from_utf8_lossy(raw).into_owned()));
        };
        // Every entry must be a plain file. A Unix archive records the file type in the high half of the
        // attributes (0 = unrecorded); a Windows one records the directory (0x10) and reparse-point (0x400) bits.
        let plain = if made_by_unix {
            matches!((attributes >> 16) & 0o170000, 0 | 0o100000)
        } else {
            attributes & (0x10 | 0x400) == 0
        };
        if !plain {
            return Err(InstallError::UnsafeEntry(format!("{name} (not a plain file)")));
        }
        names.push(name.to_string());
        p += 46 + name_len + extra_len + comment_len;
    }
    if p != eocd {
        return Err(bad("the central directory is not as long as the archive says it is"));
    }
    Ok(names)
}
