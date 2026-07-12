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
}
