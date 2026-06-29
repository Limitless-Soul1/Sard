//! IPC seam — typed `#[tauri::command]` handlers. The single boundary the React
//! frontend uses to reach the Rust core (RAWY-08). Keep all frontend↔core traffic here.

use serde::Serialize;
use tauri::State;

use crate::db::{self, AppState};
use crate::{books, library, settings};

#[derive(Serialize)]
pub struct AppInfo {
    pub app_data_dir: String,
    pub db_path: String,
    pub schema_version: i64,
}

#[derive(Serialize)]
pub struct DbHealth {
    pub ok: bool,
    pub schema_version: i64,
    pub tables: Vec<String>,
}

/// Stringify any error so it crosses the IPC boundary cleanly.
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn app_info(state: State<AppState>) -> Result<AppInfo, String> {
    let conn = state.db.lock().map_err(err)?;
    let schema_version = db::schema_version(&conn).map_err(err)?;
    Ok(AppInfo {
        app_data_dir: state.app_data_dir.display().to_string(),
        db_path: state.db_path.display().to_string(),
        schema_version,
    })
}

#[tauri::command]
pub fn db_health(state: State<AppState>) -> Result<DbHealth, String> {
    let conn = state.db.lock().map_err(err)?;
    let schema_version = db::schema_version(&conn).map_err(err)?;
    let tables = db::list_tables(&conn).map_err(err)?;
    Ok(DbHealth {
        ok: true,
        schema_version,
        tables,
    })
}

#[tauri::command]
pub fn settings_get(key: String, state: State<AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(err)?;
    settings::get(&conn, &key).map_err(err)
}

#[tauri::command]
pub fn settings_set(key: String, value: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.db.lock().map_err(err)?;
    settings::set(&conn, &key, &value).map_err(err)?;
    Ok(true)
}

/// Ensure a minimal `books` row exists for `book_id` (FK bridge until real import).
#[tauri::command]
pub fn book_register(
    book_id: String,
    file_path: String,
    state: State<AppState>,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(err)?;
    books::ensure(&conn, &book_id, &file_path).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn progress_save(
    book_id: String,
    cfi: String,
    fraction: f64,
    state: State<AppState>,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(err)?;
    library::progress_save(&conn, &book_id, &cfi, fraction).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn progress_get(
    book_id: String,
    state: State<AppState>,
) -> Result<Option<library::Progress>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::progress_get(&conn, &book_id).map_err(err)
}

/// RAWY-15 — the Library home: books (metadata + progress), sorted/filtered in SQL.
#[tauri::command]
pub fn library_list_books(
    sort: String,
    order: String,
    format: Option<String>,
    collection: Option<String>,
    search: Option<String>,
    state: State<AppState>,
) -> Result<Vec<library::BookRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::list_books(
        &conn,
        &sort,
        &order,
        format.as_deref(),
        collection.as_deref(),
        search.as_deref(),
    )
    .map_err(err)
}

/// RAWY-15 — shelves (collections) with live book counts, for the sidebar.
#[tauri::command]
pub fn collections_list(state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collections_list(&conn).map_err(err)
}

/// RAWY-17 — import EPUB files into the library (copy-in, hash/dedup, extract metadata +
/// cover). Returns one result per path so the UI can summarise imported/duplicate/
/// unsupported/error. The only Rust↔JS path for adding books.
#[tauri::command]
pub fn import_books(
    paths: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<books::ImportResult>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.db.lock().map_err(err)?;
    Ok(books::import_books(&conn, &app_data_dir, &paths))
}

/// RAWY-19 — editable metadata patch (all optional; absent = leave unchanged).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPatch {
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub dir: Option<String>,
    pub cover_fit: Option<String>,
}

/// RAWY-19 — update a book's metadata as OVERRIDES (never touches the source EPUB).
#[tauri::command]
pub fn book_update(
    id: String,
    patch: BookPatch,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::update_book(
        &conn,
        &id,
        patch.title.as_deref(),
        patch.author.as_deref(),
        patch.language.as_deref(),
        patch.dir.as_deref(),
        patch.cover_fit.as_deref(),
    )
    .map_err(err)
}

/// RAWY-19 — replace a book's cover with a copied-in image (managed storage).
#[tauri::command]
pub fn book_set_cover(
    id: String,
    image_path: String,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.db.lock().map_err(err)?;
    library::set_cover(&conn, &app_data_dir, &id, &image_path)
}

/// RAWY-19 — revert to the extracted/auto cover (delete the custom override + file).
#[tauri::command]
pub fn book_revert_cover(
    id: String,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::revert_cover(&conn, &id)
}
