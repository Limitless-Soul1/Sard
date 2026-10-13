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
    let (mut out, central) = zip_parts(entries);
    let end = end_record(entries.len() as u16, central.len() as u32, out.len() as u32);
    out.extend(central);
    out.extend(end);
    out
}

/// The end-of-central-directory record for a directory of `count` entries, `size` bytes long, at `offset`.
fn end_record(count: u16, size: u32, offset: u32) -> Vec<u8> {
    let mut end = Vec::new();
    end.extend(0x0605_4b50u32.to_le_bytes());
    end.extend(0u16.to_le_bytes());
    end.extend(0u16.to_le_bytes());
    end.extend(count.to_le_bytes());
    end.extend(count.to_le_bytes());
    end.extend(size.to_le_bytes());
    end.extend(offset.to_le_bytes());
    end.extend(0u16.to_le_bytes());
    end
}

/// The two halves of an archive: the local headers with their data, and the central directory describing them.
fn zip_parts(entries: &[Entry]) -> (Vec<u8>, Vec<u8>) {
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
    (out, central)
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
        // Any runtime of this family will do for the stand-in; the pinned engine asks for more.
        min_vc_runtime: (14, 0),
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
fn refuses_archives_that_are_not_in_the_one_plain_form() {
    let _serial = serial_for_tests();
    let files = small_engine();
    let good = build_zip(&entries(&files));
    let end = good.len() - 22;
    let u32_at = |at: usize| u32::from_le_bytes(good[at..at + 4].try_into().unwrap());
    let patched = |at: usize, bytes: &[u8]| {
        let mut b = good.clone();
        b[at..at + bytes.len()].copy_from_slice(bytes);
        b
    };

    let mut trailing = good.clone();
    trailing.extend_from_slice(b"appended after the archive");
    // "Disk 1, with its directory on disk 1" — consistent with itself, so only a reader that insists on a
    // single part refuses it.
    let in_parts = patched(end + 4, &[1, 0, 1, 0]);
    let fewer_here = patched(end + 8, &[1, 0]);
    let short_directory = patched(end + 12, &(u32_at(end + 12) - 1).to_le_bytes());
    // Four headers in the directory, and a record that admits to three: the fourth would be read by no one.
    let uncounted = patched(end + 8, &[3, 0, 3, 0]);
    // The first entry is made to point one byte past its real header.
    let astray = patched(u32_at(end + 16) as usize + 42, &1u32.to_le_bytes());

    for (tag, bytes) in [
        ("trailing", trailing),
        ("in-parts", in_parts),
        ("fewer-here", fewer_here),
        ("short-directory", short_directory),
        ("uncounted", uncounted),
        ("astray", astray),
    ] {
        let f = fixture_from_bytes(tag, &files, &bytes);
        let result = install_engine(&f);
        assert!(matches!(result, Err(InstallError::UnreadableArchive(_))), "{tag}: {result:?}");
        f.assert_nothing_installed();
    }
}

/// Where the last header of a central directory starts.
fn last_header(directory: &[u8]) -> usize {
    let u16_at = |at: usize| u16::from_le_bytes([directory[at], directory[at + 1]]) as usize;
    let (mut at, mut last) = (0, 0);
    while at < directory.len() {
        last = at;
        at += 46 + u16_at(at + 28) + u16_at(at + 30) + u16_at(at + 32);
    }
    last
}

#[test]
fn refuses_an_archive_that_two_readers_would_read_differently() {
    let _serial = serial_for_tests();
    let files = small_engine();
    // Two central directories over the same files. The first names an entry the spec does not know. The second
    // comes last, so it is the one this module reads, and it names only known entries — but it is written so
    // that the zip library cannot use it, and falls back to the first.
    let hidden = b"what the second directory hides";
    let mut first = entries(&files);
    first.push(Entry::file("ggml-rpc.dll", b"never installed"));
    first.push(Entry::file("an-unknown-backend.dll", hidden));
    let mut second = entries(&files);
    second.push(Entry::file("ggml-rpc.dll", b"never installed"));
    second.push(Entry::file("llama-bench.exe", hidden));

    let (locals, directory_one) = zip_parts(&first);
    let (_, mut directory_two) = zip_parts(&second);
    // In the second directory's last entry: a size of 0xFFFFFFFF, and a ZIP64 field too short to supply it.
    let last = last_header(&directory_two);
    directory_two[last + 24..last + 28].copy_from_slice(&[0xFF; 4]);
    let extra: [u8; 20] = [0x01, 0x00, 0x04, 0x00, 0, 0, 0, 0, 0xFE, 0xCA, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0];
    directory_two[last + 30..last + 32].copy_from_slice(&(extra.len() as u16).to_le_bytes());
    directory_two.extend_from_slice(&extra);

    let mut archive = locals;
    let one_at = archive.len() as u32;
    archive.extend(&directory_one);
    archive.extend(end_record(first.len() as u16, directory_one.len() as u32, one_at));
    let two_at = archive.len() as u32;
    archive.extend(&directory_two);
    archive.extend(end_record(second.len() as u16, directory_two.len() as u32, two_at));

    let f = fixture_from_bytes("two-readers", &files, &archive);
    assert_eq!(
        install_engine(&f),
        Err(InstallError::UnreadableArchive("the central directory and the archive disagree on the entries".into()))
    );
    f.assert_nothing_installed();
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

#[test]
fn a_crash_between_the_two_moves_leaves_no_engine_at_all() {
    let _serial = serial_for_tests();
    let f = fixture("crash-between-moves");
    install_engine(&f).unwrap();
    // The old engine has been moved aside and the new one has not yet taken its place.
    let crash = Faults { crash_between_moves: true, ..Faults::default() };
    assert!(install::install_with(&f.store, f.spec, &never(), crash).is_err());

    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::NotInstalled);
    assert!(install::verify(&f.store, f.spec).is_err());
    assert_eq!(f.leftovers().len(), 2, "the old engine set aside, and the new one still staged");

    install_engine(&f).unwrap();
    assert_eq!(f.leftovers(), Vec::<String>::new());
    install::verify(&f.store, f.spec).unwrap();
}

#[test]
fn a_cleanup_that_fails_leaves_a_whole_engine_and_says_so() {
    let _serial = serial_for_tests();
    let f = fixture("cleanup-fails");
    install_engine(&f).unwrap();
    // Something this module will not delete — a folder — sits in the engine that is about to be replaced.
    fs::create_dir(f.dir().join("stray-folder")).unwrap();
    assert!(install::verify(&f.store, f.spec).is_err(), "that engine is no longer one that would be launched");

    // The new engine goes in; clearing away the old one is what fails, and the failure is reported.
    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    assert_eq!(install::state(&f.store, f.spec).unwrap(), EngineState::Installed);
    install::verify(&f.store, f.spec).expect("what is in place is the new engine, whole and recorded");
    let left = f.leftovers();
    assert_eq!(left.len(), 1, "the old engine, set aside: {left:?}");
    assert!(f.base().join(&left[0]).join("stray-folder").is_dir(), "the folder was not deleted");

    // Until that is dealt with, another installation is refused — and the engine in place stays as it is.
    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    install::verify(&f.store, f.spec).unwrap();

    fs::remove_dir(f.base().join(&left[0]).join("stray-folder")).unwrap();
    install_engine(&f).unwrap();
    assert_eq!(f.leftovers(), Vec::<String>::new());
    install::verify(&f.store, f.spec).unwrap();
}

#[test]
fn a_recheck_that_cannot_clean_up_still_leaves_nothing_that_would_be_launched() {
    let _serial = serial_for_tests();
    let f = fixture("recheck-fails");
    // An engine with no record, whose contents are wrong, and which cannot be removed either.
    let crash = Faults { crash_before_record: true, ..Faults::default() };
    assert!(install::install_with(&f.store, f.spec, &never(), crash).is_err());
    flip_byte(&f.dir().join("ggml-cpu-x64.dll"), 10);
    fs::create_dir(f.dir().join("stray-folder")).unwrap();

    assert!(matches!(install::verify_installation(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert_ne!(install::state(&f.store, f.spec).unwrap(), EngineState::Installed);
    assert!(install::verify(&f.store, f.spec).is_err());
    assert!(install::check_unchanged(&f.store, f.spec).is_err());

    // With the folder gone the wrong engine is removed, not recorded.
    fs::remove_dir(f.dir().join("stray-folder")).unwrap();
    assert_eq!(install::verify_installation(&f.store, f.spec).unwrap(), EngineState::NotInstalled);
    f.assert_nothing_installed();
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
    assert_eq!(install::verify(&f.store, f.spec).unwrap_err(), InstallError::WrongChecksum { name: "ggml-cpu-x64.dll".into() });
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

// ---- Links, junctions and other redirections ----

/// Put a directory link at `link`, pointing to `target`: a junction on Windows (which needs no privilege), a
/// symbolic link elsewhere.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never a console window on the screen.
        let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).creation_flags(0x0800_0000).output().unwrap();
        assert!(out.status.success(), "mklink failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// Remove a directory link itself, never its target.
fn unlink_dir(link: &Path) {
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(link).unwrap();
}

/// Put a symbolic link to a FILE at `link`. On Windows that needs a privilege an ordinary account may not have,
/// so this reports whether it could be done.
fn try_link_file(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link).is_ok();
    #[cfg(not(windows))]
    let made = std::os::unix::fs::symlink(target, link).is_ok();
    made
}

/// A line that must be seen even when the test passes — a case that could not be run. The test harness hides
/// what a passing test prints, so this goes to the error stream directly.
fn note(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

#[test]
fn a_link_in_place_of_the_engine_directory_is_refused_and_never_followed() {
    let _serial = serial_for_tests();
    let f = fixture("link-engine");
    install_engine(&f).unwrap();
    let outside = f.tmp.0.join("outside");
    fs::rename(f.dir(), &outside).unwrap();
    link_dir(&f.dir(), &outside);
    let before = listing(&outside);

    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install::check_unchanged(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install::remove(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    assert_eq!(listing(&outside), before, "nothing outside the translation directory was touched");

    unlink_dir(&f.dir());
}

#[test]
fn a_link_planted_as_a_leftover_is_refused_and_never_followed() {
    let _serial = serial_for_tests();
    let f = fixture("link-leftover");
    let outside = f.tmp.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.txt"), b"the user's file").unwrap();
    let planted = f.base().join(".staging-planted");
    link_dir(&planted, &outside);

    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"the user's file");

    unlink_dir(&planted);
}

#[test]
fn a_redirection_above_the_engine_directory_is_refused_even_inside_the_translation_directory() {
    let _serial = serial_for_tests();
    let f = fixture("link-above");
    install_engine(&f).unwrap();
    // The whole runtime directory is moved elsewhere INSIDE the translation directory, and a link is left in
    // its place. Every path still resolves inside the root — just not to where it claims to be.
    let moved = f.store.root().join("moved-aside");
    fs::rename(f.base(), &moved).unwrap();
    link_dir(&f.base(), &moved);
    let before = listing(&moved.join(ENGINE_DIR));

    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install::check_unchanged(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install::verify_installation(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install::remove(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert!(matches!(install_engine(&f), Err(InstallError::PathRefused(_))));
    assert_eq!(listing(&moved.join(ENGINE_DIR)), before, "nothing reached through the link was touched");
    assert!(moved.join(ENGINE_RECORD).exists(), "nor was its record");

    unlink_dir(&f.base());
}

#[test]
fn a_file_link_inside_the_engine_directory_is_refused_and_its_target_survives() {
    let _serial = serial_for_tests();
    let f = fixture("link-inside");
    install_engine(&f).unwrap();
    // One engine file is moved out and a link to it left in its place: the bytes behind the name are the
    // right ones, and it is still not the engine's file.
    let outside = f.tmp.0.join("outside.dll");
    let name = f.dir().join("ggml-base.dll");
    fs::rename(&name, &outside).unwrap();
    if !try_link_file(&name, &outside) {
        note("NOT TESTED (a file link inside the engine directory): this account may not create symbolic links");
        return;
    }

    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    assert!(matches!(install::check_unchanged(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    assert!(matches!(install::remove(&f.store, f.spec), Err(InstallError::PathRefused(_))));
    assert_eq!(fs::read(&outside).unwrap(), small_engine()[1].1, "the link's target is untouched");

    let _ = fs::remove_file(&name);
}

#[test]
fn a_hard_link_loses_only_its_own_name() {
    let _serial = serial_for_tests();
    let f = fixture("hard-link");
    install_engine(&f).unwrap();
    // One of the engine's files and a file outside become two names for the same bytes.
    let outside = f.tmp.0.join("outside.dll");
    fs::hard_link(f.dir().join("ggml-base.dll"), &outside).unwrap();

    let held = install::verify(&f.store, f.spec).unwrap();
    #[cfg(windows)]
    assert!(fs::OpenOptions::new().write(true).open(&outside).is_err(), "a held file cannot be written through its other name either");
    drop(held);

    assert!(install::remove(&f.store, f.spec).unwrap() > 0);
    assert_eq!(fs::read(&outside).unwrap(), small_engine()[1].1, "the other name, and the bytes, remain");
}

#[test]
fn the_record_is_never_written_through_a_link() {
    let _serial = serial_for_tests();
    let f = fixture("record-link");
    let (first, second) = (f.tmp.0.join("first.txt"), f.tmp.0.join("second.txt"));
    fs::write(&first, b"the user's file").unwrap();
    fs::write(&second, b"another of the user's files").unwrap();
    // Links wait at both names the record is written through: its temporary name, and its own.
    let record = f.base().join(ENGINE_RECORD);
    let temporary = record.with_extension("json.tmp");
    if !try_link_file(&temporary, &first) || !try_link_file(&record, &second) {
        note("NOT TESTED (the record written through a link): this account may not create symbolic links");
        let _ = fs::remove_file(&temporary);
        return;
    }

    install_engine(&f).unwrap();
    assert_eq!(fs::read(&first).unwrap(), b"the user's file");
    assert_eq!(fs::read(&second).unwrap(), b"another of the user's files");
    let meta = fs::symlink_metadata(&record).unwrap();
    assert!(meta.is_file() && !meta.file_type().is_symlink(), "the record is a file of its own");
    install::verify(&f.store, f.spec).unwrap();
}

// ---- Between hashing and launching ----

#[test]
fn verified_files_are_held_so_that_they_cannot_be_changed() {
    let _serial = serial_for_tests();
    let f = fixture("held");
    install_engine(&f).unwrap();
    let file = f.dir().join("ggml-base.dll");
    let original = fs::read(&file).unwrap();

    let verified = install::verify(&f.store, f.spec).unwrap();
    assert_eq!(verified.held(), small_engine().len() + 1, "every engine file, and the notices");
    install::check_unchanged(&f.store, f.spec).unwrap();
    // Windows enforces what a handle shares; other systems do not, and the engine does not run there.
    #[cfg(windows)]
    {
        assert!(fs::OpenOptions::new().write(true).open(&file).is_err(), "opened for writing");
        assert!(fs::write(&file, b"replaced").is_err(), "overwritten");
        assert!(fs::remove_file(&file).is_err(), "deleted");
        assert!(fs::rename(&file, f.dir().join("moved.dll")).is_err(), "renamed");
        assert!(fs::rename(f.dir(), f.base().join("engine-moved")).is_err(), "its folder renamed");
        assert!(fs::rename(f.base(), f.store.root().join("moved")).is_err(), "a folder above it renamed");
        assert_eq!(fs::read(&file).unwrap(), original, "it can still be read, which is all loading needs");
        install::verify(&f.store, f.spec).expect("a second holder does not disturb the first");
    }

    // What holding does NOT prevent: a file added beside them. That is what the last check is for.
    let added = f.dir().join("ggml-added.dll");
    fs::write(&added, b"added").unwrap();
    assert!(matches!(install::check_unchanged(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    fs::remove_file(&added).unwrap();
    install::check_unchanged(&f.store, f.spec).unwrap();
    // The same goes for a link added beside them, wherever it leads.
    let outside = f.tmp.0.join("outside");
    fs::create_dir(&outside).unwrap();
    let linked = f.dir().join("ggml-linked");
    link_dir(&linked, &outside);
    assert!(matches!(install::check_unchanged(&f.store, f.spec), Err(InstallError::UnexpectedFile(_))));
    unlink_dir(&linked);
    install::check_unchanged(&f.store, f.spec).unwrap();

    drop(verified);
    fs::write(&file, &original).expect("released once the holder lets go");
}

#[cfg(windows)]
#[test]
fn a_file_something_has_open_for_writing_cannot_be_verified() {
    let _serial = serial_for_tests();
    let f = fixture("writer");
    install_engine(&f).unwrap();
    // It could be changed after it was hashed, so it is not accepted while a writer has it.
    let writer = fs::OpenOptions::new().write(true).open(f.dir().join("ggml-base.dll")).unwrap();
    assert!(matches!(install::verify(&f.store, f.spec), Err(InstallError::Io(_))));
    drop(writer);
    install::verify(&f.store, f.spec).unwrap();
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

    assert_eq!(spec.min_vc_runtime, (14, 51), "the tools this build was made with");

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
