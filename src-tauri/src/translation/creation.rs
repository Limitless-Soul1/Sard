//! Making an edition: from the extraction the reader's page made of a book, for a model and an execution path,
//! recorded with the WebView2 runtime that made it.
//!
//! The page sends the source-extraction module's output exactly as it came (`ExtractionInput`, read field for field).
//! Everything else is decided here, not taken from the page: the engine half of the configuration from the catalog
//! (`edition_run::engine_config`), the languages, and the runtime version, which must be the installed one AND the one
//! the extraction's own webview runs (`runtime_identity`). The store then checks the extraction, holds every
//! paragraph to the pipeline's input contract, and refuses an extraction other than this build's.
//!
//! This writes the edition's rows and nothing else: nothing is downloaded, started or translated.

use std::time::Duration;

use rusqlite::Connection;
use serde::Deserialize;

use super::catalog::{Artifact, ENGINE_WINDOWS_X64, MODEL_A, MODEL_B};
use super::edition_run::engine_config;
use super::editions::{self, EditionConfig, EditionError, SectionInput};
use super::engine;
use super::runtime_identity::{self, RuntimeError};

/// The languages an edition translates between: the pipeline is evaluated from English into Arabic only.
pub const SOURCE_LANG: &str = "en";
pub const TARGET_LANG: &str = "ar";
pub const TARGET_DIR: &str = "rtl";

/// How long the webview may take to say which runtime it runs.
const RUNTIME_WAIT: Duration = Duration::from_secs(5);

/// The source-extraction module's output, as the page sends it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtractionInput {
    pub extraction_id: String,
    pub sections: Vec<SectionInput>,
}

/// Where the edition is to be translated.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ExecutionInput {
    Gpu { device: String },
    Cpu { threads: u16 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CreateError {
    /// No translation model in the catalog has this id.
    NotAModel(String),
    /// The runtime that made the extraction cannot be established (see `runtime_identity`).
    Runtime(RuntimeError),
    /// The store refused the edition.
    Store(EditionError),
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CreateError::NotAModel(id) => write!(f, "{id} is not a translation model"),
            CreateError::Runtime(e) => write!(f, "{e}"),
            CreateError::Store(e) => write!(f, "the edition cannot be made: {e:?}"),
        }
    }
}

fn model(id: &str) -> Option<&'static Artifact> {
    [&MODEL_A, &MODEL_B].into_iter().find(|m| m.id == id)
}

/// Make the edition of `book_id`. `runtime` is the resolved runtime version (`runtime_identity::resolve`): an edition
/// is never made without it. Returns the new edition's id.
#[allow(clippy::too_many_arguments)]
pub fn create_edition(
    conn: &Connection,
    book_id: &str,
    model_id: &str,
    execution: &ExecutionInput,
    extraction: &ExtractionInput,
    runtime: Result<String, RuntimeError>,
    app_build: &str,
    now: i64,
) -> Result<String, CreateError> {
    let webview_version = runtime.map_err(CreateError::Runtime)?;
    let model = model(model_id).ok_or_else(|| CreateError::NotAModel(model_id.to_string()))?;
    let execution = match execution {
        ExecutionInput::Gpu { device } => engine::Execution::Gpu { device: device.clone() },
        ExecutionInput::Cpu { threads } => engine::Execution::Cpu { threads: *threads },
    };
    let engine = engine_config(&ENGINE_WINDOWS_X64, model, &execution).ok_or_else(|| CreateError::NotAModel(model_id.to_string()))?;
    let config = EditionConfig {
        source_lang: SOURCE_LANG.into(),
        target_lang: TARGET_LANG.into(),
        target_dir: TARGET_DIR.into(),
        engine,
        extraction_id: extraction.extraction_id.clone(),
        webview_version,
    };
    editions::create(conn, book_id, &config, app_build, &extraction.sections, now).map_err(CreateError::Store)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Make an edition from the extraction the calling page made. The runtime version is read from the calling webview
/// itself, so the edition records the runtime that ran the extraction.
#[tauri::command]
pub async fn translation_create_edition(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::db::AppState>,
    book_id: String,
    model_id: String,
    execution: ExecutionInput,
    extraction: ExtractionInput,
) -> Result<String, String> {
    let installed = runtime_identity::installed();
    let caller = webview.clone();
    let running = tauri::async_runtime::spawn_blocking(move || runtime_identity::running(&caller, RUNTIME_WAIT)).await.map_err(|e| e.to_string())?;
    let runtime = runtime_identity::resolve(installed, running);
    let app_build = format!("{} {}", env!("CARGO_PKG_VERSION"), env!("SARD_BUILD_ID"));
    let conn = state.conn();
    create_edition(&conn, &book_id, &model_id, &execution, &extraction, runtime, &app_build, now_unix()).map_err(|e| e.to_string())
}
