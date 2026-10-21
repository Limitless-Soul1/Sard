//! The supervisor's rule, against scripted engines: one restart and a resume at the paragraph, a second failure ends
//! the job, and the engine's life — never started for nothing, stopped at once after a cancel or a failure, kept only
//! for the idle period after a job that finished.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::catalog::{ENGINE_WINDOWS_X64, MODEL_A};
use super::edition_run::{RunEnd, Scope};
use super::edition_run_tests::{failures, gpu, make, results_are_the_pipelines, running, scratch, sessions, state, Db, Fault, ANSWERS, P02, P10};
use super::editions::*;
use super::engine::EngineInfo;
use super::pipeline::{Raw, Request, Source};
use super::supervisor::*;

/// A scripted engine. Its n-th start answers from `ANSWERS`, except that the paragraph named for that start fails as
/// an engine failure. It records every start and stop.
struct Scripted {
    log: Mutex<Vec<&'static str>>,
    up: Mutex<Option<EngineInfo>>,
    starts: Mutex<usize>,
    fail_on: Vec<Option<&'static str>>,
    cannot_start: bool,
    /// Set the job's cancel flag once this many requests have been answered.
    cancel_after: Option<usize>,
    /// Set the cancel flag at the very moment the scripted failure happens.
    cancel_on_fail: bool,
    /// How long each answer takes.
    delay: Duration,
}

impl Scripted {
    fn new(fail_on: Vec<Option<&'static str>>) -> Arc<Scripted> {
        Arc::new(Scripted { log: Mutex::new(Vec::new()), up: Mutex::new(None), starts: Mutex::new(0), fail_on, cannot_start: false, cancel_after: None, cancel_on_fail: false, delay: Duration::ZERO })
    }
    fn log(&self) -> Vec<&'static str> {
        self.log.lock().unwrap().clone()
    }
}

struct ScriptedSource {
    fail: Option<&'static str>,
    cancel: Arc<AtomicBool>,
    cancel_after: Option<usize>,
    cancel_on_fail: bool,
    delay: Duration,
    answered: usize,
}

impl Source for ScriptedSource {
    type Error = Fault;
    fn answer(&mut self, r: &Request) -> Result<Raw, Fault> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(Fault::Cancelled);
        }
        std::thread::sleep(self.delay);
        if self.fail == Some(r.text.as_str()) {
            if self.cancel_on_fail {
                self.cancel.store(true, Ordering::SeqCst);
            }
            return Err(Fault::Engine);
        }
        self.answered += 1;
        if self.cancel_after == Some(self.answered) {
            self.cancel.store(true, Ordering::SeqCst);
        }
        let out = ANSWERS.iter().find(|(t, _)| *t == r.text).map(|(_, a)| a.to_string()).unwrap_or_default();
        Ok(Raw { out, tokens: Some(9), stop: "eos".into() })
    }
}

impl Engine for Scripted {
    type Source = ScriptedSource;
    fn ready(&self) -> Option<EngineInfo> {
        self.up.lock().unwrap().clone()
    }
    fn start(&self) -> Result<EngineInfo, String> {
        self.log.lock().unwrap().push("start");
        if self.cannot_start {
            return Err("the engine would not start".into());
        }
        *self.starts.lock().unwrap() += 1;
        let info = running(&MODEL_A, gpu("Vulkan0"));
        *self.up.lock().unwrap() = Some(info.clone());
        Ok(info)
    }
    fn source(&self, cancel: Arc<AtomicBool>) -> Result<ScriptedSource, String> {
        let n = *self.starts.lock().unwrap() - 1;
        Ok(ScriptedSource { fail: self.fail_on.get(n).copied().flatten(), cancel, cancel_after: self.cancel_after, cancel_on_fail: self.cancel_on_fail, delay: self.delay, answered: 0 })
    }
    fn stop(&self) -> Result<(), String> {
        self.log.lock().unwrap().push("stop");
        *self.up.lock().unwrap() = None;
        Ok(())
    }
}

fn job_on<'a>(db: &'a Db, id: &'a str, scope: &'a Scope, cancel: Arc<AtomicBool>, now: &'a dyn Fn() -> i64) -> Job<'a> {
    Job { db: db.m(), edition_id: id, spec: &ENGINE_WINDOWS_X64, model: &MODEL_A, app_build: "1.4.1 TEST", scope, cancel, now }
}

/// Wait, a little, for the engine's log to read `want`.
fn settles_to(e: &Scripted, want: &[&str]) -> bool {
    let until = Instant::now() + Duration::from_secs(5);
    while Instant::now() < until {
        if e.log() == want {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn a_job_translates_the_edition_and_keeps_the_engine_only_for_the_idle_period() {
    let db = scratch("sup-done");
    let id = make(&db, &MODEL_A);
    let engine = Scripted::new(vec![None]);
    let now = || 1_000;
    let report = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_millis(50)).unwrap();
    assert_eq!((report.end(), report.restarts, report.runs.len()), (&RunEnd::Complete, 0, 1));
    assert_eq!(engine.log(), vec!["start"], "the engine is kept for the idle period");
    assert!(settles_to(&engine, &["start", "stop"]), "and stopped after it: {:?}", engine.log());
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5);
}

#[test]
fn an_engine_failure_restarts_the_engine_once_and_the_run_resumes_at_the_paragraph() {
    let db = scratch("sup-restart");
    let id = make(&db, &MODEL_A);
    let engine = Scripted::new(vec![Some(P02), None]);
    let now = || 1_000;
    let report = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_secs(60)).unwrap();
    assert_eq!(report.restarts, 1);
    assert_eq!(report.runs.iter().map(|r| r.end.clone()).collect::<Vec<_>>(), vec![RunEnd::EngineFailed { section_index: 0, ordinal: 2 }, RunEnd::Complete]);
    assert_eq!(report.runs[1].translated, 4, "the second run starts at the failed paragraph, not before it");
    assert_eq!(engine.log(), vec!["start", "stop", "start"]);
    assert_eq!(results_are_the_pipelines(&db, &id, &MODEL_A), 5);
    assert_eq!(failures(&db, &id).len(), 1);
    assert_eq!(sessions(&db, &id), vec![(Some("engine".into()), true), (Some("complete".into()), true)]);
}

#[test]
fn a_second_failure_ends_the_job_stops_the_engine_and_keeps_what_was_finished() {
    let db = scratch("sup-twice");
    let id = make(&db, &MODEL_A);
    let engine = Scripted::new(vec![Some(P02), Some(P10)]);
    let now = || 1_000;
    let report = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_secs(60)).unwrap();
    assert_eq!(report.restarts, 1, "one restart, not two");
    assert_eq!(report.end(), &RunEnd::EngineFailed { section_index: 1, ordinal: 0 });
    assert_eq!(engine.log(), vec!["start", "stop", "start", "stop"], "stopped at once, not after an idle period");
    let ed = state(&db, &id);
    assert_eq!((ed.state, ed.counts.done, ed.counts.pending), (EditionState::Stopped, 2, 3), "the finished paragraphs stay");
    assert_eq!(failures(&db, &id).iter().map(|f| (f.0, f.1, f.2.clone())).collect::<Vec<_>>(), vec![(0, 2, "engine".into()), (1, 0, "engine".into())]);
}

#[test]
fn a_cancelled_job_stops_the_engine_at_once() {
    let db = scratch("sup-cancel");
    let id = make(&db, &MODEL_A);
    let engine = Arc::new(Scripted { cancel_after: Some(1), ..Arc::try_unwrap(Scripted::new(vec![None])).ok().unwrap() });
    let now = || 1_000;
    let report = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_secs(60)).unwrap();
    assert_eq!((report.end(), report.restarts), (&RunEnd::Cancelled, 0));
    assert_eq!(engine.log(), vec!["start", "stop"], "no restart for a cancel, and no idle period");
    assert_eq!(state(&db, &id).counts.done, 1);
}

#[test]
fn a_job_within_the_idle_period_takes_the_running_engine_and_calls_off_the_earlier_stop() {
    let db = scratch("sup-idle");
    let id = make(&db, &MODEL_A);
    let engine = Scripted::new(vec![None]);
    let idle = Idle::default();
    let now = || 1_000;
    let first = Scope::Sections(BTreeSet::from([1]));
    let report = translate(&job_on(&db, &id, &first, Arc::new(AtomicBool::new(false)), &now), &engine, &idle, Duration::from_millis(400)).unwrap();
    assert_eq!(report.end(), &RunEnd::Done);
    let rest = Scope::Sections(BTreeSet::from([0, 2]));
    let report = translate(&job_on(&db, &id, &rest, Arc::new(AtomicBool::new(false)), &now), &engine, &idle, Duration::from_millis(50)).unwrap();
    assert_eq!(report.end(), &RunEnd::Complete);
    assert!(settles_to(&engine, &["start", "stop"]), "one start for both jobs, one stop after the second: {:?}", engine.log());
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(engine.log(), vec!["start", "stop"], "the first job's stop was called off");
}

#[test]
fn an_engine_is_never_started_for_a_job_with_nothing_to_do() {
    let db = scratch("sup-nothing");
    let id = make(&db, &MODEL_A);
    let engine = Scripted::new(vec![None]);
    let now = || 1_000;
    translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_millis(10)).unwrap();
    assert!(settles_to(&engine, &["start", "stop"]));
    let e = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_millis(10)).unwrap_err();
    assert_eq!(e, JobError::NothingPending);
    assert_eq!(engine.log(), vec!["start", "stop"], "not started again");
}

#[test]
fn an_engine_that_cannot_start_is_reported_and_nothing_is_opened() {
    let db = scratch("sup-nostart");
    let id = make(&db, &MODEL_A);
    let engine = Arc::new(Scripted { cannot_start: true, ..Arc::try_unwrap(Scripted::new(vec![None])).ok().unwrap() });
    let now = || 1_000;
    let e = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_secs(60)).unwrap_err();
    assert_eq!(e, JobError::Start { detail: "the engine would not start".into(), runs: vec![] });
    assert_eq!(sessions(&db, &id), vec![], "no session was opened");
    assert_eq!(state(&db, &id).state, EditionState::Ready);
}

#[test]
fn an_engine_failure_that_comes_with_a_cancel_is_not_restarted() {
    let db = scratch("sup-fail-cancel");
    let id = make(&db, &MODEL_A);
    let engine = Arc::new(Scripted { cancel_on_fail: true, ..Arc::try_unwrap(Scripted::new(vec![Some(P02), None])).ok().unwrap() });
    let now = || 1_000;
    let report = translate(&job_on(&db, &id, &Scope::All, Arc::new(AtomicBool::new(false)), &now), &engine, &Idle::default(), Duration::from_secs(60)).unwrap();
    assert_eq!((report.end(), report.restarts), (&RunEnd::EngineFailed { section_index: 0, ordinal: 2 }, 0), "a cancelled job is not restarted");
    assert_eq!(engine.log(), vec!["start", "stop"]);
}

#[test]
fn an_idle_stop_never_ends_a_job_that_outlasts_it() {
    // The first job finishes with a short idle period; the second takes the engine, and runs well past it.
    let db = scratch("sup-long");
    let id = make(&db, &MODEL_A);
    let engine = Arc::new(Scripted { delay: Duration::from_millis(80), ..Arc::try_unwrap(Scripted::new(vec![None])).ok().unwrap() });
    let idle = Idle::default();
    let now = || 1_000;
    let first = Scope::Sections(BTreeSet::from([2]));
    translate(&job_on(&db, &id, &first, Arc::new(AtomicBool::new(false)), &now), &engine, &idle, Duration::from_millis(100)).unwrap();
    let rest = Scope::Sections(BTreeSet::from([0, 1]));
    let report = translate(&job_on(&db, &id, &rest, Arc::new(AtomicBool::new(false)), &now), &engine, &idle, Duration::from_secs(60)).unwrap();
    assert_eq!(report.end(), &RunEnd::Complete);
    assert_eq!(engine.log(), vec!["start"], "the first job's idle stop never reached the engine while the second ran");
}
