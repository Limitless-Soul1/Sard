//! Books — file import, format detection, EPUB/PDF orchestration, cover extraction.
//!
//! RAWY-09 adds only a minimal `ensure`: insert a stub `books` row so the
//! `reading_progress` foreign key is satisfied for the currently-opened book. Full
//! import (metadata, cover, hash, real ids) is a later task and will own this table.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// Insert a minimal `books` row if one doesn't already exist (FK bridge for progress).
pub fn ensure(conn: &Connection, id: &str, file_path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO books(id, file_path, added_at) VALUES(?1, ?2, ?3)",
        rusqlite::params![id, file_path, now_unix()],
    )?;
    Ok(())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
