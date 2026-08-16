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
}

const COLS: &str = "id, name, description, author, icon_kind, icon_ref, data, derived_from, \
                    created_at, updated_at, bg_library, bg_reading";

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
    })
}

/// Every profile, most-recently-edited first — the order the Profiles area presents.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Profile>> {
    let sql = format!("SELECT {COLS} FROM profiles ORDER BY updated_at DESC");
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
