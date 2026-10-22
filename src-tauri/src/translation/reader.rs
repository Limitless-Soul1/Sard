//! The reader's side of translation: the model a book is translated with, the book's edition, the job that translates
//! it, and what the reader shows of each section.
//!
//! * **Only a ready model.** A book is translated only with a model that is prepared (`prepare::ready`) and whose
//!   licence terms, if it has any, are accepted. Nothing here downloads or prepares anything: with no ready model the
//!   reader opens the models section instead (`ReaderErrorView::NoReadyModel`).
//! * **One edition per book and model (D8).** The book's edition for the model is continued; a new one is made from
//!   the reader's extraction (`creation`), for the GPU the model was prepared on.
//! * **GPU only.** Every start of the engine passes the hardware check again on the GPU path (`execution::start`,
//!   preference `gpu`), and a start on another device than the edition's is refused. There is no CPU fallback.
//! * **The job.** The section being read first, then the rest of the book, through the supervisor (one restart, the
//!   idle stop). One job at a time, for the whole of Sard: there is one engine. There is no pause, cancel or progress
//!   in this phase — a job ends when its paragraphs are done, when the engine fails twice, or with Sard.
//! * **What a paragraph shows.** Its translation (marked when a check is unresolved: REVIEW), or its original: when it
//!   was not translated (FAILED, or it broke the pipeline's input contract), and always when it holds links, note
//!   references, images or line breaks, which a translation cannot keep (I6-8). Those are still translated in the
//!   background, with the rest; only the reader keeps them in the original.
//! * Editions are never exported.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{Emitter, Manager};

use super::active::{self, Active};
use super::catalog::{Artifact, EngineSpec};
use super::creation::{self, ExecutionInput, ExtractionInput};
use super::edition_run::{RunEnd, Scope, SourceError};
use super::editions::{self, Edition, EditionError};
use super::engine::{EngineInfo, EngineManager, EngineStatus, Execution};
use super::execution::{self, NotStarted, Preference};
use super::hardware::Fit;
use super::manage::{self, LicenceStatus};
use super::model_commands;
use super::overview::Root;
use super::pipeline::{EngineSource, Model, Source, PROVISIONAL_GPU_EXCHANGE_TIMEOUT};
use super::prepare;
use super::runtime_identity::{self, RuntimeError};
use super::store::Store;
use super::supervisor::{self, Idle, Job, JobError, IDLE_STOP};

/// The channel a translation job reports its end on.
pub const EVENT: &str = "translation-edition";

// ---- Wire views ----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyModelView {
    pub id: String,
    /// The GPU it was prepared on.
    pub device: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionView {
    pub id: String,
    pub model: String,
    pub paragraphs: u64,
    pub done: u64,
    pub pending: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStatus {
    /// The model a translation would use now, if one is ready.
    pub model: Option<ReadyModelView>,
    /// The book's edition: for the ready model if it has one, otherwise its newest — a translation already made stays
    /// readable after its model is removed (D7).
    pub edition: Option<EditionView>,
    /// A job is translating this book now.
    pub translating: bool,
    /// A job is translating another book now.
    pub translating_other: bool,
    /// Translation exists on this platform (Windows x64 only).
    pub supported: bool,
}

/// What the reader shows in a paragraph's place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ShowView {
    /// Not translated yet: the original, with no note.
    Pending,
    /// The translation; `review` when a check is unresolved (REVIEW).
    Translation { text: String, review: bool },
    /// The original, because there is no translation: FAILED, or the paragraph broke the input contract.
    NotTranslated,
    /// The original, because the paragraph holds links, note references, images or line breaks (I6-8).
    KeptOriginal,
}

/// One paragraph of a section: where it is, its original text (to recognise it on the page), and what to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphView {
    pub ordinal: u32,
    pub path: Vec<u32>,
    pub tag: String,
    pub text: String,
    pub show: ShowView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ReaderErrorView {
    /// No model is ready: the reader opens the models section.
    NoReadyModel,
    /// WebView2 was updated while Sard runs (the installed runtime is not the one this window runs): restarting Sard
    /// makes them agree (`runtime_identity`), and the book can then be translated.
    RuntimeChanged { detail: String },
    /// A job is already translating a book.
    Busy,
    /// The translation could not be started, or did not finish. `memory`: the hardware check found too little memory;
    /// `engine_busy`: another engine was running.
    Failed { memory: bool, engine_busy: bool, detail: String },
}

fn failed(detail: impl ToString) -> ReaderErrorView {
    ReaderErrorView::Failed { memory: false, engine_busy: false, detail: detail.to_string() }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum EditionEventView {
    /// A part of the job is done (the section being read, first): its paragraphs can be shown.
    Progressed { book: String, edition: String },
    /// Every paragraph the job could reach has its result.
    Ended { book: String, edition: String },
    Failed { book: String, edition: String, error: ReaderErrorView },
}

// ---- The model, the edition, a section -----------------------------------------------------------------------------

/// The model a book can be translated with now: ready, its licence terms accepted if it has any, in the catalog's
/// order — `prefer` first, so that a book goes on with the model it began with.
pub fn ready_model(conn: &Connection, store: &Store, active: &Active, prefer: Option<&str>) -> Result<Option<(&'static Artifact, prepare::Ready)>, String> {
    let records = prepare::records(conn).map_err(|e| e.to_string())?;
    let mut models = active.models.clone();
    models.sort_by_key(|m| Some(m.id) != prefer);
    for m in models {
        let licence = manage::licence_status(conn, m.licence).map_err(|e| e.to_string())?;
        if !matches!(licence, LicenceStatus::NotRequired | LicenceStatus::Accepted { .. }) {
            continue;
        }
        if let Some(ready) = prepare::ready_in(&records, store, active.spec, m).map_err(|e| e.to_string())? {
            return Ok(Some((m, ready)));
        }
    }
    Ok(None)
}

/// The book's editions, oldest first.
fn editions_of(conn: &Connection, book_id: &str) -> Result<Vec<Edition>, EditionError> {
    let mut out = Vec::new();
    for id in editions::list_for_book(conn, book_id)? {
        out.extend(editions::get(conn, &id)?);
    }
    Ok(out)
}

/// The book's newest edition made with `model_id`.
pub fn edition_for(conn: &Connection, book_id: &str, model_id: &str) -> Result<Option<Edition>, EditionError> {
    Ok(editions_of(conn, book_id)?.into_iter().filter(|e| e.config.engine.model_id == model_id).last())
}

fn edition_view(e: &Edition) -> EditionView {
    EditionView { id: e.id.clone(), model: e.config.engine.model_id.clone(), paragraphs: e.counts.paragraphs, done: e.counts.done, pending: e.counts.pending }
}

/// The reader's status for `book_id`. `running` is the job running now, if any: (book, edition).
pub fn status(conn: &Connection, store: &Store, active: &Active, book_id: &str, running: Option<(String, String)>) -> Result<ReaderStatus, String> {
    let all = editions_of(conn, book_id).map_err(|e| format!("{e:?}"))?;
    let newest = all.last().map(|e| e.config.engine.model_id.clone());
    let model = ready_model(conn, store, active, newest.as_deref())?;
    let edition = match &model {
        Some((m, _)) => all.iter().filter(|e| e.config.engine.model_id == m.id).last().or(all.last()),
        None => all.last(),
    };
    let translating = running.as_ref().is_some_and(|(b, _)| b == book_id);
    Ok(ReaderStatus {
        model: model.map(|(m, r)| ReadyModelView { id: m.id.to_string(), device: r.device }),
        edition: edition.map(edition_view),
        translating,
        translating_other: running.is_some() && !translating,
        supported: cfg!(all(windows, target_arch = "x86_64")),
    })
}

/// Whether a paragraph holds something a translation cannot keep: a link, a note reference, an image or a line break.
fn keeps_original(atoms: &BTreeMap<String, u32>) -> bool {
    ["a", "noteref", "img", "br"].iter().any(|k| atoms.get(*k).copied().unwrap_or(0) > 0)
}

/// Every paragraph of one section of the edition, in order, with what the reader shows for it.
pub fn section(conn: &Connection, edition_id: &str, section_index: u32) -> Result<Vec<ParagraphView>, EditionError> {
    let mut st = conn.prepare(
        "SELECT p.ordinal, p.path, p.tag, p.atoms, p.source_text, p.input_state, r.status, r.text FROM translation_paragraphs p \
         LEFT JOIN translation_results r ON r.edition_id = p.edition_id AND r.section_index = p.section_index AND r.ordinal = p.ordinal \
         WHERE p.edition_id = ?1 AND p.section_index = ?2 ORDER BY p.ordinal",
    )?;
    let rows = st.query_map(params![edition_id, section_index], |r| {
        Ok((
            r.get::<_, u32>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (ordinal, path, tag, atoms, text, input_state, status, translated) = row?;
        let path: Vec<u32> = serde_json::from_str(&path).map_err(|e| EditionError::Db(format!("path: {e}")))?;
        let atoms: BTreeMap<String, u32> = serde_json::from_str(&atoms).map_err(|e| EditionError::Db(format!("atoms: {e}")))?;
        let show = if keeps_original(&atoms) {
            ShowView::KeptOriginal
        } else if input_state != "ok" {
            ShowView::NotTranslated
        } else {
            match (status.as_deref(), translated) {
                (None, _) => ShowView::Pending,
                (Some("OK" | "RECOVERED" | "SECOND"), Some(t)) => ShowView::Translation { text: t, review: false },
                (Some("REVIEW"), Some(t)) => ShowView::Translation { text: t, review: true },
                _ => ShowView::NotTranslated,
            }
        };
        out.push(ParagraphView { ordinal, path, tag, text, show });
    }
    Ok(out)
}

// ---- The job -------------------------------------------------------------------------------------------------------

/// The engine a job translates with: the models section's engine manager, started on the GPU the hardware check
/// confirms — and only if that is the edition's GPU. It never stops another engine to start its own.
pub(crate) struct Assessed {
    pub manager: &'static EngineManager,
    pub store: Store,
    pub spec: &'static EngineSpec,
    pub model: &'static Artifact,
    pub device: String,
    /// Why the last start was not made, when the hardware check or the engine refused it.
    pub refused: Mutex<Option<NotStarted>>,
}

impl supervisor::Engine for Assessed {
    type Source = EngineSource;

    fn ready(&self) -> Option<EngineInfo> {
        match self.manager.status() {
            EngineStatus::Ready(info) if info.model_id == self.model.id && info.execution == (Execution::Gpu { device: self.device.clone() }) => Some(info),
            _ => None,
        }
    }

    fn start(&self) -> Result<EngineInfo, String> {
        match execution::start(self.manager, &self.store, self.spec, self.model, Preference::Gpu, None) {
            Ok((_, info)) if info.execution == (Execution::Gpu { device: self.device.clone() }) => Ok(info),
            Ok((_, info)) => {
                let _ = self.manager.stop();
                Err(format!("the hardware check confirms {:?}, but this translation was made for the GPU {}", info.execution, self.device))
            }
            Err(e) => {
                let detail = prepare::PrepareError::NotStarted(e.clone()).to_string();
                *self.refused.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                Err(detail)
            }
        }
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

/// Translate the edition: the section `first` (the one being read) first, when it is one of the edition's, then
/// the rest of the book. `progressed` is told after each part that translated something. Stops at the first run that
/// does not finish. The error is the technical text.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_book<E>(
    db: &Mutex<Connection>,
    edition_id: &str,
    spec: &EngineSpec,
    model: &Artifact,
    app_build: &str,
    first: Option<u32>,
    engine: &Arc<E>,
    idle: &Idle,
    now: &dyn Fn() -> i64,
    progressed: &dyn Fn(),
) -> Result<(), String>
where
    E: supervisor::Engine,
    <E::Source as Source>::Error: SourceError,
{
    let sections = editions::section_indexes(&db.lock().unwrap_or_else(|p| p.into_inner()), edition_id).map_err(|e| format!("{e:?}"))?;
    let mut scopes = Vec::new();
    if let Some(s) = first.filter(|s| sections.contains(s)) {
        scopes.push(Scope::Sections(BTreeSet::from([s])));
    }
    scopes.push(Scope::All);
    // No cancel in this phase: nothing ever sets it.
    let cancel = Arc::new(AtomicBool::new(false));
    for scope in &scopes {
        let job = Job { db, edition_id, spec, model, app_build, scope, cancel: cancel.clone(), now };
        match supervisor::translate(&job, engine, idle, IDLE_STOP) {
            Err(JobError::NothingPending) => {}
            Err(JobError::Start { detail, .. }) => return Err(detail),
            Err(JobError::Run { error, .. }) => return Err(format!("{error:?}")),
            Ok(report) => match report.end() {
                RunEnd::Complete | RunEnd::Done => progressed(),
                RunEnd::EngineFailed { .. } | RunEnd::Cancelled => return Err(format!("the translation stopped: {:?}", report.end())),
            },
        }
    }
    Ok(())
}

static RUNNING: Mutex<Option<(String, String)>> = Mutex::new(None);

/// The idle stop shared by every job, so that a job soon after another takes the engine still running.
fn idle() -> &'static Idle {
    static IDLE: OnceLock<Idle> = OnceLock::new();
    IDLE.get_or_init(Idle::default)
}

fn running() -> Option<(String, String)> {
    RUNNING.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Register the job, or refuse a second one.
pub(crate) fn begin(book_id: &str, edition_id: &str) -> Result<(), ReaderErrorView> {
    let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    if running.is_some() {
        return Err(ReaderErrorView::Busy);
    }
    *running = Some((book_id.to_string(), edition_id.to_string()));
    Ok(())
}

pub(crate) fn end() {
    *RUNNING.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// A job's failure as the reader shows it: too little memory and another engine running are said as such.
pub(crate) fn failure(refused: Option<&NotStarted>, detail: String) -> ReaderErrorView {
    ReaderErrorView::Failed {
        memory: matches!(refused, Some(NotStarted::Refused { why: Fit::InsufficientRam { .. }, .. })),
        engine_busy: matches!(refused, Some(NotStarted::Engine(super::engine::EngineError::AlreadyActive))),
        detail,
    }
}

// ---- Commands ------------------------------------------------------------------------------------------------------

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn app_build() -> String {
    format!("{} {}", env!("CARGO_PKG_VERSION"), env!("SARD_BUILD_ID"))
}

/// The catalog and the store, as the models section has them.
fn where_from(root: &Root) -> Result<(Active, Store), String> {
    let active = active::active()?;
    if active.test && !root.isolated {
        return Err("a test catalog is used only with a moved data directory (SARD_DATA_DIR)".into());
    }
    let dir = root.dir.clone().ok_or("the translation directory could not be found")?;
    let store = Store::open(&dir).map_err(|e| e.to_string())?;
    Ok((active, store))
}

/// The reader's status for a book: the ready model, the book's edition, and whether a job runs.
#[tauri::command]
pub async fn translation_reader_status(app: tauri::AppHandle, root: tauri::State<'_, Root>, book_id: String) -> Result<ReaderStatus, String> {
    let (active, store) = where_from(&root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::db::AppState>();
        let conn = state.conn();
        status(&conn, &store, &active, &book_id, running())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The book's edition for the ready model: the one it has, or one made from the extraction the calling page made, for
/// the GPU the model was prepared on. The runtime is read from the calling webview, as `creation` does.
#[tauri::command]
pub async fn translation_reader_edition(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::db::AppState>,
    root: tauri::State<'_, Root>,
    book_id: String,
    extraction: ExtractionInput,
) -> Result<String, ReaderErrorView> {
    let (active, store) = where_from(&root).map_err(failed)?;
    let (model, ready) = {
        let conn = state.conn();
        let newest = editions_of(&conn, &book_id).map_err(|e| failed(format!("{e:?}")))?.last().map(|e| e.config.engine.model_id.clone());
        ready_model(&conn, &store, &active, newest.as_deref()).map_err(failed)?.ok_or(ReaderErrorView::NoReadyModel)?
    };
    if let Some(e) = edition_for(&state.conn(), &book_id, model.id).map_err(|e| failed(format!("{e:?}")))? {
        return Ok(e.id);
    }
    let installed = runtime_identity::installed();
    let caller = webview.clone();
    let running = tauri::async_runtime::spawn_blocking(move || runtime_identity::running(&caller, std::time::Duration::from_secs(5))).await.map_err(failed)?;
    let runtime = runtime_identity::resolve(installed, running);
    if let Err(e @ RuntimeError::Mismatch { .. }) = &runtime {
        return Err(ReaderErrorView::RuntimeChanged { detail: e.to_string() });
    }
    let conn = state.conn();
    creation::create_edition(&conn, &book_id, model.id, &ExecutionInput::Gpu { device: ready.device }, &extraction, runtime, &app_build(), now_unix()).map_err(failed)
}

/// Translate the book's edition with its model, which must be ready: `first_section` (the one being read) first. Returns
/// once the job has started; its end arrives on `EVENT`.
#[tauri::command]
pub fn translation_reader_translate(app: tauri::AppHandle, root: tauri::State<'_, Root>, book_id: String, edition_id: String, first_section: Option<u32>) -> Result<(), ReaderErrorView> {
    let (active, store) = where_from(&root).map_err(failed)?;
    let (model, device) = {
        let state = app.state::<crate::db::AppState>();
        let conn = state.conn();
        let edition = editions::get(&conn, &edition_id).map_err(|e| failed(format!("{e:?}")))?.filter(|e| e.book_id == book_id).ok_or_else(|| failed("no such edition for this book"))?;
        let model = active.model(&edition.config.engine.model_id).ok_or(ReaderErrorView::NoReadyModel)?;
        ready_model(&conn, &store, &active, Some(model.id)).map_err(failed)?.filter(|(m, _)| m.id == model.id).ok_or(ReaderErrorView::NoReadyModel)?;
        let device = match &edition.config.engine.execution {
            editions::Execution::Gpu { device } => device.clone(),
            editions::Execution::Cpu { .. } => return Err(failed("this edition was made for the CPU, which is not offered")),
        };
        (model, device)
    };
    begin(&book_id, &edition_id)?;
    let spec = active.spec;
    std::thread::spawn(move || {
        let engine = Arc::new(Assessed { manager: model_commands::engines(), store, spec, model, device, refused: Mutex::new(None) });
        let state = app.state::<crate::db::AppState>();
        let progressed = || {
            let _ = app.emit(EVENT, EditionEventView::Progressed { book: book_id.clone(), edition: edition_id.clone() });
        };
        let result = run_book(&state.db, &edition_id, spec, model, &app_build(), first_section, &engine, idle(), &now_unix, &progressed);
        let event = match result {
            Ok(()) => EditionEventView::Ended { book: book_id.clone(), edition: edition_id.clone() },
            Err(detail) => {
                let refused = engine.refused.lock().unwrap_or_else(|p| p.into_inner()).clone();
                EditionEventView::Failed { book: book_id.clone(), edition: edition_id.clone(), error: failure(refused.as_ref(), detail) }
            }
        };
        end();
        let _ = app.emit(EVENT, event);
    });
    Ok(())
}

/// What the reader shows of one section of an edition.
#[tauri::command]
pub async fn translation_reader_section(app: tauri::AppHandle, edition_id: String, section_index: u32) -> Result<Vec<ParagraphView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::db::AppState>();
        let conn = state.conn();
        section(&conn, &edition_id, section_index).map_err(|e| format!("{e:?}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
