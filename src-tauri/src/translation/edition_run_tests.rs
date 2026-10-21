//! The edition runner, against a real Sard database opened as the app opens one, with scripted sources in place of
//! an engine: what it sends and in which order, what it stores, how each way of ending is recorded, and that it
//! refuses — before a single request — anything the edition was not made with.
//!
//! The last test replays the recorded evaluation through the runner and the store. The recordings hold book text,
//! so they are never part of the repository; it runs only when pointed at them:
//!
//! ```text
//! SARD_TRANSLATION_REPLAY_FIXTURES=<fixture dir> cargo test --lib -- --ignored --exact \
//! translation::edition_run_tests::the_recorded_evaluation_runs_through_the_store_exactly --nocapture
//! ```

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::catalog::{self, Artifact, ENGINE_WINDOWS_X64, MODEL_A, MODEL_B, RUNTIME_WINDOWS_X64};
use super::edition_run::*;
use super::editions::*;
use super::engine::{self, EngineInfo, PhaseTimes};
use super::pipeline::{self, InputError, Kind, Outcome, Paragraph, PipelineError, Planner, Profile, Raw, Request, Source, Status};
use crate::db::migrations;

// ---- Fixtures ----

pub(super) struct Db {
    db: Option<Mutex<Connection>>,
    dir: PathBuf,
}

impl Db {
    pub(super) fn m(&self) -> &Mutex<Connection> {
        self.db.as_ref().unwrap()
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        drop(self.db.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub(super) fn scratch(tag: &str) -> Db {
    let dir = std::env::temp_dir().join(format!("sard_edition_run_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = crate::db::open_database(&dir.join("sard.db")).unwrap();
    migrations::run(&conn, None).unwrap();
    conn.execute("INSERT INTO books(id, file_path, format, title, added_at) VALUES('book', 'nowhere/book.epub', 'epub', 'book', 1)", []).unwrap();
    Db { db: Some(Mutex::new(conn)), dir }
}

pub(super) fn gpu(device: &str) -> engine::Execution {
    engine::Execution::Gpu { device: device.into() }
}

pub(super) fn config_for(model: &Artifact, execution: &engine::Execution) -> EditionConfig {
    EditionConfig {
        source_lang: "en".into(),
        target_lang: "ar".into(),
        target_dir: "rtl".into(),
        engine: engine_config(&ENGINE_WINDOWS_X64, model, execution).unwrap(),
        extraction_id: SUPPORTED_EXTRACTION_ID.into(),
        webview_version: "155.0.4283.62".into(),
    }
}

pub(super) fn running(model: &Artifact, execution: engine::Execution) -> EngineInfo {
    EngineInfo { pid: 1, port: 1, model_id: model.id.into(), execution, phases: PhaseTimes::default() }
}

/// The paragraphs, and what the scripted engine answers for each request text. `TWO_SPACES` breaks the input
/// contract, so it is stored as rejected and must never be sent.
pub(super) const P00: &str = "Alpha beta gamma. Delta epsilon.";
pub(super) const TWO_SPACES: &str = "Two  spaces here.";
pub(super) const P02: &str = "One two three.";
pub(super) const P10: &str = "The night was dark.";
pub(super) const P11: &str = "She ran home.";
pub(super) const P20: &str = "The end.";
pub(super) const ANSWERS: &[(&str, &str)] = &[
    (P00, "ألفا بيتا غاما. دلتا إبسلون."),
    (P02, "واحد اثنان ثلاثة."),
    (P10, "كانت الليلة مظلمة."),
    (P11, "ركضت إلى البيت."),
    (P20, "النهاية."),
];

pub(super) fn sentences(text: &str) -> Vec<String> {
    match text {
        P00 => vec!["Alpha beta gamma.".into(), "Delta epsilon.".into()],
        other => vec![other.into()],
    }
}

pub(super) fn section(index: u32, texts: &[&str]) -> SectionInput {
    let paragraphs: Vec<ParagraphInput> = texts
        .iter()
        .enumerate()
        .map(|(j, t)| ParagraphInput { path: vec![j as u32], tag: "p".into(), atoms: BTreeMap::new(), text: t.to_string(), sentences: sentences(t) })
        .collect();
    let n = paragraphs.len() as u32;
    SectionInput { index, href: format!("s{index}.xhtml"), linear: true, content_type: "application/xhtml+xml".into(), leaves: n, dropped_empty: 0, body_fallback: false, paragraphs }
}

/// Three sections, six paragraphs, one of them rejected: five to translate.
pub(super) fn manifest() -> Vec<SectionInput> {
    vec![section(0, &[P00, TWO_SPACES, P02]), section(1, &[P10, P11]), section(2, &[P20])]
}

/// The paragraphs a full run sends, in reading order.
pub(super) const SENT: [(u32, u32, &str); 5] = [(0, 0, P00), (0, 2, P02), (1, 0, P10), (1, 1, P11), (2, 0, P20)];

pub(super) fn make(db: &Db, model: &Artifact) -> String {
    create(&db.m().lock().unwrap(), "book", &config_for(model, &gpu("Vulkan0")), "1.4.1 TEST", &manifest(), 10).unwrap()
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Fault {
    Engine,
    Cancelled,
}

impl SourceError for Fault {
    fn is_cancellation(&self) -> bool {
        *self == Fault::Cancelled
    }
    fn describe(&self) -> String {
        match self {
            Fault::Engine => "the engine went away".into(),
            Fault::Cancelled => "cancelled".into(),
        }
    }
}

/// An engine, scripted: it answers from `ANSWERS` (anything else gets an empty answer), and records what it was
/// asked and whether the database was free each time. Like the real source, it refuses an exchange once `cancel` is
/// set.
struct Script<'a> {
    db: Option<&'a Mutex<Connection>>,
    cancel: Option<&'a AtomicBool>,
    /// Whether it refuses an exchange once `cancel` is set, as the engine's source does.
    honours_cancel: bool,
    asked: Vec<String>,
    lock_free: bool,
    /// Answer the first request for this text with this fault.
    fail: Option<(&'static str, Fault)>,
    /// Set `cancel` once this many requests have been answered.
    cancel_after: Option<usize>,
}

impl<'a> Script<'a> {
    fn new(db: &'a Db, cancel: &'a AtomicBool) -> Script<'a> {
        Script { db: Some(db.m()), cancel: Some(cancel), honours_cancel: true, asked: Vec::new(), lock_free: true, fail: None, cancel_after: None }
    }

    /// The same engine, alone: what the pipeline makes of a paragraph with these answers.
    fn alone() -> Script<'static> {
        Script { db: None, cancel: None, honours_cancel: false, asked: Vec::new(), lock_free: true, fail: None, cancel_after: None }
    }
}

impl Source for Script<'_> {
    type Error = Fault;
    fn answer(&mut self, r: &Request) -> Result<Raw, Fault> {
        if let Some(db) = self.db {
            self.lock_free &= db.try_lock().is_ok();
        }
        if self.honours_cancel && self.cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(Fault::Cancelled);
        }
        self.asked.push(r.text.clone());
        if let Some((text, fault)) = self.fail.clone() {
            if text == r.text {
                self.fail = None;
                return Err(fault);
            }
        }
        if let (Some(n), Some(c)) = (self.cancel_after, self.cancel) {
            if self.asked.len() >= n {
                c.store(true, Ordering::SeqCst);
            }
        }
        let out = ANSWERS.iter().find(|(t, _)| *t == r.text).map(|(_, a)| a.to_string()).unwrap_or_default();
        Ok(Raw { out, tokens: Some(9), stop: "eos".into() })
    }
}

/// What the pipeline makes of `text` with the scripted answers — what the store must hold for it.
pub(super) fn expected(text: &str, model: &Artifact) -> Outcome {
    let k = engine_config(&ENGINE_WINDOWS_X64, model, &gpu("Vulkan0")).unwrap().profile_k;
    pipeline::translate(&mut Script::alone(), &Profile { k }, &Paragraph { text: text.into(), sentences: sentences(text) }).unwrap()
}

fn go(db: &Db, id: &str, model: &Artifact, engine: &EngineInfo, scope: &Scope, cancel: &AtomicBool, source: &mut Script) -> Result<RunReport, RunError> {
    let now = || 1_000;
    run(&Run { db: db.m(), edition_id: id, spec: &ENGINE_WINDOWS_X64, model, running: engine, app_build: "1.4.1 TEST", scope, cancel, now: &now }, source)
}

/// The paragraph texts first sent, in order — the paragraph's first request is always its first translation.
fn first_requests(asked: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for a in asked {
        if !seen.contains(a) && ANSWERS.iter().any(|(t, _)| t == a) || a == TWO_SPACES {
            seen.push(a.clone());
        }
    }
    seen
}

pub(super) fn sessions(db: &Db, id: &str) -> Vec<(Option<String>, bool)> {
    let c = db.m().lock().unwrap();
    let mut st = c.prepare("SELECT end_reason, ended_at IS NOT NULL FROM translation_sessions WHERE edition_id = ?1 ORDER BY rowid").unwrap();
    let rows = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
    rows
}

pub(super) fn failures(db: &Db, id: &str) -> Vec<(u32, u32, String, String)> {
    let c = db.m().lock().unwrap();
    let mut st = c.prepare("SELECT section_index, ordinal, kind, detail FROM translation_failures WHERE edition_id = ?1 ORDER BY rowid").unwrap();
    let rows = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect();
    rows
}

pub(super) fn state(db: &Db, id: &str) -> Edition {
    get(&db.m().lock().unwrap(), id).unwrap().unwrap()
}

/// Every paragraph that has a result holds exactly what the pipeline makes of it; returns how many have one.
pub(super) fn results_are_the_pipelines(db: &Db, id: &str, model: &Artifact) -> usize {
    let c = db.m().lock().unwrap();
    let mut n = 0;
    for (si, ord, text) in SENT {
        if let Some(r) = result(&c, id, si, ord).unwrap() {
            let want = expected(text, model);
            assert_eq!(r.status, want.status.name(), "{si}:{ord}");
            assert_eq!(r.text, want.text, "{si}:{ord}");
            assert_eq!(r.outcome_json, outcome_json(&want), "{si}:{ord}");
            n += 1;
        }
    }
    assert!(result(&c, id, 0, 1).unwrap().is_none(), "the rejected paragraph never has a result");
    n
}

// ---- The engine's configuration ----

#[test]
fn the_engine_configuration_is_the_catalogs_for_what_runs() {
    let a = engine_config(&ENGINE_WINDOWS_X64, &MODEL_A, &gpu("Vulkan0")).unwrap();
    let launch = catalog::launch_profile(&MODEL_A).unwrap();
    assert_eq!(a.model_id, MODEL_A.id);
    assert_eq!(a.model_sha256, MODEL_A.sha256);
    assert_eq!(a.runtime_id, RUNTIME_WINDOWS_X64.id);
    assert_eq!(a.runtime_sha256, RUNTIME_WINDOWS_X64.sha256);
    assert_eq!(a.launch_flags, launch.gpu.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(a.execution, Execution::Gpu { device: "Vulkan0".into() });
    assert_eq!(a.pipeline_id, PIPELINE_ID);
    assert_eq!(a.profile_k.to_bits(), 1.0f64.to_bits());

    let cpu = engine_config(&ENGINE_WINDOWS_X64, &MODEL_B, &engine::Execution::Cpu { threads: 6 }).unwrap();
    assert_eq!(cpu.launch_flags, catalog::launch_profile(&MODEL_B).unwrap().cpu.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(cpu.execution, Execution::Cpu { threads: 6 });
    assert_eq!(cpu.profile_k.to_bits(), 0.932f64.to_bits());
    assert_eq!(engine_config(&ENGINE_WINDOWS_X64, &RUNTIME_WINDOWS_X64, &gpu("Vulkan0")), None, "the runtime is not a model");
}

// ---- Runs ----

#[test]
fn a_run_sends_every_pending_paragraph_in_reading_order_and_completes_the_edition() {
    let db = scratch("full");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut s).unwrap();

    assert_eq!(first_requests(&s.asked), SENT.iter().map(|(_, _, t)| t.to_string()).collect::<Vec<_>>(), "reading order, the rejected one never");
    assert!(!s.asked.iter().any(|a| a == TWO_SPACES), "a paragraph that broke the input contract is never sent");
    assert!(s.lock_free, "the database is never locked while the engine is asked");
    assert_eq!(report.end, RunEnd::Complete);
    assert_eq!(report.state, EditionState::Complete);
    assert_eq!(report.translated, 5);
    assert_eq!(report.input_failures, vec![]);
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5);
    assert_eq!(sessions(&db, &id), vec![(Some("complete".into()), true)]);
    let ed = state(&db, &id);
    assert_eq!((ed.state, ed.counts.pending, ed.counts.done, ed.counts.rejected), (EditionState::Complete, 0, 5, 1));
    assert_eq!(go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut Script::new(&db, &cancel)), Err(RunError::NothingPending));
}

#[test]
fn a_paragraph_the_engine_cannot_translate_is_stored_failed_without_text() {
    // Nothing is answered for the last paragraph, so every candidate is empty.
    let db = scratch("failed");
    let id = create(&db.m().lock().unwrap(), "book", &config_for(&MODEL_A, &gpu("Vulkan0")), "t", &[section(0, &[P00, "Nobody answers this."])], 1).unwrap();
    let cancel = AtomicBool::new(false);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut Script::new(&db, &cancel)).unwrap();
    assert_eq!(report.end, RunEnd::Complete);
    let r = result(&db.m().lock().unwrap(), &id, 0, 1).unwrap().unwrap();
    assert_eq!((r.status.as_str(), r.text, r.final_kind), ("FAILED", None, None));
}

#[test]
fn a_cancel_between_paragraphs_stops_before_the_next_and_a_new_run_finishes_the_edition() {
    let db = scratch("cancel-between");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    s.cancel_after = Some(1); // the first paragraph takes one request
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut s).unwrap();
    assert_eq!(s.asked, vec![P00.to_string()], "nothing more is asked once the run is cancelled");
    assert_eq!((report.end, report.state, report.translated), (RunEnd::Cancelled, EditionState::Stopped, 1));
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 1);
    assert_eq!(failures(&db, &id), vec![], "a cancel is not a failure");

    cancel.store(false, Ordering::SeqCst);
    let mut again = Script::new(&db, &cancel);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut again).unwrap();
    assert!(!again.asked.iter().any(|a| a == P00), "a stored paragraph is never sent again");
    assert_eq!((report.end, report.translated), (RunEnd::Complete, 4));
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5, "the same results as one uninterrupted run");
    assert_eq!(sessions(&db, &id), vec![(Some("cancelled".into()), true), (Some("complete".into()), true)]);
}

#[test]
fn the_run_itself_stops_at_a_cancel_whatever_its_source_does() {
    // A source that never looks at the flag: only the run's own check between paragraphs can stop it.
    let db = scratch("cancel-runner");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    s.honours_cancel = false;
    s.cancel_after = Some(1);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut s).unwrap();
    assert_eq!(s.asked, vec![P00.to_string()], "the next paragraph is never started");
    assert_eq!((report.end, report.translated), (RunEnd::Cancelled, 1));
}

#[test]
fn a_cancel_during_an_exchange_leaves_that_paragraph_untouched() {
    let db = scratch("cancel-during");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    s.fail = Some((P02, Fault::Cancelled));
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut s).unwrap();
    assert_eq!((report.end, report.state, report.translated), (RunEnd::Cancelled, EditionState::Stopped, 1));
    assert!(result(&db.m().lock().unwrap(), &id, 0, 2).unwrap().is_none(), "the paragraph in flight has no row");
    assert_eq!(failures(&db, &id), vec![]);
    assert!(!s.asked.iter().any(|a| a == P10), "nothing after it is sent");
    assert_eq!(state(&db, &id).counts.pending, 4);
}

#[test]
fn an_engine_failure_is_logged_without_text_the_paragraph_stays_pending_and_the_run_stops() {
    let db = scratch("engine");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    s.fail = Some((P02, Fault::Engine));
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut s).unwrap();
    assert_eq!(report.end, RunEnd::EngineFailed { section_index: 0, ordinal: 2 });
    assert_eq!((report.state, report.translated), (EditionState::Stopped, 1));
    assert_eq!(failures(&db, &id), vec![(0, 2, "engine".into(), "fast request 0: the engine went away".into())]);
    assert!(!failures(&db, &id)[0].3.contains(P02), "a failure never holds the paragraph's text");
    assert!(!s.asked.iter().any(|a| a == P10), "the run stops at the failure: no retry, nothing after it");
    assert_eq!(sessions(&db, &id), vec![(Some("engine".into()), true)]);

    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut Script::new(&db, &cancel)).unwrap();
    assert_eq!((report.end, report.translated), (RunEnd::Complete, 4));
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5);
    assert_eq!(failures(&db, &id).len(), 1, "the logged attempt is kept");
}

#[test]
fn a_paragraph_the_pipeline_cannot_plan_is_logged_stays_pending_and_the_run_goes_on() {
    let db = scratch("input");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    let now = || 1_000;
    let engine = running(&MODEL_A, gpu("Vulkan0"));
    let r = Run { db: db.m(), edition_id: &id, spec: &ENGINE_WINDOWS_X64, model: &MODEL_A, running: &engine, app_build: "t", scope: &Scope::All, cancel: &cancel, now: &now };
    let unplannable = |s: &mut Script<'_>, k: &Profile, p: &Paragraph| {
        if p.text == P10 {
            Err(PipelineError::Input(InputError::Unlocatable { planner: Planner::Units, what: "unit", index: 0 }))
        } else {
            pipeline::translate(s, k, p)
        }
    };
    let report = run_with(&r, &mut s, unplannable).unwrap();
    assert_eq!(report.end, RunEnd::Done, "everything it was given was attempted; one paragraph is still pending");
    assert_eq!(report.input_failures, vec![(1, 0)]);
    assert_eq!((report.state, report.translated), (EditionState::Stopped, 4));
    assert_eq!(failures(&db, &id), vec![(1, 0, "input".into(), "Units planner: unit 0 is not in the paragraph at its place".into())]);
    assert!(result(&db.m().lock().unwrap(), &id, 1, 0).unwrap().is_none(), "never a result");
    assert_eq!(sessions(&db, &id), vec![(Some("cancelled".into()), true)]);
}

#[test]
fn a_result_the_store_refuses_ends_the_run_and_closes_its_session() {
    let db = scratch("refused");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let now = || 1_000;
    let engine = running(&MODEL_A, gpu("Vulkan0"));
    let r = Run { db: db.m(), edition_id: &id, spec: &ENGINE_WINDOWS_X64, model: &MODEL_A, running: &engine, app_build: "t", scope: &Scope::All, cancel: &cancel, now: &now };
    let broken = |_: &mut Script<'_>, _: &Profile, _: &Paragraph| {
        Ok(Outcome { status: Status::Failed, final_kind: None, text: Some("text without a status to carry it".into()), steps: vec![], d1: None, why_review: None, candidates: BTreeMap::new(), requests: vec![] })
    };
    let e = run_with(&r, &mut Script::new(&db, &cancel), broken).unwrap_err();
    assert!(matches!(e, RunError::Store(EditionError::InvalidOutcome(_))), "{e:?}");
    assert_eq!(state(&db, &id).counts.done, 0, "nothing was stored");
    assert_eq!(sessions(&db, &id), vec![(Some("cancelled".into()), true)], "the session is closed, not left running");
    assert_eq!(state(&db, &id).state, EditionState::Stopped);
}

#[test]
fn a_run_takes_only_the_sections_it_is_given() {
    let db = scratch("sections");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let mut s = Script::new(&db, &cancel);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::Sections(BTreeSet::from([1])), &cancel, &mut s).unwrap();
    assert_eq!(first_requests(&s.asked), vec![P10.to_string(), P11.to_string()]);
    assert_eq!((report.end, report.state, report.translated), (RunEnd::Done, EditionState::Stopped, 2));
    assert_eq!(sessions(&db, &id), vec![(Some("cancelled".into()), true)]);

    let mut rest = Script::new(&db, &cancel);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::Sections(BTreeSet::from([0, 2])), &cancel, &mut rest).unwrap();
    assert_eq!(first_requests(&rest.asked), vec![P00.to_string(), P02.to_string(), P20.to_string()]);
    assert_eq!((report.end, report.state), (RunEnd::Complete, EditionState::Complete));
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5);
}

#[test]
fn a_selection_that_names_nothing_to_do_opens_nothing_and_sends_nothing() {
    let db = scratch("selection");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let engine = running(&MODEL_A, gpu("Vulkan0"));
    let cases: Vec<(Scope, RunError)> = vec![
        (Scope::Sections(BTreeSet::new()), RunError::EmptySelection),
        (Scope::Sections(BTreeSet::from([1, 7])), RunError::NoSuchSection(7)),
    ];
    for (scope, want) in cases {
        let mut s = Script::new(&db, &cancel);
        assert_eq!(go(&db, &id, &MODEL_A, &engine, &scope, &cancel, &mut s), Err(want));
        assert!(s.asked.is_empty());
    }
    let mut s = Script::new(&db, &cancel);
    assert_eq!(go(&db, "no-such-edition", &MODEL_A, &engine, &Scope::All, &cancel, &mut s), Err(RunError::Store(EditionError::NoSuchEdition)));
    assert_eq!(sessions(&db, &id), vec![], "no session was opened");

    go(&db, &id, &MODEL_A, &engine, &Scope::Sections(BTreeSet::from([1])), &cancel, &mut Script::new(&db, &cancel)).unwrap();
    let mut s = Script::new(&db, &cancel);
    assert_eq!(go(&db, &id, &MODEL_A, &engine, &Scope::Sections(BTreeSet::from([1])), &cancel, &mut s), Err(RunError::NothingPending), "section 1 is done");
    assert!(s.asked.is_empty());
    assert_eq!(sessions(&db, &id).len(), 1);
}

#[test]
fn another_model_runtime_execution_or_device_is_refused_before_any_request() {
    let db = scratch("config");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let cpu = engine::Execution::Cpu { threads: 6 };
    let cases: Vec<(&Artifact, EngineInfo, RunError)> = vec![
        (&MODEL_B, running(&MODEL_B, gpu("Vulkan0")), RunError::Store(EditionError::ConfigurationChanged { field: "model_id" })),
        (&MODEL_A, running(&MODEL_A, gpu("Vulkan1")), RunError::Store(EditionError::ConfigurationChanged { field: "execution" })),
        // The CPU path has its own launch flags, so that is the first thing that differs.
        (&MODEL_A, running(&MODEL_A, cpu.clone()), RunError::Store(EditionError::ConfigurationChanged { field: "launch_flags" })),
        (&MODEL_A, running(&MODEL_B, gpu("Vulkan0")), RunError::EngineMismatch { field: "model_id" }),
        (&RUNTIME_WINDOWS_X64, running(&MODEL_A, gpu("Vulkan0")), RunError::NotAModel),
    ];
    for (model, engine, want) in cases {
        let mut s = Script::new(&db, &cancel);
        assert_eq!(go(&db, &id, model, &engine, &Scope::All, &cancel, &mut s), Err(want.clone()));
        assert!(s.asked.is_empty(), "{want:?}: nothing was sent");
    }
    assert_eq!(sessions(&db, &id), vec![], "no session was opened");
    assert_eq!(state(&db, &id).state, EditionState::Ready);
}

#[test]
fn an_edition_from_other_translation_code_or_with_changed_inputs_is_refused_before_any_request() {
    let db = scratch("identity");
    let cancel = AtomicBool::new(false);
    let engine = running(&MODEL_A, gpu("Vulkan0"));
    let other = create_with_implementation(&db.m().lock().unwrap(), "book", &config_for(&MODEL_A, &gpu("Vulkan0")), "t", &manifest(), 1, &"b".repeat(64)).unwrap();
    let mut s = Script::new(&db, &cancel);
    assert_eq!(go(&db, &other, &MODEL_A, &engine, &Scope::All, &cancel, &mut s), Err(RunError::Store(EditionError::ConfigurationChanged { field: "implementation" })));
    assert!(s.asked.is_empty());

    let id = make(&db, &MODEL_A);
    db.m().lock().unwrap().execute("UPDATE translation_paragraphs SET source_text = 'Something else.' WHERE edition_id = ?1 AND section_index = 1 AND ordinal = 0", params![id]).unwrap();
    let mut s = Script::new(&db, &cancel);
    assert!(matches!(go(&db, &id, &MODEL_A, &engine, &Scope::All, &cancel, &mut s), Err(RunError::Store(EditionError::Integrity(_)))));
    assert!(s.asked.is_empty(), "nothing is sent from inputs that no longer match the edition");
    assert_eq!(sessions(&db, &id), vec![]);
}

/// The canonical JSON the store hashes its identity over, written again here: keys sorted at every depth, compact.
fn canonical(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canonical(&m[k.as_str()]))).collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

#[test]
fn an_edition_from_an_earlier_extraction_is_still_resumed() {
    // Only this build's extraction can make an edition; one an earlier build made, with its own extraction id and the
    // identity that id gives, is still translated: its inputs are frozen and checked.
    let db = scratch("earlier-extraction");
    let id = make(&db, &MODEL_A);
    let ed = state(&db, &id);
    let identity_of = |extraction: &str| {
        let mut config = ed.config.clone();
        config.extraction_id = extraction.into();
        format!("{:x}", Sha256::digest(canonical(&identity(&ed.book_id, &config, &ed.manifest_sha256, &ed.implementation_sha256)).as_bytes()))
    };
    assert_eq!(identity_of(SUPPORTED_EXTRACTION_ID), ed.identity_sha256, "the identity is formed here exactly as the store forms it");
    let earlier = "leafblocks-1/pyws-3.12.0-ucd15/segmenter-en-1";
    db.m().lock().unwrap().execute("UPDATE translation_editions SET extraction_id = ?2, identity_sha256 = ?3 WHERE id = ?1", params![id, earlier, identity_of(earlier)]).unwrap();
    verify(&db.m().lock().unwrap(), &id).expect("an edition from an earlier extraction is intact");

    let cancel = AtomicBool::new(false);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut Script::new(&db, &cancel)).unwrap();
    assert_eq!((report.end, report.translated), (RunEnd::Complete, 5));
    assert_eq!(state(&db, &id).config.extraction_id, earlier, "its extraction is kept as it was");
}

#[test]
fn a_run_that_never_ended_blocks_the_next_until_recovery_and_nothing_is_done_twice() {
    let db = scratch("interrupted");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    let engine = running(&MODEL_A, gpu("Vulkan0"));
    // A run killed after storing its first paragraph: its session is open, its edition `running`.
    let killed = {
        let c = db.m().lock().unwrap();
        let session = begin_session(&c, &id, &config_for(&MODEL_A, &gpu("Vulkan0")).engine, "t", None, 5).unwrap();
        record_result(&c, &session, 0, 0, &expected(P00, &MODEL_A), 3, 6).unwrap();
        session
    };
    let mut s = Script::new(&db, &cancel);
    assert_eq!(go(&db, &id, &MODEL_A, &engine, &Scope::All, &cancel, &mut s), Err(RunError::Store(EditionError::AlreadyRunning)));
    assert!(s.asked.is_empty());

    assert_eq!(recover_interrupted(&db.m().lock().unwrap(), 7).unwrap(), 1);
    assert_eq!(state(&db, &id).state, EditionState::Stopped);
    let mut s = Script::new(&db, &cancel);
    let report = go(&db, &id, &MODEL_A, &engine, &Scope::All, &cancel, &mut s).unwrap();
    assert!(!s.asked.iter().any(|a| a == P00), "the stored paragraph is not sent again");
    assert_eq!((report.end, report.translated), (RunEnd::Complete, 4));
    assert_eq!(result(&db.m().lock().unwrap(), &id, 0, 0).unwrap().unwrap().session_id, killed, "its result is the one the killed run stored");
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5);
    assert_eq!(sessions(&db, &id), vec![(Some("interrupted".into()), true), (Some("complete".into()), true)]);
}

#[test]
fn a_run_already_cancelled_sends_nothing_and_closes_its_session() {
    let db = scratch("precancelled");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(true);
    let mut s = Script::new(&db, &cancel);
    let report = go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut s).unwrap();
    assert_eq!((report.end, report.state, report.translated), (RunEnd::Cancelled, EditionState::Stopped, 0));
    assert!(s.asked.is_empty());
    assert_eq!(sessions(&db, &id), vec![(Some("cancelled".into()), true)]);
}

#[test]
fn the_session_records_the_engine_without_any_text() {
    let db = scratch("info");
    let id = make(&db, &MODEL_A);
    let cancel = AtomicBool::new(false);
    go(&db, &id, &MODEL_A, &running(&MODEL_A, gpu("Vulkan0")), &Scope::All, &cancel, &mut Script::new(&db, &cancel)).unwrap();
    let c = db.m().lock().unwrap();
    let (info, model, execution): (String, String, String) =
        c.query_row("SELECT engine_info, model_sha256, execution_detail FROM translation_sessions WHERE edition_id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    let v: Value = serde_json::from_str(&info).unwrap();
    assert_eq!(v["model_id"], MODEL_A.id);
    assert_eq!(v["execution"]["gpu"]["device"], "Vulkan0");
    assert_eq!(model, MODEL_A.sha256);
    assert_eq!(execution, r#"{"device":"Vulkan0"}"#);
}

// ---- The recorded evaluation, through the runner and the store (private recordings) ----

/// Answers from the recordings: the paragraph is the one whose first translation is being asked for (equal texts
/// were recorded identically, which is checked when they are loaded). Every `stop_every` paragraphs it answers the
/// next first translation as a cancellation, so the run stops there and the next one resumes.
struct Recorded<'a> {
    by_text: &'a HashMap<String, Value>,
    current: Option<&'a Value>,
    stop_every: usize,
    started: usize,
    problems: Vec<String>,
}

fn raw_of(v: &Value) -> Raw {
    Raw { out: v["out"].as_str().expect("out").to_string(), tokens: v["tokens"].as_u64(), stop: v["stop"].as_str().expect("stop").to_string() }
}

fn empty_raw() -> Raw {
    Raw { out: String::new(), tokens: Some(0), stop: "eos".into() }
}

impl Source for Recorded<'_> {
    type Error = Fault;
    fn answer(&mut self, r: &Request) -> Result<Raw, Fault> {
        if r.kind == Kind::Fast {
            if self.started == self.stop_every {
                return Err(Fault::Cancelled);
            }
            self.started += 1;
            self.current = self.by_text.get(&r.text);
            if self.current.is_none() {
                self.problems.push("a first translation of a text that was never recorded".into());
            }
        }
        let Some(f) = self.current else { return Ok(empty_raw()) };
        let c = &f["candidates"][r.kind.name()];
        if c.is_null() || c.get("skipped").is_some() {
            return Ok(empty_raw());
        }
        match r.kind {
            Kind::Chunked => match c["chunks"].as_array().and_then(|a| a.get(r.index)) {
                Some(ch) => Ok(raw_of(ch)),
                None => {
                    self.problems.push(format!("chunk {} beyond the recording", r.index));
                    Ok(empty_raw())
                }
            },
            Kind::Sentences => {
                self.problems.push("a unit was requested one by one".into());
                Ok(empty_raw())
            }
            _ => Ok(raw_of(c)),
        }
    }

    fn joined_units(&mut self, _units: &[String], _limits: &[u32]) -> Option<Result<Raw, Fault>> {
        let c = self.current.map(|f| &f["candidates"]["S"]);
        Some(Ok(match c {
            Some(c) if !c.is_null() && c.get("skipped").is_none() => raw_of(c),
            _ => empty_raw(),
        }))
    }
}

fn file_sha256(p: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))))
}

#[test]
#[ignore = "needs the private recordings (see the module documentation)"]
fn the_recorded_evaluation_runs_through_the_store_exactly() {
    let fixtures = PathBuf::from(std::env::var("SARD_TRANSLATION_REPLAY_FIXTURES").expect("SARD_TRANSLATION_REPLAY_FIXTURES is not set — this test needs the private recordings"));
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(fixtures.join("manifest.json")).unwrap()).unwrap();
    for (name, info) in manifest["outputs"].as_object().unwrap() {
        assert_eq!(file_sha256(&fixtures.join(name)), info["sha256"].as_str().unwrap(), "{name} differs from its manifest");
    }
    const STOP_EVERY: usize = 97;
    let mut bad: Vec<String> = Vec::new();
    for (name, model) in [("locked-A.jsonl", &MODEL_A), ("locked-B.jsonl", &MODEL_B), ("confirm-A.jsonl", &MODEL_A), ("confirm-B.jsonl", &MODEL_B)] {
        let rows: Vec<Value> = std::fs::read_to_string(fixtures.join(name)).unwrap().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
        let k = engine_config(&ENGINE_WINDOWS_X64, model, &gpu("Vulkan0")).unwrap().profile_k;
        let mut by_text: HashMap<String, Value> = HashMap::new();
        // Sections by the recorded key's section, in order of first appearance; paragraphs in file order.
        let mut labels: Vec<String> = Vec::new();
        let mut keyed: Vec<(usize, usize)> = Vec::new(); // row -> (section, ordinal)
        let mut texts: Vec<Vec<usize>> = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            assert_eq!(r["k"].as_f64().unwrap().to_bits(), k.to_bits(), "{name}: the recorded constant is the catalog model's");
            let label = r["key"].as_str().unwrap().rsplit_once(':').unwrap().0.to_string();
            let s = labels.iter().position(|l| *l == label).unwrap_or_else(|| {
                labels.push(label);
                texts.push(Vec::new());
                labels.len() - 1
            });
            keyed.push((s, texts[s].len()));
            texts[s].push(i);
            let src = r["src"].as_str().unwrap().to_string();
            if let Some(seen) = by_text.get(&src) {
                assert!(seen["candidates"] == r["candidates"] && seen["expected"] == r["expected"], "{name}: an equal text was recorded differently");
            }
            by_text.insert(src, r.clone());
        }
        let sections: Vec<SectionInput> = texts
            .iter()
            .enumerate()
            .map(|(s, rs)| {
                let paragraphs: Vec<ParagraphInput> = rs
                    .iter()
                    .enumerate()
                    .map(|(j, &i)| ParagraphInput {
                        path: vec![j as u32],
                        tag: "p".into(),
                        atoms: BTreeMap::new(),
                        text: rows[i]["src"].as_str().unwrap().into(),
                        sentences: rows[i]["sents"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect(),
                    })
                    .collect();
                let n = paragraphs.len() as u32;
                SectionInput { index: s as u32, href: format!("s{s}.xhtml"), linear: true, content_type: "application/xhtml+xml".into(), leaves: n, dropped_empty: 0, body_fallback: false, paragraphs }
            })
            .collect();

        let db = scratch(&format!("replay-{name}"));
        let id = create(&db.m().lock().unwrap(), "book", &config_for(model, &gpu("Vulkan0")), "replay", &sections, 1).unwrap();
        assert_eq!(state(&db, &id).counts.rejected, 0, "{name}: every recorded paragraph meets the input contract");
        let cancel = AtomicBool::new(false);
        let engine = running(model, gpu("Vulkan0"));
        let mut runs = 0;
        loop {
            runs += 1;
            let mut s = Recorded { by_text: &by_text, current: None, stop_every: STOP_EVERY, started: 0, problems: Vec::new() };
            let now = || 1_000;
            let report = run(&Run { db: db.m(), edition_id: &id, spec: &ENGINE_WINDOWS_X64, model, running: &engine, app_build: "replay", scope: &Scope::All, cancel: &cancel, now: &now }, &mut s).unwrap();
            bad.extend(s.problems.iter().map(|p| format!("{name} run {runs}: {p}")));
            assert!(report.input_failures.is_empty(), "{name}: input failures {:?}", report.input_failures);
            match report.end {
                RunEnd::Complete => break,
                RunEnd::Cancelled => assert_eq!(report.translated as usize, STOP_EVERY, "{name}: a run stops exactly where it was stopped"),
                other => panic!("{name}: unexpected end {other:?}"),
            }
        }
        let c = db.m().lock().unwrap();
        for (i, r) in rows.iter().enumerate() {
            let (s, j) = keyed[i];
            let key = r["key"].as_str().unwrap();
            let got = result(&c, &id, s as u32, j as u32).unwrap().unwrap_or_else(|| panic!("{name}:{key}: no result"));
            let d = &r["expected"]["decision"];
            let want_final = d["final"].as_str().unwrap();
            if got.status != d["status"].as_str().unwrap() {
                bad.push(format!("{name}:{key}: status {} != {}", got.status, d["status"]));
            }
            if got.final_kind.as_deref().unwrap_or("FAILED") != want_final {
                bad.push(format!("{name}:{key}: final {:?} != {want_final}", got.final_kind));
            }
            if got.text.as_deref() != r["expected"]["final_text"].as_str() {
                bad.push(format!("{name}:{key}: the stored text differs from the recording"));
            }
            if let Some(w) = d.get("why_review").and_then(Value::as_str) {
                if got.why_review.as_deref() != Some(w) {
                    bad.push(format!("{name}:{key}: why_review {:?} != {w}", got.why_review));
                }
            }
        }
        let ed = get(&c, &id).unwrap().unwrap();
        let ended: i64 = c.query_row("SELECT COUNT(*) FROM translation_sessions WHERE edition_id = ?1 AND ended_at IS NOT NULL", [&id], |r| r.get(0)).unwrap();
        println!("{name}: {} paragraphs, {} sections, {runs} runs ({ended} sessions closed), state {:?}, done {}", rows.len(), sections.len(), ed.state, ed.counts.done);
        assert_eq!((ed.state, ed.counts.done as usize, ended as usize), (EditionState::Complete, rows.len(), runs));
    }
    assert!(bad.is_empty(), "{} mismatches, first: {:?}", bad.len(), &bad[..bad.len().min(10)]);
}
