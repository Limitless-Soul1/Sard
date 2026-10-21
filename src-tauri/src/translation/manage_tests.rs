//! Managing the models, against the local test server only: the licence gate before anything, the check, the fetch
//! of the runtime, the engine and the model with its events, a cancel, a lost connection, a resume and a retry,
//! verification, and removal against a model in use. The test models carry the catalog models' ids (so the catalog's
//! needs and licences apply) and small test bytes; the runtime is the installer tests' small engine. No test reaches
//! the internet, starts an engine or uses the GPU.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use super::catalog::{Artifact, EngineFile, EngineSpec, Kind, Licence, Source, MODEL_A, MODEL_B};
use super::download::{DownloadError, Mode, Policy};
use super::download_server_tests::{test_bytes, TestServer};
use super::hardware::{Fit, HardwareError, HardwareReport, Memory, Undetermined};
use super::install::{self, EngineState};
use super::install_tests::{build_zip, entries, sha, small_engine, TempDir, NOTICES};
use super::manage::*;
use super::slot::{self, serial_for_tests, Holder};
use super::store::{State, Store};

const GIB: u64 = 1024 * 1024 * 1024;
const MODEL_SIZE: usize = 1_000_000; // four 256 KiB chunks, the last one short

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn served(server: &TestServer, id: &'static str, kind: Kind, file_name: &'static str, size: u64, sha256: String, licence: Licence) -> &'static Artifact {
    let sources: &'static [Source] = Box::leak(vec![Source { url: leak(server.url("/file")) }].into_boxed_slice());
    Box::leak(Box::new(Artifact { id, kind, file_name, size, sha256: leak(sha256), sources, licence }))
}

/// A model served by `server`, with the catalog model `like`'s id and licence, whose catalog checksum is `sha256`.
fn model_like(server: &TestServer, like: &Artifact, size: usize, sha256: String) -> &'static Artifact {
    served(server, like.id, Kind::Model, like.file_name, size as u64, sha256, like.licence)
}

/// The small test engine, in a runtime archive served by `server`.
fn runtime_on(server: &TestServer, archive: &[u8], tag: &str) -> &'static EngineSpec {
    let artifact = served(server, leak(format!("test-runtime-{tag}")), Kind::Runtime, "runtime.zip", archive.len() as u64, sha(archive), Licence::LlamaCppRuntime);
    let files: Vec<EngineFile> = small_engine().iter().map(|(n, d)| EngineFile { name: leak(n.clone()), size: d.len() as u64, sha256: leak(sha(d)) }).collect();
    Box::leak(Box::new(EngineSpec {
        archive: artifact,
        files: Box::leak(files.into_boxed_slice()),
        unused: &[],
        executable: "llama-server.exe",
        min_vc_runtime: (14, 0),
        notices_name: "THIRD-PARTY-NOTICES.txt",
        notices: NOTICES,
    }))
}

fn machine(available: u64, disk_free: Option<u64>) -> Result<HardwareReport, HardwareError> {
    Ok(HardwareReport { memory: Some(Memory { total: 32 * GIB, available }), disk_free, adapters: Some(Vec::new()) })
}

fn roomy(_: &Path) -> Result<HardwareReport, HardwareError> {
    machine(24 * GIB, Some(500 * GIB))
}

struct World {
    _tmp: TempDir,
    store: Store,
    db: Mutex<Connection>,
    data: Vec<u8>,
    model_server: TestServer,
    runtime_server: TestServer,
    spec: &'static EngineSpec,
    policy: Policy,
}

fn world(tag: &str) -> World {
    let tmp = TempDir::new(&format!("manage_{tag}"));
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let conn = crate::db::open_database(&tmp.0.join("sard.db")).unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let data = test_bytes(MODEL_SIZE, tag.len() as u64);
    let model_server = TestServer::start(data.clone());
    let archive = build_zip(&entries(&small_engine()));
    let runtime_server = TestServer::start(archive.clone());
    let spec = runtime_on(&runtime_server, &archive, tag);
    World { _tmp: tmp, store, db: Mutex::new(conn), data, model_server, runtime_server, spec, policy: Policy::loopback_for_tests() }
}

impl World {
    /// The catalog model `like`, as this world's server serves it.
    fn model(&self, like: &Artifact) -> &'static Artifact {
        model_like(&self.model_server, like, self.data.len(), sha(&self.data))
    }

    fn fetch_with(&self, model: &'static Artifact, mode: Mode, cancel: &AtomicBool, probe: &dyn Fn(&Path) -> Result<HardwareReport, HardwareError>) -> (Result<Fetched, ActionError>, Vec<Event>) {
        let ctx = Context { db: &self.db, store: &self.store, spec: self.spec, policy: &self.policy, probe };
        let mut events = Vec::new();
        let result = fetch(&ctx, model, mode, cancel, &mut |e| events.push(e));
        (result, events)
    }

    fn fetch(&self, model: &'static Artifact, mode: Mode) -> (Result<Fetched, ActionError>, Vec<Event>) {
        self.fetch_with(model, mode, &AtomicBool::new(false), &roomy)
    }

    fn accept_gemma(&self) {
        accept_terms(&self.db.lock().unwrap(), Licence::GemmaTerms, GEMMA_TERMS_REVISION, 1_000).unwrap();
    }

    fn requests(&self) -> (u32, u32) {
        (self.runtime_server.stats.lock().unwrap().requests, self.model_server.stats.lock().unwrap().requests)
    }

    /// Nothing at all was fetched, opened or written for `model` or the runtime.
    fn untouched(&self, model: &Artifact) {
        assert_eq!(self.requests(), (0, 0), "nothing was requested");
        for a in [model, self.spec.archive] {
            assert_eq!(self.store.state(a).unwrap(), State::NotDownloaded, "{}", a.id);
            assert!(!self.store.partial_path(a).exists() && !self.store.artifact_dir(a).exists(), "{}: nothing on disk", a.id);
        }
        assert_eq!(install::state(&self.store, self.spec).unwrap(), EngineState::NotInstalled);
    }
}

fn steps(events: &[Event]) -> Vec<Event> {
    events.iter().filter(|e| !matches!(e, Event::Progress { .. })).cloned().collect()
}

fn progress_of(events: &[Event], id: &str) -> Vec<(u64, u64)> {
    events.iter().filter_map(|e| match e { Event::Progress { artifact, done, total } if *artifact == id => Some((*done, *total)), _ => None }).collect()
}

// ═══ THE LICENCE GATE ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn model_a_is_not_fetched_without_its_terms_accepted_and_nothing_is_touched() {
    let w = world("lic-missing");
    let a = w.model(&MODEL_A);
    let read = AtomicBool::new(false);
    let probe = |p: &Path| {
        read.store(true, Ordering::SeqCst);
        roomy(p)
    };
    let (result, events) = w.fetch_with(a, Mode::Start, &AtomicBool::new(false), &probe);
    let refused = ActionError::LicenceNotAccepted { model: MODEL_A.id, status: LicenceStatus::Missing { revision: GEMMA_TERMS_REVISION } };
    assert_eq!(result, Err(refused.clone()));
    assert_eq!(events, vec![Event::Failed { artifact: MODEL_A.id, error: refused, state: State::NotDownloaded }], "no step began before the refusal");
    assert!(!read.load(Ordering::SeqCst), "the computer was not even read");
    w.untouched(a);
}

#[test]
fn an_acceptance_of_earlier_terms_is_stale_and_refused() {
    let w = world("lic-stale");
    let a = w.model(&MODEL_A);
    w.db.lock().unwrap().execute("INSERT INTO translation_licence_acceptances(licence, revision, accepted_at) VALUES('gemma_terms', 'gemma-terms/earlier', 5)", []).unwrap();
    let status = LicenceStatus::Stale { revision: GEMMA_TERMS_REVISION, accepted: vec!["gemma-terms/earlier".into()] };
    assert_eq!(licence_status(&w.db.lock().unwrap(), Licence::GemmaTerms).unwrap(), status);
    assert_eq!(w.fetch(a, Mode::Start).0, Err(ActionError::LicenceNotAccepted { model: MODEL_A.id, status }));
    w.untouched(a);
}

#[test]
fn an_acceptance_that_is_not_of_the_current_terms_or_not_the_backends_records_nothing() {
    let w = world("lic-invalid");
    let a = w.model(&MODEL_A);
    {
        let conn = w.db.lock().unwrap();
        assert_eq!(
            accept_terms(&conn, Licence::GemmaTerms, "gemma-terms/something-else", 1_000),
            Err(LicenceError::NotTheCurrentTerms { shown: "gemma-terms/something-else".into(), current: GEMMA_TERMS_REVISION }),
        );
        assert_eq!(accept_terms(&conn, Licence::Apache2, GEMMA_TERMS_REVISION, 1_000), Err(LicenceError::NotRequired));
        // The interface can write any setting; a setting is not an acceptance.
        crate::settings::set(&conn, "translation_licence:gemma_terms", GEMMA_TERMS_REVISION).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM translation_licence_acceptances", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "nothing was recorded");
        assert_eq!(licence_status(&conn, Licence::GemmaTerms).unwrap(), LicenceStatus::Missing { revision: GEMMA_TERMS_REVISION });
    }
    assert!(matches!(w.fetch(a, Mode::Start).0, Err(ActionError::LicenceNotAccepted { .. })));
    w.untouched(a);
}

#[test]
fn with_its_terms_accepted_model_a_is_fetched_with_the_runtime_and_the_engine_and_every_step_reported() {
    let _serial = serial_for_tests();
    let w = world("lic-accepted");
    let a = w.model(&MODEL_A);
    w.accept_gemma();
    assert!(matches!(licence_status(&w.db.lock().unwrap(), Licence::GemmaTerms).unwrap(), LicenceStatus::Accepted { at: 1_000, .. }));
    let (result, events) = w.fetch(a, Mode::Start);
    let fetched = result.unwrap();
    assert_eq!((fetched.runtime_downloaded, fetched.engine_installed, fetched.model_downloaded), (true, true, true));
    assert!(matches!(fetched.assessment.gpu(), Fit::NotDetermined { why: Undetermined::DeviceListUnknown, .. }), "the GPU is not known before the runtime runs");
    assert_eq!(w.store.state(a).unwrap(), State::Installed);
    assert_eq!(fs::read(w.store.installed_path(a)).unwrap(), w.data);
    assert_eq!(install::state(&w.store, w.spec).unwrap(), EngineState::Installed);
    // Every artifact came from the local test server, under the loopback-only policy.
    let (runtime_requests, model_requests) = w.requests();
    assert!(runtime_requests > 0 && model_requests > 0);

    let rt = w.spec.archive.id;
    assert_eq!(
        steps(&events),
        vec![
            Event::Step { artifact: MODEL_A.id, step: Step::Checking },
            Event::Step { artifact: rt, step: Step::Downloading },
            Event::Step { artifact: rt, step: Step::Verifying },
            Event::Finished { artifact: rt, state: State::Installed },
            Event::Step { artifact: rt, step: Step::Installing },
            Event::Step { artifact: MODEL_A.id, step: Step::Downloading },
            Event::Step { artifact: MODEL_A.id, step: Step::Verifying },
            Event::Finished { artifact: MODEL_A.id, state: State::Installed },
        ]
    );
    let progress = progress_of(&events, MODEL_A.id);
    assert!(progress.len() >= 4, "{progress:?}");
    assert!(progress.windows(2).all(|p| p[0].0 <= p[1].0) && progress.iter().all(|p| p.1 == MODEL_SIZE as u64), "{progress:?}");
    assert_eq!(progress.last().unwrap().0, MODEL_SIZE as u64);
    // The Verifying step comes after the last byte.
    let last_progress = events.iter().rposition(|e| matches!(e, Event::Progress { artifact, .. } if *artifact == MODEL_A.id)).unwrap();
    let verifying = events.iter().position(|e| *e == Event::Step { artifact: MODEL_A.id, step: Step::Verifying }).unwrap();
    assert!(verifying > last_progress);
}

#[test]
fn model_b_needs_no_acceptance() {
    let _serial = serial_for_tests();
    let w = world("lic-b");
    let b = w.model(&MODEL_B);
    assert_eq!(licence_status(&w.db.lock().unwrap(), Licence::Apache2).unwrap(), LicenceStatus::NotRequired);
    assert!(w.fetch(b, Mode::Start).0.unwrap().model_downloaded);
    assert_eq!(w.store.state(b).unwrap(), State::Installed);
}

// ═══ THE CHECK ══════════════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn a_computer_that_cannot_run_the_model_or_cannot_be_read_is_refused_before_anything_is_fetched() {
    let w = world("check");
    let b = w.model(&MODEL_B);
    let little_disk = |_: &Path| machine(24 * GIB, Some(1024));
    let little_memory = |_: &Path| machine(64 * 1024 * 1024, Some(500 * GIB));
    let disk_unknown = |_: &Path| machine(24 * GIB, None);
    let unsupported = |_: &Path| Err(HardwareError::Unsupported);
    let cases: [(&dyn Fn(&Path) -> Result<HardwareReport, HardwareError>, &str); 4] =
        [(&little_disk, "disk"), (&little_memory, "memory"), (&disk_unknown, "disk unknown"), (&unsupported, "unsupported")];
    for (probe, what) in cases {
        let (result, events) = w.fetch_with(b, Mode::Start, &AtomicBool::new(false), probe);
        let error = result.unwrap_err();
        match (what, &error) {
            ("disk", ActionError::NotEligible { gpu: Fit::InsufficientDisk { .. }, .. }) => {}
            ("memory", ActionError::NotEligible { gpu: Fit::InsufficientRam { .. }, .. }) => {}
            ("disk unknown", ActionError::NotEligible { gpu: Fit::NotDetermined { why: Undetermined::DiskSpaceUnknown, .. }, .. }) => {}
            ("unsupported", ActionError::CheckFailed(HardwareError::Unsupported)) => {}
            _ => panic!("{what}: {error:?}"),
        }
        assert_eq!(steps(&events), vec![Event::Step { artifact: MODEL_B.id, step: Step::Checking }, Event::Failed { artifact: MODEL_B.id, error, state: State::NotDownloaded }], "{what}");
        w.untouched(b);
    }
}

// ═══ CANCEL, LOST CONNECTION, RESUME, RETRY ═════════════════════════════════════════════════════════════════════════

#[test]
fn a_cancelled_download_is_interrupted_kept_and_resumed_where_it_stopped() {
    let _serial = serial_for_tests();
    let w = world("cancel");
    let b = w.model(&MODEL_B);
    let cancel = Arc::new(AtomicBool::new(false));
    w.model_server.faults.lock().unwrap().cancel_when_past = Some((300_000, cancel.clone()));
    let (result, events) = w.fetch_with(b, Mode::Start, &cancel, &roomy);
    let Err(ActionError::Download { artifact, error: DownloadError::Cancelled { kept_bytes } }) = result.clone() else { panic!("{result:?}") };
    assert_eq!(artifact, MODEL_B.id);
    assert!(kept_bytes > 0 && kept_bytes < MODEL_SIZE as u64);
    assert_eq!(w.store.state(b).unwrap(), State::Interrupted { bytes: kept_bytes });
    assert!(matches!(events.last(), Some(Event::Failed { artifact, state: State::Interrupted { bytes }, .. }) if *artifact == MODEL_B.id && *bytes == kept_bytes));

    // Download (a new start) does not throw the kept bytes away; only Resume continues them.
    assert_eq!(w.fetch(b, Mode::Start).0, Err(ActionError::Download { artifact: MODEL_B.id, error: DownloadError::PartialExists { bytes: kept_bytes } }));
    assert_eq!(w.store.state(b).unwrap(), State::Interrupted { bytes: kept_bytes });

    let runtime_requests = w.requests().0;
    let fetched = w.fetch(b, Mode::Resume).0.unwrap();
    assert_eq!((fetched.runtime_downloaded, fetched.engine_installed, fetched.model_downloaded), (false, false, true), "the runtime and engine from before were kept");
    assert_eq!(w.requests().0, runtime_requests, "the runtime was not fetched again");
    assert_eq!(w.store.state(b).unwrap(), State::Installed);
    assert_eq!(fs::read(w.store.installed_path(b)).unwrap(), w.data);
    assert!(w.model_server.stats.lock().unwrap().body_bytes < 2 * MODEL_SIZE as u64, "resumed, not started over");
}

#[test]
fn a_lost_connection_leaves_the_download_interrupted_and_a_resume_completes_it() {
    let _serial = serial_for_tests();
    let w = world("lost");
    let b = w.model(&MODEL_B);
    let cancel = Arc::new(AtomicBool::new(false));
    w.model_server.faults.lock().unwrap().cancel_when_past = Some((300_000, cancel.clone()));
    let Err(ActionError::Download { error: DownloadError::Cancelled { kept_bytes }, .. }) = w.fetch_with(b, Mode::Start, &cancel, &roomy).0 else { panic!() };
    {
        let mut f = w.model_server.faults.lock().unwrap();
        f.fail_next = 1000;
        f.fail_status = 503;
    }
    let (result, events) = w.fetch(b, Mode::Resume);
    assert!(matches!(&result, Err(ActionError::Download { error: DownloadError::BadResponse { kept_bytes: k, .. } | DownloadError::Network { kept_bytes: k, .. }, .. }) if *k == kept_bytes), "{result:?}");
    assert_eq!(w.store.state(b).unwrap(), State::Interrupted { bytes: kept_bytes });
    assert!(matches!(events.last(), Some(Event::Failed { state: State::Interrupted { bytes }, .. }) if *bytes == kept_bytes));

    w.model_server.faults.lock().unwrap().fail_next = 0;
    assert!(w.fetch(b, Mode::Resume).0.unwrap().model_downloaded);
    assert_eq!(w.store.state(b).unwrap(), State::Installed);
}

#[test]
fn a_damaged_download_is_deleted_and_reported_and_a_retry_starts_it_again() {
    let _serial = serial_for_tests();
    let w = world("damaged");
    // The catalog expects other bytes than the server sends.
    let wrong = model_like(&w.model_server, &MODEL_B, MODEL_SIZE, sha(b"some other file"));
    let (result, events) = w.fetch(wrong, Mode::Start);
    assert!(matches!(&result, Err(ActionError::Download { error: DownloadError::ChecksumMismatch { .. }, .. })), "{result:?}");
    assert_eq!(w.store.state(wrong).unwrap(), State::NotDownloaded, "the damaged file is not kept");
    assert!(!w.store.partial_path(wrong).exists());
    assert!(matches!(events.last(), Some(Event::Failed { artifact, error: ActionError::Download { error: DownloadError::ChecksumMismatch { .. }, .. }, state: State::NotDownloaded }) if *artifact == MODEL_B.id));
    assert!(!events.iter().any(|e| matches!(e, Event::Finished { artifact, .. } if *artifact == MODEL_B.id)), "never reported finished");

    // Retry: a new start, now against the file the catalog names.
    let right = w.model(&MODEL_B);
    let fetched = w.fetch(right, Mode::Start).0.unwrap();
    assert_eq!((fetched.runtime_downloaded, fetched.model_downloaded), (false, true));
    assert_eq!(w.store.state(right).unwrap(), State::Installed);
}

// ═══ VERIFY ═════════════════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn verification_deletes_a_file_that_no_longer_matches_and_never_keeps_it_as_installed() {
    let _serial = serial_for_tests();
    let w = world("verify");
    let b = w.model(&MODEL_B);
    assert_eq!(verify(&w.store, b, &AtomicBool::new(false)), Ok(Verified::Nothing(StateKind::NotDownloaded)));
    w.fetch(b, Mode::Start).0.unwrap();
    assert_eq!(verify(&w.store, b, &AtomicBool::new(false)), Ok(Verified::Intact));

    // One byte changed, the size the same: the cheap state still says installed. Only hashing can tell.
    let file = w.store.installed_path(b);
    let mut bytes = fs::read(&file).unwrap();
    bytes[1234] ^= 0xFF;
    fs::write(&file, &bytes).unwrap();
    assert_eq!(w.store.state(b).unwrap(), State::Installed);
    assert_eq!(verify(&w.store, b, &AtomicBool::new(false)), Ok(Verified::Mismatch));
    assert_eq!(w.store.state(b).unwrap(), State::NotDownloaded, "a file that does not match is not kept");
    assert!(!file.exists());
}

// ═══ REMOVE, AND IN USE ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn holds_add_up_and_let_go_when_dropped() {
    let id = "test-holds";
    let first = hold(id);
    let second = hold(id);
    assert!(held(id));
    drop(first);
    assert!(held(id), "one hold remains");
    drop(second);
    assert!(!held(id));
}

#[test]
fn removal_is_refused_while_the_model_is_in_use_and_done_when_it_is_safe() {
    let _serial = serial_for_tests();
    let w = world("remove");
    // Its own id: holds are by model id and process-wide, and other tests hold the catalog's models.
    let m = served(&w.model_server, "test-remove-model", Kind::Model, "model.gguf", w.data.len() as u64, sha(&w.data), Licence::Apache2);
    fs::create_dir_all(w.store.artifact_dir(m)).unwrap();
    fs::write(w.store.installed_path(m), &w.data).unwrap();
    assert_eq!(w.store.verify(m, &AtomicBool::new(false)).unwrap(), State::Installed);

    let translating = hold(m.id);
    assert_eq!(remove(&w.store, m), Err(ActionError::InUse { model: m.id, by: InUseBy::Translation }));
    assert_eq!(verify(&w.store, m, &AtomicBool::new(false)), Err(ActionError::InUse { model: m.id, by: InUseBy::Translation }));
    drop(translating);

    let engine = slot::claim(Holder::Engine).unwrap();
    assert_eq!(remove(&w.store, m), Err(ActionError::InUse { model: m.id, by: InUseBy::Engine }));
    drop(engine);
    assert_eq!(w.store.state(m).unwrap(), State::Installed, "nothing was removed while it was in use");

    let removal = remove(&w.store, m).unwrap();
    assert!(removal.freed >= w.data.len() as u64 && removal.kept.is_empty(), "{removal:?}");
    assert_eq!(w.store.state(m).unwrap(), State::NotDownloaded);
    assert!(!w.store.artifact_dir(m).exists());
    assert_eq!(remove(&w.store, &MODEL_B), Ok(super::store::Removal { freed: 0, kept: Vec::new() }), "removing what is not there changes nothing");
    assert_eq!(remove(&w.store, w.spec.archive), Err(ActionError::NotAModel(w.spec.archive.id)));
}
