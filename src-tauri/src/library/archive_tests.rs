//! THE ARCHIVE SHOWS WHAT BELONGS TO A BOOK, AND A BRIDGE ROW IS NOT A BOOK.
//!
//! `books` holds two different things (see `books::IS_A_BOOK`): a BOOK the reader added, which always
//! carries a format and a title, and a BRIDGE — scaffolding written by `books::ensure` so reading
//! state has a parent, for a file that was opened but never imported. A bridge carries neither.
//!
//! THE DEFECT THESE HOLD SHUT. The four archive queries that gather marks across the whole library
//! join `books` and resolve a name with `COALESCE(override, b.title)`. Neither is a book-ness test,
//! and for a bridge both sides of that COALESCE are NULL — so the archive emitted a record with a
//! null title: a card claiming to belong to a book, naming none, for a book the library does not
//! show and the reader never added.
//!
//! WHAT IS DELIBERATELY NOT CHANGED. The per-book queries (`WHERE book_id = ?1`) are the reader's own
//! view of the file in front of them, and they must keep working for a bridge — that is what the
//! bridge exists for. Nothing here deletes a mark either: a mark made against a bridge is still the
//! reader's, still on disk, and reappears in the archive the moment the file is imported and the row
//! becomes a book. The fix withholds a false claim; it does not destroy anything.

use rusqlite::Connection;

use super::{annotations_all, bookmarks_all, refs_reps_books};

const BOOK: &str = "real";
const BRIDGE: &str = "bridge";

/// A database holding one real book and one bridge row, each carrying all four kinds of mark.
fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();

    // A book the reader added: a format and a title, as every import writes.
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, author, added_at) \
         VALUES(?1, 'real.epub', 'epub', 'A Real Book', 'An Author', 1)",
        [BOOK],
    )
    .unwrap();
    // Scaffolding: an id, a path, a timestamp, and nothing else — exactly what `ensure` writes.
    conn.execute(
        "INSERT INTO books(id, file_path, added_at) VALUES(?1, 'bridge.epub', 1)",
        [BRIDGE],
    )
    .unwrap();

    for id in [BOOK, BRIDGE] {
        conn.execute(
            "INSERT INTO bookmarks(id, book_id, locator_cfi, label, created_at) \
             VALUES(?1 || '-bm', ?1, 'cfi', 'a place', 1)",
            [id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO highlights(id, book_id, start_cfi, end_cfi, color, text_excerpt, created_at) \
             VALUES(?1 || '-hl', ?1, 's', 'e', 'amber', 'a passage', 1)",
            [id],
        )
        .unwrap();
        // A standalone note: the archive's note arm is the one that takes `highlight_id IS NULL`.
        conn.execute(
            "INSERT INTO notes(id, book_id, locator_cfi, body, created_at, updated_at) \
             VALUES(?1 || '-nt', ?1, 'cfi', 'a note', 1, 1)",
            [id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at) \
             VALUES(?1 || '-rf', ?1, 'a phrase', 'a phrase', 2, 'a gloss', 1, 1)",
            [id],
        )
        .unwrap();
    }
    conn
}

// ── THE READER'S OWN MARKS, ON A REAL BOOK, ARE UNTOUCHED ────────────────────────────────────────

#[test]
fn a_real_book_keeps_its_bookmark_in_the_archive() {
    let conn = db();
    let all = bookmarks_all(&conn).unwrap();
    let mine: Vec<_> = all.iter().filter(|b| b.book_id == BOOK).collect();
    assert_eq!(mine.len(), 1, "the reader's bookmark is still listed");
    assert_eq!(mine[0].book_title.as_deref(), Some("A Real Book"), "under its book's name");
}

#[test]
fn a_real_book_keeps_its_highlight_and_note_in_the_archive() {
    let conn = db();
    let all = annotations_all(&conn).unwrap();
    let hl: Vec<_> = all.iter().filter(|a| a.book_id == BOOK && a.kind == "highlight").collect();
    let nt: Vec<_> = all.iter().filter(|a| a.book_id == BOOK && a.kind == "note").collect();
    assert_eq!(hl.len(), 1, "the highlight is still listed");
    assert_eq!(nt.len(), 1, "and the note");
    assert_eq!(hl[0].book_title.as_deref(), Some("A Real Book"), "under its book's name");
    assert_eq!(nt[0].book_title.as_deref(), Some("A Real Book"), "and so is the note");
}

#[test]
fn a_real_book_keeps_its_reference_in_the_archive() {
    let conn = db();
    let books = refs_reps_books(&conn).unwrap();
    let mine: Vec<_> = books.iter().filter(|b| b.id == BOOK).collect();
    assert_eq!(mine.len(), 1, "the book with a reference is still listed");
    assert_eq!(mine[0].title, "A Real Book", "under its own name");
}

// ── A BRIDGE ROW PRODUCES NO ARCHIVE RECORD AT ALL ───────────────────────────────────────────────

#[test]
fn a_bridge_row_bookmark_is_not_a_title_less_archive_item() {
    let conn = db();
    let all = bookmarks_all(&conn).unwrap();
    assert!(
        !all.iter().any(|b| b.book_id == BRIDGE),
        "a bookmark on scaffolding must not be listed as belonging to a book"
    );
    assert!(all.iter().all(|b| b.book_title.is_some()), "no archive item may be title-less");
}

#[test]
fn a_bridge_row_highlight_is_not_a_title_less_archive_item() {
    let conn = db();
    let all = annotations_all(&conn).unwrap();
    assert!(
        !all.iter().any(|a| a.book_id == BRIDGE && a.kind == "highlight"),
        "a highlight on scaffolding must not be listed"
    );
    assert!(all.iter().all(|a| a.book_title.is_some()), "no archive item may be title-less");
}

#[test]
fn a_bridge_row_note_is_not_a_title_less_archive_item() {
    let conn = db();
    let all = annotations_all(&conn).unwrap();
    assert!(
        !all.iter().any(|a| a.book_id == BRIDGE && a.kind == "note"),
        "a note on scaffolding must not be listed"
    );
}

#[test]
fn a_bridge_row_reference_is_not_a_title_less_archive_item() {
    let conn = db();
    // NOT MERELY OMITTED — the call has to SUCCEED. `RefsRepsBook.title` is a non-optional String
    // read with `r.get()?`, so a NULL title is not a blank card: it is an error that propagates out
    // of `rows.collect()` and takes the WHOLE archive with it. One bridge row carrying one reference
    // emptied every book's references, which is why this asserts the Ok before it asserts the absence.
    let books = refs_reps_books(&conn).expect("a bridge row must not break the archive for every book");
    assert!(
        !books.iter().any(|b| b.id == BRIDGE),
        "scaffolding must not appear in the list of books carrying references"
    );
    assert!(books.iter().all(|b| !b.title.is_empty()), "no listed book may be title-less");
}

// ── NOTHING IS DELETED, AND THE READER'S OWN VIEW STILL WORKS ────────────────────────────────────

#[test]
fn the_fix_withholds_a_claim_and_destroys_nothing() {
    let conn = db();
    let _ = bookmarks_all(&conn).unwrap();
    let _ = annotations_all(&conn).unwrap();
    let _ = refs_reps_books(&conn).unwrap();

    let count = |t: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {t} WHERE book_id = ?1"), [BRIDGE], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count("bookmarks"), 1, "the bridge's bookmark is still on disk");
    assert_eq!(count("highlights"), 1, "and its highlight");
    assert_eq!(count("notes"), 1, "and its note");
    assert_eq!(count("refs"), 1, "and its reference");

    // And the row itself is untouched — the archive reads, it does not reconcile.
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM books WHERE id = ?1", [BRIDGE], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "the bridge row is not deleted or converted");
}

#[test]
fn the_readers_own_per_book_view_still_sees_a_bridges_marks() {
    // THE OTHER HALF OF THE INVARIANT. A bridge exists so the reader can read a file that is not in
    // the library; the marks they make while doing so must still be theirs in front of them. Only the
    // ARCHIVE — which speaks of books — withholds them.
    let conn = db();
    assert_eq!(super::bookmarks_for_book(&conn, BRIDGE).unwrap().len(), 1, "their bookmark is there");
    assert_eq!(super::highlights_for_book(&conn, BRIDGE).unwrap().len(), 1, "and their highlight");
    assert_eq!(super::notes_for_book(&conn, BRIDGE).unwrap().len(), 1, "and their note");
    assert_eq!(super::refs_for_book(&conn, BRIDGE).unwrap().len(), 1, "and their reference");
}

#[test]
fn a_mark_returns_to_the_archive_when_the_file_is_imported() {
    // The withheld claim is not a lost mark: filling the bridge in place — which is what an import
    // does — makes every one of its marks an ordinary archive record.
    let conn = db();
    assert!(!bookmarks_all(&conn).unwrap().iter().any(|b| b.book_id == BRIDGE));

    conn.execute(
        "UPDATE books SET format = 'epub', title = 'Now A Book' WHERE id = ?1",
        [BRIDGE],
    )
    .unwrap();

    let all = bookmarks_all(&conn).unwrap();
    let now: Vec<_> = all.iter().filter(|b| b.book_id == BRIDGE).collect();
    assert_eq!(now.len(), 1, "the bookmark is an archive record again");
    assert_eq!(now[0].book_title.as_deref(), Some("Now A Book"), "under the name the import gave it");

    let annos = annotations_all(&conn).unwrap();
    assert_eq!(annos.iter().filter(|a| a.book_id == BRIDGE).count(), 2, "highlight and note return too");
    assert!(refs_reps_books(&conn).unwrap().iter().any(|b| b.id == BRIDGE), "and the reference");
}
