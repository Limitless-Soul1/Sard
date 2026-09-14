//! Profiles — the visual-identity registry (stage 1).
//!
//! A profile carries how Sard LOOKS: paper and colours, the interface and book faces, both
//! backgrounds and their treatment, the bookmark and read-marker, and the interface texture. It
//! does NOT carry how the reader READS — line spacing, measure, margins, paragraph spacing,
//! tracking, alignment, diacritics and zoom stay in `reading_style` and `book_style:<id>`, are
//! never written from a profile, and never travel in a shared package.
//!
//! WHAT THIS MODULE IS. Storage only: create, read, update, delete, and the two queries the
//! background collector needs. It does not apply a profile, does not resolve a theme and does not
//! know what any field inside `data` means — the frontend owns that JSON, which is what keeps
//! adding a visual field a code change rather than a migration.
//!
//! `data` IS OPAQUE HERE, AND VALIDATED THERE. Nothing in this module inspects it, so nothing here
//! can be fooled by it. When import arrives (stage 6) the validating parser is the frontend's typed
//! struct, and the columns below stay the only Rust-visible facts.

pub mod package; // PROFILES (stage 6): the shareable package — export, inspect, commit

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// One stored profile. Mirrors the `profiles` table exactly.
///
/// The three asset columns are duplicated OUT of `data` on purpose — see the migration's note: the
/// background collector must see live references without parsing frontend-owned JSON, which is what
/// makes "no orphaned images, and no image collected out from under a profile" a property of the
/// schema instead of a promise the UI has to keep.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub icon_kind: Option<String>,
    pub icon_ref: Option<String>,
    /// The profile itself, as JSON. Opaque to Rust.
    pub data: String,
    pub derived_from: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub bg_library: Option<String>,
    pub bg_reading: Option<String>,
    /// When the profile was last WORN, or `None` for one never activated since the column existed.
    ///
    /// OPTIONAL OVER THE WIRE for the same reason: a frontend that saves a profile sends the struct
    /// it was given, and nothing there has any business naming a use-stamp.
    ///
    /// READ HERE, WRITTEN ONLY BY `touch`. `save` does not carry this column — deliberately, and
    /// that is the whole safety of the field: a frontend round-trip (rename, edit, re-save) cannot
    /// clobber it with a stale value, and no caller has to remember to preserve it.
    #[serde(default)]
    pub last_used_at: Option<i64>,
}

const COLS: &str = "id, name, description, author, icon_kind, icon_ref, data, derived_from, \
                    created_at, updated_at, bg_library, bg_reading, last_used_at";

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        author: r.get(3)?,
        icon_kind: r.get(4)?,
        icon_ref: r.get(5)?,
        data: r.get(6)?,
        derived_from: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        bg_library: r.get(10)?,
        bg_reading: r.get(11)?,
        last_used_at: r.get(12)?,
    })
}

/// Every profile, MOST RECENT EVENT first — the order the Profiles area presents.
///
/// THE MODEL: a هيئة's place is decided by the last thing that HAPPENED to it, and exactly two things
/// count — it was MADE, or it was WORN. The key is the later of the two stamps, and that single idea
/// answers every case the owner set out:
///
///   · a هيئة just made leads the list, because making it is the newest event there is;
///   · the هيئة being worn when it was made falls to SECOND rather than to the bottom, because its
///     own wearing is the second-newest event;
///   · everything else keeps its relative order, because none of their stamps moved;
///   · wearing one lifts it, so a هيئة in daily use is never buried;
///   · making a second new one leads again, with the first sitting under it.
///
/// WHY NEITHER STAMP ALONE WOULD DO, both of which were tried. `last_used_at DESC` puts a هيئة that
/// has only just been made at the BOTTOM — it has never been worn — which is the opposite of what
/// making one means. `created_at DESC` fixes that and breaks the other half: the هيئة the reader was
/// actually wearing is thrown down among rows they have not touched in months, ranked only by when it
/// happened to be created. The later of the two is the one key that reads both events as what they
/// are — moments in the same life.
///
/// EDITING IS NOT USING. `save` writes `updated_at`, which this deliberately does not consult, so
/// opening an editor and closing it again moves nothing; `touch` is the only writer of `last_used_at`
/// and `applyProfile` is the only caller — wearing is a choice, editing is not.
///
/// `rowid DESC` BREAKS THE TIE, and it is needed rather than tidy: both stamps are whole seconds, so
/// two هيئات made in the same second compare equal and SQLite would be free to return them in either
/// order — including an order that changes between runs. The rowid is the insertion sequence, which
/// is creation order at a finer grain than the stamps can express.
///
/// `COALESCE` guards the unworn case: `MAX(x, NULL)` is NULL in SQL, so a هيئة nobody has ever worn
/// would sort as unknown rather than by when it was made.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Profile>> {
    let sql = format!(
        "SELECT {COLS} FROM profiles \n         ORDER BY MAX(created_at, COALESCE(last_used_at, 0)) DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_profile)?;
    rows.collect()
}

/// One profile by id, or `None` when it does not exist.
pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Profile>> {
    let sql = format!("SELECT {COLS} FROM profiles WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_profile).optional()
}

/// Insert or update.
///
/// `created_at` is preserved on update — the caller's value is used only for a genuinely new row —
/// so re-saving a profile cannot rewrite when it was made. `updated_at` is stamped here rather than
/// taken from the caller, so the list order reflects the write that actually happened.
pub fn save(conn: &Connection, p: &Profile) -> rusqlite::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO profiles(id, name, description, author, icon_kind, icon_ref, data, \
                              derived_from, created_at, updated_at, bg_library, bg_reading) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, \
           description = excluded.description, \
           author = excluded.author, \
           icon_kind = excluded.icon_kind, \
           icon_ref = excluded.icon_ref, \
           data = excluded.data, \
           derived_from = excluded.derived_from, \
           updated_at = excluded.updated_at, \
           bg_library = excluded.bg_library, \
           bg_reading = excluded.bg_reading",
        rusqlite::params![
            p.id,
            p.name,
            p.description,
            p.author,
            p.icon_kind,
            p.icon_ref,
            p.data,
            p.derived_from,
            if p.created_at > 0 { p.created_at } else { now },
            now,
            p.bg_library,
            p.bg_reading,
        ],
    )?;
    Ok(())
}

/// Stamp a profile as worn, now.
///
/// THE ONLY WRITER of `last_used_at`, and it touches nothing else — not `updated_at`, not `data`.
/// Wearing a profile is not editing it, and a reader who only ever switches between two profiles
/// must not watch their «last edited» dates crawl forward for it.
///
/// A missing id is not an error: the caller's intent ("this profile was just used") is already
/// unsatisfiable, and a profile deleted between the switch and the stamp is a race the reader should
/// never see reported.
pub fn touch(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE profiles SET last_used_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now_unix()],
    )?;
    Ok(())
}

/// Remove a profile. Deleting one that does not exist is not an error — the caller's intent
/// ("this profile should not exist") is already satisfied.
///
/// Deletes the ROW ONLY. Any background image it referenced stays on disk until the collector runs
/// and finds nothing pointing at it, which is the same lifecycle every other background follows.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM profiles WHERE id = ?1", [id])?;
    Ok(())
}

/// Every background id any profile currently references, in one query.
///
/// FOR THE BACKGROUND COLLECTOR. Profiles are a third reference source alongside the
/// `bg_library_id` / `bg_reading_id` settings keys, and the collector must be able to ask this
/// WITHOUT parsing `data` — see the migration's note. Wired into `backgrounds::gc()`: a background
/// a profile names survives collection, and is released the moment the profile stops naming it.
pub fn referenced_backgrounds(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT bg_library FROM profiles WHERE bg_library IS NOT NULL \
         UNION \
         SELECT bg_reading FROM profiles WHERE bg_reading IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Every image a profile ICON currently references — the collector's FOURTH reference source.
///
/// SEPARATE FROM `referenced_backgrounds`, and filtered on `icon_kind`, because `icon_ref` is an
/// OVERLOADED column: it carries a hex colour for a `color` icon, nothing for a `seal`, and a
/// content hash only for an `image`. Unfiltered, this would feed `#B8893C` into the keep-list —
/// meaningless today, and exactly the kind of thing that stops being harmless without anyone
/// noticing. Like its sibling it reads COLUMNS, never `data`.
pub fn referenced_icons(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT icon_ref FROM profiles WHERE icon_kind = 'image' AND icon_ref IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        conn
    }

    fn sample(id: &str) -> Profile {
        Profile {
            id: id.into(),
            name: Some("مَساء".into()),
            description: None,
            author: None,
            icon_kind: Some("seal".into()),
            icon_ref: None,
            data: r#"{"theme":{"base":"moonlit"}}"#.into(),
            derived_from: Some("moonlit".into()),
            created_at: 0,
            updated_at: 0,
            bg_library: None,
            bg_reading: None,
            last_used_at: None,
        }
    }

    #[test]
    fn migration_creates_an_empty_table() {
        // The post-migration state is an EMPTY table: the sixteen shipped themes are rendered as
        // starting profiles, not materialised, and the reader's current settings stay in `settings`
        // until they first create or edit one.
        let conn = db();
        assert_eq!(list(&conn).unwrap().len(), 0);
    }

    #[test]
    fn save_then_get_round_trips_every_column() {
        let conn = db();
        let mut p = sample("u:one");
        p.bg_library = Some("sha-lib".into());
        p.bg_reading = Some("sha-read".into());
        save(&conn, &p).unwrap();

        let got = get(&conn, "u:one").unwrap().expect("profile should exist");
        assert_eq!(got.id, "u:one");
        assert_eq!(got.name.as_deref(), Some("مَساء"));
        assert_eq!(got.icon_kind.as_deref(), Some("seal"));
        assert_eq!(got.data, r#"{"theme":{"base":"moonlit"}}"#);
        assert_eq!(got.derived_from.as_deref(), Some("moonlit"));
        assert_eq!(got.bg_library.as_deref(), Some("sha-lib"));
        assert_eq!(got.bg_reading.as_deref(), Some("sha-read"));
        assert!(got.created_at > 0, "created_at is stamped on insert");
        assert!(got.updated_at > 0, "updated_at is stamped on insert");
    }

    #[test]
    fn save_is_an_upsert_and_preserves_created_at() {
        let conn = db();
        save(&conn, &sample("u:one")).unwrap();
        let first = get(&conn, "u:one").unwrap().unwrap();

        let mut edited = sample("u:one");
        edited.name = Some("Evening".into());
        edited.created_at = first.created_at;
        save(&conn, &edited).unwrap();

        assert_eq!(list(&conn).unwrap().len(), 1, "upsert, not a second row");
        let after = get(&conn, "u:one").unwrap().unwrap();
        assert_eq!(after.name.as_deref(), Some("Evening"));
        assert_eq!(after.created_at, first.created_at, "when it was made never moves");
    }

    #[test]
    fn get_missing_is_none_and_delete_missing_is_ok() {
        let conn = db();
        assert!(get(&conn, "u:nope").unwrap().is_none());
        // Deleting something absent satisfies the caller's intent; it is not an error.
        delete(&conn, "u:nope").unwrap();
    }

    #[test]
    fn delete_removes_only_the_named_profile() {
        let conn = db();
        save(&conn, &sample("u:one")).unwrap();
        save(&conn, &sample("u:two")).unwrap();
        delete(&conn, "u:one").unwrap();

        let left = list(&conn).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "u:two");
    }

    /// Set the two time columns by hand.
    ///
    /// `now_unix` has one-second resolution, so two saves in the same test would tie and the order
    /// under test would be whatever SQLite happened to return. Writing the stamps directly is what
    /// makes these assertions about the QUERY rather than about how fast the machine is.
    fn stamp(conn: &Connection, id: &str, updated: i64, used: Option<i64>) {
        conn.execute(
            "UPDATE profiles SET updated_at = ?2, last_used_at = ?3 WHERE id = ?1",
            rusqlite::params![id, updated, used],
        )
        .unwrap();
    }

    /// Make it at a stated moment. `created_at` is whole seconds, so a sequence of creations inside
    /// one test would tie on the clock; this states the moment instead, exactly as `stamp` does for
    /// an edit. The rowid tie-break is exercised separately, on purpose.
    fn stamp_made(conn: &Connection, id: &str, made: i64) {
        conn.execute(
            "UPDATE profiles SET created_at = ?2 WHERE id = ?1",
            rusqlite::params![id, made],
        )
        .unwrap();
    }

    /// Wear it at a stated moment. `touch` uses the clock, which has one-second resolution, so a
    /// sequence of wears in one test would tie; this states the moment instead.
    fn stamp_used(conn: &Connection, id: &str, used: i64) {
        conn.execute(
            "UPDATE profiles SET last_used_at = ?2 WHERE id = ?1",
            rusqlite::params![id, used],
        )
        .unwrap();
    }

    #[test]
    fn the_newest_profile_leads_the_list() {
        // Making one is the newest event there is, so it leads — even over هيئات worn since.
        let conn = db();
        for (i, id) in ["u:first", "u:second", "u:third"].iter().enumerate() {
            save(&conn, &sample(id)).unwrap();
            stamp_made(&conn, id, 100 + i as i64);
        }
        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["u:third", "u:second", "u:first"]);
    }

    #[test]
    fn making_one_does_not_throw_the_worn_profile_to_the_bottom() {
        // THE CASE THAT DECIDED THE MODEL. A is worn; B, C, D are old. Making E must put E first and
        // A SECOND — not bury A among rows the reader has not touched in months, which is what
        // ordering by creation alone did.
        let conn = db();
        for (i, id) in ["u:d", "u:c", "u:b", "u:a"].iter().enumerate() {
            save(&conn, &sample(id)).unwrap();
            stamp_made(&conn, id, 100 + i as i64);
        }
        stamp_used(&conn, "u:a", 500); // A is the one being worn
        save(&conn, &sample("u:e")).unwrap();
        stamp_made(&conn, "u:e", 900);

        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["u:e", "u:a", "u:b", "u:c", "u:d"]);
    }

    #[test]
    fn wearing_one_lifts_it_so_a_daily_profile_is_never_buried() {
        // The other half: use is an event too, so the هيئة in hand rises.
        let conn = db();
        for (i, id) in ["u:old", "u:mid", "u:new"].iter().enumerate() {
            save(&conn, &sample(id)).unwrap();
            stamp_made(&conn, id, 100 + i as i64);
        }
        assert_eq!(
            list(&conn).unwrap().into_iter().map(|p| p.id).collect::<Vec<_>>(),
            ["u:new", "u:mid", "u:old"]
        );
        stamp_used(&conn, "u:old", 900);
        assert_eq!(
            list(&conn).unwrap().into_iter().map(|p| p.id).collect::<Vec<_>>(),
            ["u:old", "u:new", "u:mid"]
        );
    }

    #[test]
    fn editing_a_profile_does_not_move_it() {
        // `save` carries `created_at` through and writes only `updated_at`, which the order does not
        // consult — so opening an editor and closing it again moves nothing.
        let conn = db();
        save(&conn, &sample("u:old")).unwrap();
        stamp_made(&conn, "u:old", 100);
        save(&conn, &sample("u:new")).unwrap();
        stamp_made(&conn, "u:new", 200);

        let mut edited = get(&conn, "u:old").unwrap().unwrap();
        edited.name = Some("Evening".into());
        edited.updated_at = 9_999_999; // edited far more recently than the other was made
        save(&conn, &edited).unwrap();

        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["u:new", "u:old"], "an edit must not lift a هيئة");
        assert_eq!(
            get(&conn, "u:old").unwrap().unwrap().created_at,
            100,
            "and it must not rewrite when the هيئة was made"
        );
    }

    #[test]
    fn an_unworn_profile_still_sorts_by_when_it_was_made() {
        // `MAX(x, NULL)` is NULL in SQL, so without the COALESCE a هيئة nobody has ever worn would
        // sort as unknown instead of by its own creation — the whole leading case, silently lost.
        let conn = db();
        save(&conn, &sample("u:worn")).unwrap();
        stamp_made(&conn, "u:worn", 100);
        stamp_used(&conn, "u:worn", 150);
        save(&conn, &sample("u:never")).unwrap();
        stamp_made(&conn, "u:never", 200); // made after the other was last worn, never worn itself

        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["u:never", "u:worn"]);
    }

    #[test]
    fn two_profiles_made_in_the_same_second_keep_their_true_order() {
        // Both stamps are whole seconds, so a reader who makes two هيئات quickly produces a tie —
        // and a tie SQLite is free to resolve either way is an order that can change between runs.
        let conn = db();
        for id in ["u:a", "u:b", "u:c"] {
            save(&conn, &sample(id)).unwrap();
            stamp_made(&conn, id, 500); // all three in the same second
        }
        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["u:c", "u:b", "u:a"]);
    }

    #[test]
    fn the_sequence_the_owner_specified() {
        // A worn, with B, C, D behind it. Then: make E · wear B · wear A again · make F. Each step is
        // the sequence the owner wrote out, with the expected list beside it.
        let conn = db();
        for (i, id) in ["u:d", "u:c", "u:b", "u:a"].iter().enumerate() {
            save(&conn, &sample(id)).unwrap();
            stamp_made(&conn, id, 100 + i as i64);
        }
        stamp_used(&conn, "u:a", 500);
        let ids = |c: &Connection| -> Vec<String> {
            list(c).unwrap().into_iter().map(|p| p.id).collect()
        };
        assert_eq!(ids(&conn), ["u:a", "u:b", "u:c", "u:d"], "1-2 · A in use, the rest behind it");

        save(&conn, &sample("u:e")).unwrap();
        stamp_made(&conn, "u:e", 600);
        assert_eq!(ids(&conn), ["u:e", "u:a", "u:b", "u:c", "u:d"], "3-4 · E leads, A keeps second");

        stamp_used(&conn, "u:b", 700);
        assert_eq!(ids(&conn), ["u:b", "u:e", "u:a", "u:c", "u:d"], "5-6 · B was just worn");

        stamp_used(&conn, "u:a", 800);
        assert_eq!(ids(&conn), ["u:a", "u:b", "u:e", "u:c", "u:d"], "7 · back to A");

        save(&conn, &sample("u:f")).unwrap();
        stamp_made(&conn, "u:f", 900);
        assert_eq!(
            ids(&conn),
            ["u:f", "u:a", "u:b", "u:e", "u:c", "u:d"],
            "8-9 · F leads and everything beneath it keeps the order it had"
        );

        // 10 · nothing here is derived at read time, so a restart reads the same rows and sorts them
        // the same way. Re-listing from a fresh statement is that guarantee at this layer.
        assert_eq!(ids(&conn), ids(&conn));
    }

    #[test]
    fn touching_a_profile_that_is_gone_is_not_an_error() {
        // The switch and the stamp are two statements; a profile deleted between them is a race the
        // reader should never see reported.
        let conn = db();
        touch(&conn, "u:nope").unwrap();
        assert!(get(&conn, "u:nope").unwrap().is_none());
    }

    #[test]
    fn deleting_a_worn_profile_leaves_the_rest_in_use_order() {
        let conn = db();
        for id in ["u:a", "u:b", "u:c"] {
            save(&conn, &sample(id)).unwrap();
        }
        stamp(&conn, "u:a", 30, Some(300));
        stamp(&conn, "u:b", 20, Some(100));
        stamp(&conn, "u:c", 10, Some(200));
        delete(&conn, "u:a").unwrap();

        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["u:c", "u:b"]);
    }

    #[test]
    fn referenced_backgrounds_reports_both_surfaces_without_duplicates() {
        let conn = db();
        let mut a = sample("u:one");
        a.bg_library = Some("sha-shared".into());
        a.bg_reading = Some("sha-shared".into()); // the same image on both surfaces
        save(&conn, &a).unwrap();

        let mut b = sample("u:two");
        b.bg_library = Some("sha-other".into());
        save(&conn, &b).unwrap();

        let mut refs = referenced_backgrounds(&conn).unwrap();
        refs.sort();
        assert_eq!(refs, vec!["sha-other".to_string(), "sha-shared".to_string()]);
    }

    #[test]
    fn a_profile_that_references_nothing_contributes_nothing() {
        let conn = db();
        save(&conn, &sample("u:one")).unwrap(); // both bg columns NULL
        assert!(referenced_backgrounds(&conn).unwrap().is_empty());
    }
}
