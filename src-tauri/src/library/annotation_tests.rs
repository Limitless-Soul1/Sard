//! THE FOUR MARKS A READER LEAVES IN A BOOK, AND WHO THEY BELONG TO.
//!
//! Bookmarks, highlights, notes and references are four different tables with one shared property:
//! each row belongs to exactly one `book_id`, and every surface that shows them must agree about
//! whose they are. This module holds that agreement against the ways it could quietly break —
//! ownership leaking between books, a deletion taking more than it should, a mark surviving into a
//! surface that cannot name it, and the failure that started this: one unnameable row taking a whole
//! archive query down with it.
//!
//! WHY THE PRODUCTION FUNCTIONS. Every mark here is made with `bookmark_create`, `highlight_create`,
//! `note_create` and `ref_save` rather than with hand-written INSERTs. A test that writes its own SQL
//! proves the schema accepts a row; these prove the code a reader actually reaches does the right
//! thing — including the id each of them derives, which is where ownership is decided.
//!
//! THE CONTRACTS THESE ASSERT WERE READ OUT OF THE CODE, NOT CHOSEN HERE:
//!
//!   IDENTITY   all four derive a deterministic id containing the book — `bm:{book}:{cfi}`,
//!              `hl:{book}:{cfi}`, `note:{book}:{anchor}`, `ref:{book}:{phrase_fold}` — and upsert on
//!              it. Marking the same place twice therefore EDITS one row; the same cfi in two books is
//!              two rows, because the book is part of the id.
//!   DELETION   every table carries `ON DELETE CASCADE` to `books`, so deleting a book takes its marks
//!              with it. Annotations do NOT survive a delete, and a re-import does not bring them back.
//!   ORDER      `bookmarks_all` and `annotations_all` are newest-first by `created_at`;
//!              `refs_reps_books` is newest-touched first.
//!   BOOK-NESS  the archive shows what belongs to a BOOK (`books::IS_A_BOOK`); the per-book queries
//!              serve the reader whatever the row is, which is what a bridge exists for.

use rusqlite::Connection;

use super::{
    annotations_all, bookmark_create, bookmarks_all, bookmarks_for_book, highlight_create,
    highlights_for_book, note_create, notes_for_book, ref_save, refs_for_book, refs_reps_books,
};

// ── the world these tests are set in ─────────────────────────────────────────────────────────────

fn fresh(path: Option<&std::path::Path>) -> Connection {
    let conn = match path {
        Some(p) => Connection::open(p).unwrap(),
        None => Connection::open_in_memory().unwrap(),
    };
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn
}

/// A book the reader added: a format and a title, exactly as both importers write.
fn book(conn: &Connection, id: &str, title: &str) {
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, author, added_at) \
         VALUES(?1, ?1 || '.epub', 'epub', ?2, 'An Author', 1)",
        rusqlite::params![id, title],
    )
    .unwrap();
}

/// Scaffolding: an id, a path and a timestamp — exactly what `books::ensure` writes.
fn bridge(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO books(id, file_path, added_at) VALUES(?1, ?1 || '.epub', 1)",
        [id],
    )
    .unwrap();
}

/// All four marks, made through the production path, with content that names its owner.
fn mark_all(conn: &Connection, id: &str) {
    bookmark_create(conn, id, &format!("cfi-{id}"), Some("Ch"), Some(0.25), Some(&format!("place-{id}")), None)
        .unwrap();
    highlight_create(conn, id, &format!("cfi-{id}"), "amber", Some(&format!("passage-{id}")), Some("Ch")).unwrap();
    note_create(conn, id, None, Some(&format!("ncfi-{id}")), Some("amber"), &format!("note-{id}"), Some("Ch"), None)
        .unwrap();
    ref_save(conn, id, &format!("phrase-{id}"), &format!("phrase-{id}"), 1, &format!("gloss-{id}"), None).unwrap();
}

fn count(conn: &Connection, table: &str, book_id: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE book_id = ?1"), [book_id], |r| r.get(0))
        .unwrap()
}

// ═══ A · THE FOUR MARKS ON A REAL BOOK, END TO END ═══════════════════════════════════════════════

#[test]
fn every_mark_on_a_real_book_is_one_row_owned_by_it_and_visible_from_both_surfaces() {
    let conn = fresh(None);
    book(&conn, "a", "Book A");
    mark_all(&conn, "a");

    // Exactly one of each, owned by the book.
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "a"), 1, "{t}: exactly one row");
    }

    // The reader's own view returns each, with the position and content it was given.
    let bm = bookmarks_for_book(&conn, "a").unwrap();
    assert_eq!(bm.len(), 1);
    assert_eq!(bm[0].cfi, "cfi-a", "the bookmark keeps its place");
    assert_eq!(bm[0].label.as_deref(), Some("place-a"), "and its words");

    let hl = highlights_for_book(&conn, "a").unwrap();
    assert_eq!(hl.len(), 1);
    assert_eq!(hl[0].text_excerpt.as_deref(), Some("passage-a"), "the highlight keeps its text");

    let nt = notes_for_book(&conn, "a").unwrap();
    assert_eq!(nt.len(), 1);
    assert_eq!(nt[0].body.as_deref(), Some("note-a"), "the note keeps its body");

    let rf = refs_for_book(&conn, "a").unwrap();
    assert_eq!(rf.len(), 1);
    assert_eq!(rf[0].phrase, "phrase-a", "the reference keeps its phrase");

    // And the archive returns each, under the book's name.
    let all_bm = bookmarks_all(&conn).unwrap();
    assert_eq!(all_bm.len(), 1);
    assert_eq!(all_bm[0].book_title.as_deref(), Some("Book A"));
    assert_eq!(all_bm[0].book_id, "a");

    let annos = annotations_all(&conn).unwrap();
    assert_eq!(annos.len(), 2, "the highlight and the standalone note");
    assert!(annos.iter().all(|x| x.book_id == "a" && x.book_title.as_deref() == Some("Book A")));

    let rb = refs_reps_books(&conn).unwrap();
    assert_eq!(rb.len(), 1);
    assert_eq!(rb[0].title, "Book A");
    assert_eq!(rb[0].refs_count, 1);
}

// ═══ B · THE SAME FOUR ON A BRIDGE ROW ═══════════════════════════════════════════════════════════

#[test]
fn a_bridges_marks_are_kept_and_readable_but_never_archived() {
    let conn = fresh(None);
    book(&conn, "a", "Book A");
    mark_all(&conn, "a");
    bridge(&conn, "g");
    mark_all(&conn, "g");

    // The data is there — creating a mark on scaffolding is not refused and nothing is destroyed.
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "g"), 1, "{t}: the bridge's row is kept");
    }
    // And the reader, who is reading that file, still sees all four.
    assert_eq!(bookmarks_for_book(&conn, "g").unwrap().len(), 1);
    assert_eq!(highlights_for_book(&conn, "g").unwrap().len(), 1);
    assert_eq!(notes_for_book(&conn, "g").unwrap().len(), 1);
    assert_eq!(refs_for_book(&conn, "g").unwrap().len(), 1);

    // The archive shows none of it, and names everything it does show.
    let bm = bookmarks_all(&conn).unwrap();
    let an = annotations_all(&conn).unwrap();
    let rb = refs_reps_books(&conn).unwrap();
    assert!(!bm.iter().any(|x| x.book_id == "g"));
    assert!(!an.iter().any(|x| x.book_id == "g"));
    assert!(!rb.iter().any(|x| x.id == "g"));
    assert!(bm.iter().all(|x| x.book_title.is_some()), "no title-less bookmark");
    assert!(an.iter().all(|x| x.book_title.is_some()), "no title-less annotation");
    assert!(rb.iter().all(|x| !x.title.is_empty()), "no title-less reference row");

    // And the real book's archive is untouched by the bridge's presence.
    assert_eq!(bm.len(), 1);
    assert_eq!(an.len(), 2);
    assert_eq!(rb.len(), 1);
}

// ═══ C · CROSS-BOOK ISOLATION ════════════════════════════════════════════════════════════════════

#[test]
fn three_books_never_receive_one_anothers_marks() {
    let conn = fresh(None);
    for (id, title) in [("a", "Book A"), ("b", "Book B"), ("c", "Book C")] {
        book(&conn, id, title);
    }
    // Deliberately uneven, so a leak shows up as a count rather than a tie.
    bookmark_create(&conn, "a", "p1", None, None, Some("A1"), None).unwrap();
    bookmark_create(&conn, "a", "p2", None, None, Some("A2"), None).unwrap();
    highlight_create(&conn, "b", "p1", "sky", Some("B-passage"), None).unwrap();
    note_create(&conn, "b", None, Some("p2"), None, "B-note", None, None).unwrap();
    ref_save(&conn, "c", "c-phrase", "c-phrase", 1, "C-gloss", None).unwrap();

    assert_eq!(count(&conn, "bookmarks", "a"), 2);
    assert_eq!(count(&conn, "bookmarks", "b"), 0);
    assert_eq!(count(&conn, "bookmarks", "c"), 0);
    assert_eq!(count(&conn, "highlights", "b"), 1);
    assert_eq!(count(&conn, "highlights", "a"), 0);
    assert_eq!(count(&conn, "notes", "b"), 1);
    assert_eq!(count(&conn, "notes", "c"), 0);
    assert_eq!(count(&conn, "refs", "c"), 1);
    assert_eq!(count(&conn, "refs", "a"), 0);

    // Each reader-facing view returns only its own book's marks.
    assert_eq!(bookmarks_for_book(&conn, "a").unwrap().len(), 2);
    assert!(bookmarks_for_book(&conn, "b").unwrap().is_empty());
    assert!(highlights_for_book(&conn, "a").unwrap().is_empty());
    assert_eq!(highlights_for_book(&conn, "b").unwrap().len(), 1);
    assert_eq!(refs_for_book(&conn, "c").unwrap().len(), 1);

    // And the archive attributes every single item to the right book.
    for x in bookmarks_all(&conn).unwrap() {
        assert_eq!(x.book_id, "a", "only A has bookmarks");
        assert_eq!(x.book_title.as_deref(), Some("Book A"));
    }
    for x in annotations_all(&conn).unwrap() {
        assert_eq!(x.book_id, "b", "only B has annotations");
        assert_eq!(x.book_title.as_deref(), Some("Book B"));
    }
    let rb = refs_reps_books(&conn).unwrap();
    assert_eq!(rb.len(), 1, "only C has a reference");
    assert_eq!(rb[0].id, "c");
}

// ═══ D · OWNERSHIP IS THE BOOK, NOT THE PLACE ════════════════════════════════════════════════════

#[test]
fn the_same_place_in_two_books_is_two_marks_owned_separately() {
    // Two library entries, the same cfi and the same phrase in each. The id each creator derives
    // contains the book, so these must not collide — that derivation IS the ownership rule.
    let conn = fresh(None);
    book(&conn, "one", "The Same Title");
    book(&conn, "two", "The Same Title");

    let b1 = bookmark_create(&conn, "one", "same-cfi", None, None, Some("in one"), None).unwrap().unwrap();
    let b2 = bookmark_create(&conn, "two", "same-cfi", None, None, Some("in two"), None).unwrap().unwrap();
    assert_ne!(b1.id, b2.id, "the same place in two books is two bookmarks");

    let h1 = highlight_create(&conn, "one", "same-cfi", "amber", Some("x"), None).unwrap().unwrap();
    let h2 = highlight_create(&conn, "two", "same-cfi", "amber", Some("x"), None).unwrap().unwrap();
    assert_ne!(h1.id, h2.id, "and two highlights");

    let r1 = ref_save(&conn, "one", "same phrase", "same phrase", 2, "g", None).unwrap().unwrap();
    let r2 = ref_save(&conn, "two", "same phrase", "same phrase", 2, "g", None).unwrap().unwrap();
    assert_ne!(r1.id, r2.id, "and two references, despite UNIQUE(book_id, phrase_fold) being per book");

    assert_eq!(count(&conn, "bookmarks", "one"), 1);
    assert_eq!(count(&conn, "bookmarks", "two"), 1);
    assert_eq!(bookmarks_for_book(&conn, "one").unwrap()[0].label.as_deref(), Some("in one"));
    assert_eq!(bookmarks_for_book(&conn, "two").unwrap()[0].label.as_deref(), Some("in two"));
}

// ═══ E · DELETION, PER TYPE ══════════════════════════════════════════════════════════════════════

#[test]
fn deleting_a_book_takes_each_of_its_four_marks_and_no_one_elses() {
    let dir = std::env::temp_dir().join("sard_anno_delete");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = fresh(None);
    book(&conn, "keep", "Kept");
    book(&conn, "gone", "Deleted");
    mark_all(&conn, "keep");
    mark_all(&conn, "gone");

    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "gone"), 1, "{t} exists before the delete");
    }

    assert!(super::delete_book(&conn, &dir, "gone").unwrap(), "the book is deleted");

    // THE CONTRACT: every one of these tables carries ON DELETE CASCADE, so the marks go with it.
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "gone"), 0, "{t} cascaded away with its book");
        assert_eq!(count(&conn, t, "keep"), 1, "{t} of the other book is untouched");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ═══ F · ONE BOOK OUT OF THREE ═══════════════════════════════════════════════════════════════════

#[test]
fn deleting_the_middle_book_changes_the_archive_by_exactly_its_own_records() {
    let dir = std::env::temp_dir().join("sard_anno_middle");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = fresh(None);
    for (id, title) in [("a", "Book A"), ("b", "Book B"), ("c", "Book C")] {
        book(&conn, id, title);
        mark_all(&conn, id);
    }

    let snapshot = |c: &Connection, id: &str| -> (Vec<String>, Vec<String>, Vec<String>) {
        (
            bookmarks_for_book(c, id).unwrap().iter().map(|x| format!("{}{:?}", x.cfi, x.label)).collect(),
            highlights_for_book(c, id).unwrap().iter().map(|x| format!("{:?}", x.text_excerpt)).collect(),
            notes_for_book(c, id).unwrap().iter().map(|x| format!("{:?}", x.body)).collect(),
        )
    };
    let a_before = snapshot(&conn, "a");
    let c_before = snapshot(&conn, "c");
    let bm_before = bookmarks_all(&conn).unwrap().len();
    let an_before = annotations_all(&conn).unwrap().len();
    let rb_before = refs_reps_books(&conn).unwrap().len();
    assert_eq!((bm_before, an_before, rb_before), (3, 6, 3), "three books, each with its own marks");

    assert!(super::delete_book(&conn, &dir, "b").unwrap());

    // B is gone entirely.
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "b"), 0, "{t} of B is gone");
    }
    // A and C are identical to what they were, field for field.
    assert_eq!(snapshot(&conn, "a"), a_before, "A is untouched");
    assert_eq!(snapshot(&conn, "c"), c_before, "C is untouched");
    // And the archive changed by exactly B's share.
    assert_eq!(bookmarks_all(&conn).unwrap().len(), bm_before - 1);
    assert_eq!(annotations_all(&conn).unwrap().len(), an_before - 2);
    assert_eq!(refs_reps_books(&conn).unwrap().len(), rb_before - 1);
    assert!(!bookmarks_all(&conn).unwrap().iter().any(|x| x.book_id == "b"));

    let _ = std::fs::remove_dir_all(&dir);
}

// ═══ G · DELETE THEN RE-IMPORT, AND BRIDGE PROMOTION ═════════════════════════════════════════════

#[test]
fn a_re_imported_book_does_not_inherit_the_marks_of_the_one_that_was_deleted() {
    // THE CONTRACT, READ FROM THE SCHEMA: cascade means a delete takes the marks. Re-adding the same
    // file makes a NEW book that happens to share the content id — it must not resurrect anything,
    // and nothing stale may attach itself to it.
    let dir = std::env::temp_dir().join("sard_anno_reimport");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = fresh(None);
    book(&conn, "x", "Once Had Marks");
    mark_all(&conn, "x");
    assert_eq!(count(&conn, "bookmarks", "x"), 1);

    assert!(super::delete_book(&conn, &dir, "x").unwrap());
    assert_eq!(count(&conn, "bookmarks", "x"), 0, "the marks went with the book");

    // The same content id added again — a fresh book.
    book(&conn, "x", "Added Again");
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "x"), 0, "{t}: nothing came back");
    }
    assert!(bookmarks_all(&conn).unwrap().is_empty(), "and the archive is empty, not haunted");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn promoting_a_bridge_keeps_its_marks_its_id_and_its_single_row() {
    // The interaction between the two fixes: the ghost-book fix fills a bridge IN PLACE, and this
    // archive fix then has a real book to name — so the marks made while it was scaffolding become
    // ordinary archive records without moving, changing id, or being duplicated.
    let conn = fresh(None);
    bridge(&conn, "g");
    mark_all(&conn, "g");
    let ids_before: Vec<String> = bookmarks_for_book(&conn, "g").unwrap().iter().map(|x| x.id.clone()).collect();
    assert!(bookmarks_all(&conn).unwrap().is_empty(), "hidden while it is scaffolding");

    // What the import does to the row it meets: fills it, in place.
    conn.execute(
        "UPDATE books SET format='epub', title='Promoted', author='An Author' WHERE id='g'",
        [],
    )
    .unwrap();

    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE id='g'", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "one books row, filled rather than replaced");
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "g"), 1, "{t} survived the promotion");
    }
    let ids_after: Vec<String> = bookmarks_for_book(&conn, "g").unwrap().iter().map(|x| x.id.clone()).collect();
    assert_eq!(ids_after, ids_before, "the marks kept their identity");

    let bm = bookmarks_all(&conn).unwrap();
    assert_eq!(bm.len(), 1, "and are archive records now");
    assert_eq!(bm[0].book_id, "g", "under the same book id");
    assert_eq!(bm[0].book_title.as_deref(), Some("Promoted"), "with the name the import gave it");
    assert_eq!(annotations_all(&conn).unwrap().len(), 2);
    assert!(refs_reps_books(&conn).unwrap().iter().any(|x| x.id == "g"));
}

// ═══ H · PERSISTENCE ACROSS A REAL RECONNECT ═════════════════════════════════════════════════════

#[test]
fn everything_holds_across_closing_and_reopening_the_database() {
    // A file-backed database, closed and reopened — the nearest a unit test gets to a restart, and
    // enough to prove none of this lives in a connection's memory.
    let dir = std::env::temp_dir().join("sard_anno_restart");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sard.db");

    {
        let conn = fresh(Some(&path));
        book(&conn, "a", "Book A");
        mark_all(&conn, "a");
        bridge(&conn, "g");
        mark_all(&conn, "g");
    } // closed

    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    crate::db::migrations::run(&conn, None).unwrap();

    // The real book's four marks are all still there, and still archived under its name.
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "a"), 1, "{t} survived the reopen");
    }
    let bm = bookmarks_all(&conn).unwrap();
    assert_eq!(bm.len(), 1);
    assert_eq!(bm[0].book_title.as_deref(), Some("Book A"));
    assert_eq!(annotations_all(&conn).unwrap().len(), 2);
    assert_eq!(refs_reps_books(&conn).unwrap().len(), 1);

    // The bridge's are still kept, still readable, still not archived.
    for t in ["bookmarks", "highlights", "notes", "refs"] {
        assert_eq!(count(&conn, t, "g"), 1, "{t} of the bridge survived too");
    }
    assert_eq!(bookmarks_for_book(&conn, "g").unwrap().len(), 1, "the reader still sees them");
    assert!(!bm.iter().any(|x| x.book_id == "g"), "the archive still does not");

    // Promote it, and after the promotion they are archive records — across the same reopened handle.
    conn.execute("UPDATE books SET format='epub', title='Promoted' WHERE id='g'", []).unwrap();
    let bm2 = bookmarks_all(&conn).unwrap();
    assert_eq!(bm2.len(), 2);
    assert!(bm2.iter().any(|x| x.book_id == "g" && x.book_title.as_deref() == Some("Promoted")));

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

// ═══ I · THE REFERENCES SURFACE MUST NEVER FAIL ══════════════════════════════════════════════════

#[test]
fn many_bridge_references_cannot_bring_down_the_global_references_surface() {
    // THE FAILURE THAT STARTED THIS. `RefsRepsBook.title` is a non-optional String read with
    // `r.get()?`, so a NULL title is not a blank card — it is an InvalidColumnType that propagates
    // out of `rows.collect()` and empties the surface for EVERY book. One bridge row did that; these
    // put several in, on both sides of the real books, and demand the query still answers.
    let conn = fresh(None);
    book(&conn, "a", "Book A");
    ref_save(&conn, "a", "alpha", "alpha", 1, "gloss a", None).unwrap();
    for g in ["g1", "g2", "g3"] {
        bridge(&conn, g);
        ref_save(&conn, g, &format!("ghost-{g}"), &format!("ghost-{g}"), 1, "ghost gloss", None).unwrap();
    }
    book(&conn, "b", "Book B");
    ref_save(&conn, "b", "beta", "beta", 1, "gloss b", None).unwrap();

    let rb = refs_reps_books(&conn).expect("the references surface must survive any number of bridges");
    let ids: Vec<&str> = rb.iter().map(|x| x.id.as_str()).collect();
    assert!(ids.contains(&"a"), "Book A is listed");
    assert!(ids.contains(&"b"), "Book B is listed");
    assert_eq!(rb.len(), 2, "and nothing else");
    assert!(!ids.iter().any(|i| i.starts_with('g')), "no bridge is listed");
    assert!(rb.iter().all(|x| !x.title.is_empty()), "every listed book is named");
    let titles: Vec<&str> = rb.iter().map(|x| x.title.as_str()).collect();
    assert!(titles.contains(&"Book A") && titles.contains(&"Book B"), "with their own titles");

    // The other two archive surfaces survive the same company.
    assert!(bookmarks_all(&conn).is_ok());
    assert!(annotations_all(&conn).is_ok());
}

// ═══ J · ORDER, AS THE QUERIES DECLARE IT ════════════════════════════════════════════════════════

#[test]
fn the_archive_is_newest_first_as_its_queries_say() {
    let conn = fresh(None);
    book(&conn, "a", "Book A");
    book(&conn, "b", "Book B");
    bookmark_create(&conn, "a", "old", None, None, Some("older"), None).unwrap();
    bookmark_create(&conn, "b", "new", None, None, Some("newer"), None).unwrap();
    highlight_create(&conn, "a", "h-old", "amber", Some("older"), None).unwrap();
    note_create(&conn, "b", None, Some("n-new"), None, "newer", None, None).unwrap();
    // `created_at` is written by the creators, so the order is forced explicitly rather than by luck.
    conn.execute("UPDATE bookmarks SET created_at = 100 WHERE book_id='a'", []).unwrap();
    conn.execute("UPDATE bookmarks SET created_at = 200 WHERE book_id='b'", []).unwrap();
    conn.execute("UPDATE highlights SET created_at = 100 WHERE book_id='a'", []).unwrap();
    conn.execute("UPDATE notes SET created_at = 200 WHERE book_id='b'", []).unwrap();

    let bm = bookmarks_all(&conn).unwrap();
    assert_eq!(bm.len(), 2);
    assert_eq!(bm[0].book_id, "b", "bookmarks_all is ORDER BY created_at DESC");
    assert_eq!(bm[1].book_id, "a");

    let an = annotations_all(&conn).unwrap();
    assert_eq!(an.len(), 2);
    assert_eq!(an[0].book_id, "b", "annotations_all is ORDER BY created_at DESC");
    assert_eq!(an[1].book_id, "a");
}

// ═══ K · REPEATING A MARK, AS PRODUCTION DEFINES IT ══════════════════════════════════════════════

#[test]
fn marking_the_same_place_twice_edits_one_row_rather_than_making_two() {
    // Not a uniqueness rule invented here: all four creators derive a deterministic id from the book
    // and the anchor and upsert on it. This asserts the behaviour that derivation produces.
    let conn = fresh(None);
    book(&conn, "a", "Book A");

    bookmark_create(&conn, "a", "cfi", None, None, Some("first"), None).unwrap();
    bookmark_create(&conn, "a", "cfi", None, None, Some("second"), None).unwrap();
    assert_eq!(count(&conn, "bookmarks", "a"), 1, "one bookmark, re-marked");

    highlight_create(&conn, "a", "cfi", "amber", Some("first"), None).unwrap();
    highlight_create(&conn, "a", "cfi", "sky", Some("second"), None).unwrap();
    assert_eq!(count(&conn, "highlights", "a"), 1, "one highlight, recoloured");
    assert_eq!(highlights_for_book(&conn, "a").unwrap()[0].color, "sky", "the later colour wins");

    note_create(&conn, "a", None, Some("ncfi"), None, "first body", None, None).unwrap();
    note_create(&conn, "a", None, Some("ncfi"), None, "second body", None, None).unwrap();
    assert_eq!(count(&conn, "notes", "a"), 1, "one note, rewritten");
    assert_eq!(notes_for_book(&conn, "a").unwrap()[0].body.as_deref(), Some("second body"), "the later body wins");

    ref_save(&conn, "a", "phrase", "phrase", 1, "first gloss", None).unwrap();
    ref_save(&conn, "a", "phrase", "phrase", 1, "second gloss", None).unwrap();
    assert_eq!(count(&conn, "refs", "a"), 1, "one reference, edited");

    // And the archive still shows one of each, not duplicates.
    assert_eq!(bookmarks_all(&conn).unwrap().len(), 1);
    assert_eq!(annotations_all(&conn).unwrap().len(), 2, "the highlight and the note");
}

// ═══ L · EMPTY AND ABSENT VALUES ═════════════════════════════════════════════════════════════════

#[test]
fn sparse_marks_and_a_title_less_override_do_not_break_the_archive() {
    let conn = fresh(None);
    book(&conn, "a", "Book A");
    // Every optional field omitted, and an empty note body — all accepted by the API.
    bookmark_create(&conn, "a", "cfi", None, None, None, None).unwrap();
    highlight_create(&conn, "a", "cfi", "amber", None, None).unwrap();
    note_create(&conn, "a", None, Some("ncfi"), None, "", None, None).unwrap();
    ref_save(&conn, "a", "p", "p", 1, "", None).unwrap();

    let bm = bookmarks_all(&conn).unwrap();
    let an = annotations_all(&conn).unwrap();
    assert_eq!(bm.len(), 1, "a bookmark with no label is still a bookmark");
    assert!(bm[0].book_title.is_some(), "and is still named by its book");
    assert_eq!(an.len(), 2);
    assert!(an.iter().all(|x| x.book_title.is_some()));
    assert_eq!(refs_reps_books(&conn).unwrap().len(), 1);
}

#[test]
fn a_book_whose_title_lives_only_in_an_override_is_still_a_book() {
    // A row can carry a format and a NULL title (an EPUB with no dc:title falls back to the filename,
    // but a legacy row need not), with the reader's own name held as an override. `IS_A_BOOK` is a
    // disjunction precisely so the format alone still proves it, and the archive must name it from
    // the override.
    let conn = fresh(None);
    conn.execute(
        "INSERT INTO books(id, file_path, format, added_at) VALUES('a','a.epub','epub',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES('a','title','The Reader''s Name')",
        [],
    )
    .unwrap();
    bookmark_create(&conn, "a", "cfi", None, None, Some("x"), None).unwrap();
    ref_save(&conn, "a", "p", "p", 1, "g", None).unwrap();

    let bm = bookmarks_all(&conn).unwrap();
    assert_eq!(bm.len(), 1, "a book with only a format is still a book");
    assert_eq!(bm[0].book_title.as_deref(), Some("The Reader's Name"), "named from the override");
    assert!(refs_reps_books(&conn).is_ok(), "and the references surface survives its NULL base title");
}

// ═══ THE INVARIANTS, STATED ON A GENERATED MATRIX ════════════════════════════════════════════════

/// A deterministic sweep over the combinations that matter: several books, some real and some
/// scaffolding, with and without an override, each carrying a different subset of the four marks.
/// No randomness and no new dependency — the point is cross-book leakage and query failure, not
/// fuzzing.
#[test]
fn the_invariants_hold_across_every_combination_in_the_matrix() {
    for real_count in 1..=3usize {
        for bridge_count in 0..=2usize {
            for overridden in [false, true] {
                let conn = fresh(None);
                let mut reals = Vec::new();
                for i in 0..real_count {
                    let id = format!("r{i}");
                    book(&conn, &id, &format!("Title {i}"));
                    if overridden {
                        conn.execute(
                            "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1,'title',?2)",
                            rusqlite::params![id, format!("Override {i}")],
                        )
                        .unwrap();
                    }
                    // A different subset per book, so a leak cannot hide behind symmetry.
                    match i % 3 {
                        0 => { mark_all(&conn, &id); }
                        1 => {
                            bookmark_create(&conn, &id, "c", None, None, Some("l"), None).unwrap();
                            ref_save(&conn, &id, "p", "p", 1, "g", None).unwrap();
                        }
                        _ => {
                            highlight_create(&conn, &id, "c", "amber", Some("t"), None).unwrap();
                            note_create(&conn, &id, None, Some("n"), None, "b", None, None).unwrap();
                        }
                    }
                    reals.push(id);
                }
                let mut ghosts = Vec::new();
                for j in 0..bridge_count {
                    let id = format!("g{j}");
                    bridge(&conn, &id);
                    mark_all(&conn, &id);
                    ghosts.push(id);
                }

                let case = format!("real={real_count} bridge={bridge_count} override={overridden}");

                // 1. No archive query may fail, whatever company it keeps.
                let bm = bookmarks_all(&conn).unwrap_or_else(|e| panic!("bookmarks_all failed [{case}]: {e}"));
                let an = annotations_all(&conn).unwrap_or_else(|e| panic!("annotations_all failed [{case}]: {e}"));
                let rb = refs_reps_books(&conn).unwrap_or_else(|e| panic!("refs_reps_books failed [{case}]: {e}"));

                // 2. Nothing from scaffolding is ever represented as an archive item.
                for g in &ghosts {
                    assert!(!bm.iter().any(|x| &x.book_id == g), "bridge bookmark surfaced [{case}]");
                    assert!(!an.iter().any(|x| &x.book_id == g), "bridge annotation surfaced [{case}]");
                    assert!(!rb.iter().any(|x| &x.id == g), "bridge reference surfaced [{case}]");
                    // …while remaining the reader's own, untouched.
                    assert_eq!(count(&conn, "bookmarks", g), 1, "bridge mark destroyed [{case}]");
                }

                // 3. Every archive item names a book, and names the right one.
                assert!(bm.iter().all(|x| x.book_title.is_some()), "title-less bookmark [{case}]");
                assert!(an.iter().all(|x| x.book_title.is_some()), "title-less annotation [{case}]");
                assert!(rb.iter().all(|x| !x.title.is_empty()), "title-less reference row [{case}]");
                let expected = if overridden { "Override " } else { "Title " };
                for x in &bm {
                    let i = x.book_id.trim_start_matches('r');
                    assert_eq!(
                        x.book_title.as_deref(),
                        Some(format!("{expected}{i}").as_str()),
                        "wrong owner or name [{case}]"
                    );
                }

                // 4. Ownership never crosses: each real book's own view holds only its own.
                for id in &reals {
                    for x in bookmarks_for_book(&conn, id).unwrap() {
                        assert_eq!(&x.book_id, id, "cross-book bookmark [{case}]");
                    }
                    for x in highlights_for_book(&conn, id).unwrap() {
                        assert_eq!(&x.book_id, id, "cross-book highlight [{case}]");
                    }
                    for x in notes_for_book(&conn, id).unwrap() {
                        assert_eq!(&x.book_id, id, "cross-book note [{case}]");
                    }
                }

                // 5. Every archive item belongs to a real book, never to scaffolding.
                for x in &bm {
                    assert!(reals.contains(&x.book_id), "archived a non-book [{case}]");
                }
                for x in &an {
                    assert!(reals.contains(&x.book_id), "archived a non-book annotation [{case}]");
                }
            }
        }
    }
}


// ═══ C · A RENAMED BOOK IS THE SAME BOOK ON EVERY SURFACE ════════════════════════════════════════

#[test]
fn all_three_archive_surfaces_show_a_renamed_book_under_the_same_name() {
    // THE DEFECT THIS HOLDS SHUT, MEASURED BEFORE IT WAS FIXED: base "Original Title", override
    // "Renamed By Reader", and the surfaces disagreed two to one — bookmarks and annotations showed
    // the new name, references still showed the old one, because it alone read `b.title` raw.
    let conn = fresh(None);
    book(&conn, "a", "Original Title");
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES('a','title','Renamed By Reader')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES('a','author','Renamed Author')",
        [],
    )
    .unwrap();
    mark_all(&conn, "a");

    let bm = bookmarks_all(&conn).unwrap();
    let an = annotations_all(&conn).unwrap();
    let rb = refs_reps_books(&conn).unwrap();
    assert_eq!(bm[0].book_title.as_deref(), Some("Renamed By Reader"), "bookmarks use the reader's name");
    assert!(an.iter().all(|x| x.book_title.as_deref() == Some("Renamed By Reader")), "so do annotations");
    assert_eq!(rb[0].title, "Renamed By Reader", "and so do references");
    assert_eq!(rb[0].author.as_deref(), Some("Renamed Author"), "the author is resolved the same way");

    // One name, agreed by all three — asserted as a set so a future surface cannot drift alone.
    let names: std::collections::BTreeSet<String> = bm
        .iter()
        .filter_map(|x| x.book_title.clone())
        .chain(an.iter().filter_map(|x| x.book_title.clone()))
        .chain(rb.iter().map(|x| x.title.clone()))
        .collect();
    assert_eq!(names.len(), 1, "every surface names the book identically: {names:?}");
}

// ═══ D/E · ONE SPARSE ROW MUST NOT SUPPRESS ANOTHER BOOK'S RESULTS ═══════════════════════════════

#[test]
fn a_legitimate_book_with_no_base_title_cannot_empty_the_references_surface() {
    // A row with a format and no title IS a book — `IS_A_BOOK` is a disjunction precisely so the
    // format alone proves it. No released importer has ever written one (both have always fallen back
    // to the filename), so this is reached only by data Sard did not write; it is held because one
    // unnameable row previously took the whole surface down, real books included.
    let conn = fresh(None);
    book(&conn, "named", "A Named Book");
    ref_save(&conn, "named", "p1", "p1", 1, "g1", None).unwrap();
    conn.execute(
        "INSERT INTO books(id, file_path, format, added_at) VALUES('sparse','sparse.epub','epub',1)",
        [],
    )
    .unwrap();
    ref_save(&conn, "sparse", "p2", "p2", 1, "g2", None).unwrap();
    book(&conn, "other", "Another Named Book");
    ref_save(&conn, "other", "p3", "p3", 1, "g3", None).unwrap();

    let rb = refs_reps_books(&conn).expect("one nameless row must not empty the surface");
    let ids: Vec<&str> = rb.iter().map(|x| x.id.as_str()).collect();
    assert!(ids.contains(&"named"), "the named book is still listed");
    assert!(ids.contains(&"other"), "and so is the other one");
    assert!(ids.contains(&"sparse"), "the nameless book is a book, so it is listed too");

    // NO TITLE IS INVENTED FOR IT. It is shown with an empty name — which is exactly what this view
    // already renders for an absent one — rather than given a name it does not have.
    let sparse = rb.iter().find(|x| x.id == "sparse").unwrap();
    assert_eq!(sparse.title, "", "an absent name stays absent; nothing is fabricated");
    let named = rb.iter().find(|x| x.id == "named").unwrap();
    assert_eq!(named.title, "A Named Book", "and a real name is untouched");
}
