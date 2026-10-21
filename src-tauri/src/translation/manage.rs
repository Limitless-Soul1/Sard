//! Managing the models: checking that one can run before anything is fetched, fetching it together with the runtime
//! and the engine, verifying a file again, and removing a model — each with typed outcomes and typed events, and none
//! of it reachable from the interface yet (no command is registered: the screens that ask the user, and show each
//! licence before its file is fetched, come first).
//!
//! ## What a fetch does, in order
//!
//! 1. **The licence.** A model whose licence carries terms the user must accept (the Gemma Terms) is fetched only if
//!    an acceptance of the CURRENT revision of those terms is recorded. Without one, nothing else happens: no file is
//!    opened, the computer is not read and nothing is requested. The acceptance is a row of its own table, written
//!    only by `accept_terms` against the revision the user was shown. It is not a setting, because the interface can
//!    write any setting. Recording an acceptance is not legal approval of anything; the terms and how they are shown
//!    are decision D3, under legal review.
//! 2. **One operation per file.** A second fetch, verification or removal of the same file is refused (`Busy`).
//! 3. **The check.** The computer is read once and the model classified on it. Before the runtime is installed its
//!    device list cannot be had (that runs the engine), so the GPU stays undetermined; the fetch is refused only when
//!    no path can run — too little disk or memory — or when disk or memory could not be read. Whether a computer that
//!    can only use the CPU should be offered the model is decision D4: it is reported (the assessment's CPU verdict),
//!    never decided here.
//! 4. **The runtime**, if it is not installed: downloaded — continued if an earlier fetch left part of it — and then
//!    the engine installed from it.
//! 5. **The model**, as the user asked: a new download (`Mode::Start`, for Download and Retry) or the continuation of
//!    an interrupted one (`Mode::Resume`). Neither ever happens without being asked for.
//!
//! A fetch ends with the model installed and verified. It is not yet ready: preparing it (a first start and a test
//! translation) is a separate step.
//!
//! ## In use
//!
//! A model is in use while a translation job holds it (`hold`, which the supervisor takes for the length of a job),
//! and every model is while an engine runs, since which one it has loaded is not known here. Removal and
//! verification (which deletes a file that does not match) are refused then. They take the engine slot for their
//! own length, so that no engine can start while a file is being removed.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use super::catalog::{self, Artifact, EngineSpec, Kind, Licence};
use super::download::{self, DownloadError, Mode, Policy};
use super::execution::Assessment;
use super::hardware::{self, Fit, HardwareError, HardwareReport, Undetermined};
use super::install::{self, EngineState, InstallError};
use super::slot::{self, Holder};
use super::store::{Removal, State, Store};

// ---- The licence ---------------------------------------------------------------------------------------------------

/// The revision of the Gemma Terms (with the Gemma Prohibited Use Policy) that Sard asks the user to accept.
///
/// PROVISIONAL (D3): the text Sard will show, and how, is not decided, and nothing is legally reviewed. This names
/// that text once it is fixed. Changing it makes every earlier acceptance stale, so that no acceptance ever carries
/// over to text the user has not seen.
pub const GEMMA_TERMS_REVISION: &str = "gemma-terms/provisional-1";

/// The terms the user must accept before a file under `licence` is downloaded, as their current revision. `None`:
/// no acceptance is needed (the licence's text and attribution go in Sard's notices).
pub fn terms_revision(licence: Licence) -> Option<&'static str> {
    match licence {
        Licence::GemmaTerms => Some(GEMMA_TERMS_REVISION),
        Licence::Apache2 | Licence::LlamaCppRuntime => None,
    }
}

/// How the licence is named in the acceptances table.
fn licence_key(licence: Licence) -> &'static str {
    match licence {
        Licence::GemmaTerms => "gemma_terms",
        Licence::Apache2 => "apache2",
        Licence::LlamaCppRuntime => "llama_cpp_runtime",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenceStatus {
    /// The licence asks for no acceptance.
    NotRequired,
    /// The current revision was accepted at `at` (Unix seconds).
    Accepted { revision: &'static str, at: i64 },
    /// Nothing was ever accepted for this licence.
    Missing { revision: &'static str },
    /// Only earlier revisions were accepted (`accepted`); the current one was not.
    Stale { revision: &'static str, accepted: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenceError {
    /// This licence asks for no acceptance; nothing is recorded.
    NotRequired,
    /// The revision the user was shown is not the current one; nothing is recorded.
    NotTheCurrentTerms { shown: String, current: &'static str },
    Store(String),
}

/// Whether `licence`'s current terms are accepted.
pub fn licence_status(conn: &Connection, licence: Licence) -> rusqlite::Result<LicenceStatus> {
    let Some(revision) = terms_revision(licence) else {
        return Ok(LicenceStatus::NotRequired);
    };
    let key = licence_key(licence);
    let at: Option<i64> = conn
        .query_row("SELECT accepted_at FROM translation_licence_acceptances WHERE licence = ?1 AND revision = ?2", [key, revision], |r| r.get(0))
        .optional()?;
    if let Some(at) = at {
        return Ok(LicenceStatus::Accepted { revision, at });
    }
    let mut st = conn.prepare("SELECT revision FROM translation_licence_acceptances WHERE licence = ?1 ORDER BY accepted_at, revision")?;
    let accepted: Vec<String> = st.query_map([key], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(if accepted.is_empty() { LicenceStatus::Missing { revision } } else { LicenceStatus::Stale { revision, accepted } })
}

/// Record that the user accepted `licence`'s terms, of the revision they were `shown`, at `now`. Only the current
/// revision can be accepted. Accepting it again keeps the first time.
pub fn accept_terms(conn: &Connection, licence: Licence, shown: &str, now: i64) -> Result<(), LicenceError> {
    let current = terms_revision(licence).ok_or(LicenceError::NotRequired)?;
    if shown != current {
        return Err(LicenceError::NotTheCurrentTerms { shown: shown.to_string(), current });
    }
    conn.execute(
        "INSERT OR IGNORE INTO translation_licence_acceptances(licence, revision, accepted_at) VALUES(?1, ?2, ?3)",
        rusqlite::params![licence_key(licence), current, now],
    )
    .map_err(|e| LicenceError::Store(e.to_string()))?;
    Ok(())
}

// ---- Outcomes and events -------------------------------------------------------------------------------------------

/// Who has a model in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InUseBy {
    /// A translation job holds it.
    Translation,
    /// An engine is running (with this model or another; which one is not known here).
    Engine,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    /// Only a model can be fetched or removed here.
    NotAModel(&'static str),
    /// The model's licence terms are not accepted in their current revision. Nothing was done.
    LicenceNotAccepted { model: &'static str, status: LicenceStatus },
    /// Another fetch, verification or removal of this file is under way.
    Busy(&'static str),
    /// The check could not read the computer (on another platform, the check does not exist).
    CheckFailed(HardwareError),
    /// No path can run the model here, or disk or memory could not be read: `gpu` and `cpu` say which.
    NotEligible { model: &'static str, gpu: Fit, cpu: Fit },
    /// The file is present but not usable (`State::Damaged`). It must be verified again or removed first.
    Damaged { artifact: &'static str, reason: String },
    Download { artifact: &'static str, error: DownloadError },
    Install(InstallError),
    InUse { model: &'static str, by: InUseBy },
    /// The user stopped a verification.
    Cancelled,
    Store(String),
}

/// What a fetch is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Reading the computer, before anything is fetched.
    Checking,
    Downloading,
    /// The whole file has arrived and is being hashed.
    Verifying,
    /// The engine is being installed from the runtime archive.
    Installing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Step { artifact: &'static str, step: Step },
    Progress { artifact: &'static str, done: u64, total: u64 },
    /// The artifact is done with, and stands as `state`.
    Finished { artifact: &'static str, state: State },
    /// The fetch ended on `error`; the artifact it ended on stands as `state` on disk.
    Failed { artifact: &'static str, error: ActionError, state: State },
}

/// What a successful fetch did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub runtime_downloaded: bool,
    pub engine_installed: bool,
    pub model_downloaded: bool,
    /// The check the fetch went ahead on.
    pub assessment: Assessment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verified {
    /// The file matches the catalog; its record was written again.
    Intact,
    /// The file did not match. It and its record were deleted: the model is not downloaded.
    Mismatch,
    /// There was no file to verify; the state is unchanged.
    Nothing(StateKind),
}

/// A `State` without its details, for an outcome that only reports which it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateKind {
    NotDownloaded,
    Interrupted,
    Installed,
    Unverified,
    Damaged,
}

impl From<&State> for StateKind {
    fn from(s: &State) -> Self {
        match s {
            State::NotDownloaded => Self::NotDownloaded,
            State::Interrupted { .. } => Self::Interrupted,
            State::Installed => Self::Installed,
            State::Unverified => Self::Unverified,
            State::Damaged { .. } => Self::Damaged,
        }
    }
}

// ---- In use, and one operation per file ----------------------------------------------------------------------------

static IN_USE: Mutex<BTreeMap<String, usize>> = Mutex::new(BTreeMap::new());

/// A model held in use. Dropping it lets the hold go.
#[derive(Debug)]
pub struct UseGuard(String);

impl Drop for UseGuard {
    fn drop(&mut self) {
        let mut held = IN_USE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = held.get_mut(&self.0) {
            *n -= 1;
            if *n == 0 {
                held.remove(&self.0);
            }
        }
    }
}

/// Hold the model `id` in use until the guard is dropped. Holds add up.
pub fn hold(id: &str) -> UseGuard {
    *IN_USE.lock().unwrap_or_else(|p| p.into_inner()).entry(id.to_string()).or_insert(0) += 1;
    UseGuard(id.to_string())
}

/// Whether something holds the model `id`.
pub fn held(id: &str) -> bool {
    IN_USE.lock().unwrap_or_else(|p| p.into_inner()).contains_key(id)
}

static OPERATIONS: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Operation(String);

impl Drop for Operation {
    fn drop(&mut self) {
        OPERATIONS.lock().unwrap_or_else(|p| p.into_inner()).retain(|k| k != &self.0);
    }
}

/// The one operation on `a` in `store`, or `Busy`.
fn operation(store: &Store, a: &'static Artifact) -> Result<Operation, ActionError> {
    let key = format!("{}|{}", store.root().display(), a.id);
    let mut ops = OPERATIONS.lock().unwrap_or_else(|p| p.into_inner());
    if ops.contains(&key) {
        return Err(ActionError::Busy(a.id));
    }
    ops.push(key.clone());
    Ok(Operation(key))
}

/// The engine slot for a change to the store's files, refused while a model is in use. The slot is taken BEFORE the
/// hold is looked at: a job that takes its hold after that look cannot start an engine until the slot is free again.
fn exclusive(model: &'static Artifact) -> Result<slot::SlotGuard, ActionError> {
    let guard = slot::claim(Holder::Install).map_err(|holder| match holder {
        Holder::Engine => ActionError::InUse { model: model.id, by: InUseBy::Engine },
        Holder::Install => ActionError::Busy(model.id),
    })?;
    if held(model.id) {
        return Err(ActionError::InUse { model: model.id, by: InUseBy::Translation });
    }
    Ok(guard)
}

fn store_err(e: impl std::fmt::Display) -> ActionError {
    ActionError::Store(e.to_string())
}

// ---- The check -----------------------------------------------------------------------------------------------------

/// Read the computer with `probe` and assess `model` for it, before anything is fetched. `Ok` when the fetch may go
/// ahead: the GPU still undetermined (no device list before the runtime runs) and disk and memory read and enough for
/// at least one path.
pub fn check(store: &Store, spec: &EngineSpec, model: &'static Artifact, probe: &dyn Fn(&Path) -> Result<HardwareReport, HardwareError>) -> Result<Assessment, ActionError> {
    let needs = catalog::needs(model).ok_or(ActionError::NotAModel(model.id))?;
    let found = probe(store.root()).map_err(ActionError::CheckFailed)?;
    let disk = hardware::disk_still_needed(store, spec, model).map_err(store_err)?;
    let assessed = Assessment::of(model.id, &needs, disk, &found, None);
    match assessed.gpu() {
        Fit::NotDetermined { why: Undetermined::DeviceListUnknown, .. } => Ok(assessed),
        _ => Err(ActionError::NotEligible { model: model.id, gpu: assessed.gpu().clone(), cpu: assessed.cpu().clone() }),
    }
}

// ---- Fetch ---------------------------------------------------------------------------------------------------------

/// Everything a fetch works with.
pub struct Context<'a> {
    /// Sard's database: held only to read the licence acceptance, never while a file is fetched.
    pub db: &'a Mutex<Connection>,
    pub store: &'a Store,
    pub spec: &'a EngineSpec,
    pub policy: &'a Policy,
    /// Reads the computer (`hardware::probe` in the app).
    pub probe: &'a dyn Fn(&Path) -> Result<HardwareReport, HardwareError>,
}

/// Fetch `model` — with the runtime and the engine if they are not installed yet — by the steps in the module notes.
/// `mode` is the user's: `Start` for Download and Retry, `Resume` for Resume. Every step is reported to `events`, and
/// a failure is reported there too (with the state its artifact is left in) before it is returned.
pub fn fetch(ctx: &Context, model: &'static Artifact, mode: Mode, cancel: &AtomicBool, events: &mut dyn FnMut(Event)) -> Result<Fetched, ActionError> {
    match fetch_steps(ctx, model, mode, cancel, events) {
        Ok(done) => Ok(done),
        Err((artifact, error)) => {
            let state = ctx.store.state(artifact).unwrap_or_else(|e| State::Damaged { reason: e.to_string() });
            events(Event::Failed { artifact: artifact.id, error: error.clone(), state });
            Err(error)
        }
    }
}

fn fetch_steps(ctx: &Context, model: &'static Artifact, mode: Mode, cancel: &AtomicBool, events: &mut dyn FnMut(Event)) -> Result<Fetched, (&'static Artifact, ActionError)> {
    let on_model = |e: ActionError| (model, e);
    if model.kind != Kind::Model {
        return Err(on_model(ActionError::NotAModel(model.id)));
    }
    // 1. The licence, before anything else is touched.
    let status = {
        let conn = ctx.db.lock().unwrap_or_else(|p| p.into_inner());
        licence_status(&conn, model.licence).map_err(|e| on_model(store_err(e)))?
    };
    if !matches!(status, LicenceStatus::NotRequired | LicenceStatus::Accepted { .. }) {
        return Err(on_model(ActionError::LicenceNotAccepted { model: model.id, status }));
    }
    // 2. One operation per file.
    let runtime = ctx.spec.archive;
    let _model_op = operation(ctx.store, model).map_err(on_model)?;
    let _runtime_op = operation(ctx.store, runtime).map_err(|e| (runtime, e))?;
    // 3. The check.
    events(Event::Step { artifact: model.id, step: Step::Checking });
    let assessment = check(ctx.store, ctx.spec, model, ctx.probe).map_err(on_model)?;
    // 4. The runtime, then the engine.
    let runtime_downloaded = match ctx.store.state(runtime).map_err(|e| (runtime, store_err(e)))? {
        State::Installed => false,
        State::NotDownloaded => fetch_file(ctx, runtime, Mode::Start, cancel, events)?,
        State::Interrupted { .. } => fetch_file(ctx, runtime, Mode::Resume, cancel, events)?,
        State::Unverified => match ctx.store.verify(runtime, cancel).map_err(|e| (runtime, store_err(e)))? {
            State::Installed => false,
            _ => fetch_file(ctx, runtime, Mode::Start, cancel, events)?,
        },
        State::Damaged { reason } => return Err((runtime, ActionError::Damaged { artifact: runtime.id, reason })),
    };
    let engine_installed = match install::state(ctx.store, ctx.spec).map_err(|e| (runtime, store_err(e)))? {
        EngineState::Installed => false,
        EngineState::NotInstalled | EngineState::Unverified | EngineState::Damaged { .. } => {
            events(Event::Step { artifact: runtime.id, step: Step::Installing });
            install::install(ctx.store, ctx.spec, cancel).map_err(|e| (runtime, ActionError::Install(e)))?;
            true
        }
    };
    // 5. The model, as the user asked.
    let model_downloaded = match ctx.store.state(model).map_err(|e| on_model(store_err(e)))? {
        State::Installed => false,
        State::Damaged { reason } => return Err(on_model(ActionError::Damaged { artifact: model.id, reason })),
        _ => fetch_file(ctx, model, mode, cancel, events)?,
    };
    events(Event::Finished { artifact: model.id, state: State::Installed });
    Ok(Fetched { runtime_downloaded, engine_installed, model_downloaded, assessment })
}

/// Download one file, reporting its progress and, once its last byte is in, its verification.
fn fetch_file(ctx: &Context, a: &'static Artifact, mode: Mode, cancel: &AtomicBool, events: &mut dyn FnMut(Event)) -> Result<bool, (&'static Artifact, ActionError)> {
    events(Event::Step { artifact: a.id, step: Step::Downloading });
    let mut verifying = false;
    download::download(ctx.store, a, mode, ctx.policy, cancel, |p| {
        events(Event::Progress { artifact: a.id, done: p.done, total: p.total });
        if p.done == p.total && !verifying {
            verifying = true;
            events(Event::Step { artifact: a.id, step: Step::Verifying });
        }
    })
    .map_err(|error| (a, ActionError::Download { artifact: a.id, error }))?;
    if a.kind == Kind::Runtime {
        events(Event::Finished { artifact: a.id, state: State::Installed });
    }
    Ok(true)
}

// ---- Verify and remove ---------------------------------------------------------------------------------------------

/// Hash `model`'s file again. A file that does not match is deleted with its record, never kept as installed.
pub fn verify(store: &Store, model: &'static Artifact, cancel: &AtomicBool) -> Result<Verified, ActionError> {
    if model.kind != Kind::Model {
        return Err(ActionError::NotAModel(model.id));
    }
    let _op = operation(store, model)?;
    let _slot = exclusive(model)?;
    let before = store.state(model).map_err(store_err)?;
    if matches!(before, State::NotDownloaded | State::Interrupted { .. }) {
        return Ok(Verified::Nothing((&before).into()));
    }
    match store.verify(model, cancel) {
        Ok(State::Installed) => Ok(Verified::Intact),
        Ok(_) => Ok(Verified::Mismatch),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => Err(ActionError::Cancelled),
        Err(e) => Err(store_err(e)),
    }
}

/// Remove `model`'s files — the file, its record and any unfinished download — and nothing else. Translations made
/// with it stay (D7): they are in the database, which this does not touch. Refused while the model is in use.
pub fn remove(store: &Store, model: &'static Artifact) -> Result<Removal, ActionError> {
    if model.kind != Kind::Model {
        return Err(ActionError::NotAModel(model.id));
    }
    let _op = operation(store, model)?;
    let _slot = exclusive(model)?;
    store.remove(model).map_err(store_err)
}
