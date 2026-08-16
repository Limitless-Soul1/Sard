//! Versioned migration runner (RAWY-08).
//!
//! Each applied migration is recorded as its own row in `schema_migrations`. On each launch we apply
//! every migration whose version is **absent** from that table, each in its own transaction. Never
//! edit an already-shipped migration — append a new one instead.
//!
//! # Why presence, and not a high-water mark
//!
//! This runner used to apply migrations whose version exceeded `MAX(version)`. That encodes
//! "everything below this line is done", which is a claim two branches developing in parallel cannot
//! both make truthfully — and it fails **silently**, because a skipped migration and an applied one
//! leave identical evidence behind: nothing. It was not hypothetical. Two branches both took 17, and
//! on every database that had seen the other branch the second feature's table was simply never
//! created, against a binary that compiled and passed its tests.
//!
//! Presence-tracking removes the ordering problem entirely: a migration is applied on its own
//! account, whatever else has run, so two branches converge on the same schema in either merge order
//! and nothing ever needs renumbering.
//!
//! Re-running is not a risk despite most migrations being non-idempotent (`ALTER TABLE ADD COLUMN`
//! cannot be guarded in SQLite). A migration's SQL and its `schema_migrations` row are written in the
//! SAME transaction, so a migration cannot be applied without being recorded — absent therefore
//! provably means never applied.
//!
//! # Numbering: UTC `YYYYMMDDHHMMSS`
//!
//! Presence-tracking fixes the ORDER; unique numbers fix the IDENTITY. Both are needed — if two
//! branches pick the same number, presence-tracking skips the second just as silently as before.
//!
//! Allocate a new migration's version with:
//!
//! ```text
//! date -u +%Y%m%d%H%M%S
//! ```
//!
//! and name the file after it, e.g. `20260816112700_add_shelf_colour.sql`. UTC, not local time: local
//! time repeats an hour every autumn and disagrees between contributors. Versions 1–19 predate this
//! convention and keep their hand-assigned numbers forever; `LAST_SEQUENTIAL_VERSION` is the boundary.
//!
//! The rules are enforced by the tests at the bottom of this file — unique versions, valid
//! timestamps, pinned shipped versions, and file/list agreement — and CI runs them on every pull
//! request. See `docs/WORKFLOW.md` for the contributor-facing version of this.
//!
//! # The one rule this buys with a constraint
//!
//! Migrations may be applied OUT OF NUMERIC ORDER. A database that took a migration from one branch
//! will later apply a lower-numbered one from another. **Every migration must therefore stand on its
//! own** and must not assume that a lower-numbered migration has already run. In practice migrations
//! from independent branches touch independent tables, which is what makes this safe — but it is a
//! rule, not an accident.
//!
//! `PRAGMA user_version` mirrors the COUNT of applied migrations, not the newest version number: it
//! is a 32-bit field, and a `YYYYMMDDHHMMSS` version overflows it silently to 0. Nothing in Sard
//! reads it. `db::schema_version()` returns the highest applied version, which is the value that
//! identifies *which* migration is newest.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// The last migration that was numbered by hand. Everything added after this carries a UTC
/// `YYYYMMDDHHMMSS` timestamp instead — see the module documentation above for why, and
/// `docs/WORKFLOW.md` for how to allocate one.
pub const LAST_SEQUENTIAL_VERSION: i64 = 19;

/// The smallest value a timestamp version may take (`2000-01-01 00:00:00`). Anything at or above
/// this is read as `YYYYMMDDHHMMSS`; anything below it is a hand-numbered legacy version.
pub const TIMESTAMP_FLOOR: i64 = 20_000_101_000_000;

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
    // 16 is the RESILIENCE-1 / WP-2 *code* migration (run_compat_backfill, below) — not a SQL file,
    // and NOT AVAILABLE. The number is the backfill's marker, so a SQL migration reusing it would be
    // treated as already applied on every install that had recorded the backfill, and would suppress
    // the backfill on every install that had not. The same is true of 8. Neither is a free slot, and
    // the timestamp convention means nothing will ever want them again.
    // PROFILES (stage 1): the visual-identity registry. CREATE only — no row is written, so an
    // installation that never opens Profiles is unchanged by it.
    //
    // NUMBERED 19 BECAUSE IT WAS ALLOCATED BEFORE THE TIMESTAMP CONVENTION, and it keeps that number
    // now that it has one: 17 and 18 belong to `feature/library-design`, and under presence-tracking
    // all three apply on their own account in whichever order the branches land. Nothing here needs
    // renumbering, and nothing here depends on 17 or 18 having run — the table it creates stands
    // alone, which is the rule every migration now has to satisfy.
    //
    // This migration is why the runner changed. It originally sat on 17, collided with the other
    // branch, and was silently never applied on any database that had seen it.
    (
        19,
        "profiles",
        include_str!("migrations_sql/0019_profiles.sql"),
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

    // PRESENCE, NOT A HIGH-WATER MARK — see the module documentation for what this replaced and why.
    // Read once: the set cannot change underneath us, since this is the only writer.
    let applied = applied_versions(conn)?;

    for (version, name, sql) in MIGRATIONS {
        if applied.contains(version) {
            continue;
        }
        // The SQL and its bookkeeping row commit together. That atomicity is what makes "absent"
        // mean "never applied", which is in turn what makes it safe to re-check every version on
        // every launch even though most migrations cannot be run twice.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES(?1, ?2, ?3)",
            rusqlite::params![version, name, now_unix()],
        )?;
        mirror_applied_count(&tx)?;
        tx.commit()?;
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
    mirror_applied_count(conn)
}

fn record_migration_8(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES(8, 'arabic_dir_backfill', ?1)",
        rusqlite::params![now_unix()],
    )?;
    mirror_applied_count(conn)
}

/// Every version already recorded. The runner's whole selection rule is "not in this set".
fn applied_versions(conn: &Connection) -> rusqlite::Result<std::collections::HashSet<i64>> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations")?;
    let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
    rows.collect()
}

/// Mirror the NUMBER of applied migrations into `PRAGMA user_version`.
///
/// Not the newest version number, which is what this used to carry: `user_version` is a 32-bit
/// signed field, and a `YYYYMMDDHHMMSS` version silently truncates to 0 in it (measured — 2^31 is
/// the wall, and SQLite reports no error). The count cannot overflow, is monotonic, and on a
/// database whose history is contiguous it equals the value the field carried before. Nothing in
/// Sard reads it; `db::schema_version()` is the accessor that answers "which migration is newest".
fn mirror_applied_count(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))?;
    conn.pragma_update(None, "user_version", count)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{Connection, LAST_SEQUENTIAL_VERSION, MIGRATIONS, TIMESTAMP_FLOOR};

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

    // ---- the numbering guards -------------------------------------------------------------------
    //
    // These exist because a migration that is never applied is INVISIBLE: a skipped migration and an
    // applied one leave the same evidence behind (nothing), so the failure surfaces later as "no such
    // table" in a feature nobody was working on. Two branches allocating in parallel is the ordinary
    // case, not the exotic one, so the rules that keep them from colliding are enforced here rather
    // than remembered. CI runs `cargo test` on every pull request into `develop`, on two platforms,
    // which is what makes these gates and not suggestions.

    /// Every version the project has SHIPPED. These have run on real databases; renumbering or
    /// removing one silently changes what an upgrade does, so the list is pinned rather than derived.
    /// Growing it is a deliberate act — appending here is how a version becomes immutable.
    const SHIPPED_VERSIONS: &[i64] = &[1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];

    /// Is `v` a plausible UTC `YYYYMMDDHHMMSS`? Field ranges only — this rejects a hand-typed number
    /// or a truncated timestamp, which is all it needs to do.
    fn is_utc_timestamp(v: i64) -> bool {
        if !(TIMESTAMP_FLOOR..=99_991_231_235_959).contains(&v) {
            return false;
        }
        let (sec, min, hour) = (v % 100, (v / 100) % 100, (v / 10_000) % 100);
        let (day, month) = ((v / 1_000_000) % 100, (v / 100_000_000) % 100);
        sec < 60 && min < 60 && hour < 24 && (1..=31).contains(&day) && (1..=12).contains(&month)
    }

    /// THE ONE THAT MATTERS. Two branches that both allocate the same number would otherwise produce
    /// a silent skip — the second migration is "already applied" and never runs. Combining them must
    /// fail the build instead, and a merge is exactly when both first exist in one tree.
    #[test]
    fn migration_versions_are_unique() {
        let mut seen = std::collections::HashMap::new();
        for (v, name, _) in MIGRATIONS {
            if let Some(prev) = seen.insert(*v, *name) {
                panic!(
                    "duplicate migration version {v}: '{prev}' and '{name}'.\n\
                     Two migrations cannot share a version — the second would be treated as already \
                     applied and would never run.\n\
                     Give the newer one a fresh UTC timestamp:  date -u +%Y%m%d%H%M%S"
                );
            }
        }
    }

    /// The list reads in the order things were written. Timestamps make this true across branches
    /// too, since a later authoring time is a larger number whoever produced it.
    #[test]
    fn migration_versions_ascend() {
        for w in MIGRATIONS.windows(2) {
            assert!(
                w[0].0 < w[1].0,
                "migrations must be listed in ascending version order, but {} ('{}') precedes {} ('{}')",
                w[0].0, w[0].1, w[1].0, w[1].1,
            );
        }
    }

    /// A shipped migration is immutable. If this fails, a version that has already run on real
    /// databases was renumbered or removed — which changes what an upgrade does, retroactively.
    #[test]
    fn shipped_versions_are_pinned() {
        let present: Vec<i64> = MIGRATIONS.iter().map(|(v, _, _)| *v).collect();
        for v in SHIPPED_VERSIONS {
            assert!(
                present.contains(v),
                "shipped migration {v} is missing from MIGRATIONS. Shipped versions are immutable: \
                 they have already run on real databases."
            );
        }
    }

    /// New migrations must be UTC timestamps. Sequential numbers are what let two branches collide,
    /// so the convention is enforced rather than documented.
    #[test]
    fn new_versions_are_utc_timestamps() {
        for (v, name, _) in MIGRATIONS {
            if *v <= LAST_SEQUENTIAL_VERSION {
                continue; // hand-numbered, from before the convention
            }
            assert!(
                is_utc_timestamp(*v),
                "migration {v} ('{name}') is not a valid UTC YYYYMMDDHHMMSS timestamp.\n\
                 Versions above {LAST_SEQUENTIAL_VERSION} must be allocated with:  date -u +%Y%m%d%H%M%S"
            );
        }
    }

    // ---- the behaviour: presence-tracking ---------------------------------------------------------

    /// A scratch database, opened the way the app opens one (so `afold` exists for migration 7).
    fn scratch(tag: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join("sard_migration_tracking");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("{tag}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = crate::db::open_database(&path).unwrap();
        (path, conn)
    }

    fn recorded(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT version FROM schema_migrations ORDER BY version").unwrap();
        let v: Vec<i64> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        v
    }

    fn schema_fingerprint(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT type||' '||name||' '||COALESCE(sql,'') FROM sqlite_master \
                      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    /// EVERY historical upgrade path. For each prefix of the real list, apply that prefix the way an
    /// older Sard would have, then run the current runner and assert it applies exactly the rest —
    /// no more (which would re-run a non-idempotent ALTER TABLE) and no less (a silent skip).
    #[test]
    fn every_historical_prefix_upgrades_to_the_full_set() {
        let all: Vec<i64> = MIGRATIONS.iter().map(|(v, _, _)| *v).collect();
        for cut in 0..MIGRATIONS.len() {
            let (path, conn) = scratch(&format!("prefix{cut}"));
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, \
                 name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
            )
            .unwrap();
            for (v, name, sql) in MIGRATIONS.iter().take(cut) {
                conn.execute_batch(sql).unwrap_or_else(|e| panic!("prefix apply v{v}: {e}"));
                conn.execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES(?1,?2,0)",
                    rusqlite::params![v, name],
                )
                .unwrap();
            }
            super::run(&conn, None).unwrap_or_else(|e| panic!("upgrade from prefix {cut}: {e}"));
            assert_eq!(recorded(&conn), all, "prefix {cut} must reach the full set exactly once");
            let ic: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
            assert_eq!(ic, "ok", "prefix {cut} left the database intact");
            drop(conn);
            let _ = std::fs::remove_file(&path);
        }
    }

    /// Running twice must be a no-op. This is the direct guard on non-idempotency: 7 of the shipped
    /// migrations use `ALTER TABLE ADD COLUMN`, which raises on a second application.
    #[test]
    fn running_twice_applies_nothing_the_second_time() {
        let (path, conn) = scratch("twice");
        super::run(&conn, None).unwrap();
        let after_first = recorded(&conn);
        let fp = schema_fingerprint(&conn);
        super::run(&conn, None).expect("a second run must not error");
        super::run(&conn, None).expect("a third run must not error");
        assert_eq!(recorded(&conn), after_first, "no migration may be recorded twice");
        assert_eq!(schema_fingerprint(&conn), fp, "the schema must not change on a repeat run");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// THE REGRESSION TEST for the defect this replaced. A migration numbered BELOW the highest
    /// already-applied version must still run. Under the old high-water rule it was skipped forever,
    /// silently, which is exactly how one branch's feature shipped with no table.
    #[test]
    fn a_migration_below_the_maximum_still_runs() {
        let (path, conn) = scratch("below");
        // One recorded version, higher than every migration we carry. Under the old high-water rule
        // `current` would be 999_999 and NOT ONE migration would run — the database would be left
        // with no tables at all, silently, exactly as the 17/18 collision left Profiles with none.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, \
             name TEXT NOT NULL, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations VALUES (999999,'from_the_future',0);",
        )
        .unwrap();

        super::run(&conn, None).unwrap();

        let after = recorded(&conn);
        for (v, name, _) in MIGRATIONS {
            assert!(
                after.contains(v),
                "migration {v} ('{name}') is below the recorded maximum and must still have run",
            );
        }
        assert!(after.contains(&999_999), "the future row must be left where it was");
        // And the schema really exists — not merely the bookkeeping.
        let books: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='books'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(books, 1, "migration 1 must have actually created its tables");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// BOTH MERGE ORDERS CONVERGE. Two independent branches, each adding a migration; whichever
    /// lands first, the database ends up with the same schema and the same recorded set.
    #[test]
    fn independent_branches_converge_in_either_order() {
        const BRANCH_A: (i64, &str, &str) =
            (20_260_101_120_000, "branch_a", "CREATE TABLE a_thing (id TEXT PRIMARY KEY);");
        const BRANCH_B: (i64, &str, &str) =
            (20_260_101_090_000, "branch_b", "CREATE TABLE b_thing (id TEXT PRIMARY KEY);");

        // `run` works from the const list, so replay its rule directly over an explicit order.
        fn apply(conn: &Connection, list: &[(i64, &str, &str)]) {
            let applied = super::applied_versions(conn).unwrap();
            for (v, name, sql) in list {
                if applied.contains(v) {
                    continue;
                }
                let tx = conn.unchecked_transaction().unwrap();
                tx.execute_batch(sql).unwrap();
                tx.execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES(?1,?2,0)",
                    rusqlite::params![v, name],
                )
                .unwrap();
                super::mirror_applied_count(&tx).unwrap();
                tx.commit().unwrap();
            }
        }

        let (pa, ca) = scratch("order-ab");
        super::run(&ca, None).unwrap();
        apply(&ca, &[BRANCH_A]); // A merges first…
        apply(&ca, &[BRANCH_B, BRANCH_A]); // …then B arrives, numbered LOWER than A

        let (pb, cb) = scratch("order-ba");
        super::run(&cb, None).unwrap();
        apply(&cb, &[BRANCH_B]); // B merges first…
        apply(&cb, &[BRANCH_B, BRANCH_A]); // …then A arrives

        assert_eq!(recorded(&ca), recorded(&cb), "both orders must record the same versions");
        assert_eq!(schema_fingerprint(&ca), schema_fingerprint(&cb), "both orders must build the same schema");
        assert!(recorded(&ca).contains(&BRANCH_A.0) && recorded(&ca).contains(&BRANCH_B.0));
        assert_eq!(user_version(&ca), user_version(&cb), "and agree on the mirrored count");
        drop(ca);
        drop(cb);
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
    }

    /// THE REAL-WORLD CROSS-BRANCH STATE. A database that has run another branch's build carries
    /// versions this list has never heard of — the live database here holds 17 and 18 from
    /// `feature/library-design`. Those rows must be left strictly alone: not re-applied, not removed,
    /// not counted as a reason to skip anything of ours.
    #[test]
    fn versions_the_list_does_not_know_are_left_alone() {
        let (path, conn) = scratch("foreign");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, \
             name TEXT NOT NULL, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations VALUES (17,'library_cases',0);
             INSERT INTO schema_migrations VALUES (18,'shelf_ink',0);",
        )
        .unwrap();

        super::run(&conn, None).unwrap();

        let after = recorded(&conn);
        assert!(after.contains(&17) && after.contains(&18), "foreign rows must survive untouched");
        for (v, _, _) in MIGRATIONS {
            assert!(after.contains(v), "our migration {v} must apply despite a higher foreign version");
        }
        // 19 is BELOW the foreign high-water mark of 18? No — but 1..15 certainly are, and under the
        // old rule every one of them would have been skipped on this database.
        assert!(after.contains(&1), "migration 1 must apply even though 18 was already recorded");
        assert_eq!(
            user_version(&conn),
            after.len() as i64,
            "the mirrored count includes the foreign rows, because they are applied migrations",
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// A database with no bookkeeping table is a fresh one: everything applies, nothing is assumed.
    #[test]
    fn a_database_without_bookkeeping_takes_every_migration() {
        let (path, conn) = scratch("legacy");
        assert_eq!(crate::db::schema_version(&conn).unwrap(), 0, "no table yet");
        super::run(&conn, None).unwrap();
        let all: Vec<i64> = MIGRATIONS.iter().map(|(v, _, _)| *v).collect();
        assert_eq!(recorded(&conn), all);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// `user_version` carries the COUNT, and `schema_version()` the highest version. The count must
    /// stay inside the 32-bit field the pragma actually is, which a timestamp version would not.
    #[test]
    fn user_version_mirrors_the_count_not_the_version() {
        let (path, conn) = scratch("mirror");
        super::run(&conn, None).unwrap();
        let versions = recorded(&conn);
        assert_eq!(
            user_version(&conn),
            versions.len() as i64,
            "user_version must be how many migrations have run",
        );
        assert_eq!(
            crate::db::schema_version(&conn).unwrap(),
            *versions.iter().max().unwrap(),
            "schema_version() must remain the highest applied version",
        );
        assert!(user_version(&conn) < i64::from(i32::MAX), "the pragma is a 32-bit field");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// A `.sql` file that nobody registered is a migration that never runs — the same silent failure
    /// from the other direction. The file set and the list must agree exactly.
    #[test]
    fn sql_files_and_the_list_agree() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/db/migrations_sql");
        let mut on_disk: Vec<i64> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read {dir}: {e}"))
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".sql"))
            .map(|n| {
                let digits: String = n.chars().take_while(char::is_ascii_digit).collect();
                digits
                    .parse::<i64>()
                    .unwrap_or_else(|_| panic!("migration file '{n}' does not begin with its version"))
            })
            .collect();
        on_disk.sort_unstable();

        let mut listed: Vec<i64> = MIGRATIONS.iter().map(|(v, _, _)| *v).collect();
        listed.sort_unstable();

        assert_eq!(
            on_disk, listed,
            "the migration files on disk and the MIGRATIONS list disagree.\n\
             A file that is not listed never runs; an entry with no file will not compile.\n\
             (Code migrations 8 and 16 have no .sql file and are deliberately absent from both.)"
        );
    }
}
