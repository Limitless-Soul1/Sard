//! The models section's actions, as the interface reaches them: fetch (with the runtime and the engine, and then the
//! model's preparation), cancel, verify, remove, and a licence's terms and their acceptance.
//!
//! A fetch runs on a thread of its own and reports every step on one event channel (`EVENT`), as the typed views
//! below; the command itself only starts it. A fetch that ends with the model downloaded and verified goes on to
//! prepare it (`prepare`), in the same job and under the same cancel, and the model's own end is reported once, after
//! that: the interface never sees a model finished while it is still being prepared. Everything is decided by
//! `manage` and `prepare` — the licence gate, the check, one operation per file, "in use", what makes a model ready —
//! so these commands add no rule of their own, except two of where they run:
//!
//! * the catalog is the active one (`active`): in a release build the built-in catalog, always;
//! * a development build's test catalog is used only beside moved data (`Root::isolated`), so its test files never
//!   reach a real translation directory.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::active::{self, Active};
use super::catalog::{Artifact, Licence};
use super::download::{DownloadError, Mode};
use super::engine::{EngineConfig, EngineError, EngineManager};
use super::execution::NotStarted;
use super::hardware::{self, Fit};
use super::install::InstallError;
use super::manage::{self, ActionError, Context, Event, LicenceError, Step, Verified};
use super::overview::{FitView, InUseView, LicenceStatusView, Root, StateView};
use super::pipeline::Source;
use super::prepare::{self, PrepareError};
use super::store::Store;

/// The channel every fetch reports on.
pub const EVENT: &str = "translation-model";

// ---- Wire views ----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepView {
    Checking,
    Downloading,
    Verifying,
    Installing,
    /// The model is downloaded and verified, and is being prepared: the engine started with it, and a test sentence
    /// translated.
    Preparing,
}

/// One step of a fetch, for the model `model` (the card it belongs to); `artifact` is the file it concerns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum EventView {
    Step { model: String, artifact: String, runtime: bool, step: StepView },
    Progress { model: String, artifact: String, runtime: bool, done: u64, total: u64 },
    Finished { model: String, artifact: String, runtime: bool, state: StateView },
    Failed { model: String, artifact: String, runtime: bool, state: StateView, error: ActionErrorView },
}

/// What went wrong with a download, by kind; the words are the interface's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DownloadCause {
    AlreadyPresent,
    PartialExists { bytes: u64 },
    NothingToResume,
    Busy,
    InsufficientSpace { needed: u64, available: u64 },
    UrlRefused,
    Network { kept_bytes: u64 },
    BadResponse { kept_bytes: u64 },
    ChecksumMismatch,
    OversizedPartial,
    UnsafePartial,
    Cancelled { kept_bytes: u64 },
    Io { kept_bytes: u64 },
}

/// Why an action did not happen. `detail` is the technical text, for the Details disclosure only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ActionErrorView {
    NotAModel { model: String },
    LicenceNotAccepted { model: String, status: LicenceStatusView },
    Busy { artifact: String },
    CheckFailed { detail: String },
    NotEligible { model: String, gpu: FitView, cpu: FitView },
    Damaged { artifact: String, reason: String },
    Download { artifact: String, cause: DownloadCause, detail: String },
    Install { engine_busy: bool, detail: String },
    InUse { model: String, by: InUseView },
    Cancelled,
    Store { detail: String },
    /// The catalog or the translation directory is not available (for example, a test catalog that cannot be read).
    Unavailable { detail: String },
    /// Another fetch of this model is already running.
    Running { model: String },
    /// The model is downloaded, and its preparation did not pass. `memory`: the hardware check found too little memory;
    /// `engine_busy`: another engine was running or being installed.
    Prepare { memory: bool, engine_busy: bool, detail: String },
}

impl From<&DownloadError> for DownloadCause {
    fn from(e: &DownloadError) -> Self {
        match e {
            DownloadError::AlreadyPresent => Self::AlreadyPresent,
            DownloadError::PartialExists { bytes } => Self::PartialExists { bytes: *bytes },
            DownloadError::NothingToResume => Self::NothingToResume,
            DownloadError::Busy => Self::Busy,
            DownloadError::InsufficientSpace { needed, available } => Self::InsufficientSpace { needed: *needed, available: *available },
            DownloadError::UrlRefused(_) => Self::UrlRefused,
            DownloadError::Network { kept_bytes, .. } => Self::Network { kept_bytes: *kept_bytes },
            DownloadError::BadResponse { kept_bytes, .. } => Self::BadResponse { kept_bytes: *kept_bytes },
            DownloadError::ChecksumMismatch { .. } => Self::ChecksumMismatch,
            DownloadError::OversizedPartial { .. } => Self::OversizedPartial,
            DownloadError::UnsafePartial { .. } => Self::UnsafePartial,
            DownloadError::Cancelled { kept_bytes } => Self::Cancelled { kept_bytes: *kept_bytes },
            DownloadError::Io { kept_bytes, .. } => Self::Io { kept_bytes: *kept_bytes },
        }
    }
}

impl From<&ActionError> for ActionErrorView {
    fn from(e: &ActionError) -> Self {
        match e {
            ActionError::NotAModel(id) => Self::NotAModel { model: id.to_string() },
            ActionError::LicenceNotAccepted { model, status } => Self::LicenceNotAccepted { model: model.to_string(), status: status.into() },
            ActionError::Busy(id) => Self::Busy { artifact: id.to_string() },
            ActionError::CheckFailed(h) => Self::CheckFailed { detail: h.to_string() },
            ActionError::NotEligible { model, gpu, cpu } => Self::NotEligible { model: model.to_string(), gpu: gpu.into(), cpu: cpu.into() },
            ActionError::Damaged { artifact, reason } => Self::Damaged { artifact: artifact.to_string(), reason: reason.clone() },
            ActionError::Download { artifact, error } => Self::Download { artifact: artifact.to_string(), cause: error.into(), detail: error.to_string() },
            ActionError::Install(i) => Self::Install { engine_busy: matches!(i, super::install::InstallError::EngineBusy), detail: i.to_string() },
            ActionError::InUse { model, by } => Self::InUse { model: model.to_string(), by: (*by).into() },
            ActionError::Cancelled => Self::Cancelled,
            ActionError::Store(d) => Self::Store { detail: d.clone() },
        }
    }
}

impl From<&PrepareError> for ActionErrorView {
    fn from(e: &PrepareError) -> Self {
        match e {
            PrepareError::LicenceNotAccepted { model, status } => Self::LicenceNotAccepted { model: model.to_string(), status: status.into() },
            PrepareError::Cancelled => Self::Cancelled,
            e => Self::Prepare {
                memory: matches!(e, PrepareError::NotStarted(NotStarted::Refused { why: Fit::InsufficientRam { .. }, .. })),
                engine_busy: matches!(e, PrepareError::NotStarted(NotStarted::Engine(EngineError::AlreadyActive)) | PrepareError::Install(InstallError::EngineBusy)),
                detail: e.to_string(),
            },
        }
    }
}

impl EventView {
    pub fn of(model: &str, runtime_id: &str, e: &Event) -> EventView {
        let m = model.to_string();
        match e {
            Event::Step { artifact, step } => EventView::Step {
                model: m,
                artifact: artifact.to_string(),
                runtime: *artifact == runtime_id,
                step: match step {
                    Step::Checking => StepView::Checking,
                    Step::Downloading => StepView::Downloading,
                    Step::Verifying => StepView::Verifying,
                    Step::Installing => StepView::Installing,
                },
            },
            Event::Progress { artifact, done, total } => {
                EventView::Progress { model: m, artifact: artifact.to_string(), runtime: *artifact == runtime_id, done: *done, total: *total }
            }
            Event::Finished { artifact, state } => EventView::Finished { model: m, artifact: artifact.to_string(), runtime: *artifact == runtime_id, state: state.into() },
            Event::Failed { artifact, error, state } => {
                EventView::Failed { model: m, artifact: artifact.to_string(), runtime: *artifact == runtime_id, state: state.into(), error: error.into() }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifiedView {
    Intact,
    Mismatch,
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermsView {
    pub revision: String,
    pub documents: Vec<TermsDocumentView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermsDocumentView {
    pub title: String,
    pub source: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AcceptErrorView {
    NotRequired,
    TermsUnavailable,
    NotTheCurrentTerms { shown: String, current: String },
    Store { detail: String },
    NotAModel { model: String },
}

impl From<&LicenceError> for AcceptErrorView {
    fn from(e: &LicenceError) -> Self {
        match e {
            LicenceError::NotRequired => Self::NotRequired,
            LicenceError::TermsUnavailable => Self::TermsUnavailable,
            LicenceError::NotTheCurrentTerms { shown, current } => Self::NotTheCurrentTerms { shown: shown.clone(), current: current.to_string() },
            LicenceError::Store(d) => Self::Store { detail: d.clone() },
        }
    }
}

// ---- Running fetches -----------------------------------------------------------------------------------------------

/// A running fetch: its cancel, and whether it is preparing the model now.
struct Running {
    cancel: Arc<AtomicBool>,
    preparing: bool,
}

static RUNNING: Mutex<BTreeMap<String, Running>> = Mutex::new(BTreeMap::new());

/// The engine manager of translation: the one a preparation, and a book's translation, start their engine with.
pub(crate) fn engines() -> &'static EngineManager {
    static ENGINES: OnceLock<EngineManager> = OnceLock::new();
    ENGINES.get_or_init(|| EngineManager::new(EngineConfig::default()))
}

/// Register a fetch of `model`, or refuse a second one.
pub(crate) fn begin(model: &str) -> Result<Arc<AtomicBool>, ActionErrorView> {
    let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    if running.contains_key(model) {
        return Err(ActionErrorView::Running { model: model.to_string() });
    }
    let cancel = Arc::new(AtomicBool::new(false));
    running.insert(model.to_string(), Running { cancel: cancel.clone(), preparing: false });
    Ok(cancel)
}

pub(crate) fn end(model: &str) {
    RUNNING.lock().unwrap_or_else(|p| p.into_inner()).remove(model);
}

/// Mark the running fetch of `model` as preparing it, or as no longer preparing it.
pub(crate) fn set_preparing(model: &str, preparing: bool) {
    if let Some(r) = RUNNING.lock().unwrap_or_else(|p| p.into_inner()).get_mut(model) {
        r.preparing = preparing;
    }
}

/// Ask a running fetch of `model` to stop. `false`: none is running. A fetch that is preparing its model has the
/// engine's start ended too: a start can take minutes, and looks at nothing else while it runs.
pub fn cancel(model: &str) -> bool {
    let preparing = match RUNNING.lock().unwrap_or_else(|p| p.into_inner()).get(model) {
        Some(r) => {
            r.cancel.store(true, Ordering::SeqCst);
            r.preparing
        }
        None => return false,
    };
    if preparing {
        let _ = engines().stop();
    }
    true
}

/// The fetches running now, by model.
pub fn running() -> Vec<String> {
    RUNNING.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect()
}

/// The fetches preparing their model now.
pub fn preparing() -> Vec<String> {
    RUNNING.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|(_, r)| r.preparing).map(|(k, _)| k.clone()).collect()
}

// ---- One fetch job -------------------------------------------------------------------------------------------------

/// Fetch `artifact` and, once it is downloaded and verified, prepare it with `engine`: one job, one cancel. Every step
/// goes to `emit`. The model's own `Finished` is held back until its preparation passed; a preparation that does not
/// pass ends the job as `Failed` (`ActionErrorView::Prepare`), with the model left downloaded. `preparing` is told when
/// the preparation begins and ends.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_job<E: prepare::Engine>(
    ctx: &Context,
    now: &dyn Fn() -> i64,
    artifact: &'static Artifact,
    mode: Mode,
    engine: &E,
    cancel: &Arc<AtomicBool>,
    preparing: &dyn Fn(bool),
    emit: &mut dyn FnMut(EventView),
) where
    <E::Source as Source>::Error: std::fmt::Display,
{
    let runtime_id = ctx.spec.archive.id;
    let model = artifact.id;
    let mut finished = None;
    let fetched = manage::fetch(ctx, artifact, mode, cancel, &mut |e| match e {
        Event::Finished { artifact: a, .. } if a == model => finished = Some(e),
        e => emit(EventView::of(model, runtime_id, &e)),
    });
    // A failed fetch has reported its failure already.
    if fetched.is_err() {
        return;
    }
    // Every preparation starts from "not ready": an earlier record (of these same bytes, before a removal and a new
    // download) does not stand for this attempt. Only this attempt passing makes the model ready again.
    let forgotten = prepare::forget(&ctx.db.lock().unwrap_or_else(|p| p.into_inner()), model);
    if let Err(e) = forgotten {
        let state = ctx.store.state(artifact).unwrap_or_else(|e| super::store::State::Damaged { reason: e.to_string() });
        emit(EventView::Failed { model: model.into(), artifact: model.into(), runtime: false, state: (&state).into(), error: ActionErrorView::Store { detail: e.to_string() } });
        return;
    }
    emit(EventView::Step { model: model.into(), artifact: model.into(), runtime: false, step: StepView::Preparing });
    preparing(true);
    let pctx = prepare::Context { db: ctx.db, store: ctx.store, spec: ctx.spec, now };
    let prepared = prepare::prepare(&pctx, artifact, engine, cancel, &mut |_| {});
    preparing(false);
    match prepared {
        Ok(_) => {
            let done = finished.unwrap_or(Event::Finished { artifact: model, state: super::store::State::Installed });
            emit(EventView::of(model, runtime_id, &done));
        }
        Err(error) => {
            let state = ctx.store.state(artifact).unwrap_or_else(|e| super::store::State::Damaged { reason: e.to_string() });
            emit(EventView::Failed { model: model.into(), artifact: model.into(), runtime: false, state: (&state).into(), error: (&error).into() });
        }
    }
}

// ---- Resolving where an action runs --------------------------------------------------------------------------------

fn unavailable(detail: impl Into<String>) -> ActionErrorView {
    ActionErrorView::Unavailable { detail: detail.into() }
}

/// The catalog, the translation directory and the model an action is about.
pub(crate) fn resolve(root: &Root, active: Result<Active, String>, model: &str) -> Result<(Active, std::path::PathBuf, &'static Artifact), ActionErrorView> {
    let active = active.map_err(unavailable)?;
    let dir = root.dir.clone().ok_or_else(|| unavailable("the translation directory could not be found"))?;
    if active.test && !root.isolated {
        return Err(unavailable("a test catalog is used only with a moved data directory (SARD_DATA_DIR)"));
    }
    let artifact = active.model(model).ok_or_else(|| ActionErrorView::NotAModel { model: model.to_string() })?;
    Ok((active, dir, artifact))
}

// ---- Commands ------------------------------------------------------------------------------------------------------

/// Start fetching `model` — `resume` continues an interrupted download; otherwise a new one (Download, Try again) —
/// and then preparing it. Returns as soon as the job has started; its steps, and its end, arrive on `EVENT`.
#[tauri::command]
pub fn translation_model_fetch(app: tauri::AppHandle, root: tauri::State<'_, Root>, model: String, resume: bool) -> Result<(), ActionErrorView> {
    let (active, dir, artifact) = resolve(&root, active::active(), &model)?;
    let cancel = begin(&model)?;
    std::thread::spawn(move || {
        let runtime_id = active.spec.archive.id;
        let mut emit = |e: EventView| {
            let _ = app.emit(EVENT, e);
        };
        match Store::open(&dir) {
            Ok(store) => {
                let state = app.state::<crate::db::AppState>();
                let ctx = Context { db: &state.db, store: &store, spec: active.spec, policy: &active.policy, probe: &hardware::probe };
                let mode = if resume { Mode::Resume } else { Mode::Start };
                let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                let preparing = |on: bool| set_preparing(&model, on);
                // A development build's test catalog has no real engine: its preparation is a stand-in that runs nothing.
                #[cfg(debug_assertions)]
                if active.test {
                    let stand_in = active::test::StandIn::from_environment(artifact.id, cancel.clone());
                    run_job(&ctx, &now, artifact, mode, &stand_in, &cancel, &preparing, &mut emit);
                    end(&model);
                    return;
                }
                let engine = prepare::Managed { manager: engines(), store: &store, spec: active.spec, model: artifact };
                run_job(&ctx, &now, artifact, mode, &engine, &cancel, &preparing, &mut emit);
            }
            Err(e) => {
                let failed = Event::Failed { artifact: artifact.id, error: ActionError::Store(e.to_string()), state: super::store::State::NotDownloaded };
                emit(EventView::of(&model, runtime_id, &failed));
            }
        }
        end(&model);
    });
    Ok(())
}

/// Ask the running fetch of `model` to stop. It stops at its next step, keeping what it downloaded; a preparation under
/// way is ended, and the model stays downloaded.
#[tauri::command]
pub fn translation_model_cancel(model: String) -> bool {
    cancel(&model)
}

/// Hash `model`'s file again; a file that does not match is deleted.
#[tauri::command]
pub async fn translation_model_verify(root: tauri::State<'_, Root>, model: String) -> Result<VerifiedView, ActionErrorView> {
    let (_active, dir, artifact) = resolve(&root, active::active(), &model)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = Store::open(&dir).map_err(|e| ActionErrorView::Store { detail: e.to_string() })?;
        manage::verify(&store, artifact, &AtomicBool::new(false))
            .map(|v| match v {
                Verified::Intact => VerifiedView::Intact,
                Verified::Mismatch => VerifiedView::Mismatch,
                Verified::Nothing(_) => VerifiedView::Nothing,
            })
            .map_err(|e| (&e).into())
    })
    .await
    .map_err(|e| ActionErrorView::Store { detail: e.to_string() })?
}

/// Remove `model`'s files; translations made with it stay. Refused while it is in use.
#[tauri::command]
pub async fn translation_model_remove(root: tauri::State<'_, Root>, model: String) -> Result<u64, ActionErrorView> {
    let (_active, dir, artifact) = resolve(&root, active::active(), &model)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = Store::open(&dir).map_err(|e| ActionErrorView::Store { detail: e.to_string() })?;
        // A fetch of the same model holds its file: `manage` refuses this as `Busy`.
        manage::remove(&store, artifact).map(|r| r.freed).map_err(|e| (&e).into())
    })
    .await
    .map_err(|e| ActionErrorView::Store { detail: e.to_string() })?
}

/// The terms `model`'s licence asks the user to accept, exactly as this build carries them; `None` if it carries none.
#[tauri::command]
pub fn translation_licence_terms(model: String) -> Result<Option<TermsView>, ActionErrorView> {
    let active = active::active().map_err(unavailable)?;
    let artifact = active.model(&model).ok_or_else(|| ActionErrorView::NotAModel { model: model.clone() })?;
    Ok(manage::terms(artifact.licence).map(|t| TermsView {
        revision: t.revision.to_string(),
        documents: t.documents.iter().map(|d| TermsDocumentView { title: d.title.into(), source: d.source.into(), text: d.text.into() }).collect(),
    }))
}

/// Record the user's acceptance of `model`'s licence terms, of the `revision` they were shown. Refused unless this
/// build carries those terms and `revision` is their current one.
#[tauri::command]
pub fn translation_accept_terms(app: tauri::State<'_, crate::db::AppState>, model: String, revision: String) -> Result<(), AcceptErrorView> {
    let active = active::active().map_err(|d| AcceptErrorView::Store { detail: d })?;
    let licence: Licence = active.model(&model).ok_or_else(|| AcceptErrorView::NotAModel { model: model.clone() })?.licence;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let conn = app.conn();
    manage::accept_terms(&conn, licence, &revision, now).map_err(|e| (&e).into())
}
