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
use super::store::{hex, InstalledRecord, State, Store, RECORD_NAME, RECORD_TEMP_NAME};
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

// ── the record ──────────────────────────────────────────────────────────────────────────────────

/// Put a symbolic link to a FILE at `link`. On Windows that needs a privilege an ordinary account may
/// not have, so this reports whether it could be done.
fn try_link_file(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link).is_ok();
    #[cfg(not(windows))]
    let made = std::os::unix::fs::symlink(target, link).is_ok();
    made
}

/// A line that must be seen even when the test passes — a case that could not be run. The test harness
/// hides what a passing test prints, so this goes to the error stream directly.
fn note(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// A file already in place with no record — what a crash between moving it there and recording it leaves.
fn placed_without_a_record(tag: &str) -> (Fixture, &'static Artifact) {
    let f = fixture(tag);
    let a = artifact(&f.server, "/file", &f.data, tag);
    fs::create_dir_all(f.store.artifact_dir(a)).unwrap();
    fs::write(f.store.installed_path(a), &f.data).unwrap();
    assert_eq!(f.store.state(a).unwrap(), State::Unverified);
    (f, a)
}

fn temp_record(f: &Fixture, a: &Artifact) -> PathBuf {
    f.store.artifact_dir(a).join(RECORD_TEMP_NAME)
}

#[test]
fn the_record_is_never_written_through_a_link() {
    let (f, a) = placed_without_a_record("recordlink");
    let (first, second) = (f._tmp.0.join("first.txt"), f._tmp.0.join("second.txt"));
    fs::write(&first, b"the user's file").unwrap();
    fs::write(&second, b"another of the user's files").unwrap();
    // Links wait at both names the record is written through: its temporary name, and its own.
    if !try_link_file(&temp_record(&f, a), &first) || !try_link_file(&f.store.record_path(a), &second) {
        note("NOT TESTED (the record written through a link): this account may not create symbolic links");
        return;
    }

    assert_eq!(f.store.verify(a, &no()).unwrap(), State::Installed);
    assert_eq!(fs::read(&first).unwrap(), b"the user's file");
    assert_eq!(fs::read(&second).unwrap(), b"another of the user's files");
    let meta = fs::symlink_metadata(f.store.record_path(a)).unwrap();
    assert!(meta.is_file() && !meta.file_type().is_symlink(), "the record is a file of its own");
    assert!(fs::symlink_metadata(temp_record(&f, a)).is_err(), "nothing is left under the temporary name");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);
}

#[test]
fn a_download_does_not_write_its_record_through_a_link_either() {
    let f = fixture("recordlinkdl");
    let a = artifact(&f.server, "/file", &f.data, "recordlinkdl");
    let victim = f._tmp.0.join("victim.txt");
    fs::write(&victim, b"the user's file").unwrap();
    // The link is waiting before the download starts.
    fs::create_dir_all(f.store.artifact_dir(a)).unwrap();
    if !try_link_file(&temp_record(&f, a), &victim) {
        note("NOT TESTED (a download's record written through a link): this account may not create symbolic links");
        return;
    }

    run(&f, a, Mode::Start, &Policy::loopback_for_tests(), &no()).unwrap();
    assert_eq!(fs::read(&victim).unwrap(), b"the user's file");
    assert_eq!(f.store.state(a).unwrap(), State::Installed);
    assert!(fs::symlink_metadata(temp_record(&f, a)).is_err());
}

#[test]
fn a_stale_temporary_record_is_replaced_and_never_read() {
    let (f, a) = placed_without_a_record("staletemp");
    // What a crash between writing the record and renaming it leaves — here holding something that must not
    // be taken for a record.
    fs::write(temp_record(&f, a), b"{ not the record }").unwrap();
    assert_eq!(f.store.state(a).unwrap(), State::Unverified, "a temporary record is not a record");

    assert_eq!(f.store.verify(a, &no()).unwrap(), State::Installed);
    assert!(!temp_record(&f, a).exists());
    let rec: InstalledRecord = serde_json::from_slice(&fs::read(f.store.record_path(a)).unwrap()).unwrap();
    assert_eq!((rec.size, rec.sha256.as_str()), (a.size, a.sha256));
}

#[test]
fn a_record_that_cannot_be_put_in_place_leaves_the_file_not_installed() {
    let (f, a) = placed_without_a_record("norecord");
    // The record's own name is held by something a file cannot replace.
    fs::create_dir(f.store.record_path(a)).unwrap();

    assert!(f.store.verify(a, &no()).is_err());
    assert!(!matches!(f.store.state(a), Ok(State::Installed)));
    assert!(fs::symlink_metadata(temp_record(&f, a)).is_err(), "nothing half-written is left behind");

    // Once the obstacle is gone, the same file is hashed and recorded.
    fs::remove_dir(f.store.record_path(a)).unwrap();
    assert_eq!(f.store.verify(a, &no()).unwrap(), State::Installed);
}

#[test]
fn a_temporary_name_that_cannot_be_cleared_stops_the_record_being_written() {
    let (f, a) = placed_without_a_record("blockedtemp");
    // A folder holds the temporary name. It is not the store's, so it is neither written into nor deleted.
    let blocked = temp_record(&f, a);
    fs::create_dir(&blocked).unwrap();
    fs::write(blocked.join("inside.txt"), b"not the store's").unwrap();

    assert!(f.store.verify(a, &no()).is_err());
    assert_eq!(f.store.state(a).unwrap(), State::Unverified);
    assert_eq!(fs::read(blocked.join("inside.txt")).unwrap(), b"not the store's");

    let removal = f.store.remove(a).unwrap();
    assert_eq!(removal.kept, vec![RECORD_TEMP_NAME.to_string()], "kept, and said to be kept");
    assert_eq!(fs::read(blocked.join("inside.txt")).unwrap(), b"not the store's");
}

#[test]
fn removal_clears_a_leftover_temporary_record_without_following_it() {
    // A plain leftover is the store's own file: it goes, and the directory with it.
    let (f, a) = placed_without_a_record("removetemp");
    fs::write(temp_record(&f, a), b"left by a crash").unwrap();
    let removal = f.store.remove(a).unwrap();
    assert_eq!((removal.freed, removal.kept), (a.size + 15, Vec::<String>::new()));
    assert!(!f.store.artifact_dir(a).exists());

    // A link left there goes too — and what it points to stays.
    let (f, a) = placed_without_a_record("removetemplink");
    let victim = f._tmp.0.join("victim.txt");
    fs::write(&victim, b"the user's file").unwrap();
    if !try_link_file(&temp_record(&f, a), &victim) {
        note("NOT TESTED (removing a link left under the temporary name): this account may not create symbolic links");
        return;
    }
    let removal = f.store.remove(a).unwrap();
    assert_eq!((removal.freed, removal.kept), (a.size, Vec::<String>::new()));
    assert_eq!(fs::read(&victim).unwrap(), b"the user's file");
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
