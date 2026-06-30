//! IPC seam — typed `#[tauri::command]` handlers. The single boundary the React
//! frontend uses to reach the Rust core (RAWY-08). Keep all frontend↔core traffic here.

use serde::Serialize;
use tauri::State;

use crate::db::{self, AppState};
use crate::{books, fonts, library, settings};

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

// RAWY-31 — shelf writes (the only Rust↔JS path for collections). Each returns the
// refreshed shelf list so the UI updates names + counts in one call.

#[tauri::command]
pub fn collection_create(name: String, state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collection_create(&conn, &name).map_err(err)
}

#[tauri::command]
pub fn collection_rename(id: String, name: String, state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collection_rename(&conn, &id, &name).map_err(err)
}

#[tauri::command]
pub fn collection_delete(id: String, state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collection_delete(&conn, &id).map_err(err)
}

#[tauri::command]
pub fn collection_add_book(
    collection_id: String,
    book_id: String,
    state: State<AppState>,
) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collection_add_book(&conn, &collection_id, &book_id).map_err(err)
}

#[tauri::command]
pub fn collection_remove_book(
    collection_id: String,
    book_id: String,
    state: State<AppState>,
) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collection_remove_book(&conn, &collection_id, &book_id).map_err(err)
}

/// The shelf ids a book belongs to (for the edit-dialog chips).
#[tauri::command]
pub fn collections_for_book(book_id: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::collections_for_book(&conn, &book_id).map_err(err)
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

// ---- Highlights + notes (RAWY-20) ----------------------------------------

#[tauri::command]
pub fn highlights_for_book(book_id: String, state: State<AppState>) -> Result<Vec<library::HighlightRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::highlights_for_book(&conn, &book_id).map_err(err)
}

/// Cross-book inbox (RAWY-27): every highlight + standalone note across all books.
#[tauri::command]
pub fn annotations_all(state: State<AppState>) -> Result<Vec<library::AnnoItem>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::annotations_all(&conn).map_err(err)
}

#[tauri::command]
pub fn highlight_create(
    book_id: String,
    cfi: String,
    color: String,
    excerpt: Option<String>,
    chapter_label: Option<String>,
    state: State<AppState>,
) -> Result<Option<library::HighlightRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::highlight_create(&conn, &book_id, &cfi, &color, excerpt.as_deref(), chapter_label.as_deref())
        .map_err(err)
}

#[tauri::command]
pub fn highlight_set_color(id: String, color: String, state: State<AppState>) -> Result<Option<library::HighlightRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::highlight_set_color(&conn, &id, &color).map_err(err)
}

#[tauri::command]
pub fn highlight_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.db.lock().map_err(err)?;
    library::highlight_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn notes_for_book(book_id: String, state: State<AppState>) -> Result<Vec<library::NoteRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::notes_for_book(&conn, &book_id).map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn note_create(
    book_id: String,
    highlight_id: Option<String>,
    cfi: Option<String>,
    color: Option<String>,
    body: String,
    chapter_label: Option<String>,
    state: State<AppState>,
) -> Result<Option<library::NoteRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::note_create(
        &conn,
        &book_id,
        highlight_id.as_deref(),
        cfi.as_deref(),
        color.as_deref(),
        &body,
        chapter_label.as_deref(),
    )
    .map_err(err)
}

#[tauri::command]
pub fn note_update(id: String, body: String, color: Option<String>, state: State<AppState>) -> Result<Option<library::NoteRow>, String> {
    let conn = state.db.lock().map_err(err)?;
    library::note_update(&conn, &id, &body, color.as_deref()).map_err(err)
}

#[tauri::command]
pub fn note_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.db.lock().map_err(err)?;
    library::note_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

// ---- Fonts (RAWY-39): import a user font file + list imported fonts. ----

#[tauri::command]
pub fn font_import(path: String, state: State<AppState>) -> Result<fonts::CustomFont, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.db.lock().map_err(err)?;
    fonts::import(&conn, &app_data_dir, &path)
}

#[tauri::command]
pub fn fonts_list(state: State<AppState>) -> Result<Vec<fonts::CustomFont>, String> {
    let conn = state.db.lock().map_err(err)?;
    fonts::list(&conn)
}

#[tauri::command]
pub fn font_remove(id: String, state: State<AppState>) -> Result<bool, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.db.lock().map_err(err)?;
    fonts::remove(&conn, &app_data_dir, &id)?;
    Ok(true)
}
