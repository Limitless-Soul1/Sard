//! Engine installation tests. Every archive is built here, in memory, so that archives no ordinary tool would
//! write — duplicate entries, links, hostile names — can be tested. Nothing is downloaded and nothing is run,
//! except by the `#[ignore]`d test at the end, which installs (never runs) the real archive from a path given by
//! hand.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::catalog::{Artifact, EngineFile, EngineSpec, Kind, Licence, ENGINE_WINDOWS_X64, RUNTIME_WINDOWS_X64};
use super::install::{self, EngineState, Faults, InstallError, ENGINE_DIR, ENGINE_RECORD};
use super::slot::{self, serial_for_tests, Holder};
use super::store::{hex, State, Store, RECORD_NAME};

pub(super) struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("sard_engine_{tag}_{}_{nanos}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn leak_str(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

pub(super) fn sha(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub(super) fn never() -> AtomicBool {
    AtomicBool::new(false)
}

// ---- A minimal ZIP writer: stored entries, with every header field under the test's control ----

#[derive(Clone)]
pub(super) struct Entry {
    pub name: Vec<u8>,
    pub data: Vec<u8>,
    /// "Version made by": the high byte is the host system (0 = MS-DOS/Windows, 3 = Unix).
    pub made_by: u16,
    pub attributes: u32,
    pub flags: u16,
}

impl Entry {
    pub fn file(name: &str, data: &[u8]) -> Entry {
        Entry {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            made_by: 20,
            attributes: 0x20,
            flags: if name.is_ascii() { 0 } else { 0x800 },
        }
    }

    fn unix(mut self, mode: u32) -> Entry {
        self.made_by = (3 << 8) | 30;
        self.attributes = mode << 16;
        self
    }

    fn dos(mut self, attributes: u32) -> Entry {
        self.attributes = attributes;
        self
    }
}

fn crc32(data: &[u8]) -> u32 {
    let table: Vec<u32> = (0..256u32)
        .map(|n| (0..8).fold(n, |c, _| if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 }))
        .collect();
    !data.iter().fold(!0u32, |c, &b| table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8))
}

pub(super) fn build_zip(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for e in entries {
        let offset = out.len() as u32;
        let crc = crc32(&e.data);
        let size = e.data.len() as u32;
        let name_len = e.name.len() as u16;
        out.extend(0x0403_4b50u32.to_le_bytes());
        out.extend(20u16.to_le_bytes());
        out.extend(e.flags.to_le_bytes());
        out.extend(0u16.to_le_bytes()); // stored
        out.extend(0u16.to_le_bytes()); // time
        out.extend(0x21u16.to_le_bytes()); // date: 1980-01-01
        out.extend(crc.to_le_bytes());
        out.extend(size.to_le_bytes());
        out.extend(size.to_le_bytes());
        out.extend(name_len.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out.extend(&e.name);
        out.extend(&e.data);

        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(e.made_by.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(e.flags.to_le_bytes());
        central.extend(0u16.to_le_bytes());
        central.extend(0u16.to_le_bytes());
        central.extend(0x21u16.to_le_bytes());
        central.extend(crc.to_le_bytes());
        central.extend(size.to_le_bytes());
        central.extend(size.to_le_bytes());
        central.extend(name_len.to_le_bytes());
        central.extend(0u16.to_le_bytes()); // extra
        central.extend(0u16.to_le_bytes()); // comment
        central.extend(0u16.to_le_bytes()); // disk
        central.extend(0u16.to_le_bytes()); // internal attributes
        central.extend(e.attributes.to_le_bytes());
        central.extend(offset.to_le_bytes());
        central.extend(&e.name);
    }
    let (cd_offset, cd_size) = (out.len() as u32, central.len() as u32);
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend(cd_size.to_le_bytes());
    out.extend(cd_offset.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

// ---- Engine fixtures ----

pub(super) const NOTICES: &str = "Test notices\n";

pub(super) type Files = Vec<(String, Vec<u8>)>;

/// The files of a small test engine, the executable first.
pub(super) fn small_engine() -> Files {
    vec![
        ("llama-server.exe".into(), b"MZ test server".to_vec()),
        ("ggml-base.dll".into(), b"test base library".to_vec()),
        ("ggml-cpu-x64.dll".into(), (0..5000u32).map(|i| (i * 7 % 251) as u8).collect()),
        ("LICENSE-LLVM-OpenMP".into(), b"test licence".to_vec()),
    ]
}

/// Entries the test archives may hold that are not part of the engine: known to the spec, never extracted.
const UNUSED: &[&str] = &["ggml-rpc.dll", "llama-bench.exe", "naïve-tool.exe"];

pub(super) fn unlisted() -> Files {
    vec![
        ("ggml-rpc.dll".into(), b"never installed".to_vec()),
        ("llama-bench.exe".into(), b"not part of the engine".to_vec()),
    ]
}

pub(super) fn entries(files: &[(String, Vec<u8>)]) -> Vec<Entry> {
    files.iter().map(|(n, d)| Entry::file(n, d)).collect()
}

/// An engine spec pinning `files`, from a runtime archive whose bytes are `archive`.
pub(super) fn spec_for(tag: &str, files: &[(String, Vec<u8>)], archive: &[u8]) -> &'static EngineSpec {
    let artifact: &'static Artifact = Box::leak(Box::new(Artifact {
        id: leak_str(format!("test-runtime-{tag}")),
        kind: Kind::Runtime,
        file_name: "runtime.zip",
        size: archive.len() as u64,
        sha256: leak_str(sha(archive)),
        sources: &[],
        licence: Licence::LlamaCppRuntime,
    }));
    let files: Vec<EngineFile> = files
        .iter()
        .map(|(n, d)| EngineFile { name: leak_str(n.clone()), size: d.len() as u64, sha256: leak_str(sha(d)) })
        .collect();
    Box::leak(Box::new(EngineSpec {
        archive: artifact,
        files: Box::leak(files.into_boxed_slice()),
        unused: UNUSED,
        executable: "llama-server.exe",
        notices_name: "THIRD-PARTY-NOTICES.txt",
        notices: NOTICES,
    }))
}

/// Put `bytes` in the store as a verified download of `a` — what the download stage leaves behind.
pub(super) fn put_verified(store: &Store, a: &Artifact, bytes: &[u8]) {
    fs::create_dir_all(store.artifact_dir(a)).unwrap();
    fs::write(store.installed_path(a), bytes).unwrap();
    assert_eq!(store.verify(a, &never()).unwrap(), State::Installed);
}

pub(super) struct Fixture {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub tmp: TempDir,
    pub store: Store,
    pub spec: &'static EngineSpec,
}

impl Fixture {
    pub fn dir(&self) -> PathBuf {
        install::engine_dir(&self.store, self.spec)
    }

    fn base(&self) -> PathBuf {
        self.store.artifact_dir(self.spec.archive)
    }

    /// Staging and set-aside directories in the runtime directory.
    fn leftovers(&self) -> Vec<String> {
        listing(&self.base()).into_iter().filter(|n| n.starts_with('.')).collect()
    }

    fn assert_nothing_installed(&self) {
        assert!(fs::symlink_metadata(self.dir()).is_err(), "an engine directory exists");
        assert!(!self.base().join(ENGINE_RECORD).exists(), "a record exists");
        assert_eq!(self.leftovers(), Vec::<String>::new());
        assert_eq!(install::state(&self.store, self.spec).unwrap(), EngineState::NotInstalled);
    }
}

/// A fixture in the directory `tmp`, whose archive is exactly `archive`, pinning `files`.
pub(super) fn fixture_in(tmp: TempDir, tag: &str, files: &[(String, Vec<u8>)], archive: &[u8]) -> Fixture {
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let spec = spec_for(tag, files, archive);
    put_verified(&store, spec.archive, archive);
    Fixture { tmp, store, spec }
}

fn fixture_from_bytes(tag: &str, files: &[(String, Vec<u8>)], archive: &[u8]) -> Fixture {
    fixture_in(TempDir::new(tag), tag, files, archive)
}

/// A fixture pinning `files`, whose archive holds `archive_entries`.
fn fixture_with(tag: &str, files: &[(String, Vec<u8>)], archive_entries: &[Entry]) -> Fixture {
    fixture_from_bytes(tag, files, &build_zip(archive_entries))
}

/// The small engine, in an archive that also holds files that are not part of it.
fn fixture(tag: &str) -> Fixture {
    let files = small_engine();
    let mut all = entries(&files);
    all.extend(entries(&unlisted()));
    fixture_with(tag, &files, &all)
}

pub(super) fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn flip_byte(path: &Path, at: usize) {
    let mut bytes = fs::read(path).unwrap();
    bytes[at] ^= 0xFF;
    fs::write(path, bytes).unwrap();
}

fn install_engine(f: &Fixture) -> Result<(), InstallError> {
    install::install(&f.store, f.spec, &never())
}

// ---- Installing ----

#[test]
fn installs_exactly_the_listed_files_and_the_notices() {
    let _serial = serial_for_tests();
    let f = fixture("exact");
    install_engine(&f).unwrap();

    let mut expected: Vec<String> = small_engine().into_iter().map(|(n, _)| n).collect();
    expected.push("THIRD-PARTY-NOTICES.txt".into());
    expected.sort();
    assert_eq!(listing(&f.dir()), expected);
    for (name, data) in small_engine() {
        assert_eq!(fs::read(f.dir().join(&name)).unwrap(), data, "{name}");
    }
    assert_eq!(fs::read_to_string(f.dir().join("THIRD-PARTY-NOTICES.txt")).unwrap(), NOTICES);

    // The archive's other files are never extracted, anywhere.
    let mut base = vec![ENGINE_DIR.to_string(), ENGINE_RECORD.to_string(), RECORD_NAME.to_string(), "runtime.zip".to_string()];
    base.sort();
    assert_eq!(listing(&f.base()), base);

    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::Installed);
    let verified = install::verify(&f.store, f.spec).unwrap();
    assert_eq!(verified.executable, f.dir().join("llama-server.exe"));
    assert_eq!(verified.dir, f.dir());
}

#[test]
fn installs_from_archives_made_on_unix_and_with_utf8_names() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let mut all: Vec<Entry> = entries(&files).into_iter().map(|e| e.unix(0o100644)).collect();
    all.push(Entry::file("naïve-tool.exe", b"unlisted, with a UTF-8 name"));
    let f = fixture_with("unix-made", &files, &all);
    install_engine(&f).unwrap();
    install::verify(&f.store, f.spec).unwrap();
}

#[test]
fn refuses_an_archive_the_download_never_verified() {
    let _serial = serial_for_tests();
    let f = fixture("unverified-archive");
    fs::remove_file(f.store.record_path(f.spec.archive)).unwrap();
    assert_eq!(install_engine(&f), Err(InstallError::ArchiveNotInstalled));
    f.assert_nothing_installed();
}

#[test]
fn refuses_an_archive_changed_after_it_was_verified() {
    let _serial = serial_for_tests();
    let f = fixture("changed-archive");
    // Same size, so the store's metadata check still says Installed: only the fresh hash can tell.
    flip_byte(&f.store.installed_path(f.spec.archive), 40);
    assert_eq!(f.store.state(f.spec.archive).unwrap(), State::Installed);
    assert!(matches!(install_engine(&f), Err(InstallError::ArchiveChanged { .. })));
    f.assert_nothing_installed();
}

#[test]
fn refuses_corrupt_and_truncated_archives() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let good = build_zip(&entries(&files));
    let garbage: Vec<u8> = (0..4096u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let truncated = good[..good.len() - 30].to_vec();
    let mut bad_offset = good.clone();
    let eocd = bad_offset.len() - 22;
    bad_offset[eocd + 16..eocd + 20].copy_from_slice(&0u32.to_le_bytes());
    let mut zip64 = good.clone();
    zip64[eocd + 8..eocd + 12].copy_from_slice(&[0xFF; 4]);

    for (tag, bytes) in [("garbage", garbage), ("truncated", truncated), ("bad-offset", bad_offset), ("zip64", zip64)] {
        let f = fixture_from_bytes(tag, &files, &bytes);
        let result = install_engine(&f);
        assert!(matches!(result, Err(InstallError::UnreadableArchive(_))), "{tag}: {result:?}");
        f.assert_nothing_installed();
    }
}

#[test]
fn refuses_file_data_that_does_not_match_its_entry() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let mut bytes = build_zip(&entries(&files));
    // Damage a byte inside the third file's data; the central directory still describes the original.
    let at = bytes.windows(5).position(|w| w == &files[2].1[..5]).unwrap() + 100;
    bytes[at] ^= 0xFF;
    let f = fixture_from_bytes("damaged-data", &files, &bytes);
    let result = install_engine(&f);
    assert!(matches!(result, Err(InstallError::WrongChecksum { .. } | InstallError::UnreadableArchive(_))), "{result:?}");
    f.assert_nothing_installed();
}

#[test]
fn refuses_a_missing_file_a_wrong_size_and_a_wrong_checksum() {
    let _serial = serial_for_tests();
    let files = small_engine();

    let missing: Vec<Entry> = entries(&files).into_iter().filter(|e| e.name != b"ggml-base.dll").collect();
    let f = fixture_with("missing", &files, &missing);
    assert_eq!(install_engine(&f), Err(InstallError::MissingFile("ggml-base.dll".into())));
    f.assert_nothing_installed();

    let mut longer = files.clone();
    longer[1].1.push(b'!');
    let f = fixture_with("wrong-size", &files, &entries(&longer));
    assert!(matches!(install_engine(&f), Err(InstallError::WrongSize { ref name, .. }) if name == "ggml-base.dll"));
    f.assert_nothing_installed();

    let mut altered = files.clone();
    altered[1].1[0] ^= 0xFF;
    let f = fixture_with("wrong-checksum", &files, &entries(&altered));
    assert_eq!(install_engine(&f), Err(InstallError::WrongChecksum { name: "ggml-base.dll".into() }));
    f.assert_nothing_installed();
}

#[test]
fn refuses_the_whole_archive_for_any_unsafe_entry_name() {
    let _serial = serial_for_tests();
    let names: &[&[u8]] = &[
        b"../escape.dll",
        b"..\\escape.dll",
        b"sub/ggml.dll",
        b"/rooted.dll",
        b"\\rooted.dll",
        b"c:drive.dll",
        b"ggml.dll:stream",
        b"CON",
        b"nul.txt",
        b"com1.dll",
        b"Lpt9",
        b"trailing.dll.",
        b"trailing.dll ",
        b"bell\x07.dll",
        b"wild*.dll",
        b"what?.dll",
        b"pipe|.dll",
        b"<angle.dll",
        b"quote\".dll",
        b"",
        b".",
        b"..",
        b"folder/",
        // Not UTF-8, and the archive does not claim UTF-8: the name has no single meaning.
        &[0x80, b'x', b'.', b'd', b'l', b'l'],
    ];
    let files = small_engine();
    for (i, name) in names.iter().enumerate() {
        let mut all = entries(&files);
        all.push(Entry { name: name.to_vec(), ..Entry::file("placeholder", b"payload") });
        let f = fixture_with(&format!("unsafe-{i}"), &files, &all);
        let result = install_engine(&f);
        assert!(matches!(result, Err(InstallError::UnsafeEntry(_))), "{:?}: {result:?}", String::from_utf8_lossy(name));
        f.assert_nothing_installed();
    }

    // Claimed UTF-8 but invalid.
    let mut all = entries(&files);
    all.push(Entry { name: vec![0xC3, 0x28], flags: 0x800, ..Entry::file("placeholder", b"payload") });
    let f = fixture_with("unsafe-invalid-utf8", &files, &all);
    assert!(matches!(install_engine(&f), Err(InstallError::UnsafeEntry(_))));
    f.assert_nothing_installed();
}

#[test]
fn refuses_duplicate_entries_including_names_that_differ_only_by_case() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let cases: [(&str, Entry); 3] = [
        ("exact", Entry::file("ggml-base.dll", b"a second, different ggml-base.dll")),
        ("case", Entry::file("GGML-BASE.DLL", b"a second, different ggml-base.dll")),
        ("unlisted", Entry::file("LLAMA-BENCH.exe", b"twice")),
    ];
    for (tag, extra) in cases {
        let mut all = entries(&files);
        all.extend(entries(&unlisted()));
        all.push(extra);
        let f = fixture_with(&format!("duplicate-{tag}"), &files, &all);
        let result = install_engine(&f);
        assert!(matches!(result, Err(InstallError::DuplicateEntry(_))), "{tag}: {result:?}");
        f.assert_nothing_installed();
    }
}

#[test]
fn refuses_an_archive_holding_an_entry_the_spec_does_not_name() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let mut all = entries(&files);
    all.extend(entries(&unlisted()));
    // A perfectly ordinary name — but not one of the archive's known entries. Beside the engine it would be
    // loaded as a compute backend, so it is refused long before anything is extracted.
    all.push(Entry::file("ggml-cuda.dll", b"an extra backend"));
    let f = fixture_with("unexpected", &files, &all);
    assert_eq!(install_engine(&f), Err(InstallError::UnexpectedEntry("ggml-cuda.dll".into())));
    f.assert_nothing_installed();
}

#[test]
fn refuses_links_and_directories_anywhere_in_the_archive() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let link_listed = {
        let mut all = entries(&files);
        all[1] = all[1].clone().unix(0o120777);
        all
    };
    let with = |extra: Entry| {
        let mut all = entries(&files);
        all.push(extra);
        all
    };
    let cases: [(&str, Vec<Entry>); 5] = [
        ("link-listed", link_listed),
        ("link-unlisted", with(Entry::file("elsewhere.dll", b"../../outside").unix(0o120777))),
        ("unix-directory", with(Entry::file("directory", b"").unix(0o040755))),
        ("windows-directory", with(Entry::file("directory", b"").dos(0x10))),
        ("windows-reparse-point", with(Entry::file("reparse.dll", b"x").dos(0x400 | 0x20))),
    ];
    for (tag, all) in cases {
        let f = fixture_with(&format!("non-plain-{tag}"), &files, &all);
        let result = install_engine(&f);
        assert!(matches!(result, Err(InstallError::UnsafeEntry(_))), "{tag}: {result:?}");
        f.assert_nothing_installed();
    }
}

#[test]
fn a_cancelled_installation_leaves_nothing() {
    let _serial = serial_for_tests();
    let f = fixture("cancelled");
    assert_eq!(install::install(&f.store, f.spec, &AtomicBool::new(true)), Err(InstallError::Cancelled));
    f.assert_nothing_installed();
}

#[test]
fn installation_never_runs_while_the_engine_holds_the_slot() {
    let _serial = serial_for_tests();
    let f = fixture("busy");
    let engine = slot::claim(Holder::Engine).unwrap();
    assert_eq!(install_engine(&f), Err(InstallError::EngineBusy));
    assert_eq!(install::verify_installation(&f.store, f.spec), Err(InstallError::EngineBusy));
    assert_eq!(install::remove(&f.store, f.spec), Err(InstallError::EngineBusy));
    f.assert_nothing_installed();
    drop(engine);
    install_engine(&f).unwrap();
}

// ---- Interrupted installations ----

#[test]
fn an_interrupted_extraction_leaves_nothing_usable_and_is_cleared_next_time() {
    let _serial = serial_for_tests();
    let f = fixture("crash-during-files");
    let crash = Faults { crash_after_files: Some(2), ..Faults::default() };
    assert!(install::install_with(&f.store, f.spec, &never(), crash).is_err());

    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::NotInstalled);
    assert!(install::verify(&f.store, f.spec).is_err());
    assert_eq!(f.leftovers().len(), 1, "the staging directory a crash leaves");

    // Stray files under the leftover names must not block every later installation either.
    fs::write(f.base().join(".staging-stray"), b"not a directory").unwrap();
    fs::write(f.base().join(".old-stray"), b"not a directory").unwrap();

    install_engine(&f).unwrap();
    assert_eq!(f.leftovers(), Vec::<String>::new());
    install::verify(&f.store, f.spec).unwrap();
}

#[test]
fn a_crash_before_the_record_leaves_an_engine_that_is_not_launched_until_rehashed() {
    let _serial = serial_for_tests();
    let f = fixture("crash-before-record");
    let crash = Faults { crash_before_record: true, ..Faults::default() };
    assert!(install::install_with(&f.store, f.spec, &never(), crash).is_err());

    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::Unverified);
    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::NotRecorded(_))));

    assert_eq!(install::verify_installation(&f.store, f.spec).unwrap(), EngineState::Installed);
    install::verify(&f.store, f.spec).unwrap();
}

#[test]
fn an_unrecorded_engine_that_does_not_match_is_removed_not_recorded() {
    let _serial = serial_for_tests();
    let f = fixture("crash-then-tamper");
    let crash = Faults { crash_before_record: true, ..Faults::default() };
    assert!(install::install_with(&f.store, f.spec, &never(), crash).is_err());
    flip_byte(&f.dir().join("ggml-cpu-x64.dll"), 10);

    assert_eq!(install::verify_installation(&f.store, f.spec).unwrap(), EngineState::NotInstalled);
    f.assert_nothing_installed();
    assert_eq!(f.store.state(f.spec.archive).unwrap(), State::Installed, "the archive is kept");
}

#[test]
fn reinstalling_replaces_the_engine_and_recovers_from_a_crash_during_the_swap() {
    let _serial = serial_for_tests();
    let f = fixture("reinstall");
    install_engine(&f).unwrap();
    install_engine(&f).unwrap();
    assert_eq!(f.leftovers(), Vec::<String>::new());
    install::verify(&f.store, f.spec).unwrap();

    // A crash after the new engine moved in but before its record: the old one is still set aside.
    let crash = Faults { crash_before_record: true, ..Faults::default() };
    assert!(install::install_with(&f.store, f.spec, &never(), crash).is_err());
    assert_eq!(f.leftovers().len(), 1);
    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::Unverified);

    install_engine(&f).unwrap();
    assert_eq!(f.leftovers(), Vec::<String>::new());
    install::verify(&f.store, f.spec).unwrap();
}

// ---- Verifying before launch ----

#[test]
fn verify_refuses_a_planted_changed_or_missing_file() {
    let _serial = serial_for_tests();
    let f = fixture("tampered");
    install_engine(&f).unwrap();
    let dir = f.dir();

    // A backend library planted next to the engine would be loaded by it.
    fs::write(dir.join("ggml-rpc.dll"), b"planted").unwrap();
    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    assert!(matches!(install::state(&f.store, f.spec).unwrap(), EngineState::Damaged { .. }));
    fs::remove_file(dir.join("ggml-rpc.dll")).unwrap();

    fs::create_dir(dir.join("sub")).unwrap();
    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    fs::remove_dir(dir.join("sub")).unwrap();
    install::verify(&f.store, f.spec).unwrap();

    // Same size: the metadata state cannot see it, the full hash before launch does.
    flip_byte(&dir.join("ggml-cpu-x64.dll"), 4000);
    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::Installed);
    assert_eq!(install::verify(&f.store, f.spec), Err(InstallError::WrongChecksum { name: "ggml-cpu-x64.dll".into() }));
    flip_byte(&dir.join("ggml-cpu-x64.dll"), 4000);
    install::verify(&f.store, f.spec).unwrap();

    let notices = fs::read(dir.join("THIRD-PARTY-NOTICES.txt")).unwrap();
    fs::remove_file(dir.join("THIRD-PARTY-NOTICES.txt")).unwrap();
    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    fs::write(dir.join("THIRD-PARTY-NOTICES.txt"), notices).unwrap();
    install::verify(&f.store, f.spec).unwrap();
}

#[test]
fn verify_refuses_a_record_written_for_another_engine() {
    let _serial = serial_for_tests();
    let f = fixture("other-record");
    install_engine(&f).unwrap();
    let other = format!(
        r#"{{"archive_sha256":"{}","manifest_sha256":"{}","files":5,"installed_at_unix":0}}"#,
        f.spec.archive.sha256,
        "0".repeat(64)
    );
    fs::write(f.base().join(ENGINE_RECORD), other).unwrap();
    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::NotRecorded(_))));
    assert!(matches!(install::state(&f.store, f.spec).unwrap(), EngineState::Damaged { .. }));
}

#[test]
fn removing_the_engine_keeps_the_downloaded_archive() {
    let _serial = serial_for_tests();
    let f = fixture("remove");
    install_engine(&f).unwrap();
    assert!(install::remove(&f.store, f.spec).unwrap() > 0);
    f.assert_nothing_installed();
    assert_eq!(f.store.state(f.spec.archive).unwrap(), State::Installed);
    let mut base = vec![RECORD_NAME.to_string(), "runtime.zip".to_string()];
    base.sort();
    assert_eq!(listing(&f.base()), base);
    assert_eq!(install::remove(&f.store, f.spec), Ok(0), "removing twice is harmless");
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: never a console window on the screen.
    let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).creation_flags(0x0800_0000).output().unwrap();
    assert!(out.status.success(), "mklink failed: {}", String::from_utf8_lossy(&out.stderr));
}

#[cfg(windows)]
#[test]
fn a_junction_in_place_of_the_engine_directory_is_refused_and_never_followed() {
    let _serial = serial_for_tests();
    let f = fixture("junction-engine");
    install_engine(&f).unwrap();
    let outside = f.tmp.0.join("outside");
    fs::rename(f.dir(), &outside).unwrap();
    junction(&f.dir(), &outside);
    let before = listing(&outside);

    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install::remove(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    assert_eq!(listing(&outside), before, "nothing outside the translation directory was touched");

    fs::remove_dir(f.dir()).unwrap(); // the junction itself, not its target
}

#[cfg(windows)]
#[test]
fn a_junction_planted_as_a_leftover_is_refused_and_never_followed() {
    let _serial = serial_for_tests();
    let f = fixture("junction-leftover");
    let outside = f.tmp.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.txt"), b"the user's file").unwrap();
    let planted = f.base().join(".staging-planted");
    junction(&planted, &outside);

    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"the user's file");

    fs::remove_dir(&planted).unwrap();
}

// ---- The pinned engine ----

#[test]
fn the_pinned_engine_is_the_24_files_established_for_it() {
    let spec = &ENGINE_WINDOWS_X64;
    assert_eq!(spec.archive.id, RUNTIME_WINDOWS_X64.id);
    assert_eq!(spec.archive.sha256, RUNTIME_WINDOWS_X64.sha256);
    assert_eq!(spec.files.len(), 24);

    let mut lower: Vec<String> = spec.files.iter().map(|f| f.name.to_lowercase()).collect();
    lower.sort();
    lower.dedup();
    assert_eq!(lower.len(), 24, "names are unique, ignoring case");
    for f in spec.files {
        assert!(f.sha256.len() == 64 && f.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{}", f.name);
        assert!(f.size > 0, "{}", f.name);
        assert!(!f.name.contains(['/', '\\', ':']), "{}", f.name);
    }
    assert_eq!(spec.files.iter().map(|f| f.size).sum::<u64>(), 89_547_549);

    let has = |n: &str| spec.files.iter().any(|f| f.name == n);
    for required in [
        "llama-server.exe",
        "llama-server-impl.dll",
        "llama-common.dll",
        "llama.dll",
        "mtmd.dll",
        "ggml.dll",
        "ggml-base.dll",
        "libomp.dll",
        "ggml-vulkan.dll",
        "LICENSE-LLVM-OpenMP",
    ] {
        assert!(has(required), "{required}");
    }
    assert_eq!(spec.files.iter().filter(|f| f.name.starts_with("ggml-cpu-") && f.name.ends_with(".dll")).count(), 14);
    assert!(!has("ggml-rpc.dll"), "a remote backend would be loaded if present");
    assert!(has(spec.executable));

    // Every one of the archive's 52 entries is accounted for: 24 installed, 28 knowingly left out.
    assert_eq!(spec.unused.len(), 28);
    assert!(spec.unused.contains(&"ggml-rpc.dll"));
    let mut all: Vec<String> = spec.files.iter().map(|f| f.name.to_lowercase()).chain(spec.unused.iter().map(|n| n.to_lowercase())).collect();
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 52, "no name is both installed and left out, or listed twice");

    for licence in ["llama.cpp", "LLVM OpenMP", "cpp-httplib", "BoringSSL", "jsonhpp"] {
        assert!(spec.notices.contains(&format!("License for {licence}")), "{licence}");
    }
}

#[test]
#[ignore = "installs the real engine archive named by SARD_ENGINE_ARCHIVE (about 33 MB); nothing is run"]
fn installs_the_real_engine_archive() {
    let path = std::env::var_os("SARD_ENGINE_ARCHIVE").expect("SARD_ENGINE_ARCHIVE names the downloaded runtime archive");
    let _serial = serial_for_tests();
    let tmp = TempDir::new("real-archive");
    let store = Store::open(tmp.0.join("translation")).unwrap();
    put_verified(&store, &RUNTIME_WINDOWS_X64, &fs::read(path).unwrap());

    install::install(&store, &ENGINE_WINDOWS_X64, &never()).unwrap();
    let verified = install::verify(&store, &ENGINE_WINDOWS_X64).unwrap();
    let names = listing(&verified.dir);
    assert_eq!(names.len(), 25, "the 24 engine files and the notices: {names:?}");
    assert!(!names.iter().any(|n| n == "ggml-rpc.dll"));
    assert_eq!(install::state(&store, &ENGINE_WINDOWS_X64).unwrap(), EngineState::Installed);
}
