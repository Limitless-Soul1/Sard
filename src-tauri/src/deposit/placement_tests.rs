//! THE PLACEMENT GATE, ASSERTED.
//!
//! Placement is the only part of this feature that writes to a mark AFTER it has been imported, so it
//! is the only place a bug could reach the reader's own annotations. Every test here exists to prove it
//! cannot: a row without a `mark_origin` record is unreachable, a terminal verdict is final, and a
//! `placed` verdict is the only one that writes a cfi.

use rusqlite::Connection;

use super::placement::{self, Verdict};

const BOOK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEPOSIT: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, added_at) VALUES(?1,'x.epub','epub','T',0)",
        [BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deposits(id, book_id, sender, created_at, received_at) VALUES(?1,?2,'S',1,1)",
        rusqlite::params![DEPOSIT, BOOK],
    )
    .unwrap();
    conn
}

/// A highlight the DEPOSIT brought: it has an origin row, so placement may touch it.
fn imported(conn: &Connection, id: &str, cfi: &str, state: &str) {
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, color, text_excerpt, created_at) \
         VALUES(?1,?2,?3,'amber','theirs',1)",
        rusqlite::params![id, BOOK, cfi],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO mark_origin(kind, mark_id, deposit_id, state) VALUES('highlight',?1,?2,?3)",
        rusqlite::params![id, DEPOSIT, state],
    )
    .unwrap();
}

/// A highlight the READER made: no origin row, and therefore invisible to placement.
fn own(conn: &Connection, id: &str, cfi: &str) {
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, color, text_excerpt, created_at) \
         VALUES(?1,?2,?3,'sky','mine',1)",
        rusqlite::params![id, BOOK, cfi],
    )
    .unwrap();
}

fn cfi_of(conn: &Connection, id: &str) -> String {
    conn.query_row("SELECT start_cfi FROM highlights WHERE id = ?1", [id], |r| r.get(0)).unwrap()
}
fn state_of(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT state FROM mark_origin WHERE mark_id = ?1", [id], |r| r.get(0)).unwrap()
}

#[test]
fn only_what_is_still_unplaced_is_offered_to_the_reader() {
    let conn = db();
    imported(&conn, "h-pending", "epubcfi(/6/4)", "pending");
    imported(&conn, "h-located", "epubcfi(/6/6)", "located");
    imported(&conn, "h-placed", "epubcfi(/6/8)", "placed");
    imported(&conn, "h-absent", "epubcfi(/6/10)", "absent");
    own(&conn, "h-mine", "epubcfi(/6/12)");

    let pending = placement::pending(&conn, BOOK).unwrap();
    let ids: Vec<String> = pending.iter().map(|p| p.id.clone()).collect();
    assert!(ids.contains(&"h-pending".to_string()));
    assert!(ids.contains(&"h-located".to_string()));
    assert!(!ids.contains(&"h-placed".to_string()), "a terminal verdict was offered again");
    assert!(!ids.contains(&"h-absent".to_string()), "a terminal verdict was offered again");
    assert!(!ids.contains(&"h-mine".to_string()), "the reader's own mark was offered for placement");
    assert_eq!(pending.len(), 2);
}

#[test]
fn a_mark_the_reader_made_cannot_be_written_by_any_verdict() {
    // The frontend is Sard's own, and this is exactly the assumption a boundary must not rest on.
    let mut conn = db();
    own(&conn, "h-mine", "epubcfi(/6/12)");
    let n = placement::record(
        &mut conn,
        &[Verdict {
            kind: "highlight".into(),
            id: "h-mine".into(),
            state: "placed".into(),
            target_section: Some(3),
            cfi: Some("epubcfi(/6/99!/4,/1:0,/1:9)".into()),
        }],
    )
    .unwrap();
    assert_eq!(n, 0, "a verdict was accepted for a mark with no origin");
    assert_eq!(cfi_of(&conn, "h-mine"), "epubcfi(/6/12)", "the reader's own cfi was rewritten");
}

#[test]
fn a_terminal_verdict_is_never_revisited() {
    let mut conn = db();
    imported(&conn, "h1", "epubcfi(/6/4)", "absent");
    let n = placement::record(
        &mut conn,
        &[Verdict { kind: "highlight".into(), id: "h1".into(), state: "placed".into(), target_section: None, cfi: Some("epubcfi(/6/9!/4,/1:0,/1:2)".into()) }],
    )
    .unwrap();
    assert_eq!(n, 0);
    assert_eq!(cfi_of(&conn, "h1"), "epubcfi(/6/4)");
    assert_eq!(state_of(&conn, "h1").as_deref(), Some("absent"));
}

#[test]
fn placing_writes_the_cfi_and_the_state_together() {
    let mut conn = db();
    imported(&conn, "h1", "epubcfi(/6/4)", "located");
    let placed = "epubcfi(/6/14!/4/2,/1:0,/1:9)";
    let n = placement::record(
        &mut conn,
        &[Verdict { kind: "highlight".into(), id: "h1".into(), state: "placed".into(), target_section: Some(6), cfi: Some(placed.into()) }],
    )
    .unwrap();
    assert_eq!(n, 1);
    assert_eq!(cfi_of(&conn, "h1"), placed);
    assert_eq!(state_of(&conn, "h1").as_deref(), Some("placed"));
}

#[test]
fn every_refusal_leaves_the_cfi_exactly_as_it_arrived() {
    // `already_yours`, `ambiguous`, `absent`, `unanchorable` all record a verdict and nothing else:
    // the sender's cfi is preserved, which is what keeps the mark honest in the archive.
    for state in ["already_yours", "ambiguous", "absent", "unanchorable", "located"] {
        let mut conn = db();
        imported(&conn, "h1", "epubcfi(/6/4)", "pending");
        placement::record(
            &mut conn,
            &[Verdict {
                kind: "highlight".into(),
                id: "h1".into(),
                state: state.into(),
                target_section: Some(2),
                // even if a cfi is offered, a non-`placed` verdict must not write it
                cfi: Some("epubcfi(/6/77!/4,/1:0,/1:9)".into()),
            }],
        )
        .unwrap();
        assert_eq!(cfi_of(&conn, "h1"), "epubcfi(/6/4)", "{state} wrote a cfi");
        assert_eq!(state_of(&conn, "h1").as_deref(), Some(state));
    }
}

#[test]
fn a_placed_verdict_with_no_cfi_is_refused_rather_than_writing_an_empty_anchor() {
    let mut conn = db();
    imported(&conn, "h1", "epubcfi(/6/4)", "located");
    for bad in [None, Some(String::new()), Some("   ".to_string())] {
        placement::record(
            &mut conn,
            &[Verdict { kind: "highlight".into(), id: "h1".into(), state: "placed".into(), target_section: None, cfi: bad }],
        )
        .unwrap();
        assert_eq!(cfi_of(&conn, "h1"), "epubcfi(/6/4)");
    }
}

#[test]
fn a_note_is_offered_without_a_needle_and_carries_its_highlight() {
    let conn = db();
    imported(&conn, "h1", "epubcfi(/6/4)", "pending");
    conn.execute(
        "INSERT INTO notes(id, book_id, highlight_id, locator_cfi, body, created_at, updated_at) \
         VALUES('n1',?1,'h1','epubcfi(/6/4)','their thought',1,1)",
        [BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO mark_origin(kind, mark_id, deposit_id, state) VALUES('note','n1',?1,'pending')",
        [DEPOSIT],
    )
    .unwrap();

    let pending = placement::pending(&conn, BOOK).unwrap();
    let note = pending.iter().find(|p| p.kind == "note").unwrap();
    assert!(note.excerpt.is_none(), "a note was handed a needle to search for");
    assert_eq!(note.of_highlight.as_deref(), Some("h1"));
}

#[test]
fn a_verdict_for_a_layer_that_has_no_position_is_ignored() {
    // References and replacements key on a folded phrase and are matched at render time; they have no
    // placement life, and a verdict naming one must do nothing at all.
    let mut conn = db();
    conn.execute(
        "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at) \
         VALUES('r1',?1,'k','k',1,'g',1,1)",
        [BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO mark_origin(kind, mark_id, deposit_id, state) VALUES('ref','r1',?1,'placed')",
        [DEPOSIT],
    )
    .unwrap();
    let n = placement::record(
        &mut conn,
        &[Verdict { kind: "ref".into(), id: "r1".into(), state: "absent".into(), target_section: None, cfi: None }],
    )
    .unwrap();
    assert_eq!(n, 0);
    assert_eq!(state_of(&conn, "r1").as_deref(), Some("placed"));
}
