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
pub mod deposit; // reading deposits: one book, its reader's marks, and a letter, in one file
pub mod metadata; // read embedded metadata + persist user overrides (placeholder)
pub mod fonts; // register/validate custom fonts (placeholder)
pub mod photocards; // saved photo cards: PNG store + DB rows (RAWY-52, Photo Mode part 2a)
// The isolated reader-host origin (origin-isolation step 1; serves a static bundle only). Compiled
// only where a WebView actually needs it — see the registration in `run()` for why Windows does not.
#[cfg(not(target_os = "windows"))]
pub mod bookhost;
pub mod presence; // DISC/RPC: Discord Rich Presence worker thread + the on/off gate
pub mod profiles; // PROFILES: the visual-identity registry (storage only)
pub mod settings; // key/value settings persistence
pub mod sync; // FUTURE seam: backend trait only (placeholder)
pub mod tts; // read-aloud over the Edge Read-Aloud neural voices
pub mod webview_chrome; // RAWY-196: strip WebView2's browser chrome + accelerators (find bar, reload, print)
pub mod window_chrome; // RAWY-118: theme the native title bar to match the app theme (DWM, Windows)

use std::path::Path;

use tauri::{Emitter, Manager};

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
            // PROFILES (stage 1): storage only — no UI reaches these yet.
            commands::profiles_list,
            commands::profile_get,
            commands::profile_save,
            commands::profile_touch,
            commands::profile_delete,
            // PROFILES (stage 6): the shareable package. Inspection is separate from commit on
            // purpose — the reader sees what a file contains before any of it enters.
            commands::profile_export,
            commands::profile_asset_plan,
            commands::profile_package_asset,
            commands::profile_import_inspect,
            commands::profile_import_commit,
            // READING DEPOSITS (phase 1): the sender's half. The plan is read-only and prices what the
            // writer will write; nothing here reads or commits an incoming deposit yet.
            commands::deposit_plan,
            commands::deposit_export,
            commands::deposit_inspect,
            commands::deposit_member,
            commands::deposit_commit,
            commands::deposit_pending_marks,
            commands::deposit_place_marks,
            commands::opened_files_take, // files the OS handed us (a double-clicked deposit)
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
            commands::library_tree,
            commands::library_shelf_items,
            commands::library_arrangement,
            commands::library_place_book,
            // View order: sequence, never membership. See library/view_order.rs.
            commands::view_orders_for_scope,
            commands::view_order_reorder,
            commands::case_create,
            commands::case_rename,
            commands::case_delete,
            commands::case_reorder,
            commands::shelf_create,
            commands::shelf_set_case,
            commands::shelf_set_order,
            commands::shelf_set_collapsed,
            commands::shelf_place_book,
            commands::shelf_set_ink,
            commands::case_set_ink,
            commands::shelf_reorder,
            commands::category_reorder,
            commands::category_create,
            commands::category_rename,
            commands::category_delete,
            commands::import_books,
            commands::import_folder,
            commands::book_get,
            commands::book_update,
            commands::book_set_extracted,
            commands::book_stage_cover,
            commands::book_stage_spine,
            commands::book_commit_spine,
            commands::book_clear_spine,
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
            commands::reps_for_book, // replacements (phrase-bound reading-time substitutions)
            commands::rep_save,
            commands::rep_set_enabled,
            commands::rep_delete,
            commands::refs_reps_books,
            commands::refs_all,
            commands::reps_all,
            commands::highlight_delete,
            commands::notes_for_book,
            commands::note_create,
            commands::note_update,
            commands::note_delete,
            commands::tags_list,
            commands::tag_create,
            commands::tag_delete,
            commands::tag_rename,
            commands::note_tags_for,
            commands::note_tags_set,
            commands::font_import,
            commands::font_inspect,
            commands::font_import_dropped,
            commands::fonts_list,
            commands::font_remove,
            commands::background_choose, // RAWY-265: managed background images (import + bind, atomic)
            commands::background_import, // PROFILES: import WITHOUT binding — a draft must not repaint
            commands::backgrounds_list,
            commands::background_set_surface,
            commands::bookmark_create,
            commands::bookmark_delete,
            commands::bookmarks_for_book,
            commands::bookmarks_all,
            commands::stage_png,
            commands::save_photo_card,
            commands::photocard_save,
            commands::photocard_stage_image,
            commands::photocards_list,
            commands::photocard_delete,
            tts::tts_synthesize,
            tts::tts_edge_voices,
            tts::tts_stop,
            presence::presence_update, // DISC/RPC: push the reading activity to Discord
            presence::presence_clear, // DISC/RPC: clear it (leaving the book, or toggled off)
            window_chrome::set_titlebar_theme,
            $($diag_cmd),*
        ])
    };
}

/// PATHS THE OPERATING SYSTEM HANDED TO SARD.
///
/// A deposit double-clicked in a file manager, opened with "Open with", or named on the command line
/// arrives as an argument — on a cold start before the window exists, and on a second launch in a
/// process that is about to exit. Both funnel here, and the frontend drains the queue when it is ready.
///
/// THE QUEUE IS THE ONE SOURCE OF TRUTH. The second-launch event carries no payload; it only says
/// "look again". A path can therefore never be delivered twice, nor lost because nobody was listening.
#[derive(Default)]
pub struct OpenedFiles(std::sync::Mutex<Vec<String>>);

impl OpenedFiles {
    pub fn push_all(&self, paths: Vec<String>) {
        if let Ok(mut q) = self.0.lock() {
            q.extend(paths);
        }
    }

    /// Hand over everything waiting and forget it.
    pub fn take(&self) -> Vec<String> {
        self.0.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }
}

/// Which arguments are FILES the user meant to open.
///
/// Deliberately strict rather than clever: skip the program itself, ignore anything that looks like a
/// switch, and keep only what exists on disk RIGHT NOW. A development run carries its own arguments and
/// a shipped one may be handed anything at all; neither should be able to make Sard act on a path that
/// is not a real file.
pub fn file_args<I: IntoIterator<Item = String>>(argv: I) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
        .collect()
}

#[cfg(test)]
mod opened_files_tests {
    use super::{file_args, OpenedFiles};

    fn arg(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn the_program_itself_is_never_a_file_to_open() {
        // argv[0] is Sard. Opening it would be absurd, and on Windows it is a real path that exists,
        // so nothing but the skip protects against it.
        let exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
        assert!(file_args(vec![exe.clone()]).is_empty());
        // ...and the very same path is accepted when it arrives as a genuine argument.
        assert_eq!(file_args(vec![arg("sard.exe"), exe.clone()]), vec![exe]);
    }

    #[test]
    fn switches_are_not_files() {
        let args = vec![arg("sard.exe"), arg("--flag"), arg("-v")];
        assert!(file_args(args).is_empty());
    }

    #[test]
    fn a_path_that_does_not_exist_is_refused() {
        let args = vec![arg("sard.exe"), arg("C:/nowhere/at/all/ghost.zip")];
        assert!(file_args(args).is_empty());
    }

    #[test]
    fn a_directory_is_not_a_file() {
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        assert!(file_args(vec![arg("sard.exe"), dir]).is_empty());
    }

    #[test]
    fn the_queue_hands_each_path_over_exactly_once() {
        let q = OpenedFiles::default();
        q.push_all(vec![arg("a"), arg("b")]);
        assert_eq!(q.take(), vec![arg("a"), arg("b")]);
        // DRAINED, NOT PEEKED — the second ask is empty, which is what stops a deposit being offered
        // twice when the window remounts.
        assert!(q.take().is_empty());
    }

    #[test]
    fn a_second_launch_adds_to_what_is_already_waiting() {
        let q = OpenedFiles::default();
        q.push_all(vec![arg("first")]);
        q.push_all(vec![arg("second")]);
        assert_eq!(q.take(), vec![arg("first"), arg("second")]);
    }
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // SINGLE INSTANCE — DESKTOP ONLY, and not by preference.
    //
    // RAWY-173 (AUD-9): registered FIRST so a SECOND launch is intercepted before it opens a window
    // or attaches the same WAL DB. The callback runs in the ALREADY-RUNNING instance — focus its
    // window instead of starting a rival that would fight over the DB + per-session state, and hand it
    // any file the second launch was asked to open.
    //
    // WHY IT MOVED OUT OF THE CHAIN ABOVE. `tauri-plugin-single-instance` opens with a CRATE-level
    // `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, so on mobile the crate compiles
    // to nothing and this path does not resolve. Left in the chain it is not a plugin that misbehaves
    // on a phone — it is a build that cannot start.
    //
    // The concept does not transfer either: an Android activity and an iOS app are single-instance by
    // the platform's own lifecycle, so there is no rival process for this to intercept. A file handed
    // in from another app arrives through an intent or a document URL, not a second argv.
    //
    // `cfg(desktop)` rather than `cfg(not(any(target_os = ...)))` because that alias is exactly what
    // it means, tauri-build declares it (so no `unexpected_cfgs` warning), and this file already uses
    // its counterpart at `#[cfg_attr(mobile, tauri::mobile_entry_point)]`.
    //
    // ORDERING NOTE: it is no longer literally first in the chain, but it is still registered before
    // the window is created and before `setup()` opens the database, which is what RAWY-173 required.
    // A DEVELOPMENT RUN ON ITS OWN LIBRARY IS DELIBERATELY A SECOND INSTANCE.
    //
    // The guard keys on the bundle identifier, so it would hand the test run's window straight back
    // to the developer's own copy and exit — which is exactly what must not happen when the two are
    // meant to be looking at different databases. It is skipped only when `SARD_DATA_DIR` is set,
    // and only in a debug build; a shipped Sard is single-instance exactly as before.
    #[cfg(desktop)]
    let builder = if dev_data_dir_override().is_some() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A FILE ARG IS NOW ROUTED, which is what the note above anticipated. The second launch
            // hands its paths to the running instance and dies; the running window is raised and told
            // to look at its queue.
            let files = file_args(argv);
            if !files.is_empty() {
                app.state::<OpenedFiles>().push_all(files);
                let _ = app.emit("sard://opened", ());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
    };

    // THE READER-HOST ORIGIN (origin-isolation step 1) — NOT ON WINDOWS, DELIBERATELY.
    //
    // A distinct origin serving a static, allow-listed slice of the frontend bundle: the host
    // document, its script, the bundled fonts, and the pdf.js assets pdf.js resolves against its own
    // URL. It reads through the asset resolver, so it has no filesystem path to serve a book with.
    //
    // WHY IT IS ABSENT ON WINDOWS. It exists to answer ONE measured defect: WebKitGTK does not
    // deliver input into an iframe sandboxed `allow-same-origin` without `allow-scripts`, while
    // Blink does. Windows has no such defect, so the host would be an unused origin registered in a
    // shipping product — new attack surface bought with no benefit. A `cfg` rather than a runtime
    // check because the difference should be a fact about the binary, not a branch someone can flip:
    // the Windows executable does not merely leave this unused, it never compiles it, exactly as
    // `webview_chrome` and `audio_identity` already do for their own platform-specific reasons.
    //
    // Nothing embeds this origin yet; registering it serves it, and no reader uses it.
    #[cfg(not(target_os = "windows"))]
    let builder = builder.register_uri_scheme_protocol(bookhost::SCHEME, bookhost::handle);

    // THE UPDATER — RELEASE BUILDS ONLY, and this cfg is the whole reason it is split out of the
    // chain above. A diagnostic build that carries the public update channel is a diagnostic build
    // that can install itself permanently over someone's real Sard and then report itself current,
    // so nothing will ever repair it. That is not a hypothetical: the 2026-08-07 incident's
    // diagnostic build shared the release identifier, version AND endpoint, which is exactly why a
    // user could end up stranded on it. Under `--features diag` the plugin is never registered, so
    // the binary has no update path at all — not a disabled one, none.
    //
    // `process` (relaunch-after-install) goes with it: it exists to serve the updater flow.
    //
    // AND DESKTOP ONLY, which is a second and independent reason. Unlike single-instance these two
    // crates do compile for mobile, so nothing would fail loudly — they simply declare
    // `platforms.support.{android,ios}.level = "none"` and do nothing, which is the worse failure:
    // an update path that silently never updates. Both stores also forbid an application updating
    // itself outside the store, so on mobile this is not a missing feature but a prohibited one.
    // A mobile binary therefore has no update path at all — not a disabled one, none — exactly as a
    // diagnostic build does, and for the same reason: the safest update mechanism is an absent one.
    #[cfg(all(desktop, not(feature = "diag")))]
    let builder = builder
        // Everything the updater needs — the manifest endpoint, the minisign public key and the
        // Windows install mode — is declarative, in tauri.conf.json; there is no update command of
        // our own any more, and no update code path outside this plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

/// A SEPARATE LIBRARY FOR DEVELOPMENT AND TESTING — never in a shipped build.
///
/// Sard keeps its database in the OS app-data directory, resolved through `SHGetKnownFolderPath` on
/// Windows, which ignores `%APPDATA%`. There is therefore no way to point a test run at a different
/// library, and every interaction test has had to run against the developer's real books — which is
/// how four separate runs came to move real shelves and need repairing by hand.
///
/// `SARD_DATA_DIR` names a directory to use instead. It exists only under `debug_assertions`: in a
/// release build this function is a literal `None`, the environment variable is never read, and the
/// Windows path resolution is exactly what it always was. Nothing about production changes.
#[cfg(debug_assertions)]
fn dev_data_dir_override() -> Option<std::path::PathBuf> {
    let raw = std::env::var_os("SARD_DATA_DIR")?;
    if raw.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(raw))
}

#[cfg(not(debug_assertions))]
fn dev_data_dir_override() -> Option<std::path::PathBuf> {
    None
}

    let builder = builder
        .setup(|app| {
            // Resolve & create the OS app-data dir (%APPDATA%/com.sard.app on Windows) — unless a
            // development run has named another one. See `dev_data_dir_override`; in a release
            // build that call is a constant `None` and this is the OS path, as always.
            let app_data_dir = match dev_data_dir_override() {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
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
            // EVERY BOOK HAS A PLACE. A book imported before this ran, or one whose placement was
            // cascaded away with a deleted shelf, would otherwise have none — and "no place" is the
            // state the arrangement model exists to abolish. One query that usually finds nothing.
            if let Err(e) = library::placement::ensure(&conn) {
                eprintln!("could not give every book a placement: {e}");
            }
            // A composer closed without saving leaves its imported images bound to a card id that
            // was never written. During a session those bindings are what keeps the images alive;
            // between sessions there is no composer to protect, so they are just rubbish. Swept
            // here — the one place that cannot race a live composer.
            match photocards::sweep_draft_bindings(&conn) {
                Ok(0) => {}
                Ok(n) => eprintln!("reclaimed {n} image binding(s) from unsaved cards"),
                Err(e) => eprintln!("could not reclaim unsaved card image bindings: {e}"),
            }
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
            app.manage(presence::PresenceManager::start()); // DISC/RPC: the worker thread (idle until used)

            // A COLD START THAT WAS HANDED A FILE. Queued, not acted on: the window does not exist yet
            // and the frontend is not listening, so it waits until something asks for it.
            let opened = OpenedFiles::default();
            opened.push_all(file_args(std::env::args().collect::<Vec<_>>()));
            app.manage(opened);
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
                // DISC/RPC: clear the activity before the pipe dies, so no exit leaves a stale
                // "reading" card on the user's Discord profile. Fire-and-forget: the worker also
                // ends when the channel drops, and the process exit is not delayed for it.
                if let Some(presence) = app_handle.try_state::<presence::PresenceManager>() {
                    presence::shutdown(&presence);
                }
            }
        });
}
