//! Versioned, ordered migration runner (RAWY-08).
//!
//! Deterministic and idempotent: the highest applied version is recorded in a
//! `schema_migrations` table (and mirrored to `PRAGMA user_version`). On each launch we
//! apply only migrations whose version is greater than the current one, each in its own
//! transaction. Never edit an already-shipped migration — append a new one instead.

use std::path::Path;
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
    // 8 is the RAWY-189 *code* migration (run_arabic_dir_backfill, below) — not a SQL file.
    (
        9,
        "paragraph_spacing_default",
        include_str!("migrations_sql/0009_paragraph_spacing_default.sql"),
    ),
    (
        10,
        "note_tags",
        include_str!("migrations_sql/0010_note_tags.sql"),
    ),
    (
        11,
        "highlight_alpha",
        include_str!("migrations_sql/0011_highlight_alpha.sql"),
    ),
    (
        12,
        "references",
        include_str!("migrations_sql/0012_references.sql"),
    ),
    (
        13,
        "backgrounds",
        include_str!("migrations_sql/0013_backgrounds.sql"),
    ),
    (
        14,
        "note_title",
        include_str!("migrations_sql/0014_note_title.sql"),
    ),
    // RESILIENCE-1 / WP-2: five nullable columns for what the compatibility layer learned.
    (
        15,
        "book_compat",
        include_str!("migrations_sql/0015_book_compat.sql"),
    ),
];

/// Apply any not-yet-applied migrations. Safe to call on every startup.
///
/// `app_data_dir` is needed only by the code migration below (it reads imported EPUBs off disk); pass
/// `None` for schema-only setups (e.g. tests) to skip it — the SQL migrations run either way.
pub fn run(conn: &Connection, app_data_dir: Option<&Path>) -> rusqlite::Result<()> {
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

    // RAWY-189: migration 8 — the first *code* migration. It lives here rather than in a `.sql` file
    // because it must read the imported EPUBs off disk to sniff their script and correct a mis-declared
    // `books.dir`. Ordered after the SQL migrations and recorded in `schema_migrations` like any other
    // (so the NEXT migration — SQL or code — must be >= 9). Skipped when `app_data_dir` is None.
    if let Some(dir) = app_data_dir {
        run_arabic_dir_backfill(conn, dir);
        // RESILIENCE-1 / WP-2: migration 16 — the compatibility backfill. Same shape and the same
        // guarantees as migration 8 above: wrapped so it can never prevent launch, marker written
        // only on success, and idempotent by its own WHERE clause independently of that marker.
        run_compat_backfill(conn, dir);
    }
    Ok(())
}

/// Migration 8 (RAWY-189): content-based Arabic direction backfill, wrapped so it can NEVER prevent the
/// app from launching. A missing/unreadable file, corrupt zip/OPF, or even a parse panic is caught and
/// logged; the app continues. If the whole `library/` folder is gone, the scan simply flips nothing.
///
/// Durability: the marker is written only on success, so a successful run never repeats. The single
/// UPDATE is scoped `dir='ltr'`, so even a failed-marker re-scan flips nothing new (no forever loop of
/// changes). A deferred (Err/panic) run leaves the marker unset and retries next launch — near-
/// unreachable, since the per-row reads are best-effort and can't fail the transaction.
fn run_arabic_dir_backfill(conn: &Connection, app_data_dir: &Path) {
    match conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 8)",
        [],
        |r| r.get::<_, bool>(0),
    ) {
        Ok(true) => return, // already applied — second launch is a true no-op (no file scan)
        Ok(false) => {}
        Err(e) => {
            eprintln!("[Sard] migration 8 check failed, skipping this launch: {e}");
            return;
        }
    }

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::books::backfill_arabic_dir(conn, app_data_dir)
    }));
    match outcome {
        Ok(Ok(n)) => match record_migration_8(conn) {
            Ok(()) => {
                if n > 0 {
                    println!("[Sard] migration 8 (arabic_dir_backfill): corrected {n} book(s) dir->rtl by content");
                }
            }
            Err(e) => eprintln!("[Sard] migration 8 applied ({n} flipped) but marker write failed, will re-scan: {e}"),
        },
        Ok(Err(e)) => eprintln!("[Sard] migration 8 (arabic_dir_backfill) deferred, will retry next launch: {e}"),
        Err(_) => eprintln!("[Sard] migration 8 (arabic_dir_backfill) panicked; skipped, app continues"),
    }
}

/// Migration 16 (RESILIENCE-1 / WP-2): fill the compatibility columns for books imported before
/// WP-2 shipped, and correct placeholder metadata such as the literal title "Unknown".
///
/// Deliberately identical in shape to migration 8: never fails a launch, never repeats after
/// success, and — because `backfill_compat` scopes its own query to `script_detected IS NULL` — a
/// re-run after a failed marker write examines only what is still unexamined.
fn run_compat_backfill(conn: &Connection, app_data_dir: &Path) {
    match conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 16)",
        [],
        |r| r.get::<_, bool>(0),
    ) {
        Ok(true) => return, // already applied — no file scan on later launches
        Ok(false) => {}
        Err(e) => {
            eprintln!("[Sard] migration 16 check failed, skipping this launch: {e}");
            return;
        }
    }

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::books::backfill_compat(conn, app_data_dir)
    }));
    match outcome {
        Ok(Ok((examined, retitled))) => match record_migration(conn, 16, "book_compat_backfill") {
            Ok(()) => {
                if examined > 0 {
                    println!("[Sard] migration 16 (book_compat_backfill): examined {examined} book(s), corrected {retitled} placeholder title(s)");
                }
            }
            Err(e) => eprintln!("[Sard] migration 16 applied ({examined} examined) but marker write failed, will re-scan: {e}"),
        },
        Ok(Err(e)) => eprintln!("[Sard] migration 16 (book_compat_backfill) deferred, will retry next launch: {e}"),
        Err(_) => eprintln!("[Sard] migration 16 (book_compat_backfill) panicked; skipped, app continues"),
    }
}

/// Record a code migration's marker. (Migration 8 predates this and keeps its own writer, so its
/// shipped behaviour is untouched.)
fn record_migration(conn: &Connection, version: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES(?1, ?2, ?3)",
        rusqlite::params![version, name, now_unix()],
    )?;
    conn.pragma_update(None, "user_version", version)?;
    Ok(())
}

fn record_migration_8(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES(8, 'arabic_dir_backfill', ?1)",
        rusqlite::params![now_unix()],
    )?;
    conn.pragma_update(None, "user_version", 8i64)?;
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
