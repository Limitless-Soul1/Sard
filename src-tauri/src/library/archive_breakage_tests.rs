//! BREAKAGE PASS — what the archive does with rows its own API could never have written.
//!
//! `annotation_tests` and `archive_tests` exercise the archive through the production path: the marks
//! a reader can actually make, on books and on bridges. This module attacks it from the other side,
//! with raw SQL, in the states a database can HOLD but the API cannot produce — a title that is the
//! empty string, an override row whose value is NULL, a mark with no timestamp, a column left NULL
//! that the writer's own signature made impossible.
//!
//! WHY THAT IS WORTH TESTING. These queries gather across the whole library and map each row into a
//! struct with `r.get()?`. A single row that will not map is not a blank card: the error propagates out
//! of `rows.collect()`, and every consumer turns a failed call into an empty list — so ONE unmappable
//! row silently empties the surface FOR EVERY BOOK. That is exactly how the references defect behaved.
//! The tests here hold that door shut from the inside.
//!
//! WHAT IS DELIBERATELY NOT HERE. Nothing re-tests ownership, cascades, reopening or ordering on sound
//! data — `annotation_tests` already pins those, and repeating them would only add cost.

use rusqlite::Connection;

use super::{annotations_all, bookmark_create, bookmarks_all, refs_reps_books};

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn
}

/// A book row written field by field, so a test can put it in a state no importer would.
fn row(conn: &Connection, id: &str, title: Option<&str>, author: Option<&str>, format: Option<&str>) {
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, author, added_at) \
         VALUES(?1, ?1 || '.epub', ?2, ?3, ?4, 1)",
        rusqlite::params![id, format, title, author],
    )
    .unwrap();
}

/// A bookmark, a highlight, a note and a reference, each naming its owner, all through the API.
fn marks(conn: &Connection, id: &str) {
    bookmark_create(conn, id, &format!("cfi-{id}"), None, None, Some(&format!("place-{id}")), None).unwrap();
    super::highlight_create(conn, id, &format!("cfi-{id}"), "amber", Some(&format!("passage-{id}")), None)
        .unwrap();
    super::note_create(conn, id, None, Some(&format!("ncfi-{id}")), None, &format!("note-{id}"), None, None)
        .unwrap();
    super::ref_save(conn, id, &format!("phrase-{id}"), &format!("phrase-{id}"), 1, "g", None).unwrap();
}

fn over(conn: &Connection, id: &str, field: &str, value: Option<&str>) {
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1,?2,?3)",
        rusqlite::params![id, field, value],
    )
    .unwrap();
}

// ═══ §1 · EVERY STATE A NAME CAN BE IN ═══════════════════════════════════════════════════════════

#[test]
fn every_title_state_a_row_can_hold_names_the_book_or_omits_it_but_never_fails() {
    // Nine states, including the four no writer can produce (an empty base, a whitespace base, an
    // override holding the empty string, an override holding NULL). In every one of them all three
    // surfaces must SUCCEED and must list the book's marks — a name Sard cannot resolve is a card
    // without a name, never an empty archive.
    //
    // `base_title, base_format, override` -> the name the archive shows, and the one references shows.
    let cases: &[(Option<&str>, Option<&str>, Option<Option<&str>>, Option<&str>, &str)] = &[
        // A · the ordinary book.
        (Some("Base"), Some("epub"), None, Some("Base"), "Base"),
        // B · a book proved by its format alone, with no name anywhere.
        (None, Some("epub"), None, None, ""),
        // C · the reader renamed it; the override is the name.
        (Some("Base"), Some("epub"), Some(Some("Over")), Some("Over"), "Over"),
        // D · no base name, only the reader's.
        (None, Some("epub"), Some(Some("Over")), Some("Over"), "Over"),
        // E · an empty base title. Not NULL, so it names the book "" — a book all the same.
        (Some(""), Some("epub"), None, Some(""), ""),
        // F · whitespace only. Carried through as stored; the archive invents nothing.
        (Some("   "), Some("epub"), None, Some("   "), "   "),
        // G · a book proved by its TITLE alone, with no format — the other half of `IS_A_BOOK`.
        (Some("Base"), None, None, Some("Base"), "Base"),
        // H · an override holding the empty string. `COALESCE` takes it, because '' is not NULL: the
        //     reader's cleared name wins over the extracted one rather than falling back to it.
        (Some("Base"), Some("epub"), Some(Some("")), Some(""), ""),
        // I · an override ROW that holds NULL. `COALESCE` steps past it to the base.
        (Some("Base"), Some("epub"), Some(None), Some("Base"), "Base"),
    ];

    for (i, (title, format, ov, want, want_ref)) in cases.iter().enumerate() {
        let label = (b'A' + i as u8) as char;
        let conn = fresh();
        row(&conn, "b", *title, Some("An Author"), *format);
        if let Some(v) = ov {
            over(&conn, "b", "title", *v);
        }
        marks(&conn, "b");

        let bm = bookmarks_all(&conn).unwrap_or_else(|e| panic!("state {label}: bookmarks failed: {e}"));
        let an = annotations_all(&conn).unwrap_or_else(|e| panic!("state {label}: annotations failed: {e}"));
        let rr = refs_reps_books(&conn).unwrap_or_else(|e| panic!("state {label}: references failed: {e}"));

        assert_eq!(bm.len(), 1, "state {label}: the bookmark is listed");
        assert_eq!(an.len(), 2, "state {label}: the highlight and the note are listed");
        assert_eq!(rr.len(), 1, "state {label}: the book carrying a reference is listed");
        assert_eq!(bm[0].book_title.as_deref(), *want, "state {label}: the bookmark's book name");
        assert!(an.iter().all(|x| x.book_title.as_deref() == *want), "state {label}: and the annotations'");
        assert_eq!(rr[0].title, *want_ref, "state {label}: and the references surface's");
    }
}

// ═══ §2 · THE AUTHOR, ATTACKED ON ITS OWN ════════════════════════════════════════════════════════

#[test]
fn a_name_override_and_an_author_override_cannot_move_each_other() {
    // TWO SUBSELECTS KEYED ON `field`. If either matched the wrong key, a renamed book would show its
    // author as its title or the reverse — a contamination no ownership test would catch, because every
    // row would still belong to the right book.
    let conn = fresh();
    row(&conn, "b", Some("Base Title"), Some("Base Author"), Some("epub"));
    over(&conn, "b", "title", Some("Reader Title"));
    marks(&conn, "b");

    let rr = refs_reps_books(&conn).unwrap();
    assert_eq!(rr[0].title, "Reader Title", "the title override is the title");
    assert_eq!(rr[0].author.as_deref(), Some("Base Author"), "and it did NOT become the author");

    // The mirror image: an author override must leave the title alone.
    let conn = fresh();
    row(&conn, "b", Some("Base Title"), Some("Base Author"), Some("epub"));
    over(&conn, "b", "author", Some("Reader Author"));
    marks(&conn, "b");

    let rr = refs_reps_books(&conn).unwrap();
    assert_eq!(rr[0].author.as_deref(), Some("Reader Author"), "the author override is the author");
    assert_eq!(rr[0].title, "Base Title", "and the title is untouched");
    assert_eq!(
        bookmarks_all(&conn).unwrap()[0].book_title.as_deref(),
        Some("Base Title"),
        "the other surfaces agree"
    );
}

#[test]
fn an_author_in_any_state_cannot_empty_the_references_surface() {
    // `author` is nullable, has no fallback, and is read into an `Option` — so no state of it should be
    // able to fail. Stated rather than assumed, because `title` in the same position could.
    for author in [None, Some(""), Some("   "), Some("An Author")] {
        let conn = fresh();
        row(&conn, "b", Some("A Book"), author, Some("epub"));
        marks(&conn, "b");
        let rr = refs_reps_books(&conn).expect("no author state may break the surface");
        assert_eq!(rr.len(), 1, "the book is listed whatever its author is");
        assert_eq!(rr[0].author.as_deref(), author, "and its author is reported as stored");
    }
}

// ═══ §4 · FIVE BOOKS, AND NOT ONE MARK IN THE WRONG PLACE ════════════════════════════════════════

#[test]
fn five_books_each_keep_exactly_their_own_marks_on_every_surface() {
    // Wider than the three-book test in `annotation_tests`: five books, one of them renamed, one with
    // no base title, one with no format — so the fan-out crosses every naming path at once.
    let conn = fresh();
    row(&conn, "a", Some("Book A"), Some("Author A"), Some("epub"));
    row(&conn, "b", Some("Book B"), Some("Author B"), Some("pdf"));
    row(&conn, "c", Some("Base C"), Some("Author C"), Some("epub"));
    over(&conn, "c", "title", Some("Book C"));
    row(&conn, "d", None, Some("Author D"), Some("epub")); // a book by format alone
    row(&conn, "e", Some("Book E"), None, None); // a book by title alone
    for id in ["a", "b", "c", "d", "e"] {
        marks(&conn, id);
    }

    let bm = bookmarks_all(&conn).unwrap();
    let an = annotations_all(&conn).unwrap();
    let rr = refs_reps_books(&conn).unwrap();
    assert_eq!(bm.len(), 5, "five bookmarks, one per book");
    assert_eq!(an.len(), 10, "and two annotations each");
    assert_eq!(rr.len(), 5, "and every book carries a reference");

    for id in ["a", "b", "c", "d", "e"] {
        let mine: Vec<_> = bm.iter().filter(|x| x.book_id == id).collect();
        assert_eq!(mine.len(), 1, "{id} has exactly its own bookmark");
        assert_eq!(mine[0].label.as_deref(), Some(format!("place-{id}").as_str()), "{id}'s own words");
        let ann: Vec<_> = an.iter().filter(|x| x.book_id == id).collect();
        assert_eq!(ann.len(), 2, "{id} has exactly its own two annotations");
        assert!(
            ann.iter().all(|x| x.text.as_deref().is_some_and(|t| t.ends_with(id))),
            "{id}'s annotations carry {id}'s text and nobody else's"
        );
        assert_eq!(rr.iter().filter(|x| x.id == id).count(), 1, "{id} is listed once in references");
        assert_eq!(rr.iter().find(|x| x.id == id).unwrap().refs_count, 1, "with its own single reference");
    }
    // The renamed one is renamed everywhere, and nowhere else is.
    assert_eq!(rr.iter().find(|x| x.id == "c").unwrap().title, "Book C");
    assert_eq!(bm.iter().find(|x| x.book_id == "c").unwrap().book_title.as_deref(), Some("Book C"));
    assert_eq!(bm.iter().find(|x| x.book_id == "a").unwrap().book_title.as_deref(), Some("Book A"));
}

// ═══ §8 · A ROW THAT WILL NOT MAP MUST NOT TAKE THE SURFACE WITH IT ══════════════════════════════

#[test]
fn a_bridge_carrying_an_unsound_bookmark_cannot_empty_the_bookmarks_archive() {
    // `BookmarkItem.cfi` is a non-optional `String` read from `bookmarks.locator_cfi`, which the schema
    // allows to be NULL. No writer can produce that — `bookmark_create` has taken `cfi: &str` in every
    // released version — but a BRIDGE row is the one place odd state legitimately collects, since it
    // exists for a file that was opened and never imported.
    //
    // `IS_A_BOOK` filters in SQL, BEFORE any row is mapped, so a bridge's rows never reach `r.get()` at
    // all. That ordering is what this pins: the fix does not merely hide the bridge's card, it puts the
    // bridge's rows out of reach of the mapping that would fail on them.
    let conn = fresh();
    row(&conn, "a", Some("Book A"), Some("An Author"), Some("epub"));
    marks(&conn, "a");
    conn.execute("INSERT INTO books(id, file_path, added_at) VALUES('g','g.epub',1)", []).unwrap();
    conn.execute(
        "INSERT INTO bookmarks(id, book_id, locator_cfi, created_at) VALUES('g-bm','g',NULL,NULL)",
        [],
    )
    .unwrap();

    let bm = bookmarks_all(&conn).expect("one unmappable row on scaffolding must not empty the archive");
    assert_eq!(bm.len(), 1, "the reader's own bookmark is still listed");
    assert_eq!(bm[0].book_id, "a", "and it is the real book's");
    // Nothing was deleted to achieve that.
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM bookmarks WHERE book_id='g'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 1, "the bridge's row is still on disk, merely not spoken of");
}

#[test]
fn a_highlight_and_a_note_stripped_to_their_bare_rows_are_still_archived() {
    // Every optional column NULL at once — no cfi, no colour, no excerpt, no chapter, no timestamp. The
    // API cannot write this; a legacy row can hold it. The annotations surface types all five as
    // `Option`, and this is the test that says so out loud.
    let conn = fresh();
    row(&conn, "a", Some("Book A"), Some("An Author"), Some("epub"));
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, end_cfi, color, text_excerpt, chapter_label, created_at) \
         VALUES('h','a',NULL,NULL,NULL,NULL,NULL,NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes(id, book_id, locator_cfi, color, body, chapter_label, created_at, updated_at) \
         VALUES('n','a',NULL,NULL,NULL,NULL,NULL,NULL)",
        [],
    )
    .unwrap();

    let an = annotations_all(&conn).expect("a bare row must not empty the annotations archive");
    assert_eq!(an.len(), 2, "both are listed");
    assert!(an.iter().all(|x| x.book_title.as_deref() == Some("Book A")), "under their book's name");
    assert!(an.iter().all(|x| x.cfi.is_none() && x.color.is_none()), "with the absent fields absent");
    assert!(an.iter().all(|x| x.tags.is_empty()), "and no tags invented for them");
}

#[test]
fn a_mark_with_no_timestamp_is_still_listed() {
    // `ORDER BY created_at DESC` with a NULL in the column: SQLite sorts NULL last under DESC. The row
    // must still be PRESENT — an undated mark is a mark, and dropping it would lose the reader's work.
    let conn = fresh();
    row(&conn, "a", Some("Book A"), Some("An Author"), Some("epub"));
    conn.execute(
        "INSERT INTO bookmarks(id, book_id, locator_cfi, created_at) VALUES('old','a','cfi',NULL)",
        [],
    )
    .unwrap();
    bookmark_create(&conn, "a", "cfi-2", None, None, Some("dated"), None).unwrap();

    let bm = bookmarks_all(&conn).unwrap();
    assert_eq!(bm.len(), 2, "the undated bookmark is not dropped");
    assert_eq!(bm.last().unwrap().id, "old", "it simply sorts last");
}

// ═══ §10 · PROMOTION BY A TITLE ALONE ════════════════════════════════════════════════════════════

#[test]
fn a_bridge_promoted_by_a_title_alone_is_archived_like_any_book() {
    // `IS_A_BOOK` is a disjunction, and `annotation_tests` promotes a bridge by giving it BOTH a format
    // and a title. This takes the other branch: a row that gains only a name. It must cross into the
    // archive on that alone, keeping the same id and the same marks.
    let conn = fresh();
    conn.execute("INSERT INTO books(id, file_path, added_at) VALUES('g','g.epub',1)", []).unwrap();
    marks(&conn, "g");
    assert!(bookmarks_all(&conn).unwrap().is_empty(), "scaffolding is not archived");

    conn.execute("UPDATE books SET title='Named At Last' WHERE id='g'", []).unwrap();

    let bm = bookmarks_all(&conn).unwrap();
    assert_eq!(bm.len(), 1, "a name alone makes it a book");
    assert_eq!(bm[0].book_id, "g", "the same row, not a new one");
    assert_eq!(bm[0].book_title.as_deref(), Some("Named At Last"));
    assert_eq!(annotations_all(&conn).unwrap().len(), 2, "its annotations come with it");
    assert_eq!(refs_reps_books(&conn).unwrap().len(), 1, "and its reference");
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "and no second row was created anywhere");
}
