//! Sard (سَرْد) — Rust core (backend). (Formerly "eRawy".)
//!
//! Opens a SQLite DB in the OS app-data dir, runs versioned migrations, and exposes a
//! small typed IPC seam (`commands`). The other modules remain placeholders that make
//! the planned architecture (PROJECT.md §5) visible. All frontend↔core traffic goes
//! through `commands`.

#[cfg(target_os = "windows")]
pub mod audio_identity; // RAWY-270A: name + icon Sard's WebView2 audio session in the Volume Mixer
pub mod backgrounds; // RAWY-265: managed user background images (copy-in, dedup, derivative, GC)
pub mod commands; // IPC seam: #[tauri::command] handlers (the only frontend↔core boundary)
pub mod db; // SQLite connection, pragmas, migration runner, AppState
// DIAGNOSTIC BUILD ONLY: the pre-WebView startup record. Gated on the `diag` Cargo feature, so a
// release build does not merely leave it unused — it never compiles it, and none of its strings
// reach the binary. That absence is what `scripts/verify-artifact.mjs` measures.
#[cfg(feature = "diag")]
pub mod diag_startup;

// The one string that says out loud what this executable is. It exists only under the `diag`
// feature, is never printed in a release build, and is what the artifact verifier requires to be
// PRESENT before it will let a diagnostic package be handed to anyone. A diagnostic build that
// quietly lost its instrumentation cost a tester a week; it cannot happen unnoticed again.
#[cfg(feature = "diag")]
pub const BUILD_KIND_BANNER: &str = "SARD DIAGNOSTIC BUILD — NOT FOR RELEASE";
pub mod library; // repositories: books, shelves, highlights, notes, bookmarks, progress (placeholder)
pub mod books; // file import, format detection, EPUB/PDF orchestration (placeholder)
pub mod metadata; // read embedded metadata + persist user overrides (placeholder)
pub mod fonts; // register/validate custom fonts (placeholder)
pub mod photocards; // saved photo cards: PNG store + DB rows (RAWY-52, Photo Mode part 2a)
pub mod settings; // key/value settings persistence
pub mod sync; // FUTURE seam: backend trait only (placeholder)
pub mod tts; // read-aloud over the Edge Read-Aloud neural voices
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

// The IPC surface, in ONE list, with the diagnostic commands passed in rather than written twice.
//
// Two copies of a fifty-command list is a list that drifts, and a drifted list is how a diagnostic
// command survives into a release build without anyone deciding it should. The macro expands before
// `generate_handler!` parses, so the release build's handler genuinely has no diagnostic arm to call.
// It takes the BUILDER rather than returning the handler, because `generate_handler!` expands to a
// closure generic over the Tauri runtime: bound to a bare `let` it has nothing to infer that
// parameter from and fails with "type annotations needed". Applying it in place gives it the
// builder's own runtime type, and costs nothing in clarity.
macro_rules! sard_invoke_handler {
    ($builder:expr $(, $diag_cmd:path)* $(,)?) => {
        $builder.invoke_handler(tauri::generate_handler![
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
            commands::book_get,
            commands::book_update,
            commands::book_set_extracted,
            commands::book_stage_cover,
            commands::book_commit_cover,
            commands::book_discard_cover,
            commands::book_set_cover_png,
            commands::book_revert_cover,
            commands::book_delete,
            commands::highlights_for_book,
            commands::annotations_all,
            commands::highlight_create,
            commands::highlight_set_color,
            commands::highlight_set_alpha, // RAWY-259: per-highlight ink density
            commands::refs_for_book, // RAWY-260: references (phrase-bound notes)
            commands::ref_save,
            commands::ref_delete,
            commands::highlight_delete,
            commands::notes_for_book,
            commands::note_create,
            commands::note_update,
            commands::note_delete,
            commands::tags_list,
            commands::tag_create,
            commands::tag_delete,
            commands::note_tags_for,
            commands::note_tags_set,
            commands::font_import,
            commands::fonts_list,
            commands::font_remove,
            commands::background_choose, // RAWY-265: managed background images (import + bind, atomic)
            commands::backgrounds_list,
            commands::background_set_surface,
            commands::bookmark_create,
            commands::bookmark_delete,
            commands::bookmarks_for_book,
            commands::bookmarks_all,
            commands::stage_png,
            commands::save_photo_card,
            commands::photocard_save,
            commands::photocards_list,
            commands::photocard_delete,
            tts::tts_synthesize,
            tts::tts_edge_voices,
            tts::tts_stop,
            window_chrome::set_titlebar_theme,
            $($diag_cmd),*
        ])
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // RAWY-111: two rustls crypto providers (aws-lc-rs via msedge-tts + ring via ureq 3) are compiled
    // in, so rustls' auto-detection is ambiguous and would PANIC on the first TLS handshake (the Edge
    // TTS WebSocket). Pin aws-lc-rs as the explicit process default before anything opens a connection.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    #[cfg(feature = "diag")]
    println!("[Sard] {BUILD_KIND_BANNER}");

    let builder = tauri::Builder::default()
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
        .plugin(tauri_plugin_dialog::init());

    // THE UPDATER — RELEASE BUILDS ONLY, and this cfg is the whole reason it is split out of the
    // chain above. A diagnostic build that carries the public update channel is a diagnostic build
    // that can install itself permanently over someone's real Sard and then report itself current,
    // so nothing will ever repair it. That is not a hypothetical: the 2026-08-07 incident's
    // diagnostic build shared the release identifier, version AND endpoint, which is exactly why a
    // user could end up stranded on it. Under `--features diag` the plugin is never registered, so
    // the binary has no update path at all — not a disabled one, none.
    //
    // `process` (relaunch-after-install) goes with it: it exists to serve the updater flow.
    #[cfg(not(feature = "diag"))]
    let builder = builder
        // Everything the updater needs — the manifest endpoint, the minisign public key and the
        // Windows install mode — is declarative, in tauri.conf.json; there is no update command of
        // our own any more, and no update code path outside this plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder
        .setup(|app| {
            // Resolve & create the OS app-data dir (%APPDATA%/com.sard.app on Windows).
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("sard.db");

            // DIAGNOSTIC BUILD ONLY. Written HERE — before the legacy migration, before the database
            // is opened, and before any frontend code runs — so it survives a failure in any of them
            // and so the file's ABSENCE proves the running executable is not this build. Observation
            // only; it cannot fail in a way that reaches this function.
            #[cfg(feature = "diag")]
            diag_startup::write_startup_record(app.path().document_dir().ok(), &app_data_dir);

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

            // RAWY-270A: read-aloud is Web Audio inside the WebView, so the WASAPI session belongs to
            // a WebView2 process and the Volume Mixer falls back to Microsoft's icon and name. Stamp
            // Sard's name and icon onto it. METADATA ONLY — no audio is produced, routed or touched
            // here. Returns immediately; all work is on its own thread, which then blocks on a
            // Windows event and costs nothing until a session or a device actually changes.
            #[cfg(target_os = "windows")]
            audio_identity::start();

            app.manage(db::AppState {
                db: std::sync::Mutex::new(conn),
                app_data_dir,
                db_path,
            });
            app.manage(tts::TtsEngine::default()); // holds the warm Edge socket + cached voice list
            Ok(())
        });

    // THE IPC SURFACE, chosen at COMPILE time. Exactly one of these two lines exists in any given
    // binary, so "is this a diagnostic build?" is answered by what was compiled — never by a runtime
    // flag someone could flip, a config someone could edit, or a folder someone could copy out of.
    #[cfg(feature = "diag")]
    let builder = sard_invoke_handler![
        builder,
        commands::diag_save,
        commands::diag_probe_assets,
        commands::diag_startup_mark,
    ];
    #[cfg(not(feature = "diag"))]
    let builder = sard_invoke_handler![builder];

    builder
        .build(tauri::generate_context!())
        .expect("error while building Sard")
        // RAWY-173 (AUD-10): on app exit, drop the warm Edge socket rather than leaving the
        // connection to be reaped by process teardown.
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(engine) = app_handle.try_state::<tts::TtsEngine>() {
                    tts::shutdown(&engine);
                }
            }
        });
}
