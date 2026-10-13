//! Delivery tests: every download runs against the local test server; nothing here uses the internet
//! except the two `#[ignore]`d tests at the end, which are run by hand.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::catalog::{Artifact, Kind, Licence, Source};
use super::download::{check_url, download, DownloadError, Mode, Policy, Progress};
use super::store::{hex, InstalledRecord, State, Store, RECORD_NAME};
use super::test_server::{test_bytes, TestServer};

const SIZE: usize = 1_500_000; // six 256 KiB chunks and a short seventh

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("sard_translation_{tag}_{}_{nanos}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn sha(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// A catalog entry for test bytes served by `server` at `path`.
fn artifact(server: &TestServer, path: &str, data: &[u8], tag: &str) -> &'static Artifact {
    artifact_with_sha(server, path, data.len() as u64, sha(data), tag)
}

fn artifact_with_sha(server: &TestServer, path: &str, size: u64, sha256: String, tag: &str) -> &'static Artifact {
    let sources: &'static [Source] = Box::leak(vec![Source { url: leak(server.url(path)) }].into_boxed_slice());
    Box::leak(Box::new(Artifact {
        id: leak(format!("test-{tag}")),
        kind: Kind::Model,
        file_name: "model.gguf",
        size,
        sha256: leak(sha256),
        sources,
        licence: Licence::Apache2,
    }))
}

struct Fixture {
    _tmp: TempDir,
    store: Store,
    server: TestServer,
    data: Vec<u8>,
}

fn fixture(tag: &str) -> Fixture {
    let tmp = TempDir::new(tag);
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let data = test_bytes(SIZE, tag.len() as u64);
    let server = TestServer::start(data.clone());
    Fixture { _tmp: tmp, store, server, data }
}

fn run(f: &Fixture, a: &Artifact, mode: Mode, policy: &Policy, cancel: &AtomicBool) -> Result<Vec<Progress>, DownloadError> {
    let mut seen = Vec::new();
    download(&f.store, a, mode, policy, cancel, |p| seen.push(p)).map(|_| seen)
}

fn no() -> AtomicBool {
    AtomicBool::new(false)
}

fn served(f: &Fixture) -> u64 {
    f.server.stats.lock().unwrap().body_bytes
}

/// The served-byte count once the server has stopped writing to connections the client abandoned.
fn settled(f: &Fixture) -> u64 {
    let mut last = served(f);
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let now = served(f);
        if now == last {
            return now;
        }
        last = now;
    }
    last
}

// ── the normal path ─────────────────────────────────────────────────────────────────────────────

#[test]
fn downloads_through_a_redirect_and_installs_only_after_verification() {
    let f = fixture("normal");
    let a = artifact(&f.server, "/redirect", &f.data, "normal");
    let seen = run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).expect("download");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);
    assert_eq!(fs::read(f.store.installed_path(a)).unwrap(), f.data, "the installed bytes are the served bytes");
    assert!(!f.store.partial_path(a).exists(), "nothing is left in the partial area");
    let rec: InstalledRecord = serde_json::from_slice(&fs::read(f.store.record_path(a)).unwrap()).unwrap();
    assert_eq!((rec.size, rec.sha256.as_str(), rec.file_name.as_str()), (a.size, a.sha256, a.file_name));
    assert_eq!(seen.last(), Some(&Progress { done: a.size, total: a.size }));
    assert!(seen.len() >= 7, "one report per chunk, got {}", seen.len());
    assert_eq!(served(&f), a.size, "every byte was fetched exactly once");
}

#[test]
fn an_installed_file_is_not_downloaded_again() {
    let f = fixture("again");
    let a = artifact(&f.server, "/file", &f.data, "again");
    run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).unwrap();
    let before = served(&f);
    assert_eq!(run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()), Err(DownloadError::AlreadyPresent));
    assert_eq!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::AlreadyPresent));
    assert_eq!(served(&f), before, "nothing was requested");
}

// ── interruption and resumption ─────────────────────────────────────────────────────────────────

#[test]
fn a_dropped_connection_is_retried_from_the_bytes_already_received() {
    let f = fixture("dropped");
    f.server.faults.lock().unwrap().drop_after_once = Some(700_000);
    let a = artifact(&f.server, "/file", &f.data, "dropped");
    run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).expect("recovers within the download");
    assert_eq!(fs::read(f.store.installed_path(a)).unwrap(), f.data);
    assert_eq!(served(&f), a.size, "no byte that had arrived was fetched twice");
}

#[test]
fn a_stalled_connection_times_out_and_the_download_continues() {
    let f = fixture("stalled");
    f.server.faults.lock().unwrap().stall_once_at = Some(400_000);
    let a = artifact(&f.server, "/file", &f.data, "stalled");
    run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).expect("the stall becomes a retry");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);
}

#[test]
fn cancel_keeps_the_partial_and_only_an_explicit_resume_continues_it() {
    let f = fixture("cancel");
    let cancel = Arc::new(AtomicBool::new(false));
    f.server.faults.lock().unwrap().cancel_when_past = Some((600_000, cancel.clone()));
    let a = artifact(&f.server, "/file", &f.data, "cancel");
    let policy = Policy::loopback_for_tests();

    let kept = match run(&f, a, Mode::Start, &policy, &cancel) {
        Err(DownloadError::Cancelled { kept_bytes }) => kept_bytes,
        other => panic!("expected a cancel, got {other:?}"),
    };
    assert!(kept > 0 && kept < a.size, "kept {kept}");
    assert_eq!(f.store.state(a).unwrap(), State::Interrupted { bytes: kept });
    assert_eq!(fs::read(f.store.partial_path(a)).unwrap(), f.data[..kept as usize], "what was kept is the file's own prefix");

    // Nothing continues it implicitly: starting again is refused, and says what is there.
    f.server.faults.lock().unwrap().cancel_when_past = None;
    cancel.store(false, Ordering::Relaxed);
    assert_eq!(run(&f, a, Mode::Start, &policy, &no()), Err(DownloadError::PartialExists { bytes: kept }));
    assert_eq!(f.store.state(a).unwrap(), State::Interrupted { bytes: kept }, "the refusal changed nothing");

    let before = settled(&f);
    run(&f, a, Mode::Resume, &policy, &no()).expect("resume");
    assert_eq!(fs::read(f.store.installed_path(a)).unwrap(), f.data);
    assert_eq!(served(&f) - before, a.size - kept, "the resume fetched only the missing bytes");
}

#[test]
fn a_resume_after_a_crash_rehashes_the_bytes_on_disk() {
    let f = fixture("crash");
    let a = artifact(&f.server, "/file", &f.data, "crash");
    // A crash leaves a prefix of the file and nothing else.
    fs::write(f.store.partial_path(a), &f.data[..777_777]).unwrap();
    assert_eq!(f.store.state(a).unwrap(), State::Interrupted { bytes: 777_777 });
    run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()).expect("resume");
    assert_eq!(fs::read(f.store.installed_path(a)).unwrap(), f.data);
}

#[test]
fn resume_with_nothing_to_resume_is_refused() {
    let f = fixture("noresume");
    let a = artifact(&f.server, "/file", &f.data, "noresume");
    assert_eq!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::NothingToResume));
    assert_eq!(f.server.stats.lock().unwrap().requests, 0);
}

#[test]
fn a_cancel_during_the_rehash_returns_without_touching_the_partial() {
    let f = fixture("rehashcancel");
    let a = artifact(&f.server, "/file", &f.data, "rehashcancel");
    fs::write(f.store.partial_path(a), &f.data[..300_000]).unwrap();
    let cancel = AtomicBool::new(true);
    assert_eq!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &cancel), Err(DownloadError::Cancelled { kept_bytes: 300_000 }));
    assert_eq!(fs::read(f.store.partial_path(a)).unwrap(), f.data[..300_000]);
    assert_eq!(f.server.stats.lock().unwrap().requests, 0);
}

#[test]
fn a_full_disk_mid_download_keeps_what_was_written_and_can_be_resumed() {
    let f = fixture("diskfull");
    let a = artifact(&f.server, "/file", &f.data, "diskfull");
    let mut failing = Policy::loopback_for_tests();
    failing.fault_write_after = Some(600_000);
    let kept = match run(&f, a, Mode::Start, &failing, &no()) {
        Err(DownloadError::Io { kept_bytes, .. }) => kept_bytes,
        other => panic!("expected a disk error, got {other:?}"),
    };
    let on_disk = fs::read(f.store.partial_path(a)).unwrap();
    assert_eq!(on_disk.len() as u64, kept);
    assert_eq!(on_disk, f.data[..on_disk.len()], "the partial is a correct prefix");
    run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()).expect("resume once space is back");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);
}

#[test]
fn two_downloads_of_the_same_file_never_run_at_once() {
    let f = Arc::new(fixture("busy"));
    f.server.faults.lock().unwrap().stall_once_at = Some(300_000);
    let a = artifact(&f.server, "/file", &f.data, "busy");
    let f2 = f.clone();
    let first = std::thread::spawn(move || run(&f2, a, Mode::Start, &Policy::loopback_for_tests(), &no()));
    // Wait until the first download is writing.
    for _ in 0..200 {
        if matches!(f.store.partial_bytes(a), Ok(Some(n)) if n > 0) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::Busy));
    first.join().unwrap().expect("the first download finishes");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);
}

// ── the unfinished download is never written through a link ─────────────────────────────────────

/// A download must never put a byte anywhere but in its own file in the translation directory.
///
/// Each test plants something at the unfinished download's name and then looks at what the planted thing
/// leads to — its bytes, its length and its modification time — and at everything else beside the
/// translation directory. That an error came back is never the whole of a test.
mod partial_file_safety {
    use super::*;
    use std::sync::Mutex;

    /// A line that must be seen even when the test passes — a case that could not be run. The test harness
    /// hides what a passing test prints, so this goes to the error stream directly.
    fn note(line: &str) {
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), "{line}");
    }

    /// Put a symbolic link to a file at `link`. On Windows that needs a privilege an ordinary account may
    /// not have, so this reports whether it could be done.
    fn link_file(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        made
    }

    /// Put a link to a folder at `link`: a junction on Windows, which needs no privilege.
    fn link_folder(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: never a console window on the screen.
            let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).creation_flags(0x0800_0000).output().unwrap();
            assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
        }
    }

    fn is_link(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
    }

    fn refused(result: &Result<Vec<Progress>, DownloadError>) -> bool {
        matches!(result, Err(DownloadError::UnsafePartial { .. }))
    }

    /// One file, exactly as it is now — or the fact that it does not exist — to be compared later.
    struct Kept {
        path: PathBuf,
        was: Option<(Vec<u8>, SystemTime)>,
    }

    impl Kept {
        fn of(path: &Path) -> Kept {
            let was = fs::read(path).ok().map(|bytes| (bytes, fs::metadata(path).unwrap().modified().unwrap()));
            Kept { path: path.to_path_buf(), was }
        }

        fn assert_untouched(&self) {
            match &self.was {
                None => assert!(fs::symlink_metadata(&self.path).is_err(), "{} was created", self.path.display()),
                Some((bytes, modified)) => {
                    let now = fs::read(&self.path).unwrap();
                    assert_eq!(now.len(), bytes.len(), "{} changed length", self.path.display());
                    assert!(now == *bytes, "{} changed contents", self.path.display());
                    assert_eq!(fs::metadata(&self.path).unwrap().modified().unwrap(), *modified, "{} was written to", self.path.display());
                }
            }
        }
    }

    /// A download about to happen, with the user's own files beside the translation directory.
    struct Scene {
        f: Fixture,
        a: &'static Artifact,
        /// The unfinished download's name, as the store resolves it.
        part: PathBuf,
        /// The translation directory by its plain path: `mklink` does not take the store's resolved one.
        translation: PathBuf,
        /// A folder of the user's own files.
        users: PathBuf,
        outside: BTreeMap<PathBuf, (u64, String, SystemTime)>,
    }

    impl Scene {
        fn new(tag: &str) -> Scene {
            let f = fixture(tag);
            let a = artifact(&f.server, "/file", &f.data, tag);
            user_data(&f._tmp.0);
            let (translation, users) = (f._tmp.0.join("translation"), f._tmp.0.join("library"));
            let part = f.store.partial_path(a);
            let outside = snapshot(&f._tmp.0, &translation);
            Scene { f, a, part, translation, users, outside }
        }

        /// Call once the user's files are as the test wants them: from here on they must not change.
        fn settle(&mut self) {
            self.outside = snapshot(&self.f._tmp.0, &self.translation);
        }

        /// Everything beside the translation directory is byte-identical, has the same modification
        /// times, and nothing has been added to it.
        fn assert_nothing_outside_changed(&self) {
            assert!(self.outside.len() >= 4, "the snapshot covers the user's files");
            assert!(self.outside == snapshot(&self.f._tmp.0, &self.translation), "something beside the translation directory changed");
        }

        fn plain_part(&self) -> PathBuf {
            self.translation.join("partial").join(format!("{}.part", self.a.id))
        }

        fn requests(&self) -> u32 {
            self.f.server.stats.lock().unwrap().requests
        }

        fn download(&self, mode: Mode) -> Result<Vec<Progress>, DownloadError> {
            run(&self.f, self.a, mode, &Policy::loopback_for_tests(), &no())
        }

        /// The download finished: the catalog's exact bytes are installed and recorded, and nothing is
        /// left under the unfinished download's name.
        fn assert_installed(&self) {
            let (store, a) = (&self.f.store, self.a);
            assert_eq!(store.state(a).unwrap(), State::Installed);
            let installed = fs::read(store.installed_path(a)).unwrap();
            assert_eq!(installed.len() as u64, a.size);
            assert_eq!(sha(&installed), a.sha256);
            assert!(installed == self.f.data, "the installed bytes are the served bytes");
            let record: InstalledRecord = serde_json::from_slice(&fs::read(store.record_path(a)).unwrap()).unwrap();
            assert_eq!((record.size, record.sha256.as_str()), (a.size, a.sha256));
            assert!(fs::symlink_metadata(&self.part).is_err(), "something is left at the unfinished download's name");
        }
    }

    /// The defect this module exists for, in its first form: a new download followed a link left at its
    /// name, and wrote the whole file — 1,500,000 bytes here — to wherever the link led.
    #[test]
    fn a_new_download_is_never_written_through_a_link_at_its_name() {
        for leads_to in ["a file that does not exist yet", "one of the user's files", "another file in the translation directory"] {
            let mut s = Scene::new("startlink");
            let target = match leads_to {
                "a file that does not exist yet" => s.users.join("not-there-yet.bin"),
                "one of the user's files" => s.users.join("a-book.epub"),
                _ => {
                    let other = s.f.store.root().join("models").join("another-model");
                    fs::create_dir_all(&other).unwrap();
                    fs::write(other.join("model.gguf"), b"another model's bytes").unwrap();
                    other.join("model.gguf")
                }
            };
            if !link_file(&s.part, &target) {
                note("NOT TESTED (a new download over a link): this account may not create a symbolic link to a file");
                return;
            }
            s.settle();
            let kept = Kept::of(&target);

            assert_eq!(s.a.size, 1_500_000, "the size the defect was first reproduced with");
            s.download(Mode::Start).unwrap_or_else(|e| panic!("{leads_to}: the link is removed as a name and the download runs, but: {e}"));

            // Not one of those bytes went where the link led: what was there is as it was, and what was
            // not there still is not.
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
            s.assert_installed();
            assert_eq!(served(&s.f), s.a.size, "{leads_to}: every byte was fetched exactly once");
        }
    }

    /// The same defect in its second form: a resumed download appended through the link. Each target here
    /// is something a resume would otherwise have continued without complaint.
    #[test]
    fn a_resumed_download_never_appends_through_a_link_at_its_name() {
        for leads_to in ["an empty file of the user's", "a file of the user's holding the download's first bytes", "the same inside the translation directory", "nothing"] {
            let mut s = Scene::new("resumelink");
            let target = match leads_to {
                // What the original defect appended 1,500,000 bytes to.
                "an empty file of the user's" => s.users.join("empty.bin"),
                "a file of the user's holding the download's first bytes" => s.users.join("looks-like-a-download.bin"),
                "nothing" => s.users.join("not-there-yet.bin"),
                _ => {
                    let other = s.f.store.root().join("models").join("another-model");
                    fs::create_dir_all(&other).unwrap();
                    other.join("model.gguf")
                }
            };
            match leads_to {
                "nothing" => {}
                "an empty file of the user's" => fs::write(&target, b"").unwrap(),
                _ => fs::write(&target, &s.f.data[..400_000]).unwrap(),
            }
            if !link_file(&s.part, &target) {
                note("NOT TESTED (a resume over a link): this account may not create a symbolic link to a file");
                return;
            }
            s.settle();
            let kept = Kept::of(&target);

            assert_eq!(s.a.size, 1_500_000, "the size the defect was first reproduced with");
            let result = s.download(Mode::Resume);
            assert!(refused(&result), "{leads_to}: {result:?}");
            assert_eq!(s.requests(), 0, "{leads_to}: nothing was asked of the server");
            // Not one of those bytes was appended where the link led.
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
            assert!(is_link(&s.part), "{leads_to}: the refusal changed nothing, so the link is still there");

            // The way out the error names: discarding the unfinished download removes the link, as a name.
            assert_eq!(s.f.store.discard_partial(s.a).unwrap(), 0, "{leads_to}");
            assert!(fs::symlink_metadata(&s.part).is_err(), "{leads_to}: the link is gone");
            kept.assert_untouched();
            s.download(Mode::Start).unwrap_or_else(|e| panic!("{leads_to}: a new download now runs, but: {e}"));
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
            s.assert_installed();
        }
    }

    /// A hard link needs no privilege at all, and shares its bytes with the file it was made from: what is
    /// appended under one name is appended to the other.
    #[test]
    fn a_file_that_also_has_a_name_elsewhere_is_never_appended_to() {
        let mut s = Scene::new("hardlink");
        // One of the user's files, holding what happens to be the download's first 500,000 bytes — so a
        // resume would find nothing wrong with it, and append the other million.
        let target = s.users.join("looks-like-a-download.bin");
        fs::write(&target, &s.f.data[..500_000]).unwrap();
        fs::hard_link(&target, &s.part).unwrap();
        s.settle();
        let kept = Kept::of(&target);

        let result = s.download(Mode::Resume);
        assert!(refused(&result), "{result:?}");
        assert_eq!(s.requests(), 0);
        kept.assert_untouched();
        // A plain file has the name, so a new download is not started over it either.
        assert_eq!(s.download(Mode::Start), Err(DownloadError::PartialExists { bytes: 500_000 }));
        assert_eq!(s.requests(), 0);
        kept.assert_untouched();
        s.assert_nothing_outside_changed();

        // Discarding removes the store's name for it. The user's file is whole under its own.
        s.f.store.discard_partial(s.a).unwrap();
        assert!(fs::symlink_metadata(&s.part).is_err());
        kept.assert_untouched();
        s.download(Mode::Start).expect("a new download now runs");
        kept.assert_untouched();
        s.assert_nothing_outside_changed();
        s.assert_installed();
    }

    #[test]
    fn a_folder_at_its_name_is_refused_and_a_link_to_one_is_removed_only_as_a_name() {
        // A real folder, with something in it: not the store's, so not the store's to remove.
        let mut s = Scene::new("folder");
        fs::create_dir(&s.part).unwrap();
        fs::write(s.part.join("inside.txt"), b"not the store's").unwrap();
        s.settle();
        for mode in [Mode::Start, Mode::Resume] {
            let result = s.download(mode);
            assert!(refused(&result), "{mode:?}: {result:?}");
        }
        assert!(s.f.store.discard_partial(s.a).is_err(), "a folder is not discarded");
        assert_eq!(s.requests(), 0);
        assert_eq!(fs::read(s.part.join("inside.txt")).unwrap(), b"not the store's");
        s.assert_nothing_outside_changed();

        // A link to one of the user's folders.
        let mut s = Scene::new("folderlink");
        link_folder(&s.plain_part(), &s.users);
        s.settle();
        let result = s.download(Mode::Resume);
        assert!(refused(&result), "{result:?}");
        assert_eq!(s.requests(), 0);
        assert!(is_link(&s.part));
        s.assert_nothing_outside_changed();
        // A new download removes the link — the name, not the folder it leads to or anything in it.
        s.download(Mode::Start).expect("the link is removed as a name and the download runs");
        s.assert_nothing_outside_changed();
        s.assert_installed();
    }

    /// Checking a name and then creating the file is two steps. Here a link is put at the name between
    /// them — after it was cleared, at the last moment before the file is created.
    #[test]
    fn a_link_that_appears_just_before_the_file_is_created_is_not_followed() {
        for leads_to in ["a file that does not exist yet", "one of the user's files"] {
            let mut s = Scene::new("racelink");
            let target = s.users.join(if leads_to == "one of the user's files" { "a-book.epub" } else { "not-there-yet.bin" });
            s.settle();
            let kept = Kept::of(&target);

            let planted = Arc::new(Mutex::new(None));
            let mut racing = Policy::loopback_for_tests();
            racing.before_open = Some({
                let (part, target, planted) = (s.part.clone(), target.clone(), planted.clone());
                Arc::new(move || *planted.lock().unwrap() = Some(link_file(&part, &target)))
            });
            let result = run(&s.f, s.a, Mode::Start, &racing, &no());
            let planted = planted.lock().unwrap().expect("the download reached the point of creating its file");
            if !planted {
                note("NOT TESTED (a link planted just before creation): this account may not create a symbolic link to a file");
                return;
            }
            assert!(refused(&result), "{leads_to}: {result:?}");
            assert_eq!(s.requests(), 0, "{leads_to}: nothing was asked of the server");
            kept.assert_untouched();
            s.assert_nothing_outside_changed();

            // Asked again with nothing racing it, the link is removed as a name and the download runs.
            s.download(Mode::Start).unwrap_or_else(|e| panic!("{leads_to}: {e}"));
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
            s.assert_installed();
        }
    }

    /// The same two steps when resuming: the name is looked at, then opened. Here the unfinished download
    /// is exchanged for a link between them — to a file a resume would have nothing against.
    #[test]
    fn a_link_exchanged_for_the_file_just_before_it_is_opened_is_not_followed() {
        for leads_to in ["an empty file of the user's", "a file of the user's holding the same bytes"] {
            let mut s = Scene::new("raceresume");
            fs::write(&s.part, &s.f.data[..200_000]).unwrap();
            let target = s.users.join("looks-like-a-download.bin");
            let held = if leads_to == "an empty file of the user's" { 0 } else { 200_000 };
            fs::write(&target, &s.f.data[..held]).unwrap();
            s.settle();
            let kept = Kept::of(&target);

            let planted = Arc::new(Mutex::new(None));
            let mut racing = Policy::loopback_for_tests();
            racing.before_open = Some({
                let (part, target, planted) = (s.part.clone(), target.clone(), planted.clone());
                Arc::new(move || {
                    fs::remove_file(&part).unwrap();
                    *planted.lock().unwrap() = Some(link_file(&part, &target));
                })
            });
            let result = run(&s.f, s.a, Mode::Resume, &racing, &no());
            let planted = planted.lock().unwrap().expect("the download reached the point of opening its file");
            if !planted {
                note("NOT TESTED (a link exchanged for the file just before it is opened): this account may not create a symbolic link to a file");
                return;
            }
            assert!(refused(&result), "{leads_to}: {result:?}");
            assert_eq!(s.requests(), 0, "{leads_to}: nothing was asked of the server");
            assert_eq!(fs::metadata(&target).unwrap().len(), held as u64, "{leads_to}: none of the download reached it");
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
        }
    }

    /// Discarding removes a link at the name without following it — but only in the store's own folder.
    /// With that folder redirected, the name is in a folder of the user's, and nothing there is removed.
    #[test]
    fn discarding_through_a_redirected_folder_removes_nothing() {
        for holds in ["a file", "a link"] {
            let mut s = Scene::new("discard-redirected");
            let elsewhere = s.f._tmp.0.join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            let named_like_it = elsewhere.join(format!("{}.part", s.a.id));
            if holds == "a file" {
                fs::write(&named_like_it, b"the user's, whatever it is called").unwrap();
            } else if !link_file(&named_like_it, &s.users.join("a-book.epub")) {
                note("NOT TESTED (discarding a link through a redirected folder): this account may not create a symbolic link to a file");
                return;
            }
            let folder = s.translation.join("partial");
            fs::remove_dir(&folder).unwrap();
            link_folder(&folder, &elsewhere);
            s.settle();

            assert!(s.f.store.discard_partial(s.a).is_err(), "{holds}: something was discarded through the link");
            assert!(fs::symlink_metadata(&named_like_it).is_ok(), "{holds}: it was removed from the user's folder");
            assert_eq!(is_link(&named_like_it), holds == "a link");
            s.assert_nothing_outside_changed();
        }
    }

    /// The folder for unfinished downloads replaced by a link to a folder of the user's: the name of the
    /// file is then right, and everything above it is wrong.
    #[test]
    fn a_redirected_folder_never_receives_a_byte() {
        let redirect = |s: &Scene, elsewhere: &Path| {
            let folder = s.translation.join("partial");
            fs::remove_dir(&folder).unwrap();
            link_folder(&folder, elsewhere);
        };

        // Redirected beforehand, to an empty folder: a new download creates nothing in it.
        let mut s = Scene::new("redirected");
        let elsewhere = s.f._tmp.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("the-users.txt"), b"the user's").unwrap();
        redirect(&s, &elsewhere);
        s.settle();
        let result = s.download(Mode::Start);
        assert!(refused(&result), "{result:?}");
        assert_eq!(s.requests(), 0);
        s.assert_nothing_outside_changed();

        // Redirected to a folder holding a file with the very name the download uses, and its first bytes.
        let mut s = Scene::new("redirected-file");
        let elsewhere = s.f._tmp.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let target = elsewhere.join(format!("{}.part", s.a.id));
        fs::write(&target, &s.f.data[..300_000]).unwrap();
        redirect(&s, &elsewhere);
        s.settle();
        let kept = Kept::of(&target);
        let result = s.download(Mode::Resume);
        assert!(refused(&result), "{result:?}");
        // Through the link it looks like an unfinished download, so a new one is not started over it.
        assert_eq!(s.download(Mode::Start), Err(DownloadError::PartialExists { bytes: 300_000 }));
        assert_eq!(s.requests(), 0);
        kept.assert_untouched();
        s.assert_nothing_outside_changed();

        // Redirected at the last moment: after the folder was checked, before the file is created.
        let mut s = Scene::new("redirect-race");
        let elsewhere = s.f._tmp.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("the-users.txt"), b"the user's").unwrap();
        s.settle();
        let mut racing = Policy::loopback_for_tests();
        racing.before_open = Some({
            let (folder, elsewhere) = (s.translation.join("partial"), elsewhere.clone());
            Arc::new(move || {
                fs::remove_dir(&folder).unwrap();
                link_folder(&folder, &elsewhere);
            })
        });
        let result = run(&s.f, s.a, Mode::Start, &racing, &no());
        assert!(refused(&result), "{result:?}");
        assert_eq!(s.requests(), 0, "nothing was asked of the server, so there was nothing to write");
        let stray = elsewhere.join(format!("{}.part", s.a.id));
        if cfg!(windows) {
            // The file was created where the link led, found to be there, and taken back by its own handle.
            s.assert_nothing_outside_changed();
        } else {
            // Elsewhere a file cannot be deleted through its handle, and its path is the thing that cannot
            // be trusted: the empty file is left. Nothing was written to it.
            assert_eq!(fs::metadata(&stray).map(|m| m.len()).unwrap_or(0), 0);
            assert_eq!(fs::read(elsewhere.join("the-users.txt")).unwrap(), b"the user's");
            note(&format!("MEASURED: redirected at the last moment, an empty file {} left where the link led", if stray.exists() { "WAS" } else { "was not" }));
        }
    }

    /// Once the file is open and proved, an attacker's next move is to exchange it for a link. On Windows
    /// the open handle forbids that. Elsewhere nothing can, so what matters there is where the bytes go.
    #[test]
    fn once_the_file_is_open_it_cannot_be_exchanged_for_a_link() {
        for mode in [Mode::Start, Mode::Resume] {
            let mut s = Scene::new("held");
            let target = s.users.join("a-book.epub");
            if mode == Mode::Resume {
                fs::write(&s.part, &s.f.data[..200_000]).unwrap();
            }
            s.settle();
            let kept = Kept::of(&target);

            let attempt = Arc::new(Mutex::new(None));
            let mut attacked = Policy::loopback_for_tests();
            attacked.after_open = Some({
                let (part, target, folder, attempt) = (s.part.clone(), target.clone(), s.translation.join("partial"), attempt.clone());
                Arc::new(move || {
                    // Only where it is expected to fail: a folder that did move would take the test with it.
                    let folder_moved = cfg!(windows) && fs::rename(&folder, folder.with_file_name("moved")).is_ok();
                    let removed = fs::remove_file(&part).is_ok();
                    let linked = removed && link_file(&part, &target);
                    *attempt.lock().unwrap() = Some((folder_moved, removed, linked));
                })
            });
            let result = run(&s.f, s.a, mode, &attacked, &no());
            let (folder_moved, removed, linked) = attempt.lock().unwrap().expect("the download reached the point of writing");

            // Whatever the attempt achieved, nothing of the user's was written to.
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
            if cfg!(windows) {
                assert!(!removed && !folder_moved, "{mode:?}: the open file, or its folder, was taken from under the download");
                result.unwrap_or_else(|e| panic!("{mode:?}: nothing could be exchanged, so the download finishes, but: {e}"));
                s.assert_installed();
            } else if linked {
                // The bytes went to the file that had been proved, which no longer has a name; the link was
                // then refused when the store came to move the download into place.
                assert!(result.is_err(), "{mode:?}: a link was installed");
                assert!(!s.f.store.installed_path(s.a).exists() && !s.f.store.record_path(s.a).exists());
            }
        }
    }

    /// A download that stops part-way — cancelled, or failing to write — leaves a plain file of the
    /// store's own, and that file resumes and is verified. Both start over a link left at the name.
    #[test]
    fn a_cancel_or_a_failed_write_leaves_a_plain_partial_that_resumes_and_is_verified() {
        for stopped_by in ["a cancel", "a failed write"] {
            let mut s = Scene::new("interrupted");
            let target = s.users.join("a-book.epub");
            if !link_file(&s.part, &target) {
                note("NOT TESTED (an interrupted download over a link): this account may not create a symbolic link to a file");
            }
            s.settle();
            let kept = Kept::of(&target);

            let kept_bytes = if stopped_by == "a cancel" {
                let cancel = Arc::new(AtomicBool::new(false));
                s.f.server.faults.lock().unwrap().cancel_when_past = Some((600_000, cancel.clone()));
                let result = run(&s.f, s.a, Mode::Start, &Policy::loopback_for_tests(), &cancel);
                s.f.server.faults.lock().unwrap().cancel_when_past = None;
                match result {
                    Err(DownloadError::Cancelled { kept_bytes }) => kept_bytes,
                    other => panic!("expected a cancel, got {other:?}"),
                }
            } else {
                let mut failing = Policy::loopback_for_tests();
                failing.fault_write_after = Some(600_000);
                match run(&s.f, s.a, Mode::Start, &failing, &no()) {
                    Err(DownloadError::Io { kept_bytes, .. }) => kept_bytes,
                    other => panic!("expected a disk error, got {other:?}"),
                }
            };

            // What is left is a file of the store's own — not the link — holding the download's first bytes.
            assert!(!is_link(&s.part), "{stopped_by}: the link is still at the name");
            let on_disk = fs::read(&s.part).unwrap();
            assert!(kept_bytes > 0 && kept_bytes < s.a.size, "{stopped_by}: kept {kept_bytes}");
            assert_eq!(on_disk.len() as u64, kept_bytes, "{stopped_by}");
            assert!(on_disk == s.f.data[..on_disk.len()], "{stopped_by}: the partial is a correct prefix");
            assert_eq!(s.f.store.state(s.a).unwrap(), State::Interrupted { bytes: kept_bytes });
            kept.assert_untouched();
            s.assert_nothing_outside_changed();

            // It resumes: only the missing bytes are fetched, and the whole file is checked before it is installed.
            let before = settled(&s.f);
            s.download(Mode::Resume).unwrap_or_else(|e| panic!("{stopped_by}: the resume runs, but: {e}"));
            assert_eq!(served(&s.f) - before, s.a.size - kept_bytes, "{stopped_by}: the resume fetched only the missing bytes");
            s.assert_installed();
            kept.assert_untouched();
            s.assert_nothing_outside_changed();
        }
    }

    /// Clearing the name can fail. Then nothing is created, nothing is requested and nothing is written.
    #[cfg(windows)]
    #[test]
    fn a_link_that_cannot_be_removed_stops_the_download_before_anything_is_written() {
        use std::os::windows::fs::OpenOptionsExt;
        let mut s = Scene::new("stuck");
        // The original defect created this file and wrote the download into it.
        let target = s.users.join("not-there-yet.bin");
        if !link_file(&s.part, &target) {
            note("NOT TESTED (a link that cannot be removed): this account may not create a symbolic link to a file");
            return;
        }
        s.settle();
        // Something has the link itself open (FILE_FLAG_OPEN_REPARSE_POINT) and shares it for reading only,
        // so it cannot be deleted.
        let holder = fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x0020_0000).open(&s.part).unwrap();

        let result = s.download(Mode::Start);
        assert!(refused(&result), "{result:?}");
        assert_eq!(s.requests(), 0);
        assert!(is_link(&s.part) && !target.exists());
        s.assert_nothing_outside_changed();

        drop(holder);
        s.download(Mode::Start).expect("with the link free to go, the download runs");
        assert!(!target.exists());
        s.assert_nothing_outside_changed();
        s.assert_installed();
    }
}

// ── integrity ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_wrong_checksum_is_refused_and_nothing_is_kept() {
    let f = fixture("badsum");
    let other = sha(b"a different file");
    let a = artifact_with_sha(&f.server, "/file", f.data.len() as u64, other.clone(), "badsum");
    match run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()) {
        Err(DownloadError::ChecksumMismatch { expected, actual }) => {
            assert_eq!(expected, other);
            assert_eq!(actual, sha(&f.data));
        }
        r => panic!("expected a checksum mismatch, got {r:?}"),
    }
    assert!(!f.store.partial_path(a).exists() && !f.store.installed_path(a).exists() && !f.store.record_path(a).exists());
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded);
}

#[test]
fn a_corrupted_partial_is_caught_by_the_final_checksum() {
    let f = fixture("corrupt");
    let a = artifact(&f.server, "/file", &f.data, "corrupt");
    let mut prefix = f.data[..500_000].to_vec();
    prefix[4096] ^= 0xff;
    fs::write(f.store.partial_path(a), &prefix).unwrap();
    assert!(matches!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::ChecksumMismatch { .. })));
    assert!(!f.store.partial_path(a).exists(), "the damaged partial is deleted");
    assert!(!f.store.installed_path(a).exists(), "and nothing was installed");
}

#[test]
fn an_oversized_partial_is_discarded() {
    let f = fixture("oversized");
    let a = artifact(&f.server, "/file", &f.data, "oversized");
    let mut too_long = f.data.clone();
    too_long.extend_from_slice(&[0u8; 10]);
    fs::write(f.store.partial_path(a), &too_long).unwrap();
    assert_eq!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::OversizedPartial { bytes: a.size + 10 }));
    assert!(!f.store.partial_path(a).exists());
}

#[test]
fn a_server_that_ignores_ranges_fails_closed_without_writing() {
    let f = fixture("norange");
    f.server.faults.lock().unwrap().ignore_range = true;
    let a = artifact(&f.server, "/file", &f.data, "norange");
    assert!(matches!(run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()), Err(DownloadError::BadResponse { kept_bytes: 0, .. })));
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded, "no empty partial is left behind");

    // With bytes already on disk, they are kept exactly as they were.
    fs::write(f.store.partial_path(a), &f.data[..123_456]).unwrap();
    assert!(matches!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::BadResponse { kept_bytes: 123_456, .. })));
    assert_eq!(fs::read(f.store.partial_path(a)).unwrap(), f.data[..123_456]);
}

#[test]
fn a_wrong_content_range_fails_closed() {
    let f = fixture("wrongrange");
    f.server.faults.lock().unwrap().wrong_range = true;
    let a = artifact(&f.server, "/file", &f.data, "wrongrange");
    fs::write(f.store.partial_path(a), &f.data[..200_000]).unwrap();
    assert!(matches!(run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::BadResponse { kept_bytes: 200_000, .. })));
    assert_eq!(fs::metadata(f.store.partial_path(a)).unwrap().len(), 200_000);
}

#[test]
fn bytes_beyond_the_requested_range_are_never_stored() {
    let f = fixture("extra");
    f.server.faults.lock().unwrap().extra_byte = true;
    let a = artifact(&f.server, "/file", &f.data, "extra");
    // Bytes already on disk make the check meaningful: they must survive, and nothing wrong may follow them.
    fs::write(f.store.partial_path(a), &f.data[..100_000]).unwrap();
    match run(&f, a, Mode::Resume, &Policy::loopback_for_tests(), &no()) {
        Err(DownloadError::BadResponse { detail, .. }) => assert!(detail.contains("more than the range"), "{detail}"),
        other => panic!("expected the over-long body to be refused, got {other:?}"),
    }
    let on_disk = fs::read(f.store.partial_path(a)).unwrap();
    assert!(on_disk.len() >= 100_000 && on_disk.len() <= f.data.len());
    assert_eq!(on_disk, f.data[..on_disk.len()], "only correct bytes of the file were kept");
}

#[test]
fn server_errors_are_retried_then_reported_with_the_partial_kept() {
    let f = fixture("5xx");
    let a = artifact(&f.server, "/file", &f.data, "5xx");
    {
        let mut x = f.server.faults.lock().unwrap();
        x.fail_next = 2;
        x.fail_status = 503;
    }
    run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).expect("two failures fit within the attempts");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);

    let g = fixture("5xx-always");
    let b = artifact(&g.server, "/file", &g.data, "5xx-always");
    fs::write(g.store.partial_path(b), &g.data[..400_000]).unwrap();
    {
        let mut x = g.server.faults.lock().unwrap();
        x.fail_next = 1000;
        x.fail_status = 500;
    }
    assert!(matches!(run(&g, b, Mode::Resume, &Policy::loopback_for_tests(), &no()), Err(DownloadError::BadResponse { kept_bytes: 400_000, .. })));
    assert_eq!(g.store.state(b).unwrap(), State::Interrupted { bytes: 400_000 });
}

#[test]
fn a_redirect_off_the_allowed_hosts_is_refused() {
    let f = fixture("away");
    let a = artifact(&f.server, "/redirect-away", &f.data, "away");
    assert!(matches!(run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()), Err(DownloadError::UrlRefused(_))));
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded);
}

#[test]
fn only_https_urls_on_allowed_hosts_are_accepted() {
    let p = Policy::production();
    for ok in [
        "https://huggingface.co/x",
        "https://HuggingFace.CO/x",
        "https://us.aws.cdn.hf.co/x?X-Amz-Signature=abc",
        "https://cas-bridge.xethub.hf.co/x",
        "https://github.com/ggml-org/llama.cpp/releases/download/b11501/x.zip",
        "https://release-assets.githubusercontent.com/x",
        "https://huggingface.co:443/x",
    ] {
        assert!(check_url(&p, ok).is_ok(), "{ok} should be accepted");
    }
    for bad in [
        "http://huggingface.co/x",
        "https://huggingface.co.evil.com/x",
        "https://evilhuggingface.co/x",
        "https://cdn.hf.co.evil.net/x",
        "https://huggingface.co:443@evil.com/x",
        "https://user@huggingface.co/x",
        "https://huggingface.co:8443/x",
        "https://evil.com/?u=https://huggingface.co",
        "ftp://huggingface.co/x",
        "/relative/path",
        "http://127.0.0.1/x",
        "https://raw.githubusercontent.com/x",
    ] {
        assert!(check_url(&p, bad).is_err(), "{bad} should be refused");
    }
}

#[test]
fn insufficient_space_is_refused_before_any_request() {
    let f = fixture("nospace");
    let a = artifact(&f.server, "/file", &f.data, "nospace");
    let policy = Policy::loopback_for_tests().with_space_probe(|_| Some(1_000), 0);
    assert_eq!(run(&f, a, Mode::Start, &policy, &no()), Err(DownloadError::InsufficientSpace { needed: a.size, available: 1_000 }));
    assert_eq!(f.server.stats.lock().unwrap().requests, 0);
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded);
}

// ── store state, verification and removal ───────────────────────────────────────────────────────

#[test]
fn state_is_derived_from_what_is_on_disk() {
    let f = fixture("state");
    let a = artifact(&f.server, "/file", &f.data, "state");
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded);

    // A file without a record is never trusted until it has been hashed again.
    fs::create_dir_all(f.store.artifact_dir(a)).unwrap();
    fs::write(f.store.installed_path(a), &f.data).unwrap();
    assert_eq!(f.store.state(a).unwrap(), State::Unverified);
    assert_eq!(f.store.verify(a, &no()).unwrap(), State::Installed);
    assert_eq!(f.store.state(a).unwrap(), State::Installed);

    // A record that no longer matches the file is reported, not believed.
    fs::write(f.store.installed_path(a), &f.data[..10]).unwrap();
    assert!(matches!(f.store.state(a).unwrap(), State::Damaged { .. }));
    assert_eq!(f.store.verify(a, &no()).unwrap(), State::NotDownloaded, "a file that fails verification is deleted");
    assert!(!f.store.installed_path(a).exists() && !f.store.record_path(a).exists());
}

/// Everything under `root` except the translation directory: path → (length, SHA-256, modified).
fn snapshot(root: &Path, skip: &Path) -> BTreeMap<PathBuf, (u64, String, SystemTime)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.starts_with(skip) {
                continue;
            }
            let m = fs::metadata(&p).unwrap();
            if m.is_dir() {
                stack.push(p);
            } else {
                out.insert(p.clone(), (m.len(), sha(&fs::read(&p).unwrap()), m.modified().unwrap()));
            }
        }
    }
    out
}

/// A stand-in for the user's own data next to the translation directory.
fn user_data(root: &Path) {
    fs::create_dir_all(root.join("library")).unwrap();
    fs::write(root.join("sard.db"), b"database pages").unwrap();
    fs::write(root.join("sard.db-wal"), b"write-ahead log").unwrap();
    fs::write(root.join("library").join("a-book.epub"), test_bytes(40_000, 7)).unwrap();
    fs::write(root.join("library").join("notes-and-highlights.json"), b"{\"highlights\":[1,2,3]}").unwrap();
}

#[test]
fn the_whole_lifecycle_never_touches_anything_outside_the_translation_directory() {
    let tmp = TempDir::new("lifecycle");
    user_data(&tmp.0);
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let data = test_bytes(SIZE, 99);
    let server = TestServer::start(data.clone());
    let a = artifact(&server, "/redirect", &data, "lifecycle");
    // The store resolves its root (on Windows to a `\\?\` path); the walk below sees the plain one.
    let translation_dir = tmp.0.join("translation");
    let before = snapshot(&tmp.0, &translation_dir);
    let policy = Policy::loopback_for_tests();

    let cancel = Arc::new(AtomicBool::new(false));
    server.faults.lock().unwrap().cancel_when_past = Some((500_000, cancel.clone()));
    assert!(matches!(download(&store, a, Mode::Start, &policy, &cancel, |_| {}), Err(DownloadError::Cancelled { .. })));
    server.faults.lock().unwrap().cancel_when_past = None;
    download(&store, a, Mode::Resume, &policy, &no(), |_| {}).unwrap();
    assert_eq!(store.verify(a, &no()).unwrap(), State::Installed);
    let removal = store.remove(a).unwrap();
    assert_eq!(store.state(a).unwrap(), State::NotDownloaded);
    assert!(removal.freed >= a.size, "freed {} for a {}-byte file", removal.freed, a.size);
    assert!(removal.kept.is_empty());

    let after = snapshot(&tmp.0, &translation_dir);
    assert!(!before.is_empty() && before.keys().all(|k| !k.starts_with(&translation_dir)), "the snapshot covers the user's data only");
    assert_eq!(before, after, "the user's data is byte-identical, with the same modification times, and nothing was added beside it");
}

#[test]
fn removal_deletes_only_what_the_store_wrote() {
    let f = fixture("remove");
    let a = artifact(&f.server, "/file", &f.data, "remove");
    run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).unwrap();
    // Something the store did not write, in the model's own directory.
    let stranger = f.store.artifact_dir(a).join("my-notes.txt");
    fs::write(&stranger, b"keep me").unwrap();
    let record_len = fs::metadata(f.store.record_path(a)).unwrap().len();

    let removal = f.store.remove(a).unwrap();
    assert_eq!(removal.freed, a.size + record_len);
    assert_eq!(removal.kept, vec!["my-notes.txt".to_string()]);
    assert_eq!(fs::read(&stranger).unwrap(), b"keep me");
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded);

    fs::remove_file(&stranger).unwrap();
    assert_eq!(f.store.remove(a).unwrap().kept, Vec::<String>::new());
    assert!(!f.store.artifact_dir(a).exists(), "an empty directory is removed");
}

#[test]
fn removing_also_discards_an_unfinished_download() {
    let f = fixture("removepartial");
    let a = artifact(&f.server, "/file", &f.data, "removepartial");
    fs::write(f.store.partial_path(a), &f.data[..1000]).unwrap();
    assert_eq!(f.store.remove(a).unwrap().freed, 1000);
    assert_eq!(f.store.state(a).unwrap(), State::NotDownloaded);
}

/// A model directory replaced by a link to the user's files must not turn a removal into deleting them.
#[test]
fn a_link_planted_in_the_root_cannot_redirect_a_removal() {
    let tmp = TempDir::new("link");
    let outside = tmp.0.join("users-folder");
    fs::create_dir_all(&outside).unwrap();
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let data = test_bytes(1000, 3);
    let server = TestServer::start(data.clone());
    let a = artifact(&server, "/file", &data, "link");
    fs::write(outside.join(a.file_name), b"the user's file").unwrap();
    fs::write(outside.join(RECORD_NAME), b"the user's other file").unwrap();
    // The plain path, not the store's resolved one: `mklink` does not take a `\\?\` path.
    let link = tmp.0.join("translation").join("models").join(a.id);

    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    #[cfg(windows)]
    {
        // A directory junction needs no privilege, which is what makes it the realistic attack here.
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J failed");
    }

    let err = store.remove(a).expect_err("the removal must be refused");
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(fs::read(outside.join(a.file_name)).unwrap(), b"the user's file");
    assert_eq!(fs::read(outside.join(RECORD_NAME)).unwrap(), b"the user's other file");
}

#[test]
fn the_translation_root_is_its_own_directory_under_local_app_data() {
    let local = Path::new("C:/Users/someone/AppData/Local/com.sard.app");
    assert_eq!(super::store::default_root(local), local.join("translation"));
}

#[cfg(windows)]
#[test]
fn free_space_is_reported_on_windows() {
    let free = super::download::available_space(&std::env::temp_dir()).expect("free space");
    assert!(free > 0);
}

// ── against the real hosts — run by hand: cargo test translation -- --ignored ───────────────────

/// Downloads the 33 MB runtime archive from its real source, cancels part-way, resumes, and checks the
/// result against the catalog. Light: one small file.
#[test]
#[ignore]
fn real_runtime_archive_cancel_resume_and_verify() {
    use super::catalog::RUNTIME_WINDOWS_X64 as R;
    let tmp = TempDir::new("real-runtime");
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let policy = Policy::production();
    let cancel = AtomicBool::new(false);
    let r = download(&store, &R, Mode::Start, &policy, &cancel, |p| {
        if p.done >= 8 * 1024 * 1024 {
            cancel.store(true, Ordering::Relaxed);
        }
    });
    let kept = match r {
        Err(DownloadError::Cancelled { kept_bytes }) => kept_bytes,
        other => panic!("expected a cancel, got {other:?}"),
    };
    println!("cancelled with {kept} bytes kept");
    assert_eq!(store.state(&R).unwrap(), State::Interrupted { bytes: kept });
    download(&store, &R, Mode::Resume, &policy, &no(), |_| {}).expect("resume");
    assert_eq!(store.verify(&R, &no()).unwrap(), State::Installed);
    println!("verified {} bytes, sha256 {}", R.size, R.sha256);
}

/// Each model source answers a ranged request for its first bytes with 206, the catalog's exact size,
/// and the GGUF magic — without downloading the model.
#[test]
#[ignore]
fn real_model_sources_serve_the_cataloged_file() {
    use super::catalog::{MODEL_A, MODEL_B};
    use super::download::{agent, fetch_range};
    use std::io::Read;
    let policy = Policy::production();
    let ag = agent(&policy);
    for m in [MODEL_A, MODEL_B] {
        let (status, cr, body, host) = match fetch_range(&ag, &policy, m.sources[0].url, 0, 15) {
            Ok(x) => x,
            Err(_) => panic!("{}: request failed", m.id),
        };
        let mut head = Vec::new();
        body.into_reader().take(16).read_to_end(&mut head).unwrap();
        println!("{}: {status} {cr:?} via {}", m.id, host.split('?').next().unwrap_or(""));
        assert_eq!(status, 206);
        assert_eq!(cr.as_deref(), Some(format!("bytes 0-15/{}", m.size).as_str()));
        assert_eq!(&head[..4], b"GGUF");
    }
}
