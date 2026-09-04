//! THE IMPORT'S PROMISES, ASSERTED.
//!
//! Every test here exists because the promise it checks is one a reader cannot verify for themselves:
//! that accepting a stranger's deposit cannot quietly rewrite a note they wrote, a gloss they chose, or
//! a substitution they turned off.

use rusqlite::Connection;

use super::apply::{Acceptance, ConflictChoice};
use super::{apply, package};

const BOOK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CFI: &str = "epubcfi(/6/14!/4/2,/1:0,/1:9)";

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, added_at) VALUES(?1, 'x.epub', 'epub', 'T', 0)",
        [BOOK],
    )
    .unwrap();
    conn
}

fn manifest(marks: &str) -> String {
    format!(
        r#"{{"deposit":1,"created_at":1,"app":{{"name":"Sard","version":"1"}},
            "sender":{{"name":"S"}},
            "book":{{"hash":"{BOOK}","format":"epub","title":"T","spine_count":20}},
            "inscription":{{"text":"hello","signed":"S"}},
            "marks":{marks}}}"#
    )
}

const ONE_OF_EACH: &str = r#"{
  "highlights":[{"cfi":"epubcfi(/6/14!/4/2,/1:0,/1:9)","section":"/6/14","section_index":6,
                 "color":"sky","text":"theirs","chapter_label":"II","created_at":5}],
  "notes":[{"cfi":"epubcfi(/6/14!/4/2)","section":"/6/14","section_index":6,"title":"T",
            "body":"their note","color":null,"chapter_label":"II","created_at":6,"of_highlight":null}],
  "references":[{"phrase":"klein","phrase_fold":"klein","word_count":1,"note":"their gloss"}],
  "replacements":[{"phrase":"morton","phrase_fold":"morton","word_count":1,"replacement":"mortin"}]
}"#;

fn all() -> Acceptance {
    Acceptance {
        highlights: vec![0],
        notes: vec![0],
        references: vec![ConflictChoice { index: 0, take_theirs: false }],
        replacements: vec![ConflictChoice { index: 0, take_theirs: false }],
    }
}

fn commit(conn: &mut Connection, json: &str, accept: &Acceptance) -> apply::Outcome {
    apply::commit(conn, std::path::Path::new("."), json, "", accept, None).unwrap()
}

#[test]
fn a_deposit_applies_what_was_kept_and_records_where_it_came_from() {
    let mut conn = db();
    let out = commit(&mut conn, &manifest(ONE_OF_EACH), &all());
    assert_eq!(out.applied.highlights, 1);
    assert_eq!(out.applied.notes, 1);
    assert_eq!(out.applied.references, 1);
    assert_eq!(out.applied.replacements, 1);
    assert!(out.same_book, "the receiver already holds this exact file");
    let origins: i64 = conn
        .query_row("SELECT COUNT(*) FROM mark_origin WHERE deposit_id = ?1", [&out.deposit_id], |r| r.get(0))
        .unwrap();
    assert_eq!(origins, 4, "every accepted mark is attributed");
}

#[test]
fn an_identical_highlight_is_skipped_and_never_updated() {
    let mut conn = db();
    // the receiver's own mark, on the same range, in their own colour
    let id = crate::library::gen_id(&format!("hl:{BOOK}:{CFI}"));
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, color, text_excerpt, created_at) \
         VALUES(?1,?2,?3,'amber','mine',1)",
        rusqlite::params![id, BOOK, CFI],
    )
    .unwrap();

    let out = commit(&mut conn, &manifest(ONE_OF_EACH), &all());
    assert_eq!(out.skipped_existing.highlights, 1);
    assert_eq!(out.applied.highlights, 0);

    let (color, text): (String, String) = conn
        .query_row("SELECT color, text_excerpt FROM highlights WHERE id = ?1", [&id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(color, "amber", "the receiver's colour was rewritten");
    assert_eq!(text, "mine", "the receiver's excerpt was rewritten");
}

#[test]
fn an_arriving_note_can_never_land_on_the_receivers_own_note() {
    let mut conn = db();
    // The receiver's note, written with the LOCAL seed — the exact id `note_create` would upsert onto.
    let anchor = "epubcfi(/6/14!/4/2)";
    let mine = crate::library::gen_id(&format!("note:{BOOK}:{anchor}"));
    conn.execute(
        "INSERT INTO notes(id, book_id, locator_cfi, body, title, created_at, updated_at) \
         VALUES(?1,?2,?3,'my thought','my title',1,1)",
        rusqlite::params![mine, BOOK, anchor],
    )
    .unwrap();

    let out = commit(&mut conn, &manifest(ONE_OF_EACH), &all());
    assert_eq!(out.applied.notes, 1);

    let (body, title): (String, String) = conn
        .query_row("SELECT body, title FROM notes WHERE id = ?1", [&mine], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(body, "my thought", "the receiver's note was overwritten");
    assert_eq!(title, "my title");

    let n: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2, "the arriving note is a SECOND note, beside the receiver's");
}

#[test]
fn a_reference_the_receiver_already_glosses_is_left_alone_unless_they_say_otherwise() {
    let mut conn = db();
    let id = crate::library::gen_id(&format!("ref:{BOOK}:klein"));
    conn.execute(
        "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at) \
         VALUES(?1,?2,'klein','klein',1,'my gloss',1,1)",
        rusqlite::params![id, BOOK],
    )
    .unwrap();

    // keep mine
    let out = commit(&mut conn, &manifest(ONE_OF_EACH), &all());
    assert_eq!(out.kept_mine.references, 1);
    assert_eq!(out.applied.references, 0);
    let note: String = conn.query_row("SELECT note FROM refs WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(note, "my gloss");

    // take theirs — an explicit, chosen replacement of that one column
    let mut conn2 = db();
    conn2
        .execute(
            "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at) \
             VALUES(?1,?2,'klein','klein',1,'my gloss',1,1)",
            rusqlite::params![id, BOOK],
        )
        .unwrap();
    let taking = Acceptance {
        references: vec![ConflictChoice { index: 0, take_theirs: true }],
        ..Acceptance::default()
    };
    let out2 = commit(&mut conn2, &manifest(ONE_OF_EACH), &taking);
    assert_eq!(out2.applied.references, 1);
    let note2: String = conn2.query_row("SELECT note FROM refs WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(note2, "their gloss");
}

#[test]
fn an_imported_replacement_arrives_switched_off() {
    let mut conn = db();
    commit(&mut conn, &manifest(ONE_OF_EACH), &all());
    let enabled: i64 = conn
        .query_row("SELECT enabled FROM reps WHERE book_id = ?1", [BOOK], |r| r.get(0))
        .unwrap();
    assert_eq!(enabled, 0, "a stranger's substitution must not silently rewrite the page");
}

#[test]
fn a_replacement_the_receiver_already_has_is_not_re_enabled_when_taken() {
    let mut conn = db();
    let id = crate::library::gen_id(&format!("rep:{BOOK}:morton"));
    conn.execute(
        "INSERT INTO reps(id, book_id, phrase, phrase_fold, replacement, word_count, enabled, created_at, updated_at) \
         VALUES(?1,?2,'morton','morton','mine',1,0,1,1)",
        rusqlite::params![id, BOOK],
    )
    .unwrap();
    let taking = Acceptance {
        replacements: vec![ConflictChoice { index: 0, take_theirs: true }],
        ..Acceptance::default()
    };
    commit(&mut conn, &manifest(ONE_OF_EACH), &taking);
    let (r, enabled): (String, i64) = conn
        .query_row("SELECT replacement, enabled FROM reps WHERE id = ?1", [&id], |x| Ok((x.get(0)?, x.get(1)?)))
        .unwrap();
    assert_eq!(r, "mortin");
    assert_eq!(enabled, 0, "taking theirs must not switch a substitution on");
}

#[test]
fn the_same_deposit_twice_changes_nothing_the_second_time() {
    let mut conn = db();
    let json = manifest(ONE_OF_EACH);
    let first = commit(&mut conn, &json, &all());
    assert!(!first.already_received);
    let counts = |c: &Connection| -> (i64, i64, i64, i64) {
        (
            c.query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0)).unwrap(),
            c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap(),
            c.query_row("SELECT COUNT(*) FROM refs", [], |r| r.get(0)).unwrap(),
            c.query_row("SELECT COUNT(*) FROM reps", [], |r| r.get(0)).unwrap(),
        )
    };
    let before = counts(&conn);
    let second = commit(&mut conn, &json, &all());
    assert!(second.already_received);
    assert_eq!(counts(&conn), before, "a re-import wrote something");
}

#[test]
fn a_sectionless_mark_is_carried_and_counted_rather_than_dropped() {
    let mut conn = db();
    let marks = r#"{"highlights":[{"cfi":"epubcfi(/6/8)","section":"/6/8","section_index":null,
                     "color":"amber","text":"loose","chapter_label":null,"created_at":1}],
                    "notes":[],"references":[],"replacements":[]}"#;
    let out = commit(&mut conn, &manifest(marks), &Acceptance { highlights: vec![0], ..Acceptance::default() });
    assert_eq!(out.applied.highlights, 1);
    assert_eq!(out.unplaced.highlights, 1, "a mark with no place is reported as such");
    let cfi: String = conn
        .query_row("SELECT start_cfi FROM highlights", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cfi, "epubcfi(/6/8)", "the cfi is stored verbatim, whatever shape it has");
}

#[test]
fn a_deposit_for_a_book_the_receiver_does_not_have_writes_no_marks() {
    let mut conn = db();
    let other = format!("{}", "b".repeat(64));
    let json = manifest(ONE_OF_EACH).replace(BOOK, &other);
    let out = commit(&mut conn, &json, &all());
    assert!(out.book_id.is_none());
    assert_eq!(out.applied.highlights, 0);
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    // the deposit itself is still recorded, so the same file cannot be applied twice by accident
    let d: i64 = conn.query_row("SELECT COUNT(*) FROM deposits", [], |r| r.get(0)).unwrap();
    assert_eq!(d, 1);
}

#[test]
fn nothing_is_written_when_the_manifest_is_refused() {
    let mut conn = db();
    let cases = [
        (r#"{"deposit":99,"book":{"hash":"aa"}}"#, "dep.err.newer"),
        (r#"{"nope":1}"#, "dep.err.notSard"),
        ("not json at all", "dep.err.unreadable"),
        (r#"{"deposit":1,"book":{"hash":"short"}}"#, "dep.err.badBook"),
        (
            r#"{"deposit":1,"book":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","file":"book/../escape.epub"}}"#,
            "dep.err.badMember",
        ),
    ];
    for (json, code) in cases {
        let err = apply::commit(&mut conn, std::path::Path::new("."), json, "", &all(), None).unwrap_err();
        assert_eq!(err, code, "wrong refusal for {json}");
    }
    let d: i64 = conn.query_row("SELECT COUNT(*) FROM deposits", [], |r| r.get(0)).unwrap();
    assert_eq!(d, 0, "a refused deposit left a row behind");
}

#[test]
fn a_failure_part_way_through_leaves_nothing_behind() {
    // A failure is forced AFTER the deposit row and the first marks are written: attribution has
    // nowhere to go, so the statement fails mid-transaction. Nothing may survive it — not the deposit
    // row, not the highlight that had already been inserted moments earlier.
    //
    // (An absent book is NOT such a failure: `deposits.book_id` is nullable by design, so a deposit for
    // a book the reader does not own is recorded and simply applies no marks.)
    let mut conn = db();
    conn.execute("DROP TABLE mark_origin", []).unwrap();
    let err = apply::commit(&mut conn, std::path::Path::new("."), &manifest(ONE_OF_EACH), "", &all(), None);
    assert!(err.is_err(), "the commit should have failed on the foreign key");
    let d: i64 = conn.query_row("SELECT COUNT(*) FROM deposits", [], |r| r.get(0)).unwrap();
    let h: i64 = conn.query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0)).unwrap();
    assert_eq!((d, h), (0, 0), "a partial import survived a failure");
}

#[test]
fn reading_progress_and_bookmarks_are_never_touched() {
    let mut conn = db();
    conn.execute(
        "INSERT INTO reading_progress(book_id, locator_cfi, fraction, updated_at) VALUES(?1,'mine',0.5,1)",
        [BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO bookmarks(id, book_id, locator_cfi, created_at) VALUES('bm1',?1,'mine',1)",
        [BOOK],
    )
    .unwrap();
    // a manifest that TRIES to carry them — the importer reads neither key
    let marks = r#"{"highlights":[],"notes":[],"references":[],"replacements":[],
                    "progress":{"locator_cfi":"theirs","fraction":0.9},
                    "bookmarks":[{"cfi":"theirs"}]}"#;
    commit(&mut conn, &manifest(marks), &Acceptance::default());
    let p: String = conn.query_row("SELECT locator_cfi FROM reading_progress", [], |r| r.get(0)).unwrap();
    let b: i64 = conn.query_row("SELECT COUNT(*) FROM bookmarks", [], |r| r.get(0)).unwrap();
    assert_eq!(p, "mine");
    assert_eq!(b, 1, "a bookmark arrived from a deposit");
}

#[test]
fn tags_never_arrive_as_tags() {
    let mut conn = db();
    let marks = r#"{"highlights":[],"notes":[{"cfi":"epubcfi(/6/2)","section_index":1,"body":"n",
                    "tags":["theirs"],"of_highlight":null}],"references":[],"replacements":[]}"#;
    commit(&mut conn, &manifest(marks), &Acceptance { notes: vec![0], ..Acceptance::default() });
    let t: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
    let nt: i64 = conn.query_row("SELECT COUNT(*) FROM note_tags", [], |r| r.get(0)).unwrap();
    assert_eq!((t, nt), (0, 0), "a deposit edited the reader's shared tag vocabulary");
}

#[test]
fn the_deposit_id_is_the_manifest_own_hash() {
    let a = package::deposit_id("{\"deposit\":1}");
    let b = package::deposit_id("{\"deposit\":1}");
    let c = package::deposit_id("{\"deposit\":1} ");
    assert_eq!(a, b);
    assert_ne!(a, c, "a different file is a different deposit");
    assert_eq!(a.len(), 64);
}
