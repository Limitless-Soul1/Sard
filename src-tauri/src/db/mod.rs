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
    // execute_batch ignores result rows (journal_mode returns the new mode).
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    Ok(conn)
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
