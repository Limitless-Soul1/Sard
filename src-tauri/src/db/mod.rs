//! Database — SQLite connection, baseline pragmas, and the migration runner (RAWY-08).
//!
//! One DB file lives in the OS app-data dir. A single shared `Connection` is guarded by
//! a `Mutex` inside `AppState` (low-concurrency desktop app; no pool needed yet).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

pub mod migrations;

/// Shared application state stored in Tauri's managed state and reached by commands.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub app_data_dir: PathBuf,
    pub db_path: PathBuf,
}

impl AppState {
    /// Lock the shared connection, RECOVERING from a poisoned mutex instead of failing forever.
    ///
    /// RAWY-273. `std::sync::Mutex` poisons PERMANENTLY the first time a thread panics while holding
    /// the guard, and the release profile unwinds (`panic = "unwind"` is the Cargo default and this
    /// crate sets no profile). Every command did `state.db.lock().map_err(err)?`, so ONE panic under
    /// this lock turned every subsequent DB call — `progress_save`, `settings_set`, `highlight_create`,
    /// all of them — into an `Err` for the remaining life of the process. The frontend swallows those
    /// into `.catch(console.error)` and release builds disable DevTools (`webview_chrome.rs`), so the
    /// observable result is an app that looks completely normal and has silently stopped saving
    /// anything: reading position, highlights, notes, bookmarks and the TTS cursor all lost.
    ///
    /// MEASURED, not assumed (see the tests below): after one panic under the guard the command
    /// pattern fails and never recovers, while the connection behind it still answers queries and
    /// `PRAGMA integrity_check` returns `ok`; and a panic inside an ASYNC command body is caught by
    /// `tauri::async_runtime`, so the process stays alive to experience the poisoned state.
    ///
    /// Recovering is SAFE here because the invariant a poisoned mutex protects is not violated: the
    /// guarded value is a SQLite `Connection`, statements and transactions are atomic, and a
    /// transaction that never reached `commit()` is rolled back when its guard drops. Recovery
    /// therefore downgrades an unbounded, silent, process-wide data-loss failure to at most one lost
    /// operation. On the happy path it is the same lock, with no added cost.
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Open (or create) the database file and apply baseline pragmas
/// (`foreign_keys=ON`, `journal_mode=WAL`).
pub fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // execute_batch ignores result rows (journal_mode/busy_timeout return the new value).
    // RAWY-173 (AUD-9): busy_timeout makes brief write contention RETRY (up to 3 s) instead of throwing
    // SQLITE_BUSY — a backstop for WAL checkpoint contention (and any second connection the
    // single-instance guard doesn't catch), so a routinely-swallowed save isn't silently dropped.
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;",
    )?;
    register_functions(&conn)?;
    Ok(conn)
}

/// RAWY-178 (AUD-12): register `afold(text)` — the Arabic search-folding used by the library search's
/// `title_fold`/`author_fold` shadow columns (import INSERTs, the edit refresh, and the migration
/// backfill). Registered on EVERY connection BEFORE migrations run so migration 0007's backfill can
/// call it. Deterministic + pure, so SQLite may cache it. NULL in → NULL out.
/// Idempotent — safe to call twice (SQLite replaces the function), so BOTH `open_database` (runtime
/// search) and `migrations::run` (so a migration works on ANY connection, e.g. in tests) register it.
pub(crate) fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function(
        "afold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let arg: Option<String> = ctx.get(0)?;
            Ok(arg.map(|s| crate::library::fold_search(&s)))
        },
    )
}

/// Current schema version = highest applied migration (0 on a brand-new DB).
pub fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !has_table {
        return Ok(0);
    }
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )
}

/// User tables (excludes SQLite-internal `sqlite_*`), sorted by name.
pub fn list_tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master \
         WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // RAWY-173 (AUD-9): `open_database` applies the contention backstop (busy_timeout) + WAL + FK on the
    // exact connection every command uses — proven here by reading the pragmas back from a real connection.
    #[test]
    fn open_database_sets_busy_timeout_wal_and_fk() {
        let dir = std::env::temp_dir().join("sard_rawy173_db");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);

        let conn = open_database(&path).unwrap();
        let busy: i64 = conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(busy, 3000, "busy_timeout must be 3000 ms (contention retries, not SQLITE_BUSY)");
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal", "journal_mode must be WAL");
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "foreign_keys must be ON");

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    // ---- RAWY-273: mutex-poison recovery ----
    // These are the instrument the fix was measured with, kept as permanent regression guards. They
    // cost nothing outside `cargo test` and they are the only thing that stops the `.map_err(err)?`
    // pattern being reintroduced without anyone noticing.
    fn state_for(tag: &str) -> AppState {
        let dir = std::env::temp_dir().join(format!("sard_rawy273_{tag}"));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);
        let conn = open_database(&path).unwrap();
        AppState { db: Mutex::new(conn), app_data_dir: dir, db_path: path }
    }

    /// The pattern EVERY command in commands/mod.rs uses today, verbatim.
    fn command_pattern(state: &AppState) -> Result<i64, String> {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT 1", [], |r| r.get(0)).map_err(|e| e.to_string())
    }

    /// The A/B, in one test: after a panic under the guard the OLD pattern is permanently broken and
    /// `conn()` is not — and the database is provably fine either way, which is what makes recovering
    /// the correct response rather than a papering-over.
    #[test]
    fn conn_recovers_from_a_poisoned_mutex_but_the_old_pattern_does_not() {
        let state = state_for("poison");
        assert_eq!(command_pattern(&state), Ok(1), "healthy before the panic");

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.db.lock().unwrap();
            panic!("a panic while the DB guard is alive");
        }));

        // BEFORE (the pattern every command used): permanently broken, and it never recovers.
        assert!(command_pattern(&state).is_err(), "expected the poisoned mutex to break it");
        for _ in 0..5 {
            assert!(command_pattern(&state).is_err(), "and it never recovers on its own");
        }

        // AFTER (the fix): the same work succeeds, repeatedly.
        for _ in 0..5 {
            let conn = state.conn();
            let n: i64 = conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "conn() must keep working after poisoning");
        }

        // WHY RECOVERY IS CORRECT: the failure is the mutex, not SQLite.
        let conn = state.conn();
        let ic: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ic, "ok", "the database behind the poisoned mutex is not corrupt");
    }

    /// A transaction abandoned by a panic must leave NO partial write behind — the specific worry
    /// with recovering a poisoned lock rather than refusing to use it.
    #[test]
    fn a_transaction_abandoned_by_a_panic_is_rolled_back() {
        let state = state_for("rollback");
        {
            let conn = state.conn();
            conn.execute_batch("CREATE TABLE t(x INTEGER);").unwrap();
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let conn = state.db.lock().unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute("INSERT INTO t(x) VALUES(1)", []).unwrap();
            panic!("panic before commit");
        }));

        let conn = state.conn();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the uncommitted row must have been rolled back when the guard dropped");
    }

    /// Does a panic inside an ASYNC command leave the process alive to observe the poisoning?
    /// This is the precondition the whole defect rests on, so it is measured rather than assumed.
    ///
    /// It matters for ORDERING as well as for justification: at the commit that introduced this fix,
    /// NO async command locked `state.db`, so the route was not yet live. The pending async import and
    /// the pending async `background_choose` both create one — each holding this lock while a
    /// third-party parser (`zip`/`quick-xml`, `image`) runs over a user-supplied file. This guard is
    /// what keeps that from becoming reachable the moment either lands.
    #[test]
    fn an_async_command_panic_leaves_the_process_alive_and_the_mutex_poisoned() {
        let state = std::sync::Arc::new(state_for("async"));
        let s2 = state.clone();

        // tauri::async_runtime is the exact executor an `async fn` #[tauri::command] is dispatched to.
        let handle = tauri::async_runtime::spawn(async move {
            let _guard = s2.db.lock().unwrap();
            panic!("a panic inside an async command body");
        });
        let joined = tauri::async_runtime::block_on(handle);

        assert!(joined.is_err(), "the task itself must report the panic");
        // The runtime -- and therefore the app -- survived it.
        assert!(command_pattern(&state).is_err(), "and the mutex is poisoned for every later command");
    }
}
