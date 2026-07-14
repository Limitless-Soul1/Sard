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
pub mod photocards; // saved photo cards: PNG store + DB rows (RAWY-52, Photo Mode part 2a)
pub mod settings; // key/value settings persistence
pub mod sync; // FUTURE seam: backend trait only (placeholder)
pub mod tts; // RAWY-105: bundled piper sidecar (persistent process) + on-demand voice download
pub mod updater; // RAWY-168: in-app update CHECK (Phase 1 — notify only, no download/install)
pub mod webview_chrome; // RAWY-196: strip WebView2's browser chrome + accelerators (find bar, reload, print)
pub mod window_chrome; // RAWY-118: theme the native title bar to match the app theme (DWM, Windows)

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
    // RAWY-111: two rustls crypto providers (aws-lc-rs via msedge-tts + ring via ureq 3) are compiled
    // in, so rustls' auto-detection is ambiguous and would PANIC on the first TLS handshake (the Edge
    // TTS WebSocket). Pin aws-lc-rs as the explicit process default before anything opens a connection.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    tauri::Builder::default()
        // RAWY-173 (AUD-9): registered FIRST so a SECOND launch is intercepted before it opens a window
        // or attaches the same WAL DB. The callback runs in the ALREADY-RUNNING instance — focus its
        // window instead of starting a rival that would fight over the DB + per-session state. (A file
        // arg could be routed here later; for now, just surface the existing window.)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Resolve & create the OS app-data dir (%APPDATA%/com.sard.app on Windows).
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("sard.db");

            // Preserve data from the former "eRawy" identity (one-time, copy-verify).
            migrate_legacy_appdata(&app_data_dir, &db_path)?;

            // Open DB, apply pragmas, run migrations (idempotent). RAWY-189: pass app_data_dir so the
            // content-based direction backfill (migration 8) can read the imported EPUBs off disk.
            let conn = db::open_database(&db_path)?;
            db::migrations::run(&conn, Some(&app_data_dir))?;
            let version = db::schema_version(&conn)?;

            println!("[Sard] app_data_dir  = {}", app_data_dir.display());
            println!("[Sard] db_path       = {}", db_path.display());
            println!("[Sard] schema_version = {version}");

            // RAWY-196: Sard owns its keyboard + pointer surface. Strip WebView2's browser chrome
            // (find bar, reload, print, the right-click Back/Refresh/Save/Print menu) before the user
            // can reach any of it. Release only — a debug build keeps devtools (see webview_chrome).
            if let Some(win) = app.get_webview_window("main") {
                webview_chrome::harden(&win);
            }

            app.manage(db::AppState {
                db: std::sync::Mutex::new(conn),
                app_data_dir,
                db_path,
            });
            app.manage(tts::TtsEngine::default()); // RAWY-105: persistent piper process holder
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
            commands::import_folder,
            commands::book_update,
            commands::book_set_cover,
            commands::book_set_cover_png,
            commands::book_revert_cover,
            commands::book_delete,
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
            commands::stage_png,
            commands::save_photo_card,
            commands::photocard_save,
            commands::photocards_list,
            commands::photocard_delete,
            tts::tts_voice_present,
            tts::tts_download_voice,
            tts::tts_synthesize,
            tts::tts_edge_voices,
            tts::tts_stop,
            updater::check_for_update,
            window_chrome::set_titlebar_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sard")
        // RAWY-173 (AUD-10): on app exit, kill the warm Piper child (belt-and-braces — piper --json-input
        // should self-exit on stdin EOF when the parent drops, but this guarantees no orphaned piper.exe).
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(engine) = app_handle.try_state::<tts::TtsEngine>() {
                    tts::shutdown(&engine);
                }
            }
        });
}
