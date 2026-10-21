//! Preparing a model: the step from "Downloaded" to "Ready".
//!
//! A downloaded model is verified, but nothing has yet shown that it runs on this computer. Preparing shows it, once,
//! by the steps below. Only a preparation that passes every one of them makes the model ready, and only that is
//! recorded.
//!
//! ## What a preparation does, in order
//!
//! 1. **The licence.** A model whose terms must be accepted is prepared only if the current revision of them is
//!    accepted, exactly as for its download (`manage`). Without one, nothing else happens.
//! 2. **The model is installed**: verified and recorded. Anything else (not downloaded, interrupted, never verified,
//!    damaged) is refused. From here to the end the model is held in use, so that it is not verified again or
//!    removed under the preparation.
//! 3. **The engine**, if it is not installed, is installed from the runtime archive, which must already be downloaded
//!    and verified. Nothing is ever downloaded here: a missing archive is `RuntimeMissing`, and the model's own
//!    download fetches it.
//! 4. **The start, on the GPU** (`execution::start` with the preference `gpu`). The engine is asked which GPUs it
//!    offers, the computer is assessed again with that list, and the engine is started with the model on the GPU the
//!    hardware check confirms: the model loaded once, the engine checked, and its readiness probe answered. A GPU the
//!    check does not confirm is refused, with the CPU named when it could run. Nothing switches to it.
//! 5. **The test translation:** `TEST_SENTENCE`, through the pipeline exactly as a book's paragraph is translated, each
//!    exchange bounded by `PROVISIONAL_GPU_EXCHANGE_TIMEOUT`. It passes only when the pipeline accepts a translation
//!    (OK, RECOVERED or SECOND: its own checks found nothing wrong) and that translation has Arabic letters. REVIEW
//!    and FAILED do not pass.
//! 6. **The engine is stopped**, whatever the test gave. It is never kept after a preparation.
//! 7. **Ready is recorded**, with the GPU the model ran on.
//!
//! ## The record
//!
//! A row of its own table (`translation_prepared`), bound to the exact model file and the exact engine (their catalog
//! SHA-256). `ready` reads it as ready only while it names the model's and the engine's current bytes and both are
//! installed: a model removed or replaced by other bytes, or an engine that is not installed, is not ready, whatever
//! the row says.
//!
//! A preparation that reaches the engine and does not pass removes the row: the model was just tried here and did not
//! run. One that ends without saying anything about the model leaves the row as it was: refused before the engine is
//! asked anything (the licence, the files), cancelled, another engine running, or the computer unreadable.
//!
//! ## From the interface
//!
//! No command of its own. A fetch that ends with the model downloaded and verified goes on to prepare it, in the same
//! job and under the same cancel (`model_commands`); "Try again" on a downloaded model that is not ready is that same
//! fetch, which finds every file in place and prepares.
//!
//! ## Not here
//!
//! * **The CPU.** Whether the CPU path is offered at all is decision D4, and no exchange timeout is decided for it, so
//!   a preparation runs on the GPU only.
//! * **A run with the real engine in the tests.** The steps are tested against scripted engines. The real engine and
//!   GPU are exercised only by the ignored test at the end of `prepare_tests`, run by hand.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use super::catalog::{Artifact, EngineSpec, Kind};
use super::engine::{EngineError, EngineInfo, EngineManager, Execution, PhaseTimes};
use super::execution::{self, NotStarted, Preference};
use super::install::{self, EngineState, InstallError};
use super::manage::{self, LicenceStatus, StateKind};
use super::pipeline::{self, Candidate, EngineSource, Model, Outcome, Paragraph, PipelineError, Source, Status, PROVISIONAL_GPU_EXCHANGE_TIMEOUT};
use super::store::{State, Store};

/// The sentence every preparation translates: one plain sentence, which the pipeline plans as a single unit and any
/// working model translates in a few Arabic words.
pub const TEST_SENTENCE: &str = "The small library on the corner opens early every morning.";

/// What a preparation needs of an engine. `Managed` is the engine manager behind it; the tests script it.
pub trait Engine {
    type Source: Source;
    /// Start the engine with the model, on the GPU the hardware check confirms. Blocks until it is ready. A start that
    /// fails leaves nothing of its own running.
    fn start(&self) -> Result<EngineInfo, NotStarted>;
    /// A source for the running engine. The source refuses an exchange once `cancel` is set.
    fn source(&self, cancel: Arc<AtomicBool>) -> Result<Self::Source, String>;
    /// Stop the engine. Idempotent.
    fn stop(&self) -> Result<(), String>;
}

/// The engine manager, as a preparation's engine. A stop of the manager from another thread ends a start under way.
pub struct Managed<'a> {
    pub manager: &'a EngineManager,
    pub store: &'a Store,
    pub spec: &'a EngineSpec,
    pub model: &'static Artifact,
}

impl Engine for Managed<'_> {
    type Source = EngineSource;

    fn start(&self) -> Result<EngineInfo, NotStarted> {
        execution::start(self.manager, self.store, self.spec, self.model, Preference::Gpu, None).map(|(_, info)| info)
    }

    fn source(&self, cancel: Arc<AtomicBool>) -> Result<EngineSource, String> {
        let endpoint = self.manager.endpoint().ok_or_else(|| "the engine is not running".to_string())?;
        let model = Model::of(self.model).ok_or_else(|| format!("{} is not a translation model", self.model.id))?;
        Ok(EngineSource::new(endpoint, model, PROVISIONAL_GPU_EXCHANGE_TIMEOUT, cancel))
    }

    fn stop(&self) -> Result<(), String> {
        self.manager.stop().map_err(|e| e.to_string())
    }
}

/// Everything a preparation works with.
pub struct Context<'a> {
    /// Sard's database: held only to read the licence acceptance and to write the record, never while the engine runs.
    pub db: &'a Mutex<Connection>,
    pub store: &'a Store,
    pub spec: &'a EngineSpec,
    /// The time to record, in Unix seconds.
    pub now: &'a dyn Fn() -> i64,
}

/// What a preparation is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Installing the engine from the runtime archive already on disk.
    Installing,
    /// Asking the engine for its GPUs, then starting it with the model.
    Starting,
    /// Translating the test sentence.
    Testing,
}

/// What a successful preparation did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    /// The GPU the model ran on, by the engine's name for it.
    pub device: String,
    /// Whether the engine had to be installed first.
    pub engine_installed: bool,
    /// The test translation's status and text.
    pub status: Status,
    pub text: String,
    pub phases: PhaseTimes,
    /// When it was recorded, in Unix seconds.
    pub prepared_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareError {
    /// Only a translation model can be prepared.
    NotAModel(&'static str),
    /// The model's licence terms are not accepted in their current revision. Nothing was done.
    LicenceNotAccepted { model: &'static str, status: LicenceStatus },
    /// The model is not installed (verified and recorded). Nothing was started.
    NotInstalled { model: &'static str, state: StateKind },
    /// The engine is not installed and its runtime archive is not downloaded. Nothing is downloaded here.
    RuntimeMissing,
    Install(InstallError),
    /// The start was not made, or failed: the hardware check refused the GPU, the computer could not be read, or the
    /// engine failed.
    NotStarted(NotStarted),
    /// An exchange of the test translation failed: a timeout, an error from the engine, a lost connection.
    TestFailed(String),
    /// The test translation did not pass. `status` is the pipeline's; `reasons` are its checks', in its own words.
    TestRejected { status: Status, reasons: Vec<String> },
    /// The engine did not stop after the test. Nothing was recorded.
    StopFailed(String),
    Cancelled,
    Store(String),
}

impl std::fmt::Display for PrepareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAModel(id) => write!(f, "{id} is not a translation model"),
            Self::LicenceNotAccepted { model, .. } => write!(f, "the licence terms of {model} are not accepted"),
            Self::NotInstalled { model, state } => write!(f, "{model} is not installed ({state:?})"),
            Self::RuntimeMissing => write!(f, "the translation engine is not installed, and its archive is not downloaded"),
            Self::Install(e) => write!(f, "the translation engine could not be installed: {e}"),
            Self::NotStarted(NotStarted::Engine(e)) => match e.recovery() {
                Some(recovery) => write!(f, "{e}. {recovery}"),
                None => write!(f, "{e}"),
            },
            Self::NotStarted(NotStarted::Assessment(e)) => write!(f, "the computer could not be read: {e}"),
            Self::NotStarted(NotStarted::Refused { why, .. }) => write!(f, "the hardware check did not confirm the GPU: {why:?}"),
            Self::NotStarted(other) => write!(f, "the GPU is not used: {other:?}"),
            Self::TestFailed(why) => write!(f, "the test translation failed: {why}"),
            Self::TestRejected { status, reasons } => write!(f, "the test translation was not accepted ({}): {}", status.name(), reasons.join("; ")),
            Self::StopFailed(why) => write!(f, "the engine did not stop: {why}"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Store(why) => write!(f, "{why}"),
        }
    }
}

/// A model prepared with its current bytes and the current engine, both still installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    pub device: String,
    pub prepared_at: i64,
}

/// One row of the record, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub model: String,
    pub model_sha256: String,
    pub engine_sha256: String,
    pub device: String,
    pub prepared_at: i64,
}

fn store_err(e: impl std::fmt::Display) -> PrepareError {
    PrepareError::Store(e.to_string())
}

fn lock(db: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

/// Prepare `model` with `engine`, by the steps in the module notes. Every step is reported to `events` as it begins.
/// `cancel` is looked at before the engine is installed and before it is started, and stops the test's next exchange;
/// a start under way is ended by stopping the engine manager.
pub fn prepare<E: Engine>(ctx: &Context, model: &'static Artifact, engine: &E, cancel: &Arc<AtomicBool>, events: &mut dyn FnMut(Step)) -> Result<Prepared, PrepareError>
where
    <E::Source as Source>::Error: std::fmt::Display,
{
    let pipeline_model = match Model::of(model) {
        Some(m) if model.kind == Kind::Model => m,
        _ => return Err(PrepareError::NotAModel(model.id)),
    };
    // 1. The licence, before anything else is touched.
    let status = manage::licence_status(&lock(ctx.db), model.licence).map_err(store_err)?;
    if !matches!(status, LicenceStatus::NotRequired | LicenceStatus::Accepted { .. }) {
        return Err(PrepareError::LicenceNotAccepted { model: model.id, status });
    }
    // 2. The model, installed — and in use from now on.
    let _in_use = manage::hold(model.id);
    let state = ctx.store.state(model).map_err(store_err)?;
    if state != State::Installed {
        return Err(PrepareError::NotInstalled { model: model.id, state: (&state).into() });
    }
    // 3. The engine, from the archive already on disk.
    if cancel.load(Ordering::SeqCst) {
        return Err(PrepareError::Cancelled);
    }
    let engine_installed = match install::state(ctx.store, ctx.spec).map_err(store_err)? {
        EngineState::Installed => false,
        EngineState::NotInstalled | EngineState::Unverified | EngineState::Damaged { .. } => {
            if ctx.store.state(ctx.spec.archive).map_err(store_err)? != State::Installed {
                return Err(PrepareError::RuntimeMissing);
            }
            events(Step::Installing);
            install::install(ctx.store, ctx.spec, cancel).map_err(|e| match e {
                InstallError::Cancelled => PrepareError::Cancelled,
                e => PrepareError::Install(e),
            })?;
            true
        }
    };
    // 4. The start, on the GPU.
    if cancel.load(Ordering::SeqCst) {
        return Err(PrepareError::Cancelled);
    }
    events(Step::Starting);
    let info = match engine.start() {
        Ok(info) => info,
        // A start that fails leaves nothing running, and the engine is not stopped after it: when another engine was
        // running (`AlreadyActive`), that stop would end the other engine's work.
        Err(e) => {
            let error = match e {
                NotStarted::Engine(EngineError::Cancelled) => PrepareError::Cancelled,
                e => PrepareError::NotStarted(e),
            };
            return Err(failed(ctx, model, error));
        }
    };
    let device = match &info.execution {
        Execution::Gpu { device } => device.clone(),
        // The start asks for the GPU only; an engine on the CPU is refused, never recorded.
        Execution::Cpu { .. } => {
            let _ = engine.stop();
            let error = EngineError::InvalidExecution("a preparation runs on the GPU only".into());
            return Err(failed(ctx, model, PrepareError::NotStarted(NotStarted::Engine(error))));
        }
    };
    // 5. The test translation.
    events(Step::Testing);
    let tested = test(engine, pipeline_model, cancel);
    // 6. The engine is stopped, whatever the test gave.
    if let Err(why) = engine.stop() {
        return Err(failed(ctx, model, PrepareError::StopFailed(why)));
    }
    let outcome = tested.map_err(|e| failed(ctx, model, e))?;
    let text = accepted(&outcome).map_err(|reasons| failed(ctx, model, PrepareError::TestRejected { status: outcome.status, reasons }))?;
    // 7. Ready.
    let prepared_at = (ctx.now)();
    record(&lock(ctx.db), model, ctx.spec, &device, prepared_at).map_err(store_err)?;
    Ok(Prepared { device, engine_installed, status: outcome.status, text, phases: info.phases, prepared_at })
}

/// Translate `TEST_SENTENCE` with the running engine.
fn test<E: Engine>(engine: &E, model: Model, cancel: &Arc<AtomicBool>) -> Result<Outcome, PrepareError>
where
    <E::Source as Source>::Error: std::fmt::Display,
{
    let mut source = engine.source(cancel.clone()).map_err(PrepareError::TestFailed)?;
    let paragraph = Paragraph { text: TEST_SENTENCE.to_string(), sentences: vec![TEST_SENTENCE.to_string()] };
    pipeline::translate(&mut source, &model.profile(), &paragraph).map_err(|e| match e {
        _ if cancel.load(Ordering::SeqCst) => PrepareError::Cancelled,
        PipelineError::Source { error, .. } => PrepareError::TestFailed(error.to_string()),
        PipelineError::Input(error) => PrepareError::TestFailed(error.to_string()),
    })
}

/// The test translation's text, when it passes: a translation the pipeline accepted, with Arabic letters in it.
/// Otherwise why not, in the pipeline's own words.
fn accepted(outcome: &Outcome) -> Result<String, Vec<String>> {
    let text = outcome.text.as_deref().unwrap_or("");
    let accepted = matches!(outcome.status, Status::Ok | Status::Recovered | Status::Second);
    if accepted && text.chars().any(is_arabic_letter) {
        return Ok(text.to_string());
    }
    let mut reasons = Vec::new();
    if let Some(why) = outcome.why_review {
        reasons.push(why.text().to_string());
    }
    if let Some(Candidate::Produced(first)) = outcome.candidates.get(&pipeline::Kind::Fast) {
        reasons.extend(first.flags.iter().cloned());
        reasons.extend(first.script.iter().cloned());
    }
    if accepted {
        reasons.push("the translation has no Arabic letters".to_string());
    }
    Err(reasons)
}

fn is_arabic_letter(c: char) -> bool {
    c.is_alphabetic() && matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

/// A preparation that reached the engine and did not pass: the model was just tried here and did not run, so it is
/// not left ready. A cancel, another engine running, or a computer that could not be read say nothing about the model,
/// and leave the record as it was.
fn failed(ctx: &Context, model: &Artifact, error: PrepareError) -> PrepareError {
    let says_nothing = matches!(
        error,
        PrepareError::Cancelled | PrepareError::NotStarted(NotStarted::Engine(EngineError::AlreadyActive)) | PrepareError::NotStarted(NotStarted::Assessment(_))
    );
    if says_nothing {
        return error;
    }
    match forget(&lock(ctx.db), model.id) {
        Ok(()) => error,
        Err(e) => PrepareError::Store(format!("{error:?}, and the earlier record could not be removed: {e}")),
    }
}

/// Whether `model` is ready: prepared with its current bytes and the current engine, both still installed.
pub fn ready(conn: &Connection, store: &Store, spec: &EngineSpec, model: &Artifact) -> Result<Option<Ready>, String> {
    let records = records(conn).map_err(|e| e.to_string())?;
    ready_in(&records, store, spec, model).map_err(|e| e.to_string())
}

/// Every row of the record. Read under the database lock; judged with `ready_in` without it.
pub fn records(conn: &Connection) -> rusqlite::Result<Vec<Record>> {
    let mut st = conn.prepare("SELECT model, model_sha256, engine_sha256, device, prepared_at FROM translation_prepared ORDER BY model")?;
    let rows = st.query_map([], |r| {
        Ok(Record { model: r.get(0)?, model_sha256: r.get(1)?, engine_sha256: r.get(2)?, device: r.get(3)?, prepared_at: r.get(4)? })
    })?;
    rows.collect()
}

/// Whether `records` make `model` ready: a row naming its current bytes and the current engine's, with both installed.
pub fn ready_in(records: &[Record], store: &Store, spec: &EngineSpec, model: &Artifact) -> std::io::Result<Option<Ready>> {
    let Some(row) = records.iter().find(|r| r.model == model.id && r.model_sha256 == model.sha256 && r.engine_sha256 == spec.archive.sha256) else {
        return Ok(None);
    };
    let installed = store.state(model)? == State::Installed && install::state(store, spec)? == EngineState::Installed;
    Ok(installed.then(|| Ready { device: row.device.clone(), prepared_at: row.prepared_at }))
}

fn record(conn: &Connection, model: &Artifact, spec: &EngineSpec, device: &str, at: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO translation_prepared(model, model_sha256, engine_sha256, device, prepared_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![model.id, model.sha256, spec.archive.sha256, device, at],
    )
    .map(|_| ())
}

fn forget(conn: &Connection, model: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM translation_prepared WHERE model = ?1", [model]).map(|_| ())
}
