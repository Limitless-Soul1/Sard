//! IPC seam — typed `#[tauri::command]` handlers. The single boundary the React
//! frontend uses to reach the Rust core (RAWY-08). Keep all frontend↔core traffic here.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::db::{self, AppState};
use crate::{backgrounds, books, fonts, library, photocards, settings};

#[derive(Serialize)]
pub struct AppInfo {
    /// THE BUILD ID baked in at compile time (build.rs). Product metadata, not instrumentation:
    /// "which build are you running?" is the first question of every support conversation, and
    /// before this the running app had no way to answer it.
    pub build_id: String,
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

/// RAWY-64 — every legitimate `id` this app hands to Rust (a photo-card id, a book id) is a
/// `crypto.randomUUID()` or a SHA-256 hex string; neither ever contains a path separator or `..`.
/// Reject anything else before it's spliced into a filename, so an id can't be used to write/read
/// outside its intended managed subdirectory (defense-in-depth alongside the RAWY-64 sandbox fix,
/// which is what actually stops untrusted content from reaching these commands at all).
/// RAWY-FINAL — a path handed back by `stage_png`, and nothing else.
///
/// `book_set_cover_png` and `photocard_save` `fs::read` then `fs::remove_file` their path argument,
/// and `save_photo_card` `fs::copy`s ONTO its destination and then deletes the source — arbitrary
/// read, arbitrary overwrite, arbitrary delete, all from an unvalidated string. `safe_id` guarded the
/// ID; no one guarded the PATH.
///
/// This is DEFENCE IN DEPTH, not a live hole: the only caller is Sard's own JS, and book content
/// cannot execute script (the RAWY-64 patches drop `allow-scripts` from both iframe creation sites,
/// and the CSP is `script-src 'self'` with no `unsafe-eval`). But the entire point of the RAWY-177
/// staging design is that these paths are always temp files THIS process just created, so asserting
/// that costs nothing and removes the class outright if the sandbox ever regresses on a re-vendor.
///
/// The shape is the one `stage_png` writes: `<temp>/sard-stage-<pid>-<nanos>.png`.
fn staged_png_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    let in_temp = p
        .parent()
        .map(|d| d == std::env::temp_dir().as_path())
        .unwrap_or(false);
    let named = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("sard-stage-") && n.ends_with(".png"))
        .unwrap_or(false);
    if in_temp && named { Ok(()) } else { Err("invalid staged path".into()) }
}

fn safe_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err("invalid id".into()) }
}

#[tauri::command]
pub fn app_info(state: State<AppState>) -> Result<AppInfo, String> {
    let conn = state.conn();
    let schema_version = db::schema_version(&conn).map_err(err)?;
    Ok(AppInfo {
        build_id: env!("SARD_BUILD_ID").to_string(),
        app_data_dir: state.app_data_dir.display().to_string(),
        db_path: state.db_path.display().to_string(),
        schema_version,
    })
}

/// DIAGNOSTIC BUILD ONLY — write the collected evidence next to the profile.
///
/// Two user-reported failures cannot be reproduced on any development machine, so the evidence has
/// to be captured where they happen and sent back. Writes a human-readable `.txt` beside a `.json`
/// of the same events, timestamped so repeated reproductions never overwrite each other. Returns the
/// directory, which the UI shows so the tester can find the files.
///
/// Reads nothing and changes nothing: it only writes what the frontend already collected.
// DIAGNOSTIC BUILD ONLY — compiled ONLY under the `diag` Cargo feature, so a release build has no
// such command to invoke and its name never reaches the binary (see lib.rs::sard_invoke_handler).
#[cfg(feature = "diag")]
#[tauri::command]
pub fn diag_save(
    text: String,
    json: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    // Documents\Sard Diagnostics, NOT the profile folder. A non-technical tester should never have
    // to find %APPDATA%, which is hidden by default on Windows. Falls back to the profile only if
    // the Documents folder cannot be resolved, so saving can never fail outright.
    use tauri::Manager;
    let dir = match app.path().document_dir() {
        Ok(docs) => docs.join("Sard Diagnostics"),
        Err(_) => state.app_data_dir.join("diagnostics"),
    };
    std::fs::create_dir_all(&dir).map_err(err)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_secs();
    let txt = dir.join(format!("sard-diag-{stamp}.txt"));
    let js = dir.join(format!("sard-diag-{stamp}.json"));
    std::fs::write(&txt, text).map_err(err)?;
    std::fs::write(&js, json).map_err(err)?;

    // Open the folder so the tester does not have to navigate anywhere. Best-effort: if the shell
    // call fails the report is already on disk, and the dialog still names the exact path.
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
    }

    Ok(dir.display().to_string())
}

/// DIAGNOSTIC BUILD ONLY — on-disk facts about the vendored PDF engine, read straight from the
/// filesystem so they are independent of the web layer entirely.
///
/// If the browser cannot load `pdf.mjs`, the first question is whether the bytes are even there.
/// Antivirus quarantine and a partially-written install both produce a missing or truncated file,
/// and neither is visible from JavaScript. Returns one line per file: exists, size, and whether it
/// can actually be opened for reading (presence is not the same as readability).
/// DIAGNOSTIC BUILD ONLY — amend THIS launch's startup record with what the frontend found.
///
/// The startup record is written by Rust before any frontend code runs and says `NOT REACHED`. This
/// is the only thing that can change that, so the section it appends is the evidence that the
/// frontend of THIS executable actually executed — which no measurement taken from Rust can
/// establish, and which distinguishes "the new build ran and its frontend is dead" from "an older
/// executable ran". Writes text the frontend has already formatted; it computes nothing.
// DIAGNOSTIC BUILD ONLY — compiled ONLY under the `diag` Cargo feature, so a release build has no
// such command to invoke and its name never reaches the binary (see lib.rs::sard_invoke_handler).
#[cfg(feature = "diag")]
#[tauri::command]
pub fn diag_startup_mark(section: String) -> Result<(), String> {
    crate::diag_startup::append_frontend(&section)
}

// DIAGNOSTIC BUILD ONLY — compiled ONLY under the `diag` Cargo feature, so a release build has no
// such command to invoke and its name never reaches the binary (see lib.rs::sard_invoke_handler).
#[cfg(feature = "diag")]
#[tauri::command]
pub fn diag_probe_assets(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let mut out = Vec::new();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    out.push(format!("exe_dir = {}", exe_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "UNKNOWN".into())));
    out.push(format!(
        "resource_dir = {}",
        app.path().resource_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "UNKNOWN".into())
    ));

    // The frontend is embedded in the binary, so these paths may not exist on disk at all — that is
    // itself a useful fact, and is reported rather than treated as an error.
    for rel in [
        "foliate-js/vendor/pdfjs/pdf.mjs",
        "foliate-js/vendor/pdfjs/pdf.worker.mjs",
        "foliate-js/vendor/pdfjs/text_layer_builder.css",
        "foliate-js/vendor/pdfjs/annotation_layer_builder.css",
    ] {
        let mut seen = false;
        for root in [exe_dir.clone(), app.path().resource_dir().ok()].into_iter().flatten() {
            let p = root.join(rel);
            if p.exists() {
                seen = true;
                let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let readable = std::fs::File::open(&p).is_ok();
                out.push(format!("{rel}: EXISTS at {} size={len} readable={readable}", p.display()));
            }
        }
        if !seen {
            out.push(format!("{rel}: not present on disk (expected — the frontend is embedded in the executable)"));
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn db_health(state: State<AppState>) -> Result<DbHealth, String> {
    let conn = state.conn();
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
    let conn = state.conn();
    settings::get(&conn, &key).map_err(err)
}

#[tauri::command]
pub fn settings_set(key: String, value: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
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
    let conn = state.conn();
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
    let conn = state.conn();
    library::progress_save(&conn, &book_id, &cfi, fraction).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn progress_get(
    book_id: String,
    state: State<AppState>,
) -> Result<Option<library::Progress>, String> {
    let conn = state.conn();
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
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    let mut rows = library::list_books(
        &conn,
        &sort,
        &order,
        format.as_deref(),
        collection.as_deref(),
        search.as_deref(),
    )
    .map_err(err)?;
    // Storage is app-data-relative; the IPC contract stays "absolute path". Converting HERE, at the
    // boundary, is what lets custody move later without touching a single consumer.
    for r in rows.iter_mut() {
        library::resolve_row_cover(&app_data_dir, r);
    }
    Ok(rows)
}

/// RAWY-15 — shelves (collections) with live book counts, for the sidebar.
#[tauri::command]
pub fn collections_list(state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.conn();
    library::collections_list(&conn).map_err(err)
}

// RAWY-31 — shelf writes (the only Rust↔JS path for collections). Each returns the
// refreshed shelf list so the UI updates names + counts in one call.

#[tauri::command]
pub fn collection_create(name: String, state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.conn();
    library::collection_create(&conn, &name).map_err(err)
}

#[tauri::command]
pub fn collection_rename(id: String, name: String, state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.conn();
    library::collection_rename(&conn, &id, &name).map_err(err)
}

#[tauri::command]
pub fn collection_delete(id: String, state: State<AppState>) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.conn();
    library::collection_delete(&conn, &id).map_err(err)
}

#[tauri::command]
pub fn collection_add_book(
    collection_id: String,
    book_id: String,
    state: State<AppState>,
) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.conn();
    library::collection_add_book(&conn, &collection_id, &book_id).map_err(err)
}

#[tauri::command]
pub fn collection_remove_book(
    collection_id: String,
    book_id: String,
    state: State<AppState>,
) -> Result<Vec<library::CollectionRow>, String> {
    let conn = state.conn();
    library::collection_remove_book(&conn, &collection_id, &book_id).map_err(err)
}

/// The shelf ids a book belongs to (for the edit-dialog chips).
#[tauri::command]
pub fn collections_for_book(book_id: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let conn = state.conn();
    library::collections_for_book(&conn, &book_id).map_err(err)
}

/// RAWY-17 — import EPUB files into the library (copy-in, hash/dedup, extract metadata +
/// cover). Returns one result per path so the UI can summarise imported/duplicate/
/// unsupported/error. The only Rust↔JS path for adding books.
///
/// ---- RAWY-274: `async` ON PURPOSE, and the reason is the same one tts.rs and backgrounds/mod.rs
/// already carry ----
///
/// This is the heaviest command in the app. Per file it does a whole-file `fs::read`, a SHA-256 over
/// every byte, a ZIP open + OPF parse, a cover extraction + write, and a whole-file `fs::write` into
/// managed storage. MEASURED on the owner's real 10-book / 43.79 MB library: **~150 ms warm, 309 ms
/// cold** — about 290 MB/s. `import_folder` exists for BULK import, where that scales: ~7 s for a 2 GB
/// Calibre-sized folder, ~35 s for 10 GB (extrapolated from the measured rate, and labelled as such).
///
/// A SYNC `#[tauri::command]` runs on the MAIN thread, so all of that ran there and froze the whole
/// native window for its duration. That behaviour is not re-measured here — it is CONFIRMED BY PRIOR
/// MEASUREMENT in this project (RAWY-183 and RAWY-188 measured the symptom directly: input not
/// reaching the WebView, the taskbar icon reverting while Windows judged the app unresponsive) and it
/// is a hard rule in LESSONS.md. `async` dispatches the body to the runtime's worker pool instead.
///
/// The body has NO `.await`, matching `tts_synthesize` and `background_choose`, so the non-`Send`
/// `MutexGuard` never crosses an await point.
///
/// ---- WHAT WAS DELIBERATELY *NOT* CHANGED, and why ----
///
/// The guard is still taken ONCE for the whole batch. Moving to a per-FILE lock was proposed and then
/// REFUTED BY MEASUREMENT: with a contending thread doing a small DB write every 2 ms, the worst wait
/// over three runs of the real library was 285/142/129 ms batch versus 73/139/116 ms per-file — an
/// improvement in one run of three and none in the other two. The cause is that Windows'
/// `std::sync::Mutex` is an unfair SRWLOCK: this loop releases and re-acquires within microseconds, so
/// a waiting thread essentially never wins the handover and per-file locking buys nothing reliable.
/// Under the engineering contract a change with no measured benefit is rejected, so it was dropped.
#[tauri::command]
pub async fn import_books(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<books::ImportResult>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    Ok(books::import_books(&conn, &app_data_dir, &paths))
}

/// RAWY-80 (audit #7) — import every EPUB inside a chosen folder (recursive), through the
/// same pipeline as `import_books`. One `ImportResult` per EPUB found.
///
/// RAWY-274: `async` for the reason given on `import_books` above — and more so here, because this is
/// the BULK path where the measured ~290 MB/s turns a large folder into seconds of work.
#[tauri::command]
pub async fn import_folder(
    dir: String,
    state: State<'_, AppState>,
) -> Result<Vec<books::ImportResult>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    Ok(books::import_folder(&conn, &app_data_dir, &dir))
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

/// RESILIENCE-1 / WP-3 — read ONE book's authoritative row (effective title/author, i.e.
/// `COALESCE(override, extracted)`).
///
/// The reader opens from four different surfaces (library card, inbox, bookmarks shelf, a
/// cross-book annotation jump) and only one of them held a full row. Rather than trust whichever
/// caller happened to launch it, the reader asks the database for the book it is opening.
#[tauri::command]
pub fn book_get(id: String, state: State<AppState>) -> Result<Option<library::BookRow>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    let mut row = library::get_book(&conn, &id).map_err(err)?;
    if let Some(r) = row.as_mut() { library::resolve_row_cover(&app_data_dir, r); }
    Ok(row)
}

/// RAWY-19 — update a book's metadata as OVERRIDES (never touches the source EPUB).
#[tauri::command]
pub fn book_update(
    id: String,
    patch: BookPatch,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    let conn = state.conn();
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

/// RESILIENCE-1 / WP-3 — record metadata EXTRACTED FROM THE FILE (the PDF path reads it from
/// PDF.js on first open). Writes the BASE columns, never `metadata_overrides`, so a title the
/// reader set keeps winning through COALESCE. See `library::set_extracted_metadata`.
#[tauri::command]
pub fn book_set_extracted(
    id: String,
    title: Option<String>,
    author: Option<String>,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    let conn = state.conn();
    library::set_extracted_metadata(&conn, &id, title.as_deref(), author.as_deref()).map_err(err)
}

/// RAWY-19 — STAGE a replacement cover: copy it into managed storage under its content-addressed
/// name and validate what Rust can, WITHOUT adopting it yet.
///
/// Staging and committing are separate because acceptance cannot be decided in one place. Rust
/// decoding catches damage a browser would silently render half of; the renderer accepts formats
/// Rust has no decoder for (AVIF today, whatever ships next) and needs no allow-list to maintain.
/// `verified: false` means only "we could not decode it" — the caller asks the renderer and then
/// calls `book_commit_cover` or `book_discard_cover`.
#[tauri::command]
pub fn book_stage_cover(
    id: String,
    image_path: String,
    state: State<AppState>,
) -> Result<library::StagedCover, String> {
    safe_id(&id)?;
    library::stage_cover(&state.app_data_dir, &id, &image_path)
}

/// RAWY-19 — adopt a staged cover (see `book_stage_cover`).
#[tauri::command]
pub fn book_commit_cover(
    id: String,
    rel: String,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    safe_id(&id)?;
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    let mut row = library::commit_cover(&conn, &app_data_dir, &id, &rel)?;
    if let Some(r) = row.as_mut() {
        library::resolve_row_cover(&app_data_dir, r);
    }
    Ok(row)
}

/// RAWY-19 — abandon a staged cover the renderer refused. Nothing was adopted, so nothing is undone.
#[tauri::command]
pub fn book_discard_cover(rel: String, state: State<AppState>) -> Result<(), String> {
    library::discard_cover(&state.app_data_dir, &rel)
}

/// RAWY-85 — set a PDF's page-1 cover from PNG bytes (extracted by the reader on first open).
/// RAWY-177 (AUD-4): the bytes arrive as a STAGED temp file (`stage_png`), not a JSON number-array
/// on the UI thread; we read the temp file, apply it, then delete it.
#[tauri::command]
pub fn book_set_cover_png(id: String, png_path: String, state: State<AppState>) -> Result<bool, String> {
    safe_id(&id)?;
    staged_png_path(&png_path)?; // RAWY-FINAL: only a path stage_png produced
    let data = std::fs::read(&png_path).map_err(err)?;
    let _ = std::fs::remove_file(&png_path);
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    library::set_cover_bytes(&conn, &app_data_dir, &id, &data)?;
    Ok(true)
}

/// RAWY-19 — revert to the extracted/auto cover (delete the custom override + file).
#[tauri::command]
pub fn book_revert_cover(
    id: String,
    state: State<AppState>,
) -> Result<Option<library::BookRow>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    let mut row = library::revert_cover(&conn, &app_data_dir, &id)?;
    if let Some(r) = row.as_mut() {
        library::resolve_row_cover(&app_data_dir, r);
    }
    Ok(row)
}

/// RAWY-76 — delete a book and cascade ALL related rows + files (zero orphans). Other books intact.
/// `safe_id` guards the id before it's spliced into a settings key / filenames.
#[tauri::command]
pub fn book_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    safe_id(&id)?;
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    library::delete_book(&conn, &app_data_dir, &id)
}

// ---- Highlights + notes (RAWY-20) ----------------------------------------

#[tauri::command]
pub fn highlights_for_book(book_id: String, state: State<AppState>) -> Result<Vec<library::HighlightRow>, String> {
    let conn = state.conn();
    library::highlights_for_book(&conn, &book_id).map_err(err)
}

/// Cross-book inbox (RAWY-27): every highlight + standalone note across all books.
#[tauri::command]
pub fn annotations_all(state: State<AppState>) -> Result<Vec<library::AnnoItem>, String> {
    let conn = state.conn();
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
    let conn = state.conn();
    library::highlight_create(&conn, &book_id, &cfi, &color, excerpt.as_deref(), chapter_label.as_deref())
        .map_err(err)
}

#[tauri::command]
pub fn highlight_set_color(id: String, color: String, state: State<AppState>) -> Result<Option<library::HighlightRow>, String> {
    let conn = state.conn();
    library::highlight_set_color(&conn, &id, &color).map_err(err)
}

/// RAWY-259: per-highlight ink density. `alpha: None` clears the override (back to the theme default).
#[tauri::command]
pub fn highlight_set_alpha(
    id: String,
    alpha: Option<f64>,
    state: State<AppState>,
) -> Result<Option<library::HighlightRow>, String> {
    let conn = state.conn();
    library::highlight_set_alpha(&conn, &id, alpha).map_err(err)
}

#[tauri::command]
pub fn highlight_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
    library::highlight_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn notes_for_book(book_id: String, state: State<AppState>) -> Result<Vec<library::NoteRow>, String> {
    let conn = state.conn();
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
    // RAWY-282: optional and LAST, so an older caller that omits it still compiles and still creates a
    // titleless note — Tauri fills a missing `Option` argument with `None`.
    title: Option<String>,
    state: State<AppState>,
) -> Result<Option<library::NoteRow>, String> {
    let conn = state.conn();
    library::note_create(
        &conn,
        &book_id,
        highlight_id.as_deref(),
        cfi.as_deref(),
        color.as_deref(),
        &body,
        chapter_label.as_deref(),
        title.as_deref(),
    )
    .map_err(err)
}

#[tauri::command]
pub fn note_update(
    id: String,
    body: String,
    color: Option<String>,
    title: Option<String>,
    state: State<AppState>,
) -> Result<Option<library::NoteRow>, String> {
    let conn = state.conn();
    library::note_update(&conn, &id, &body, color.as_deref(), title.as_deref()).map_err(err)
}

#[tauri::command]
pub fn note_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
    library::note_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

// ---- Note tags (RAWY-203): user-defined categories, shared across books, many-to-many. ----
#[tauri::command]
pub fn tags_list(state: State<AppState>) -> Result<Vec<library::Tag>, String> {
    let conn = state.conn();
    library::tags_list(&conn).map_err(err)
}

#[tauri::command]
pub fn tag_create(name: String, state: State<AppState>) -> Result<Option<library::Tag>, String> {
    let conn = state.conn();
    library::tag_create(&conn, &name).map_err(err)
}

#[tauri::command]
pub fn tag_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
    library::tag_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn note_tags_for(note_id: String, state: State<AppState>) -> Result<Vec<library::Tag>, String> {
    let conn = state.conn();
    library::note_tags_for(&conn, &note_id).map_err(err)
}

#[tauri::command]
pub fn note_tags_set(note_id: String, tag_ids: Vec<String>, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
    library::note_tags_set(&conn, &note_id, &tag_ids).map_err(err)?;
    Ok(true)
}

// ---- Bookmarks (RAWY-41): a saved CFI location, toggled at the current spot. ----

#[tauri::command]
pub fn bookmark_create(
    book_id: String,
    cfi: String,
    chapter_label: Option<String>,
    fraction: Option<f64>,
    label: Option<String>,
    state: State<AppState>,
) -> Result<Option<library::BookmarkRow>, String> {
    let conn = state.conn();
    library::bookmark_create(&conn, &book_id, &cfi, chapter_label.as_deref(), fraction, label.as_deref())
        .map_err(err)
}

#[tauri::command]
pub fn bookmark_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
    library::bookmark_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub fn bookmarks_for_book(book_id: String, state: State<AppState>) -> Result<Vec<library::BookmarkRow>, String> {
    let conn = state.conn();
    library::bookmarks_for_book(&conn, &book_id).map_err(err)
}

#[tauri::command]
pub fn bookmarks_all(state: State<AppState>) -> Result<Vec<library::BookmarkItem>, String> {
    let conn = state.conn();
    library::bookmarks_all(&conn).map_err(err)
}

// ---- Fonts (RAWY-39): import a user font file + list imported fonts. ----

#[tauri::command]
pub fn font_import(path: String, state: State<AppState>) -> Result<fonts::CustomFont, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    fonts::import(&conn, &app_data_dir, &path)
}

#[tauri::command]
pub fn fonts_list(state: State<AppState>) -> Result<Vec<fonts::CustomFont>, String> {
    let conn = state.conn();
    fonts::list(&conn)
}

#[tauri::command]
pub fn font_remove(id: String, state: State<AppState>) -> Result<bool, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    fonts::remove(&conn, &app_data_dir, &id)?;
    Ok(true)
}

// ---- Backgrounds (RAWY-265, Phase 1): managed user background images. ----

/// Import a background image. **ASYNC ON PURPOSE, and it must stay that way.** The body decodes the
/// image and may run a Lanczos3 resample — real CPU work. A SYNC `#[tauri::command]` runs on the main
/// thread and freezes the ENTIRE native window until it returns (LESSONS, threading: the RAWY-183 and
/// RAWY-188 scars). `async` dispatches it to the runtime's worker pool instead, so the window stays
/// live while a 24 MP photo is processed.
///
/// The body contains NO `.await`, matching `tts_synthesize`'s shape — so nothing non-`Send` (the
/// `MutexGuard` over the connection) is ever held across an await point.
/// Import AND bind in one call. Deliberately not two: a bare import leaves the row unreferenced, and
/// the GC that runs on any surface bind would collect the image the user just chose (verified in
/// `tests/backgrounds.rs`). Binding inside the same call closes that window by construction.
///
/// RAWY-FINAL: the heavy stage now runs with NO DB LOCK HELD.
///
/// `async` was already right and is unchanged. What was wrong is that the body took `state.db.lock()`
/// and then ran decode + Lanczos3 + PNG encode while holding it. That is the app's ONLY connection,
/// and every other DB command is SYNCHRONOUS — so the main thread blocked on the mutex for the whole
/// resample and the window froze regardless of this command being off-thread. The stages are now:
///   1. `prepare`   — read + sniff + probe + content id, NO lock;
///   2. dedup check — a BRIEF lock, so an already-managed image costs no decode at all;
///   3. `materialize` — decode, luma, resample, PNG-encode into memory, NO lock;
///   4. commit+bind — ONE lock for the file writes, the INSERT, the surface binding and the GC.
///
/// Step 4 is indivisible on purpose: `gc()` collects any file in `backgrounds/` that no row names, so
/// writing the managed copy with the lock released would let a concurrent bind delete the image the
/// user just chose. Binding still happens inside the same lock as the INSERT, which is what keeps
/// `choose()`'s original atomicity guarantee (verified by `tests/backgrounds.rs`) true here too.
#[tauri::command]
pub async fn background_choose(
    surface: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<backgrounds::Background, String> {
    let key = match surface.as_str() {
        "library" => backgrounds::KEY_LIBRARY_ID,
        "reading" => backgrounds::KEY_READING_ID,
        _ => return Err("bg.err.surface".into()),
    };
    let app_data_dir = state.app_data_dir.clone();

    // 1. no lock
    let prep = backgrounds::prepare(&path)?;

    // 2. brief lock — an exact re-import binds the existing row and never reaches the decoder
    {
        let conn = state.conn();
        if let Some(existing) = backgrounds::dedup_or_repair(&conn, prep.id())? {
            backgrounds::set_surface(&conn, &app_data_dir, key, Some(&existing.id))?;
            return Ok(existing);
        }
    }

    // 3. no lock — this is the part that used to freeze the window
    let mat = backgrounds::materialize(prep)?;

    // 4. one lock: write + record + bind + collect, indivisible against gc()
    let conn = state.conn();
    let row = backgrounds::commit(&conn, &app_data_dir, mat)?;
    backgrounds::set_surface(&conn, &app_data_dir, key, Some(&row.id))?;
    Ok(row)
}

#[tauri::command]
pub fn backgrounds_list(state: State<AppState>) -> Result<Vec<backgrounds::Background>, String> {
    let conn = state.conn();
    backgrounds::list(&conn)
}

/// Bind a surface ("library" / "reading") to a background id, or clear it with `None`. Collecting
/// orphans is done INSIDE this call, not exposed separately, so zero-orphans (D31) cannot be missed
/// by a caller that forgets to follow up.
#[tauri::command]
pub fn background_set_surface(
    surface: String,
    id: Option<String>,
    state: State<AppState>,
) -> Result<bool, String> {
    let key = match surface.as_str() {
        "library" => backgrounds::KEY_LIBRARY_ID,
        "reading" => backgrounds::KEY_READING_ID,
        _ => return Err("bg.err.surface".into()),
    };
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    backgrounds::set_surface(&conn, &app_data_dir, key, id.as_deref())?;
    Ok(true)
}

// ---- Photo Mode (RAWY-49): write a rendered photo-card PNG to a user-chosen path. ----
// The frontend rasterises the card DOM to PNG bytes (html-to-image) and picks a path via the
// dialog plugin; RAWY-177 (AUD-4) stages those bytes to a temp file first (raw ipc body, no JSON
// number-array on the UI thread), so this just moves the staged file onto the chosen destination.
#[tauri::command]
pub fn save_photo_card(path: String, src_path: String) -> Result<(), String> {
    staged_png_path(&src_path)?; // RAWY-FINAL: the SOURCE must be ours; `path` is the user's dialog pick
    // Copy (not rename) so a cross-volume destination — temp on C:, library on M: — still works,
    // then drop the temp. The output bytes are identical to the staged PNG.
    // RAWY-FINAL: the temp is dropped on the FAILURE path too. It used to be deleted only after a
    // successful copy, so a write to a full or read-only destination orphaned a multi-MB PNG in %TEMP%
    // that nothing ever collected.
    let res = std::fs::copy(&src_path, &path).map_err(err);
    let _ = std::fs::remove_file(&src_path);
    res?;
    Ok(())
}

// RAWY-177 (AUD-4): receive PNG bytes as a RAW ipc body (octet-stream) — not `Array.from` + a JSON
// number-array serialised on the main thread — and spill them to a temp file, returning its path.
// The photo-card / cover commands then take that path instead of a multi-MB `Vec<u8>` argument, so a
// 2–4 MB image never crosses the bridge as JSON and Save/Export no longer hitches.
#[tauri::command]
pub fn stage_png(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("stage_png expects raw bytes".into()),
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!("sard-stage-{}-{}.png", std::process::id(), nanos));
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---- Saved photo cards + gallery (RAWY-52, Photo Mode part 2a). ----
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn photocard_save(
    id: String,
    book_id: Option<String>,
    book_title: Option<String>,
    author: Option<String>,
    chapter_label: Option<String>,
    cfi: Option<String>,
    format: Option<String>,
    theme_id: Option<String>,
    quote: Option<String>,
    passages: Option<String>,
    quote_font: Option<String>,
    created_at: i64,
    png_path: String, // RAWY-177 (AUD-4): a staged temp file, not a JSON number-array of the bytes
    state: State<AppState>,
) -> Result<photocards::PhotoCard, String> {
    safe_id(&id)?;
    staged_png_path(&png_path)?; // RAWY-FINAL: only a path stage_png produced
    let data = std::fs::read(&png_path).map_err(err)?;
    let _ = std::fs::remove_file(&png_path);
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    let meta = photocards::SaveMeta {
        id,
        book_id,
        book_title,
        author,
        chapter_label,
        cfi,
        format,
        theme_id,
        quote,
        passages,
        quote_font,
        created_at,
    };
    photocards::save(&conn, &app_data_dir, meta, &data)
}

#[tauri::command]
pub fn photocards_list(state: State<AppState>) -> Result<Vec<photocards::PhotoCard>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    photocards::list(&conn, &app_data_dir)
}

#[tauri::command]
pub fn photocard_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    safe_id(&id)?;
    let app_data_dir = state.app_data_dir.clone();
    let conn = state.conn();
    photocards::delete(&conn, &app_data_dir, &id)?;
    Ok(true)
}

// RAWY-260 — REFERENCES: a note bound to a phrase, scoped to one book.

/// Every reference for a book — loaded once on open and held in memory for per-section matching.
#[tauri::command]
pub fn refs_for_book(book_id: String, state: State<AppState>) -> Result<Vec<library::RefRow>, String> {
    let conn = state.conn();
    library::refs_for_book(&conn, &book_id).map_err(err)
}

/// Create OR update — the dialog uses one path for both, so referencing a phrase twice edits it.
#[tauri::command]
pub fn ref_save(
    book_id: String,
    phrase: String,
    phrase_fold: String,
    word_count: i64,
    note: String,
    state: State<AppState>,
) -> Result<Option<library::RefRow>, String> {
    let conn = state.conn();
    library::ref_save(&conn, &book_id, &phrase, &phrase_fold, word_count, &note).map_err(err)
}

#[tauri::command]
pub fn ref_delete(id: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.conn();
    library::ref_delete(&conn, &id).map_err(err)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{safe_id, staged_png_path};

    /// RAWY-FINAL. The guard is only correct if it ACCEPTS what `stage_png` actually produces — a
    /// mismatch here would silently break Save/Export and cover extraction, which is worse than the
    /// hole it closes. This builds the path exactly as `stage_png` does (`temp_dir()` +
    /// `sard-stage-<pid>-<nanos>.png`) and asserts the round trip. It also pins the Windows detail
    /// that `temp_dir()` carries a trailing separator while `Path::parent()` does not: `Path` compares
    /// by COMPONENT, so the two are equal — assert it rather than assume it.
    #[test]
    fn staged_png_path_accepts_what_stage_png_writes() {
        let mut p = std::env::temp_dir();
        p.push(format!("sard-stage-{}-{}.png", std::process::id(), 1_234_567_890_u128));
        assert_eq!(
            staged_png_path(&p.to_string_lossy()),
            Ok(()),
            "the guard must accept stage_png's own output: {}",
            p.display()
        );
    }

    #[test]
    fn staged_png_path_rejects_everything_else() {
        let temp = std::env::temp_dir();
        for bad in [
            r"C:\Windows\System32\drivers\etc\hosts",
            r"C:\Users\Public\important.png",
            "relative-sard-stage-1-2.png",
        ] {
            assert!(staged_png_path(bad).is_err(), "should reject {bad}");
        }
        // Right directory, wrong name — the prefix/extension pair is part of the contract.
        assert!(staged_png_path(&temp.join("evil.png").to_string_lossy()).is_err());
        assert!(staged_png_path(&temp.join("sard-stage-1-2.exe").to_string_lossy()).is_err());
        // Traversal out of temp: `parent()` is no longer temp, so it cannot pass.
        assert!(staged_png_path(&temp.join("..").join("sard-stage-1-2.png").to_string_lossy()).is_err());
    }

    #[test]
    fn safe_id_rejects_separators_and_traversal() {
        assert!(safe_id("a1b2c3-D4_e5").is_ok());
        for bad in ["", "..", "a/b", r"a\b", "a..b", "a b", "id;drop"] {
            assert!(safe_id(bad).is_err(), "should reject {bad:?}");
        }
    }
}
