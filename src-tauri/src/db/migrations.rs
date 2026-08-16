//! Versioned, ordered migration runner (RAWY-08).
//!
//! Deterministic and idempotent: the highest applied version is recorded in a
//! `schema_migrations` table (and mirrored to `PRAGMA user_version`). On each launch we
//! apply only migrations whose version is greater than the current one, each in its own
//! transaction. Never edit an already-shipped migration — append a new one instead.

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
    // and NOT AVAILABLE. The runner's high-water mark is MAX(version), so a SQL migration numbered
    // 16 would be skipped forever on every install that had already recorded the backfill, and
    // would suppress the backfill on every install that had not.
    // PROFILES (stage 1): the visual-identity registry. CREATE only — no row is written, so an
    // installation that never opens Profiles is unchanged by it.
    //
    // NUMBERED 19, NOT 17, AND THE GAP IS DELIBERATE. The runner's high-water mark is MAX(version),
    // so a version that another in-flight branch has already recorded is skipped forever — silently,
    // because a skipped migration is indistinguishable from an applied one. `feature/library-design`
    // occupies 17 (`0017_library_cases.sql`) and 18 (`0018_shelf_ink.sql`); this migration sat on 17
    // and was therefore never applied on any database that had seen that branch, leaving every
    // Profiles command failing with "no such table: profiles". Measured on a live database at
    // user_version 18.
    //
    // 19 ASSUMES `feature/library-design` LANDS FIRST, and the assumption is load-bearing in BOTH
    // directions. Read this before merging either branch:
    //
    //   · library-design first, then Profiles — correct, and the order this number is chosen for.
    //     A database at 16 takes 17 and 18, then 19 here. Nothing is skipped.
    //
    //   · Profiles first, then library-design — BREAKS THE OTHER BRANCH, and does so silently. A
    //     database at 16 would take 19 and record it; 17 and 18 are then below the high-water mark
    //     forever, so `library_cases` and `shelf_ink` never run and that feature fails the same way
    //     this one did. The damage lands on the branch that merges second, which is the branch
    //     nobody is looking at while merging the first.
    //
    // Whichever merges second is the one that renumbers, and it must renumber ABOVE the highest
    // version the other branch actually shipped — not merely to the next free-looking slot. Numbering
    // cannot make both orders safe on its own: the runner takes MAX(version) once and compares every
    // migration against it, so a lower number is never revisited. The only change that would remove
    // this constraint entirely is per-version tracking in the runner (apply when a version is absent
    // from `schema_migrations` rather than when it exceeds the maximum), which is a change to shared
    // machinery that every shipped install would feel, and is not made here.
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
    use super::{LAST_SEQUENTIAL_VERSION, MIGRATIONS, TIMESTAMP_FLOOR};

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
