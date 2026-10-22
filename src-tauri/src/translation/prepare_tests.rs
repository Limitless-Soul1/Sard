//! Preparing a model, against scripted engines: the licence gate first, an installed model, the engine installed from
//! the archive already on disk and never downloaded, the start on the GPU, the test translation through the pipeline
//! and its judgement, the engine stopped whatever happened, and Ready recorded only for a preparation that passed —
//! bound to the exact bytes. The models carry the catalog models' ids (so their licences and pipeline profiles apply)
//! and small test bytes; the runtime is the installer tests' small engine. No test reaches the network, starts a real
//! engine or uses the GPU, except the ignored one at the end.

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use super::active::test::{Behaviour, StandIn};
use super::catalog::{Artifact, EngineSpec, Kind, Licence, MODEL_A, MODEL_B};
use super::download::{Mode, Policy};
use super::download_server_tests::TestServer;
use super::edition_run_tests::{gpu, running};
use super::engine::{self, EngineError, EngineInfo};
use super::execution::{NotStarted, Path};
use super::hardware::{Fit, HardwareError, HardwareReport, Memory, NoGpu};
use super::install::{self, EngineState};
use super::install_tests::{build_zip, entries, put_verified, sha, small_engine, spec_for, TempDir};
use super::manage::{self, ActionError, InUseBy, LicenceError, LicenceStatus, StateKind, GEMMA_TERMS_REVISION};
use super::model_commands::{self, ActionErrorView, EventView, StepView};
use super::pipeline::{Raw, Request, Source, Status};
use super::prepare::*;
use super::slot::serial_for_tests;
use super::store::{State, Store};

/// What a working model answers for the test sentence.
const ARABIC: &str = "تفتح المكتبة الصغيرة عند الزاوية أبوابها باكرًا كل صباح.";

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

struct Bench {
    _tmp: TempDir,
    store: Store,
    db: Mutex<Connection>,
    spec: &'static EngineSpec,
    data: Vec<u8>,
}

/// A store with the small engine's runtime archive downloaded and verified (the engine itself not installed), and a
/// database with every migration.
fn bench(tag: &str) -> Bench {
    let b = bare(tag);
    let archive = build_zip(&entries(&small_engine()));
    put_verified(&b.store, b.spec.archive, &archive);
    b
}

/// As `bench`, without the runtime archive.
fn bare(tag: &str) -> Bench {
    let tmp = TempDir::new(&format!("prepare_{tag}"));
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let conn = crate::db::open_database(&tmp.0.join("sard.db")).unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let archive = build_zip(&entries(&small_engine()));
    let spec = spec_for(&format!("prepare-{tag}"), &small_engine(), &archive);
    let data: Vec<u8> = (0..4096u32).map(|i| (i * 31 + tag.len() as u32) as u8).collect();
    Bench { _tmp: tmp, store, db: Mutex::new(conn), spec, data }
}

impl Bench {
    /// The catalog model `like`, with this bench's bytes. Not on disk until `install`.
    fn model(&self, like: &Artifact) -> &'static Artifact {
        Box::leak(Box::new(Artifact { sha256: leak(sha(&self.data)), size: self.data.len() as u64, sources: &[], ..*like }))
    }

    /// `like`, downloaded and verified.
    fn installed(&self, like: &Artifact) -> &'static Artifact {
        let m = self.model(like);
        put_verified(&self.store, m, &self.data);
        m
    }

    fn install_engine(&self) {
        install::install(&self.store, self.spec, &AtomicBool::new(false)).unwrap();
    }

    fn prepare(&self, model: &'static Artifact, engine: &Scripted) -> (Result<Prepared, PrepareError>, Vec<Step>) {
        self.prepare_with(model, engine, &Arc::new(AtomicBool::new(false)))
    }

    fn prepare_with(&self, model: &'static Artifact, engine: &Scripted, cancel: &Arc<AtomicBool>) -> (Result<Prepared, PrepareError>, Vec<Step>) {
        let ctx = Context { db: &self.db, store: &self.store, spec: self.spec, now: &|| 1_000 };
        let mut steps = Vec::new();
        let result = prepare(&ctx, model, engine, cancel, &mut |s| steps.push(s));
        (result, steps)
    }

    /// Prepare with any engine, without the events.
    fn prepare_with_engine<E: Engine>(&self, model: &'static Artifact, engine: &E) -> Result<Prepared, PrepareError>
    where
        <E::Source as Source>::Error: std::fmt::Display,
    {
        let ctx = Context { db: &self.db, store: &self.store, spec: self.spec, now: &|| 1_000 };
        prepare(&ctx, model, engine, &Arc::new(AtomicBool::new(false)), &mut |_| {})
    }

    fn ready(&self, model: &Artifact) -> Option<Ready> {
        ready(&self.db.lock().unwrap(), &self.store, self.spec, model).unwrap()
    }

    fn engine_state(&self) -> EngineState {
        install::state(&self.store, self.spec).unwrap()
    }
}

type Observer = Arc<dyn Fn() + Send + Sync>;

/// A scripted engine: it starts as `start` says, answers every request with `answer`, and records its starts and
/// stops.
struct Scripted {
    log: Mutex<Vec<&'static str>>,
    start: Result<EngineInfo, NotStarted>,
    answer: fn(&Request) -> Result<Raw, String>,
    stop_fails: bool,
    asked: Arc<Mutex<usize>>,
    /// Called as each request arrives, to look at the world while the test runs.
    observe: Option<Observer>,
}

fn arabic(_: &Request) -> Result<Raw, String> {
    Ok(Raw { out: ARABIC.into(), tokens: Some(14), stop: "eos".into() })
}

fn english(r: &Request) -> Result<Raw, String> {
    Ok(Raw { out: r.text.clone(), tokens: Some(12), stop: "eos".into() })
}

fn nothing(_: &Request) -> Result<Raw, String> {
    Ok(Raw { out: String::new(), tokens: Some(0), stop: "eos".into() })
}

/// Arabic with a word in another script, which no retry repairs: the pipeline shows it, marked for review.
fn leaky(_: &Request) -> Result<Raw, String> {
    Ok(Raw { out: format!("{} ведь.", ARABIC.trim_end_matches('.')), tokens: Some(15), stop: "eos".into() })
}

fn lost(_: &Request) -> Result<Raw, String> {
    Err("/completion: connection reset".into())
}

impl Scripted {
    fn new() -> Scripted {
        Scripted::starting(Ok(running(&MODEL_B, gpu("Vulkan0"))))
    }
    fn starting(start: Result<EngineInfo, NotStarted>) -> Scripted {
        Scripted { log: Mutex::new(Vec::new()), start, answer: arabic, stop_fails: false, asked: Arc::new(Mutex::new(0)), observe: None }
    }
    fn answering(answer: fn(&Request) -> Result<Raw, String>) -> Scripted {
        Scripted { answer, ..Scripted::new() }
    }
    fn log(&self) -> Vec<&'static str> {
        self.log.lock().unwrap().clone()
    }
    fn asked(&self) -> usize {
        *self.asked.lock().unwrap()
    }
}

struct ScriptedSource {
    answer: fn(&Request) -> Result<Raw, String>,
    cancel: Arc<AtomicBool>,
    asked: Arc<Mutex<usize>>,
    observe: Option<Observer>,
}

impl Source for ScriptedSource {
    type Error = String;
    fn answer(&mut self, r: &Request) -> Result<Raw, String> {
        if let Some(observe) = &self.observe {
            observe();
        }
        if self.cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        *self.asked.lock().unwrap() += 1;
        (self.answer)(r)
    }
}

impl Engine for Scripted {
    type Source = ScriptedSource;
    fn start(&self) -> Result<EngineInfo, NotStarted> {
        self.log.lock().unwrap().push("start");
        self.start.clone()
    }
    fn source(&self, cancel: Arc<AtomicBool>) -> Result<ScriptedSource, String> {
        Ok(ScriptedSource { answer: self.answer, cancel, asked: self.asked.clone(), observe: self.observe.clone() })
    }
    fn stop(&self) -> Result<(), String> {
        self.log.lock().unwrap().push("stop");
        if self.stop_fails {
            return Err("the engine did not stop".into());
        }
        Ok(())
    }
}

// ═══ A PREPARATION THAT PASSES ══════════════════════════════════════════════════════════════════════════════════════

#[test]
fn model_b_is_prepared_on_the_gpu_with_the_engine_installed_first_and_recorded_ready() {
    let _serial = serial_for_tests();
    let b = bench("pass");
    let m = b.installed(&MODEL_B);
    assert_eq!(b.engine_state(), EngineState::NotInstalled);
    let engine = Scripted::new();
    let (result, steps) = b.prepare(m, &engine);
    let prepared = result.unwrap();
    assert_eq!(prepared.device, "Vulkan0");
    assert!(prepared.engine_installed);
    assert_eq!((prepared.status, prepared.text.as_str(), prepared.prepared_at), (Status::Ok, ARABIC, 1_000));
    assert_eq!(steps, vec![Step::Installing, Step::Starting, Step::Testing]);
    assert_eq!(engine.log(), vec!["start", "stop"], "started once, and stopped after the test");
    assert_eq!(engine.asked(), 1, "the first translation was accepted: one request");
    assert_eq!(b.engine_state(), EngineState::Installed);
    assert_eq!(b.ready(m), Some(Ready { device: "Vulkan0".into(), prepared_at: 1_000 }));
    assert!(!manage::held(m.id), "the model is let go of once the preparation ends");
}

#[test]
fn an_installed_engine_is_used_as_it_is() {
    let _serial = serial_for_tests();
    let b = bench("installed-engine");
    let m = b.installed(&MODEL_B);
    b.install_engine();
    let (result, steps) = b.prepare(m, &Scripted::new());
    assert!(!result.unwrap().engine_installed);
    assert_eq!(steps, vec![Step::Starting, Step::Testing]);
}

#[test]
fn the_model_is_held_in_use_while_it_is_prepared() {
    let _serial = serial_for_tests();
    let b = bench("in-use");
    let m = b.installed(&MODEL_B);
    let store = b.store.clone();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let observe: Observer = Arc::new(move || record.lock().unwrap().push((manage::held(m.id), manage::remove(&store, m))));
    let engine = Scripted { observe: Some(observe), ..Scripted::new() };
    b.prepare(m, &engine).0.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(*seen, vec![(true, Err(ActionError::InUse { model: m.id, by: InUseBy::Translation }))], "it could not be removed under the test");
    assert_eq!(b.store.state(m).unwrap(), State::Installed);
}

// ═══ THE LICENCE GATE ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn model_a_is_never_prepared_without_its_terms_accepted_and_nothing_is_touched() {
    let _serial = serial_for_tests();
    let b = bench("lic");
    let a = b.installed(&MODEL_A);
    let engine = Scripted::starting(Ok(running(&MODEL_A, gpu("Vulkan0"))));
    let refused = PrepareError::LicenceNotAccepted { model: a.id, status: LicenceStatus::Missing { revision: GEMMA_TERMS_REVISION } };
    let (result, steps) = b.prepare(a, &engine);
    assert_eq!(result, Err(refused.clone()));
    assert!(steps.is_empty() && engine.log().is_empty(), "nothing was started: {steps:?} {:?}", engine.log());
    assert_eq!(b.engine_state(), EngineState::NotInstalled, "nothing was installed");
    assert_eq!(b.ready(a), None);

    // This build carries no terms, so the acceptance itself is refused, and the gate stays shut.
    let refusal = manage::accept_terms(&b.db.lock().unwrap(), Licence::GemmaTerms, GEMMA_TERMS_REVISION, 2_000);
    assert_eq!(refusal, Err(LicenceError::TermsUnavailable));
    assert_eq!(b.prepare(a, &engine).0, Err(refused));
    assert!(engine.log().is_empty());

    // The gate is the only thing in the way: with the terms accepted (a build that carries them), A is prepared.
    manage::record_acceptance(&b.db.lock().unwrap(), Licence::GemmaTerms, GEMMA_TERMS_REVISION, 2_000).unwrap();
    assert_eq!(b.prepare(a, &engine).0.unwrap().device, "Vulkan0");
}

// ═══ REFUSED BEFORE THE ENGINE ══════════════════════════════════════════════════════════════════════════════════════

#[test]
fn a_model_that_is_not_installed_is_refused_before_anything_else() {
    let _serial = serial_for_tests();
    let b = bench("not-installed");
    let m = b.model(&MODEL_B);
    let engine = Scripted::new();
    let refused = |state| Err(PrepareError::NotInstalled { model: m.id, state });

    assert_eq!(b.prepare(m, &engine).0, refused(StateKind::NotDownloaded));
    fs::create_dir_all(b.store.artifact_dir(m)).unwrap();
    fs::write(b.store.partial_path(m), &b.data[..100]).unwrap();
    assert_eq!(b.prepare(m, &engine).0, refused(StateKind::Interrupted));
    fs::remove_file(b.store.partial_path(m)).unwrap();
    fs::write(b.store.installed_path(m), &b.data).unwrap();
    assert_eq!(b.prepare(m, &engine).0, refused(StateKind::Unverified), "a file never verified is not used");

    assert!(engine.log().is_empty());
    assert_eq!(b.engine_state(), EngineState::NotInstalled);
}

#[test]
fn a_missing_runtime_is_refused_and_never_downloaded() {
    let _serial = serial_for_tests();
    let b = bare("no-runtime");
    let m = b.installed(&MODEL_B);
    let engine = Scripted::new();
    let (result, steps) = b.prepare(m, &engine);
    assert_eq!(result, Err(PrepareError::RuntimeMissing));
    assert!(steps.is_empty() && engine.log().is_empty());
    assert_eq!(b.store.state(b.spec.archive).unwrap(), State::NotDownloaded);
    assert!(!b.store.artifact_dir(b.spec.archive).exists(), "nothing was written for the runtime");
}

#[test]
fn only_a_translation_model_can_be_prepared() {
    let _serial = serial_for_tests();
    let b = bench("not-a-model");
    let engine = Scripted::new();
    assert_eq!(b.prepare(b.spec.archive, &engine).0, Err(PrepareError::NotAModel(b.spec.archive.id)));
    let unknown: &'static Artifact = Box::leak(Box::new(Artifact { id: "some-other-model", kind: Kind::Model, ..MODEL_B }));
    assert_eq!(b.prepare(unknown, &engine).0, Err(PrepareError::NotAModel("some-other-model")));
    assert!(engine.log().is_empty());
}

#[test]
fn a_cancel_before_the_start_starts_nothing() {
    let _serial = serial_for_tests();
    let b = bench("cancel-early");
    let m = b.installed(&MODEL_B);
    let engine = Scripted::new();
    let (result, steps) = b.prepare_with(m, &engine, &Arc::new(AtomicBool::new(true)));
    assert_eq!(result, Err(PrepareError::Cancelled));
    assert!(steps.is_empty() && engine.log().is_empty());
    assert_eq!(b.engine_state(), EngineState::NotInstalled);
}

// ═══ THE START ══════════════════════════════════════════════════════════════════════════════════════════════════════

/// A bench whose model B was prepared once, so that what a later preparation does to the record shows.
fn prepared_once(tag: &str) -> (Bench, &'static Artifact) {
    let b = bench(tag);
    let m = b.installed(&MODEL_B);
    b.prepare(m, &Scripted::new()).0.unwrap();
    assert!(b.ready(m).is_some());
    (b, m)
}

#[test]
fn a_gpu_the_check_does_not_confirm_is_refused_and_nothing_switches_to_the_cpu() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("refused");
    let why = NotStarted::Refused { why: Fit::CpuOnly { why: NoGpu::NoEngineDevice }, alternative: Some(Path::Cpu) };
    let engine = Scripted::starting(Err(why.clone()));
    let (result, steps) = b.prepare(m, &engine);
    assert_eq!(result, Err(PrepareError::NotStarted(why)));
    assert_eq!(steps, vec![Step::Starting]);
    assert_eq!(engine.asked(), 0, "nothing was translated");
    assert_eq!(b.ready(m), None, "the GPU no longer takes the model: it is not left ready");
}

#[test]
fn an_engine_that_fails_to_start_leaves_no_ready() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("start-fails");
    let engine = Scripted::starting(Err(NotStarted::Engine(EngineError::ProbeTimeout)));
    assert_eq!(b.prepare(m, &engine).0, Err(PrepareError::NotStarted(NotStarted::Engine(EngineError::ProbeTimeout))));
    assert_eq!((engine.log(), engine.asked()), (vec!["start"], 0));
    assert_eq!(b.ready(m), None);
}

#[test]
fn an_engine_on_the_cpu_is_refused_and_never_recorded() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("cpu");
    let engine = Scripted::starting(Ok(running(&MODEL_B, engine::Execution::Cpu { threads: 2 })));
    let result = b.prepare(m, &engine).0;
    assert!(matches!(result, Err(PrepareError::NotStarted(NotStarted::Engine(EngineError::InvalidExecution(_))))), "{result:?}");
    assert_eq!(engine.log(), vec!["start", "stop"]);
    assert_eq!(engine.asked(), 0);
    assert_eq!(b.ready(m), None);
}

#[test]
fn what_says_nothing_about_the_model_leaves_ready_as_it_was() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("says-nothing");
    for (start, want) in [
        (NotStarted::Engine(EngineError::AlreadyActive), PrepareError::NotStarted(NotStarted::Engine(EngineError::AlreadyActive))),
        (NotStarted::Engine(EngineError::Cancelled), PrepareError::Cancelled),
        (NotStarted::Assessment(HardwareError::Io("unreadable".into())), PrepareError::NotStarted(NotStarted::Assessment(HardwareError::Io("unreadable".into())))),
    ] {
        let engine = Scripted::starting(Err(start));
        assert_eq!(b.prepare(m, &engine).0, Err(want));
        assert_eq!(engine.log(), vec!["start"], "a start that failed is not followed by a stop: it would end another engine's work");
        assert!(b.ready(m).is_some(), "the earlier preparation still stands");
    }
}

// ═══ THE TEST TRANSLATION ═══════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn a_test_translation_that_does_not_pass_is_not_ready_and_the_engine_is_stopped() {
    let _serial = serial_for_tests();
    for (tag, answer) in [("english", english as fn(&Request) -> Result<Raw, String>), ("empty", nothing)] {
        let (b, m) = prepared_once(tag);
        let engine = Scripted::answering(answer);
        let result = b.prepare(m, &engine).0;
        match &result {
            Err(PrepareError::TestRejected { status, reasons }) => {
                assert!(matches!(status, Status::Review | Status::Failed), "{tag}: {status:?}");
                assert!(!reasons.is_empty(), "{tag}: the reasons are given");
            }
            other => panic!("{tag}: {other:?}"),
        }
        assert_eq!(engine.log(), vec!["start", "stop"], "{tag}");
        assert_eq!(b.ready(m), None, "{tag}: the earlier record was removed");
    }
}

#[test]
fn a_translation_marked_for_review_is_not_ready_although_it_has_arabic() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("review");
    let engine = Scripted::answering(leaky);
    match b.prepare(m, &engine).0 {
        Err(PrepareError::TestRejected { status: Status::Review, reasons }) => assert_eq!(reasons.first().map(String::as_str), Some("script leak not repaired")),
        other => panic!("{other:?}"),
    }
    assert_eq!(engine.log(), vec!["start", "stop"]);
    assert_eq!(b.ready(m), None);
}

#[test]
fn a_failed_exchange_is_reported_and_the_engine_is_stopped() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("lost");
    let engine = Scripted::answering(lost);
    assert_eq!(b.prepare(m, &engine).0, Err(PrepareError::TestFailed("/completion: connection reset".into())));
    assert_eq!(engine.log(), vec!["start", "stop"]);
    assert_eq!(b.ready(m), None);
}

#[test]
fn a_cancel_during_the_test_stops_the_engine_and_keeps_an_earlier_ready() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("cancel-test");
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let engine = Scripted { observe: Some(Arc::new(move || flag.store(true, Ordering::SeqCst))), ..Scripted::new() };
    assert_eq!(b.prepare_with(m, &engine, &cancel).0, Err(PrepareError::Cancelled));
    assert_eq!(engine.log(), vec!["start", "stop"]);
    assert_eq!(engine.asked(), 0, "no exchange was made after the cancel");
    assert!(b.ready(m).is_some());
}

#[test]
fn an_engine_that_does_not_stop_is_reported_and_nothing_is_recorded() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("stop-fails");
    let engine = Scripted { stop_fails: true, ..Scripted::new() };
    assert_eq!(b.prepare(m, &engine).0, Err(PrepareError::StopFailed("the engine did not stop".into())));
    assert_eq!(b.ready(m), None);
}

#[test]
fn the_test_sentence_is_one_sentence() {
    assert_eq!(TEST_SENTENCE.matches(". ").count(), 0);
    assert!(TEST_SENTENCE.ends_with('.') && TEST_SENTENCE.split_whitespace().count() >= 6);
}

// ═══ READY ══════════════════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn ready_names_the_exact_bytes_and_needs_both_installed() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("bound");
    // Other bytes for the same model, or another engine, are not what was prepared.
    let other: &'static Artifact = Box::leak(Box::new(Artifact { sha256: leak("0".repeat(64)), ..*m }));
    assert_eq!(b.ready(other), None);
    // Another engine installed beside it is not the engine the model was prepared with.
    let mut files = small_engine();
    files[1].1 = b"another base library".to_vec();
    let archive = build_zip(&entries(&files));
    let newer = spec_for("prepare-bound-newer", &files, &archive);
    put_verified(&b.store, newer.archive, &archive);
    install::install(&b.store, newer, &AtomicBool::new(false)).unwrap();
    assert_eq!(install::state(&b.store, newer).unwrap(), EngineState::Installed);
    assert_eq!(ready(&b.db.lock().unwrap(), &b.store, newer, m).unwrap(), None);
    // The engine removed: not ready. Installed again from the same archive: the same engine, ready again.
    install::remove(&b.store, b.spec).unwrap();
    assert_eq!(b.ready(m), None);
    b.install_engine();
    assert!(b.ready(m).is_some());
    // The model removed: not ready. The same bytes downloaded again: what was prepared, so ready.
    b.store.remove(m).unwrap();
    assert_eq!(b.ready(m), None);
    put_verified(&b.store, m, &b.data);
    assert!(b.ready(m).is_some());
}

// ═══ ONE FETCH JOB: THE FETCH, THEN THE PREPARATION ═════════════════════════════════════════════════════════════════

const GIB: u64 = 1024 * 1024 * 1024;

fn roomy(_: &std::path::Path) -> Result<HardwareReport, HardwareError> {
    Ok(HardwareReport { memory: Some(Memory { total: 32 * GIB, available: 24 * GIB }), disk_free: Some(500 * GIB), adapters: Some(Vec::new()) })
}

/// What the interface would see of one job, and when the preparation was said to begin and end.
fn job<E: Engine>(b: &Bench, model: &'static Artifact, engine: &E, cancel: &Arc<AtomicBool>) -> (Vec<EventView>, Vec<bool>)
where
    <E::Source as Source>::Error: std::fmt::Display,
{
    let policy = Policy::loopback_for_tests();
    let ctx = manage::Context { db: &b.db, store: &b.store, spec: b.spec, policy: &policy, probe: &roomy };
    let flags = Mutex::new(Vec::new());
    let mut events = Vec::new();
    model_commands::run_job(&ctx, &|| 1_000, model, Mode::Start, engine, cancel, &|on| flags.lock().unwrap().push(on), &mut |e| events.push(e));
    (events, flags.into_inner().unwrap())
}

/// The events as `kind[:step]`.
fn kinds(events: &[EventView]) -> Vec<String> {
    events
        .iter()
        .map(|e| match e {
            EventView::Step { step, runtime, .. } => format!("step:{step:?}{}", if *runtime { " (runtime)" } else { "" }),
            EventView::Progress { .. } => "progress".into(),
            EventView::Finished { .. } => "finished".into(),
            EventView::Failed { .. } => "failed".into(),
        })
        .collect()
}

#[test]
fn a_fetch_goes_on_to_prepare_the_model_and_reports_it_finished_only_after() {
    let _serial = serial_for_tests();
    let b = bench("job-pass");
    let m = b.installed(&MODEL_B);
    let engine = Scripted::new();
    let (events, flags) = job(&b, m, &engine, &Arc::new(AtomicBool::new(false)));
    assert_eq!(kinds(&events), vec!["step:Checking", "step:Installing (runtime)", "step:Preparing", "finished"]);
    assert_eq!(flags, vec![true, false]);
    assert_eq!(engine.log(), vec!["start", "stop"]);
    assert!(b.ready(m).is_some());
}

#[test]
fn a_preparation_that_does_not_pass_ends_the_job_failed_with_the_model_still_downloaded() {
    let _serial = serial_for_tests();
    let b = bench("job-fail");
    let m = b.installed(&MODEL_B);
    let (events, _) = job(&b, m, &Scripted::answering(english), &Arc::new(AtomicBool::new(false)));
    assert_eq!(kinds(&events).last().map(String::as_str), Some("failed"));
    assert!(!kinds(&events).contains(&"finished".to_string()), "the model was never reported finished: {:?}", kinds(&events));
    match events.last().unwrap() {
        EventView::Failed { state, error: ActionErrorView::Prepare { memory: false, engine_busy: false, detail }, .. } => {
            assert_eq!(serde_json::to_value(state).unwrap()["kind"], "installed", "it stays downloaded");
            assert!(detail.contains("not accepted"), "{detail}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(b.ready(m), None);

    // Too little memory says so; another engine running says so.
    let refused = NotStarted::Refused { why: Fit::InsufficientRam { needed: 4 * GIB, available: 2 * GIB }, alternative: None };
    let (events, _) = job(&b, m, &Scripted::starting(Err(refused)), &Arc::new(AtomicBool::new(false)));
    assert!(matches!(events.last(), Some(EventView::Failed { error: ActionErrorView::Prepare { memory: true, engine_busy: false, .. }, .. })), "{:?}", events.last());
    let (events, _) = job(&b, m, &Scripted::starting(Err(NotStarted::Engine(EngineError::AlreadyActive))), &Arc::new(AtomicBool::new(false)));
    assert!(matches!(events.last(), Some(EventView::Failed { error: ActionErrorView::Prepare { memory: false, engine_busy: true, .. }, .. })), "{:?}", events.last());
}

#[test]
fn a_fetch_that_fails_or_is_refused_is_never_followed_by_a_preparation() {
    let _serial = serial_for_tests();
    let b = bench("job-no-fetch");
    // Model A, its terms not accepted: the fetch refuses, and nothing is prepared.
    let a = b.installed(&MODEL_A);
    let engine = Scripted::starting(Ok(running(&MODEL_A, gpu("Vulkan0"))));
    let (events, flags) = job(&b, a, &engine, &Arc::new(AtomicBool::new(false)));
    assert_eq!(kinds(&events), vec!["failed"]);
    assert!(matches!(events[0], EventView::Failed { error: ActionErrorView::LicenceNotAccepted { .. }, .. }));
    assert!(flags.is_empty() && engine.log().is_empty());
    // A model that cannot be downloaded (it has no source): the fetch fails, and nothing is prepared.
    let m = b.model(&MODEL_B);
    let engine = Scripted::new();
    let (events, flags) = job(&b, m, &engine, &Arc::new(AtomicBool::new(false)));
    assert_eq!(kinds(&events).last().map(String::as_str), Some("failed"));
    assert!(!kinds(&events).contains(&"step:Preparing".to_string()));
    assert!(flags.is_empty() && engine.log().is_empty());
}

#[test]
fn a_cancel_while_preparing_ends_the_job_as_cancelled_not_failed() {
    let _serial = serial_for_tests();
    let b = bench("job-cancel");
    let m = b.installed(&MODEL_B);
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let engine = Scripted { observe: Some(Arc::new(move || flag.store(true, Ordering::SeqCst))), ..Scripted::new() };
    let (events, _) = job(&b, m, &engine, &cancel);
    assert!(matches!(events.last(), Some(EventView::Failed { error: ActionErrorView::Cancelled, .. })), "{:?}", events.last());
    assert_eq!(engine.log(), vec!["start", "stop"]);
}

#[test]
fn a_ready_model_removed_and_downloaded_again_stays_downloaded_when_its_preparation_is_cancelled() {
    let _serial = serial_for_tests();
    let (b, m) = prepared_once("job-again");
    // The same model, served by a local test server: the identical file, downloaded again.
    let server = TestServer::start(b.data.clone());
    let sources: &'static [super::catalog::Source] = Box::leak(vec![super::catalog::Source { url: leak(server.url("/file")) }].into_boxed_slice());
    let served: &'static Artifact = Box::leak(Box::new(Artifact { sources, ..*m }));
    manage::remove(&b.store, served).unwrap();
    assert_eq!(b.store.state(served).unwrap(), State::NotDownloaded);
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let engine = Scripted { observe: Some(Arc::new(move || flag.store(true, Ordering::SeqCst))), ..Scripted::new() };
    let (events, _) = job(&b, served, &engine, &cancel);
    assert!(server.stats.lock().unwrap().requests > 0, "the file was downloaded again");
    assert!(kinds(&events).contains(&"step:Preparing".to_string()), "{:?}", kinds(&events));
    assert!(matches!(events.last(), Some(EventView::Failed { error: ActionErrorView::Cancelled, .. })), "{:?}", events.last());
    // Downloaded, never Ready: the earlier preparation does not stand for this attempt.
    assert_eq!(b.store.state(served).unwrap(), State::Installed);
    assert_eq!(b.ready(served), None);
}

#[test]
fn the_interface_reads_the_preparing_step_and_a_preparation_failure() {
    assert_eq!(serde_json::to_value(StepView::Preparing).unwrap(), "preparing");
    let v = serde_json::to_value(ActionErrorView::from(&PrepareError::TestFailed("timeout".into()))).unwrap();
    assert_eq!(v, serde_json::json!({ "kind": "prepare", "memory": false, "engineBusy": false, "detail": "the test translation failed: timeout" }));
    assert_eq!(serde_json::to_value(ActionErrorView::from(&PrepareError::Cancelled)).unwrap(), serde_json::json!({ "kind": "cancelled" }));
}

#[test]
fn a_test_catalogs_stand_in_starts_nothing_and_passes_or_fails_as_asked() {
    let _serial = serial_for_tests();
    let b = bench("stand-in");
    let m = b.installed(&MODEL_B);
    let stand_in = |behaviour| StandIn::new(m.id, Arc::new(AtomicBool::new(false)), behaviour);
    let prepared = b.prepare_with_engine(m, &stand_in(Behaviour::Pass)).unwrap();
    assert_eq!((prepared.device.as_str(), prepared.status), ("Test GPU (stand-in)", Status::Ok));
    assert!(matches!(b.prepare_with_engine(m, &stand_in(Behaviour::Test)), Err(PrepareError::TestRejected { .. })));
    let memory = b.prepare_with_engine(m, &stand_in(Behaviour::Memory));
    assert!(matches!(memory, Err(PrepareError::NotStarted(NotStarted::Refused { why: Fit::InsufficientRam { .. }, .. }))), "{memory:?}");
    assert_eq!(b.ready(m), None, "the failures removed the record");
}

// ═══ WITH THE REAL ENGINE ═══════════════════════════════════════════════════════════════════════════════════════════

/// Prepares model B with the real engine on the real GPU, from a translation directory where the engine and model B
/// are already installed. It starts the engine and uses the GPU, so it is run by hand only:
///
///   SARD_TRANSLATION_PREPARE_ROOT=<a translation directory> cargo test --lib -- --ignored translation::prepare_tests::with_the_real
#[test]
#[ignore = "starts the real engine on the GPU"]
fn with_the_real_engine_model_b_is_prepared_on_the_gpu() {
    use super::catalog::ENGINE_WINDOWS_X64;
    use super::engine::{EngineConfig, EngineManager, EngineStatus};

    let _serial = serial_for_tests();
    let root = std::env::var_os("SARD_TRANSLATION_PREPARE_ROOT").expect("SARD_TRANSLATION_PREPARE_ROOT names a translation directory");
    let store = Store::open(root).unwrap();
    assert_eq!(install::state(&store, &ENGINE_WINDOWS_X64).unwrap(), EngineState::Installed, "the engine must be installed");
    assert_eq!(store.state(&MODEL_B).unwrap(), State::Installed, "model B must be installed");
    let tmp = TempDir::new("prepare_real");
    let conn = crate::db::open_database(&tmp.0.join("sard.db")).unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let db = Mutex::new(conn);
    let manager = EngineManager::new(EngineConfig::default());
    let engine = Managed { manager: &manager, store: &store, spec: &ENGINE_WINDOWS_X64, model: &MODEL_B };
    let ctx = Context { db: &db, store: &store, spec: &ENGINE_WINDOWS_X64, now: &|| 1_000 };
    let mut steps = Vec::new();
    let prepared = prepare(&ctx, &MODEL_B, &engine, &Arc::new(AtomicBool::new(false)), &mut |s| steps.push(s)).unwrap();
    eprintln!("{prepared:?}");
    assert_eq!(steps, vec![Step::Starting, Step::Testing]);
    assert!(!prepared.device.is_empty());
    assert_eq!(manager.status(), EngineStatus::Idle, "the engine was stopped");
    assert_eq!(ready(&db.lock().unwrap(), &store, &ENGINE_WINDOWS_X64, &MODEL_B).unwrap().map(|r| r.device), Some(prepared.device));
}
