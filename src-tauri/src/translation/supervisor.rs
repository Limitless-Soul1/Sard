//! Supervising a translation: the engine is started for it, restarted once if it fails, and stopped when it is no
//! longer needed.
//!
//! THE RULE, for an engine that fails while translating: one restart, and the run resumes at the paragraph where it
//! stopped — the pipeline keeps nothing between paragraphs, and the store holds every finished one. A second failure
//! in the same job ends it: the finished paragraphs stay, and the report says where and why. There is no other
//! retry; when, and how often, to try again later is not decided here.
//!
//! THE ENGINE'S LIFE: started only for a translation, and never for a job with nothing to do. Stopped at once when a
//! job is cancelled or fails. Kept for a short idle period after a job that finished, so that the next one need not
//! load the model again, and then stopped. It ends with Sard in any case: the engine manager runs it in a job the
//! operating system closes when Sard ends. It is never resident.
//!
//! The engine is reached through `Engine`, so that the rule is tested against scripted engines; `Managed` is the
//! engine manager behind it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use super::catalog::{Artifact, EngineSpec};
use super::edition_run::{self, Run, RunEnd, RunError, RunReport, Scope, SourceError};
use super::editions;
use super::engine::{self, EngineInfo, EngineManager, EngineStatus};
use super::pipeline::{EngineSource, Model, Source};
use super::store::Store;

/// How long a finished job's engine is kept for the next one. PROVISIONAL: no measurement or decision fixes it; it
/// only trades a model load against memory held while nothing is translated.
pub const IDLE_STOP: Duration = Duration::from_secs(60);
/// How many times one job restarts a failed engine.
pub const RESTARTS: u32 = 1;

/// What a job needs of an engine.
pub trait Engine: Send + Sync + 'static {
    type Source: Source;
    /// The engine running now, if it is this one — its model, where it runs — and ready.
    fn ready(&self) -> Option<EngineInfo>;
    /// Start this engine, stopping whatever else runs first. Blocks until it is ready.
    fn start(&self) -> Result<EngineInfo, String>;
    /// A source for the running engine. The source refuses an exchange once `cancel` is set.
    fn source(&self, cancel: Arc<AtomicBool>) -> Result<Self::Source, String>;
    /// Stop the engine. Idempotent.
    fn stop(&self) -> Result<(), String>;
}

/// The engine manager, as a job's engine: one model, one execution path, one exchange timeout.
pub struct Managed {
    pub manager: Arc<EngineManager>,
    pub store: Store,
    pub spec: &'static EngineSpec,
    pub model: &'static Artifact,
    pub execution: engine::Execution,
    /// Bounds every exchange. On the GPU, `PROVISIONAL_GPU_EXCHANGE_TIMEOUT`; the CPU's is not decided.
    pub exchange_timeout: Duration,
}

impl Engine for Managed {
    type Source = EngineSource;

    fn ready(&self) -> Option<EngineInfo> {
        match self.manager.status() {
            EngineStatus::Ready(info) if info.model_id == self.model.id && info.execution == self.execution => Some(info),
            _ => None,
        }
    }

    fn start(&self) -> Result<EngineInfo, String> {
        self.manager.stop().map_err(|e| e.to_string())?;
        self.manager.start(&self.store, self.spec, self.model, self.execution.clone()).map_err(|e| e.to_string())
    }

    fn source(&self, cancel: Arc<AtomicBool>) -> Result<EngineSource, String> {
        let endpoint = self.manager.endpoint().ok_or_else(|| "the engine is not running".to_string())?;
        let model = Model::of(self.model).ok_or_else(|| format!("{} is not a translation model", self.model.id))?;
        Ok(EngineSource::new(endpoint, model, self.exchange_timeout, cancel))
    }

    fn stop(&self) -> Result<(), String> {
        self.manager.stop().map_err(|e| e.to_string())
    }
}

/// Stops an engine once the idle period is over, unless a job takes it first.
#[derive(Default)]
pub struct Idle {
    generation: Arc<Mutex<u64>>,
}

impl Idle {
    /// A job holds the engine: any idle stop pending is called off. Waits for one already under way to finish.
    fn hold(&self) {
        *self.generation.lock().unwrap_or_else(|p| p.into_inner()) += 1;
    }

    /// Stop `engine` after `after`, unless a job holds it before then.
    fn stop_after<E: Engine>(&self, engine: Arc<E>, after: Duration) {
        let generation = self.generation.clone();
        let mine = {
            let mut g = generation.lock().unwrap_or_else(|p| p.into_inner());
            *g += 1;
            *g
        };
        std::thread::spawn(move || {
            std::thread::sleep(after);
            // Checked and stopped under the lock, so a job that starts now waits for the stop, and then starts a new
            // engine rather than one that is going away.
            let g = generation.lock().unwrap_or_else(|p| p.into_inner());
            if *g == mine {
                let _ = engine.stop();
            }
        });
    }
}

/// One job: an edition, the model and runtime it is translated with, and the paragraphs to take.
pub struct Job<'a> {
    pub db: &'a Mutex<Connection>,
    pub edition_id: &'a str,
    pub spec: &'a EngineSpec,
    pub model: &'a Artifact,
    pub app_build: &'a str,
    pub scope: &'a Scope,
    pub cancel: Arc<AtomicBool>,
    pub now: &'a dyn Fn() -> i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobReport {
    /// Every run of the job, in order: one, or two after a restart.
    pub runs: Vec<RunReport>,
    pub restarts: u32,
}

impl JobReport {
    /// How the job ended: how its last run did.
    pub fn end(&self) -> &RunEnd {
        &self.runs.last().expect("a job has a run").end
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum JobError {
    /// Nothing the job was given is pending. The engine was not started.
    NothingPending,
    /// The engine could not be started, or reached. `runs` are the job's runs before it.
    Start { detail: String, runs: Vec<RunReport> },
    /// A run refused or failed (`RunError`). The engine was stopped.
    Run { error: RunError, runs: Vec<RunReport> },
}

/// Translate what `job` takes with `engine`, by the rule above. After a job that finished, the engine is stopped once
/// `idle_after` has passed without another job; after one that was cancelled or failed, at once.
pub fn translate<E>(job: &Job<'_>, engine: &Arc<E>, idle: &Idle, idle_after: Duration) -> Result<JobReport, JobError>
where
    E: Engine,
    <E::Source as Source>::Error: SourceError,
{
    // An engine is never started for nothing.
    let pending = job.db.lock().map_err(|_| JobError::Run { error: RunError::Lock, runs: Vec::new() }).and_then(|c| {
        editions::pending(&c, job.edition_id).map_err(|e| JobError::Run { error: RunError::Store(e), runs: Vec::new() })
    })?;
    let any = match job.scope {
        Scope::All => !pending.is_empty(),
        Scope::Sections(s) => pending.iter().any(|p| s.contains(&p.section_index)),
    };
    if !any {
        return Err(JobError::NothingPending);
    }
    // The model is in use for as long as the job runs: it cannot be removed or re-verified under it.
    let _in_use = super::manage::hold(job.model.id);

    idle.hold();
    let mut runs: Vec<RunReport> = Vec::new();
    let mut restarts = 0;
    loop {
        let info = match engine.ready() {
            Some(info) => info,
            None => match engine.start() {
                Ok(info) => info,
                Err(detail) => {
                    let _ = engine.stop();
                    return Err(JobError::Start { detail, runs });
                }
            },
        };
        let mut source = match engine.source(job.cancel.clone()) {
            Ok(s) => s,
            Err(detail) => {
                let _ = engine.stop();
                return Err(JobError::Start { detail, runs });
            }
        };
        let run = Run {
            db: job.db,
            edition_id: job.edition_id,
            spec: job.spec,
            model: job.model,
            running: &info,
            app_build: job.app_build,
            scope: job.scope,
            cancel: &job.cancel,
            now: job.now,
        };
        match edition_run::run(&run, &mut source) {
            Ok(report) => {
                let failed = matches!(report.end, RunEnd::EngineFailed { .. });
                runs.push(report);
                if failed && restarts < RESTARTS && !job.cancel.load(Ordering::SeqCst) {
                    restarts += 1;
                    let _ = engine.stop();
                    continue;
                }
                break;
            }
            Err(error) => {
                let _ = engine.stop();
                return Err(JobError::Run { error, runs });
            }
        }
    }
    let report = JobReport { runs, restarts };
    match report.end() {
        RunEnd::Complete | RunEnd::Done => idle.stop_after(engine.clone(), idle_after),
        RunEnd::Cancelled | RunEnd::EngineFailed { .. } => {
            let _ = engine.stop();
        }
    }
    Ok(report)
}
