//! eRawy (الراوي) — Rust core (backend).
//!
//! RAWY-08 adds the core foundation: open a SQLite DB in the OS app-data dir, run
//! versioned migrations, and expose a small typed IPC seam (`commands`). The other
//! modules remain placeholders that make the planned architecture (PROJECT.md §5)
//! visible. All frontend↔core traffic goes through `commands`.

pub mod commands; // IPC seam: #[tauri::command] handlers (the only frontend↔core boundary)
pub mod db; // SQLite connection, pragmas, migration runner, AppState
pub mod library; // repositories: books, shelves, highlights, notes, bookmarks, progress (placeholder)
pub mod books; // file import, format detection, EPUB/PDF orchestration (placeholder)
pub mod metadata; // read embedded metadata + persist user overrides (placeholder)
pub mod fonts; // register/validate custom fonts (placeholder)
pub mod settings; // key/value settings persistence
pub mod sync; // FUTURE seam: backend trait only (placeholder)

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Resolve & create the OS app-data dir (%APPDATA%/com.erawy.app on Windows).
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("erawy.db");

            // Open DB, apply pragmas, run migrations (idempotent).
            let conn = db::open_database(&db_path)?;
            db::migrations::run(&conn)?;
            let version = db::schema_version(&conn)?;

            println!("[eRawy] app_data_dir  = {}", app_data_dir.display());
            println!("[eRawy] db_path       = {}", db_path.display());
            println!("[eRawy] schema_version = {version}");

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running eRawy");
}
