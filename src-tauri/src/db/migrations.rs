//! Versioned, ordered migration runner (RAWY-08).
//!
//! Deterministic and idempotent: the highest applied version is recorded in a
//! `schema_migrations` table (and mirrored to `PRAGMA user_version`). On each launch we
//! apply only migrations whose version is greater than the current one, each in its own
//! transaction. Never edit an already-shipped migration — append a new one instead.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// Ordered list of `(version, name, sql)`. Append-only.
pub const MIGRATIONS: &[(i64, &str, &str)] = &[(
    1,
    "initial_schema",
    include_str!("migrations_sql/0001_initial_schema.sql"),
)];

/// Apply any not-yet-applied migrations. Safe to call on every startup.
pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (\
            version    INTEGER PRIMARY KEY, \
            name       TEXT NOT NULL, \
            applied_at INTEGER NOT NULL);",
    )?;

    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;

    for (version, name, sql) in MIGRATIONS {
        if *version > current {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES(?1, ?2, ?3)",
                rusqlite::params![version, name, now_unix()],
            )?;
            tx.pragma_update(None, "user_version", *version)?;
            tx.commit()?;
        }
    }
    Ok(())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
