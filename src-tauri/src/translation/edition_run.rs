//! The edition runner: translates an edition's pending paragraphs, in reading order, and stores each result whole
//! the moment it exists.
//!
//! WHAT IT TRUSTS: nothing it is handed. It builds the engine half of the configuration from the catalog — the
//! runtime and the model the engine was started with, that model's launch flags for the execution path the engine
//! reports, its constant, and `PIPELINE_ID` — and refuses an engine that reports another model. The store then opens
//! the session only if the edition's stored inputs still match their hashes, this build's translation code is the
//! one the edition was made with, and every setting is the edition's: two models are never mixed, and neither are
//! GPU and CPU output without an approval nothing can grant yet.
//!
//! WHAT IT SENDS: only what the store lists as pending — paragraphs the input contract accepted and that have no
//! result — in reading order, and only those of the sections the caller names, if it names any. Which sections a
//! caller names is not decided here.
//!
//! THE DATABASE LOCK is taken for each store call and released before the pipeline asks the engine anything, so
//! nothing else waits on a translation.
//!
//! HOW A RUN ENDS, and what its session records:
//! * every pending paragraph of the edition has its result — `complete`;
//! * the engine failed — the attempt is logged, the paragraph stays pending and the run stops — `engine`. There is
//!   no retry: when, and how often, to try again is not decided;
//! * cancelled between paragraphs, or during an exchange (one already sent finishes first); or every paragraph it was
//!   given was attempted while others are still pending — `cancelled`;
//! * a paragraph the pipeline cannot plan is logged as an input failure, stays pending, and the run goes on. The
//!   pipeline's input contract is checked when an edition is made, so this is not expected; it is never hidden.
//!
//! A paragraph is all or nothing: one in flight when a run stops has no row and is done again by the next run. A run
//! that never ends its session — a crash, a kill, a panic — leaves its edition `running` until the store's
//! `recover_interrupted` closes the session as interrupted. That must run once when Sard starts, before any run; it
//! is part of wiring translation into the app, which this module does not do.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::json;

use super::catalog::{self, Artifact, EngineSpec};
use super::editions::{self, EditionError, EditionState, EndReason, EngineConfig, Execution, FailureKind, Pending};
use super::engine::{self, EngineInfo};
use super::pipeline::{self, AdapterError, Model, Outcome, Paragraph, PipelineError, Profile, Source};

/// The pipeline, as an edition records it. Its code is pinned separately, by the implementation fingerprint.
pub const PIPELINE_ID: &str = "G2/1";

/// The engine half of an edition's configuration, from exactly what the engine is started with: the catalog's
/// runtime (`spec.archive`) and `model`, the model's launch flags for `execution`, its constant, and `PIPELINE_ID`.
/// `None` for an artifact that is not a translation model.
pub fn engine_config(spec: &EngineSpec, model: &Artifact, execution: &engine::Execution) -> Option<EngineConfig> {
    let launch = catalog::launch_profile(model)?;
    let profile = Model::of(model)?.profile();
    let (flags, execution) = match execution {
        engine::Execution::Gpu { device } => (launch.gpu, Execution::Gpu { device: device.clone() }),
        engine::Execution::Cpu { threads } => (launch.cpu, Execution::Cpu { threads: u32::from(*threads) }),
    };
    Some(EngineConfig {
        model_id: model.id.to_string(),
        model_sha256: model.sha256.to_string(),
        runtime_id: spec.archive.id.to_string(),
        runtime_sha256: spec.archive.sha256.to_string(),
        execution,
        launch_flags: flags.iter().map(|f| f.to_string()).collect(),
        pipeline_id: PIPELINE_ID.to_string(),
        profile_k: profile.k,
    })
}

/// Which pending paragraphs a run takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Every pending paragraph of the edition.
    All,
    /// Only the pending paragraphs of these sections, each of which must be one of the edition's.
    Sections(BTreeSet<u32>),
}

impl Scope {
    fn takes(&self, p: &Pending) -> bool {
        match self {
            Scope::All => true,
            Scope::Sections(s) => s.contains(&p.section_index),
        }
    }
}

/// What a run needs to know about its source's errors.
pub trait SourceError {
    /// The run's own cancellation — not a failure.
    fn is_cancellation(&self) -> bool;
    /// What went wrong, without any request or answer text: it is stored.
    fn describe(&self) -> String;
}

impl SourceError for AdapterError {
    fn is_cancellation(&self) -> bool {
        matches!(self, AdapterError::Cancelled)
    }

    fn describe(&self) -> String {
        self.to_string()
    }
}

/// One run: the edition, the engine exactly as it was started and as it reports itself, and the paragraphs to take.
pub struct Run<'a> {
    pub db: &'a Mutex<Connection>,
    pub edition_id: &'a str,
    /// The runtime the engine was started from.
    pub spec: &'a EngineSpec,
    /// The model the engine was started with.
    pub model: &'a Artifact,
    /// The engine, ready, as it reports itself. The source must be this engine.
    pub running: &'a EngineInfo,
    pub app_build: &'a str,
    pub scope: &'a Scope,
    /// Checked before every paragraph. The engine's own source checks the same flag before every exchange.
    pub cancel: &'a AtomicBool,
    /// The time the store records.
    pub now: &'a dyn Fn() -> i64,
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEnd {
    /// Every pending paragraph of the edition has its result.
    Complete,
    /// Every paragraph the run was given was attempted, and some are still pending: outside its sections, or ones
    /// the pipeline could not plan (`input_failures`).
    Done,
    /// Cancelled, between paragraphs or during an exchange.
    Cancelled,
    /// The engine failed on this paragraph, which stays pending.
    EngineFailed { section_index: u32, ordinal: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub session_id: String,
    pub end: RunEnd,
    /// The edition's state once the session was closed.
    pub state: EditionState,
    /// How many results this run stored.
    pub translated: u32,
    /// The paragraphs the pipeline could not plan, in reading order, as `(section_index, ordinal)`. Each is logged,
    /// and stays pending.
    pub input_failures: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunError {
    /// The model is not one the pipeline translates with.
    NotAModel,
    /// The running engine is not the one the run was given.
    EngineMismatch { field: &'static str },
    /// The run was given no section.
    EmptySelection,
    /// The run was given a section the edition does not have.
    NoSuchSection(u32),
    /// Nothing the run was given is pending.
    NothingPending,
    /// The store refused, or failed. A session the run had opened has been closed (`cancelled`) if the store could.
    Store(EditionError),
    /// The database lock is poisoned.
    Lock,
}

fn with_db<T>(db: &Mutex<Connection>, f: impl FnOnce(&Connection) -> Result<T, EditionError>) -> Result<T, RunError> {
    let conn = db.lock().map_err(|_| RunError::Lock)?;
    f(&conn).map_err(RunError::Store)
}

/// Run the edition with the pipeline: translate what `run` takes, store each result, and close the session.
pub fn run<S>(run: &Run<'_>, source: &mut S) -> Result<RunReport, RunError>
where
    S: Source,
    S::Error: SourceError,
{
    run_with(run, source, pipeline::translate)
}

/// `run`, with the pipeline given — so that a test can make it fail the ways the pipeline itself is not expected to.
pub(crate) fn run_with<S, T>(r: &Run<'_>, source: &mut S, mut translate: T) -> Result<RunReport, RunError>
where
    S: Source,
    S::Error: SourceError,
    T: FnMut(&mut S, &Profile, &Paragraph) -> Result<Outcome, PipelineError<S::Error>>,
{
    let engine = engine_config(r.spec, r.model, &r.running.execution).ok_or(RunError::NotAModel)?;
    if r.running.model_id != engine.model_id {
        return Err(RunError::EngineMismatch { field: "model_id" });
    }
    // The selection, against the edition, before anything is opened.
    if with_db(r.db, |c| editions::get(c, r.edition_id))?.is_none() {
        return Err(RunError::Store(EditionError::NoSuchEdition));
    }
    if let Scope::Sections(want) = r.scope {
        let have = with_db(r.db, |c| editions::section_indexes(c, r.edition_id))?;
        if want.is_empty() {
            return Err(RunError::EmptySelection);
        }
        if let Some(&missing) = want.iter().find(|s| !have.contains(s)) {
            return Err(RunError::NoSuchSection(missing));
        }
    }
    if !with_db(r.db, |c| editions::pending(c, r.edition_id))?.iter().any(|p| r.scope.takes(p)) {
        return Err(RunError::NothingPending);
    }

    let info = engine_info(r.running);
    let session = with_db(r.db, |c| editions::begin_session(c, r.edition_id, &engine, r.app_build, Some(&info), (r.now)()))?;
    // From here on, every way out closes the session.
    let work: Vec<Pending> = match with_db(r.db, |c| editions::pending(c, r.edition_id)) {
        Ok(p) => p.into_iter().filter(|p| r.scope.takes(p)).collect(),
        Err(e) => return Err(close(r, &session, e)),
    };
    let profile = Profile { k: engine.profile_k };
    let (mut translated, mut input_failures, mut end) = (0u32, Vec::new(), None);
    for p in work {
        if r.cancel.load(Ordering::SeqCst) {
            end = Some(RunEnd::Cancelled);
            break;
        }
        let (si, ord) = (p.section_index, p.ordinal);
        let paragraph = Paragraph { text: p.text, sentences: p.sentences };
        let started = Instant::now();
        let result = translate(source, &profile, &paragraph); // no lock is held while the engine works
        let took_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let stored = match result {
            Ok(outcome) => with_db(r.db, |c| editions::record_result(c, &session, si, ord, &outcome, took_ms, (r.now)())).map(|()| translated += 1),
            Err(PipelineError::Input(e)) => {
                input_failures.push((si, ord));
                with_db(r.db, |c| editions::record_failure(c, &session, si, ord, FailureKind::Input, &e.to_string(), (r.now)()))
            }
            Err(PipelineError::Source { error, .. }) if error.is_cancellation() => {
                end = Some(RunEnd::Cancelled);
                break;
            }
            Err(PipelineError::Source { kind, index, error }) => {
                let detail = format!("{} request {index}: {}", kind.name(), error.describe());
                end = Some(RunEnd::EngineFailed { section_index: si, ordinal: ord });
                with_db(r.db, |c| editions::record_failure(c, &session, si, ord, FailureKind::Engine, &detail, (r.now)()))
            }
        };
        if let Err(e) = stored {
            return Err(close(r, &session, e));
        }
        if end.is_some() {
            break;
        }
    }
    let end = match end {
        Some(end) => end,
        None => match with_db(r.db, |c| editions::get(c, r.edition_id)) {
            Ok(Some(ed)) if ed.counts.pending == 0 => RunEnd::Complete,
            Ok(_) => RunEnd::Done,
            Err(e) => return Err(close(r, &session, e)),
        },
    };
    let reason = match end {
        RunEnd::Complete => EndReason::Complete,
        RunEnd::Done | RunEnd::Cancelled => EndReason::Cancelled,
        RunEnd::EngineFailed { .. } => EndReason::Engine,
    };
    let state = match with_db(r.db, |c| editions::end_session(c, &session, reason, (r.now)())) {
        Ok(state) => state,
        Err(e) => return Err(close(r, &session, e)),
    };
    Ok(RunReport { session_id: session, end, state, translated, input_failures })
}

/// After the store refused or failed mid-run: close the session as `cancelled` if the store still can, and pass the
/// failure on. If it cannot, the session stays open until `recover_interrupted`.
fn close(r: &Run<'_>, session: &str, e: RunError) -> RunError {
    let _ = with_db(r.db, |c| editions::end_session(c, session, EndReason::Cancelled, (r.now)()));
    e
}

/// What the session records of the engine: its model, where it runs, and how its start went. No text.
fn engine_info(e: &EngineInfo) -> String {
    let execution = match &e.execution {
        engine::Execution::Gpu { device } => json!({ "gpu": { "device": device } }),
        engine::Execution::Cpu { threads } => json!({ "cpu": { "threads": threads } }),
    };
    let ms = |v: u128| u64::try_from(v).unwrap_or(u64::MAX);
    let p = &e.phases;
    json!({
        "model_id": e.model_id,
        "execution": execution,
        "phases_ms": { "created": ms(p.created_ms), "listening": ms(p.listening_ms), "loaded": ms(p.loaded_ms), "ready": ms(p.ready_ms), "probe": ms(p.probe_ms) },
    })
    .to_string()
}
