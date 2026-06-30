//! Sard (سَرْد) — Rust core (backend). (Formerly "eRawy".)
//!
//! Opens a SQLite DB in the OS app-data dir, runs versioned migrations, and exposes a
//! small typed IPC seam (`commands`). The other modules remain placeholders that make
//! the planned architecture (PROJECT.md §5) visible. All frontend↔core traffic goes
//! through `commands`.

pub mod commands; // IPC seam: #[tauri::command] handlers (the only frontend↔core boundary)
pub mod db; // SQLite connection, pragmas, migration runner, AppState
pub mod library; // repositories: books, shelves, highlights, notes, bookmarks, progress (placeholder)
pub mod books; // file import, format detection, EPUB/PDF orchestration (placeholder)
pub mod metadata; // read embedded metadata + persist user overrides (placeholder)
pub mod fonts; // register/validate custom fonts (placeholder)
pub mod settings; // key/value settings persistence
pub mod sync; // FUTURE seam: backend trait only (placeholder)

use std::path::Path;

use tauri::Manager;

/// One-time, idempotent migration of legacy app-data from the old identity
/// (`com.erawy.app` / `erawy.db`) to the new one (`com.sard.app` / `sard.db`).
///
/// COPY-then-keep: if the new DB doesn't exist yet but the old one does, copy the DB
/// (plus its `-wal`/`-shm` sidecars, which may hold the latest writes) into the new dir
/// as `sard.db`. The old data is NEVER deleted here.
fn migrate_legacy_appdata(new_dir: &Path, new_db: &Path) -> std::io::Result<()> {
    if new_db.exists() {
        return Ok(()); // already migrated, or a fresh install that already has data
    }
    let Some(appdata_root) = new_dir.parent() else {
        return Ok(());
    };
    let old_dir = appdata_root.join("com.erawy.app");
    let old_db = old_dir.join("erawy.db");
    if !old_db.exists() {
        return Ok(()); // nothing to migrate (clean fresh install)
    }

    // Copy the main DB + WAL/SHM sidecars (sidecars carry uncheckpointed writes).
    std::fs::copy(&old_db, new_db)?;
    for (from, to) in [
        ("erawy.db-wal", "sard.db-wal"),
        ("erawy.db-shm", "sard.db-shm"),
    ] {
        let src = old_dir.join(from);
        if src.exists() {
            std::fs::copy(&src, new_dir.join(to))?;
        }
    }

    // Verify the copy landed (size match) before reporting success. Old data left intact.
    let ok = new_db.exists()
        && std::fs::metadata(new_db)?.len() == std::fs::metadata(&old_db)?.len();
    println!(
        "[Sard] migrated legacy app-data: {} -> {} (verified={ok}); old dir preserved",
        old_db.display(),
        new_db.display()
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Resolve & create the OS app-data dir (%APPDATA%/com.sard.app on Windows).
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("sard.db");

            // Preserve data from the former "eRawy" identity (one-time, copy-verify).
            migrate_legacy_appdata(&app_data_dir, &db_path)?;

            // Open DB, apply pragmas, run migrations (idempotent).
            let conn = db::open_database(&db_path)?;
            db::migrations::run(&conn)?;
            let version = db::schema_version(&conn)?;

            println!("[Sard] app_data_dir  = {}", app_data_dir.display());
            println!("[Sard] db_path       = {}", db_path.display());
            println!("[Sard] schema_version = {version}");

            app.manage(db::AppState {
                db: std::sync::Mutex::new(conn),
                app_data_dir,
                db_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::db_health,
            commands::settings_get,
            commands::settings_set,
            commands::book_register,
            commands::progress_save,
            commands::progress_get,
            commands::library_list_books,
            commands::collections_list,
            commands::collection_create,
            commands::collection_rename,
            commands::collection_delete,
            commands::collection_add_book,
            commands::collection_remove_book,
            commands::collections_for_book,
            commands::import_books,
            commands::book_update,
            commands::book_set_cover,
            commands::book_revert_cover,
            commands::highlights_for_book,
            commands::annotations_all,
            commands::highlight_create,
            commands::highlight_set_color,
            commands::highlight_delete,
            commands::notes_for_book,
            commands::note_create,
            commands::note_update,
            commands::note_delete,
            commands::font_import,
            commands::fonts_list,
            commands::font_remove,
            commands::bookmark_create,
            commands::bookmark_delete,
            commands::bookmarks_for_book,
            commands::bookmarks_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sard");
}
