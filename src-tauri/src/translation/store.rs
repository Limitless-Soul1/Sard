//! Where translation files live, what state each one is in, and how they are removed.
//!
//! ## Layout
//!
//! ```text
//! <root>/                      the translation root — see `default_root`
//!   models/<id>/<file>         a verified model, plus `installed.json`
//!   runtime/<id>/<file>        the verified runtime archive, plus `installed.json`
//!   partial/<id>.part          an unfinished download: the bytes received so far, nothing else
//! ```
//!
//! ## The root is NOT the library's data directory
//!
//! Sard's library, database and settings live in the ROAMING application-data directory. Model files
//! are several gigabytes each and must not roam with a Windows profile, so the translation root sits
//! in the LOCAL application-data directory instead. That keeps every translation file away from the
//! installation directory (which an update replaces), from the user's books, and from the database.
//!
//! ## What "installed" means
//!
//! A file is installed only when its size and SHA-256 matched the catalog AND `installed.json` was
//! written afterwards. The record is written last, so a crash at any earlier point leaves something
//! that is visibly not installed: a partial download, or a file with no record (`Unverified`), which
//! is never used until it has been hashed again.
//!
//! ## Removal touches nothing it did not write
//!
//! Removing a model deletes exactly the files this store writes for it — the model file and its
//! record — and then the directory only if it is empty. Anything else found there is left alone and
//! reported. Every path is resolved and checked to lie inside the root before anything is deleted, so
//! a link planted inside the root cannot redirect a removal to the user's files.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::catalog::{Artifact, Kind};

/// The record written next to an installed file.
pub const RECORD_NAME: &str = "installed.json";
/// The name the record is written under first, and renamed from. Nothing is ever read from it.
pub const RECORD_TEMP_NAME: &str = "installed.json.tmp";

/// The translation root under the local (non-roaming) application-data directory.
pub fn default_root(local_app_data: &Path) -> PathBuf {
    local_app_data.join("translation")
}

/// What an artifact's files on disk amount to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// Nothing on disk.
    NotDownloaded,
    /// A download stopped before it finished. It continues only when the user asks.
    Interrupted { bytes: u64 },
    /// Verified and recorded.
    Installed,
    /// The file is present but was never recorded as verified (for example, a crash between moving it
    /// into place and writing the record). It is not used until `verify` has hashed it again.
    Unverified,
    /// A record exists but no longer matches the file or the catalog.
    Damaged { reason: String },
}

/// The record written once a file has been verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledRecord {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub source: String,
    pub verified_at_unix: u64,
}

/// What a removal did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    /// Bytes freed by deleting files this store had written.
    pub freed: u64,
    /// Names found in the artifact's directory that this store did not write, and therefore kept.
    pub kept: Vec<String>,
}

/// The translation root and everything under it.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Open (creating if needed) a store at `root`. The root is resolved once, here, and every later
    /// path check compares against this resolved form.
    pub fn open(root: impl AsRef<Path>) -> io::Result<Store> {
        fs::create_dir_all(root.as_ref())?;
        let root = fs::canonicalize(root.as_ref())?;
        for sub in ["models", "runtime", "partial"] {
            fs::create_dir_all(root.join(sub))?;
        }
        Ok(Store { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The directory an artifact's verified files live in.
    pub fn artifact_dir(&self, a: &Artifact) -> PathBuf {
        let kind = match a.kind {
            Kind::Model => "models",
            Kind::Runtime => "runtime",
        };
        self.root.join(kind).join(a.id)
    }

    pub fn installed_path(&self, a: &Artifact) -> PathBuf {
        self.artifact_dir(a).join(a.file_name)
    }

    pub fn record_path(&self, a: &Artifact) -> PathBuf {
        self.artifact_dir(a).join(RECORD_NAME)
    }

    fn record_temp_path(&self, a: &Artifact) -> PathBuf {
        self.artifact_dir(a).join(RECORD_TEMP_NAME)
    }

    pub fn partial_path(&self, a: &Artifact) -> PathBuf {
        self.root.join("partial").join(format!("{}.part", a.id))
    }

    /// Bytes of an unfinished download, if there is one.
    pub fn partial_bytes(&self, a: &Artifact) -> io::Result<Option<u64>> {
        match fs::metadata(self.partial_path(a)) {
            Ok(m) if m.is_file() => Ok(Some(m.len())),
            Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "the partial download is not a file")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The artifact's state, from metadata only — cheap enough to call whenever the UI asks.
    pub fn state(&self, a: &Artifact) -> io::Result<State> {
        let file = self.installed_path(a);
        let file_len = match fs::metadata(&file) {
            Ok(m) => Some(m.len()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        match fs::read(self.record_path(a)) {
            Ok(bytes) => {
                let reason = match serde_json::from_slice::<InstalledRecord>(&bytes) {
                    Err(_) => Some("the record cannot be read".to_string()),
                    Ok(r) if r.id != a.id || r.file_name != a.file_name || r.size != a.size || r.sha256 != a.sha256 => {
                        Some("the record does not describe the file this version of Sard expects".to_string())
                    }
                    Ok(_) => match file_len {
                        None => Some("the file is missing".to_string()),
                        Some(len) if len != a.size => Some(format!("the file is {len} bytes, expected {}", a.size)),
                        Some(_) => None,
                    },
                };
                return Ok(match reason {
                    Some(reason) => State::Damaged { reason },
                    None => State::Installed,
                });
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if file_len.is_some() {
            return Ok(State::Unverified);
        }
        Ok(match self.partial_bytes(a)? {
            Some(bytes) => State::Interrupted { bytes },
            None => State::NotDownloaded,
        })
    }

    /// Hash the installed file in full. If it matches the catalog, (re)write its record and report
    /// `Installed`; if it does not, delete the file and its record and report `NotDownloaded`.
    /// `cancel` stops the hashing early without changing anything.
    pub fn verify(&self, a: &Artifact, cancel: &AtomicBool) -> io::Result<State> {
        let file = self.installed_path(a);
        if !file.exists() {
            return self.state(a);
        }
        self.guard_existing(&file)?;
        let (len, sha) = match hash_file(&file, cancel)? {
            Some(h) => h,
            None => return Err(io::Error::new(io::ErrorKind::Interrupted, "verification cancelled")),
        };
        if len == a.size && sha == a.sha256 {
            let source = a.sources.first().map(|s| s.url).unwrap_or_default();
            self.write_record(a, source)?;
            Ok(State::Installed)
        } else {
            self.delete_owned_file(&self.record_path(a))?;
            self.delete_owned_file(&file)?;
            Ok(State::NotDownloaded)
        }
    }

    /// Delete an unfinished download. Returns the bytes freed.
    ///
    /// A link left at its name is removed as a NAME — what it leads to is not touched, and nothing is
    /// freed. A folder there is not the store's, and is refused.
    pub fn discard_partial(&self, a: &Artifact) -> io::Result<u64> {
        let path = self.partial_path(a);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        if meta.file_type().is_file() {
            return self.delete_owned_file(&path);
        }
        if meta.is_dir() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{} is a folder", path.display())));
        }
        // The folder the link sits in must be the store's own; the link itself is never followed.
        self.guard_existing(path.parent().unwrap_or(&path))?;
        fs::remove_file(&path).or_else(|_| fs::remove_dir(&path))?;
        Ok(0)
    }

    /// Remove an artifact: its file, its record and any unfinished download. Nothing else.
    pub fn remove(&self, a: &Artifact) -> io::Result<Removal> {
        let mut freed = self.discard_partial(a)?;
        let dir = self.artifact_dir(a);
        if !dir.exists() {
            return Ok(Removal { freed, kept: Vec::new() });
        }
        self.guard_existing(&dir)?;
        freed += self.delete_owned_file(&self.installed_path(a))?;
        freed += self.delete_owned_file(&self.record_path(a))?;
        // The name the record is written under first is the store's too. It is removed as a NAME, so a link
        // left there goes without its target being touched; a folder there is not the store's, and is kept.
        let tmp = self.record_temp_path(a);
        if let Ok(meta) = fs::symlink_metadata(&tmp) {
            if !meta.is_dir() {
                remove_name(&tmp)?;
                if meta.is_file() {
                    freed += meta.len();
                }
            }
        }
        let mut kept: Vec<String> = fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();
        if kept.is_empty() {
            fs::remove_dir(&dir)?;
        }
        Ok(Removal { freed, kept })
    }

    /// Move a verified partial download into place, then write its record — in that order, so that a
    /// crash in between leaves `Unverified`, never a record for a file that is not there.
    pub(crate) fn install_verified_partial(&self, a: &Artifact, source: &str) -> io::Result<()> {
        let dir = self.artifact_dir(a);
        fs::create_dir_all(&dir)?;
        self.guard_existing(&dir)?;
        let part = self.partial_path(a);
        self.guard_existing(&part)?;
        fs::rename(&part, self.installed_path(a))?;
        self.write_record(a, source)
    }

    /// Write the record: under a temporary name first, then renamed into place.
    ///
    /// Neither step goes through a link. Whatever already has the temporary name is removed as a NAME (a
    /// link is not followed); the file is then created new, which fails rather than open anything that has
    /// reappeared there; and the rename replaces the record's own name, not what a link there might point
    /// to. If the record cannot be put in place, nothing is left under the temporary name — and the file
    /// is what it was without a record: not installed.
    fn write_record(&self, a: &Artifact, source: &str) -> io::Result<()> {
        let record = InstalledRecord {
            id: a.id.to_string(),
            file_name: a.file_name.to_string(),
            size: a.size,
            sha256: a.sha256.to_string(),
            source: source.to_string(),
            verified_at_unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(io::Error::other)?;
        let path = self.record_path(a);
        let tmp = self.record_temp_path(a);
        remove_name(&tmp)?;
        let placed = write_new(&tmp, &bytes).and_then(|()| fs::rename(&tmp, &path));
        if placed.is_err() {
            let _ = remove_name(&tmp);
        }
        placed
    }

    /// Delete one file this store owns, after checking that it really lies inside the root. A missing
    /// file is not an error. Returns its size.
    fn delete_owned_file(&self, path: &Path) -> io::Result<u64> {
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        self.guard_existing(path)?;
        if !meta.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{} is not a plain file", path.display())));
        }
        fs::remove_file(path)?;
        Ok(meta.len())
    }

    /// Refuse any existing path that does not resolve to a location strictly inside the root — which is
    /// what a symbolic link or a junction planted in the root would try to arrange.
    fn guard_existing(&self, path: &Path) -> io::Result<()> {
        let resolved = fs::canonicalize(path)?;
        if resolved != self.root && resolved.starts_with(&self.root) {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} resolves outside the translation directory", path.display()),
            ))
        }
    }
}

/// Remove one name from a directory. Removing a name never follows a link: if the name is a link, the link
/// goes and its target is untouched. A name that is not there is not an error.
fn remove_name(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Create a file that must not already exist, write all of `bytes` to it, and flush it to disk.
fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// SHA-256 of a whole file, read in 8 MiB blocks. `None` if cancelled.
pub(crate) fn hash_file(path: &Path, cancel: &AtomicBool) -> io::Result<Option<(u64, String)>> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    let mut len = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok(Some((len, hex(&hasher.finalize()))))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
