//! Versioned, ordered migration runner (RAWY-08).
//!
//! Deterministic and idempotent: the highest applied version is recorded in a
//! `schema_migrations` table (and mirrored to `PRAGMA user_version`). On each launch we
//! apply only migrations whose version is greater than the current one, each in its own
//! transaction. Never edit an already-shipped migration — append a new one instead.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// Ordered list of `(version, name, sql)`. Append-only.
pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "initial_schema",
        include_str!("migrations_sql/0001_initial_schema.sql"),
    ),
    (
        2,
        "bookmark_fields",
        include_str!("migrations_sql/0002_bookmark_fields.sql"),
    ),
    (
        3,
        "photo_cards",
        include_str!("migrations_sql/0003_photo_cards.sql"),
    ),
    (
        4,
        "photo_card_author",
        include_str!("migrations_sql/0004_photo_card_author.sql"),
    ),
    (
        5,
        "photo_card_passages",
        include_str!("migrations_sql/0005_photo_card_passages.sql"),
    ),
    (
        6,
        "photo_card_quote_font",
        include_str!("migrations_sql/0006_photo_card_quote_font.sql"),
    ),
    (
        7,
        "book_search_fold",
        include_str!("migrations_sql/0007_book_search_fold.sql"),
    ),
];

/// Apply any not-yet-applied migrations. Safe to call on every startup.
pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    // RAWY-178 (AUD-12): migration 0007's backfill calls `afold()`, so ensure it's registered on this
    // connection regardless of how it was opened (idempotent with open_database's registration).
    crate::db::register_functions(conn)?;
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

#[cfg(test)]
mod tests {
    use super::MIGRATIONS;

    // RAWY-178 (AUD-12): the v6→v7 upgrade path — an EXISTING library (books present before the
    // migration) gains `title_fold`/`author_fold`, backfilled by folding the effective title/author,
    // so an unvocalized query finds a vocalized/variant title. Faithfully replays the real path:
    // apply 1..=6, insert pre-7 books (no fold columns), then apply 7 and assert the backfill + search.
    #[test]
    fn migration_0007_backfills_and_folds() {
        let dir = std::env::temp_dir().join("sard_rawy178_mig");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("m.db");
        let _ = std::fs::remove_file(&path);

        // open_database registers `afold` (needed by 0007's backfill) + the pragmas.
        let conn = crate::db::open_database(&path).unwrap();
        for (v, _, sql) in MIGRATIONS.iter().filter(|(v, _, _)| *v <= 6) {
            conn.execute_batch(sql).unwrap_or_else(|e| panic!("apply v{v}: {e}"));
        }
        // Existing books as they'd sit at v6: a vocalized title + a hamza author, and a variant title.
        conn.execute(
            "INSERT INTO books(id, file_path, format, title, author, added_at) \
             VALUES('a','pa','epub','كِتاب','أحمد',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO books(id, file_path, format, title, added_at) \
             VALUES('b','pb','epub','مكتبة',0)",
            [],
        )
        .unwrap();
        // A title override should win over the base for the fold (backfill folds the EFFECTIVE value).
        conn.execute(
            "INSERT INTO metadata_overrides(book_id, field, value) VALUES('b','title','مصطفى')",
            [],
        )
        .unwrap();

        // Apply migration 7 (adds the columns + backfills via afold).
        let sql7 = MIGRATIONS.iter().find(|(v, _, _)| *v == 7).unwrap().2;
        conn.execute_batch(sql7).unwrap();

        // Row count preserved; integrity intact.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "no rows lost by the migration");
        let ic: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ic, "ok");

        // Folded search: an UNVOCALIZED query finds the vocalized title (كتاب ⇒ كِتاب).
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM books WHERE title_fold LIKE '%'||afold('كتاب')||'%' ESCAPE '\\'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "كتاب must find كِتاب via the folded column");

        // Hamza variant: احمد finds أحمد.
        let found_a: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM books WHERE author_fold LIKE '%'||afold('احمد')||'%' ESCAPE '\\'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found_a, 1, "احمد must find أحمد");

        // The backfill folded the EFFECTIVE (overridden) title: مصطفي finds book 'b' (override مصطفى).
        let ov: String = conn
            .query_row("SELECT title_fold FROM books WHERE id='b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ov, crate::library::fold_search("مصطفى"), "backfill uses the override, not the base");

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
