//! RESILIENCE-1 / WP-3 — the database is the single source of truth for a book's name.
//!
//! The rule has two halves and this module pins both:
//!
//!   1. What the FILE says is an EXTRACTION, and an extraction may only fill a gap. It must never
//!      overwrite what a reader typed, and it must never be written through the override table
//!      (which would be indistinguishable from a reader's edit and would destroy the original).
//!   2. What every surface DISPLAYS is `COALESCE(override, extracted)` — one value, so the library
//!      card, the reading chrome and a shared photo card cannot disagree.
//!
//! The bug that motivated (1) was live in the shipped code: opening a renamed PDF called
//! `book_update`, so PDF.js's embedded title replaced the reader's own title permanently.

use rusqlite::Connection;

use super::{get_book, set_extracted_metadata, update_book};

/// A migrated database holding one book with a KNOWN extracted title/author.
fn db_with_book(title: Option<&str>, author: Option<&str>) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, author, added_at, title_fold, author_fold) \
         VALUES('b1', 'M:\\books\\x.epub', 'epub', ?1, ?2, 0, afold(?1), afold(?2))",
        rusqlite::params![title, author],
    )
    .unwrap();
    conn
}

fn overrides(conn: &Connection) -> Vec<(String, String)> {
    let mut st = conn
        .prepare("SELECT field, value FROM metadata_overrides WHERE book_id='b1' ORDER BY field")
        .unwrap();
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

/// The BASE column, i.e. what was extracted — not the effective value `get_book` returns.
fn base(conn: &Connection, col: &str) -> Option<String> {
    conn.query_row(&format!("SELECT {col} FROM books WHERE id='b1'"), [], |r| r.get(0))
        .unwrap()
}

// ── (1) an extraction may only fill a gap ────────────────────────────────────────────────────────

#[test]
fn extraction_fills_an_empty_title() {
    // The self-healing case: a row imported before WP-2's tolerant decoder has no title, the reader
    // opens it, and what foliate parsed is recorded so the LIBRARY agrees on its next visit.
    let conn = db_with_book(None, None);
    let row = set_extracted_metadata(&conn, "b1", Some("Real Title"), Some("Real Author"))
        .unwrap()
        .unwrap();
    assert_eq!(row.title.as_deref(), Some("Real Title"));
    assert_eq!(row.author.as_deref(), Some("Real Author"));
    assert_eq!(base(&conn, "title").as_deref(), Some("Real Title"));
    // …and it was recorded as an EXTRACTION, so nothing pretends the reader typed it.
    assert!(overrides(&conn).is_empty(), "an extraction must not create an override");
}

#[test]
fn extraction_never_replaces_an_existing_extracted_value() {
    let conn = db_with_book(Some("From The File"), Some("File Author"));
    set_extracted_metadata(&conn, "b1", Some("Something Else"), Some("Someone Else")).unwrap();
    assert_eq!(base(&conn, "title").as_deref(), Some("From The File"));
    assert_eq!(base(&conn, "author").as_deref(), Some("File Author"));
}

#[test]
fn extraction_never_overwrites_a_readers_edit() {
    // THE REGRESSION THIS PACKAGE EXISTS FOR. Reader renames the book; the file still says otherwise;
    // opening it must not change what they see. Before WP-3D this path called `update_book`, which
    // wrote the override table — the rename was gone and the original was unrecoverable.
    let conn = db_with_book(None, None);
    update_book(&conn, "b1", Some("My Own Title"), Some("My Own Author"), None, None, None).unwrap();

    set_extracted_metadata(&conn, "b1", Some("Embedded Title"), Some("Embedded Author")).unwrap();

    let row = get_book(&conn, "b1").unwrap().unwrap();
    assert_eq!(row.title.as_deref(), Some("My Own Title"), "the reader's title must win");
    assert_eq!(row.author.as_deref(), Some("My Own Author"));
    // The extraction still landed — in the BASE column, where reverting the override can reach it.
    assert_eq!(base(&conn, "title").as_deref(), Some("Embedded Title"));
    assert_eq!(overrides(&conn).len(), 2, "exactly the reader's two edits, no more");
}

#[test]
fn a_reverted_override_falls_back_to_the_recorded_extraction() {
    // Because the extraction was stored in the base column rather than thrown away, clearing an
    // override reveals the book's own name instead of leaving the reader with nothing.
    let conn = db_with_book(None, None);
    update_book(&conn, "b1", Some("My Own Title"), None, None, None, None).unwrap();
    set_extracted_metadata(&conn, "b1", Some("Embedded Title"), None).unwrap();

    update_book(&conn, "b1", Some(""), None, None, None, None).unwrap(); // empty = clear the override

    let row = get_book(&conn, "b1").unwrap().unwrap();
    assert_eq!(row.title.as_deref(), Some("Embedded Title"));
    assert!(overrides(&conn).is_empty());
}

#[test]
fn blank_and_whitespace_extractions_are_ignored() {
    // PDF.js reports `""` for a PDF with an empty Title entry, and some producers write a run of
    // spaces. Neither is a name, and storing either would make the row look "filled" forever.
    let conn = db_with_book(None, None);
    set_extracted_metadata(&conn, "b1", Some("   "), Some("")).unwrap();
    assert_eq!(base(&conn, "title"), None);
    assert_eq!(base(&conn, "author"), None);
}

#[test]
fn extraction_is_trimmed_before_it_is_stored() {
    let conn = db_with_book(None, None);
    set_extracted_metadata(&conn, "b1", Some("  Padded Title \n"), None).unwrap();
    assert_eq!(base(&conn, "title").as_deref(), Some("Padded Title"));
}

#[test]
fn a_none_field_is_left_completely_alone() {
    // The reader sends only the fields it actually needs healed, so `None` must mean "don't touch",
    // never "clear".
    let conn = db_with_book(Some("Kept"), None);
    set_extracted_metadata(&conn, "b1", None, Some("New Author")).unwrap();
    assert_eq!(base(&conn, "title").as_deref(), Some("Kept"));
    assert_eq!(base(&conn, "author").as_deref(), Some("New Author"));
}

#[test]
fn an_unknown_book_id_returns_none_instead_of_failing() {
    let conn = db_with_book(None, None);
    assert!(set_extracted_metadata(&conn, "nope", Some("T"), None).unwrap().is_none());
}

#[test]
fn extraction_is_idempotent() {
    // It runs on every open of a row that still has a gap; twice must equal once.
    let conn = db_with_book(None, None);
    set_extracted_metadata(&conn, "b1", Some("T"), Some("A")).unwrap();
    let first = get_book(&conn, "b1").unwrap().unwrap();
    set_extracted_metadata(&conn, "b1", Some("T"), Some("A")).unwrap();
    let second = get_book(&conn, "b1").unwrap().unwrap();
    assert_eq!(first.title, second.title);
    assert_eq!(first.author, second.author);
    assert!(overrides(&conn).is_empty());
}

#[test]
fn a_readers_edit_is_trimmed_before_it_is_stored() {
    // Found by the byte-identity harness: the owner's library really does hold "الأنمساخ " with a
    // trailing space. Surrounding whitespace is invisible, never intended, and made the stored value
    // differ from the displayed one — so it is stripped where the value ENTERS the database.
    let conn = db_with_book(None, None);
    update_book(&conn, "b1", Some("  Padded  "), Some(" Author "), None, None, None).unwrap();
    let row = get_book(&conn, "b1").unwrap().unwrap();
    assert_eq!(row.title.as_deref(), Some("Padded"));
    assert_eq!(row.author.as_deref(), Some("Author"));
}

#[test]
fn a_whitespace_only_edit_clears_the_override_rather_than_storing_blanks() {
    // "  " is how a reader asks for the extracted value back; it must behave like an empty box.
    let conn = db_with_book(Some("Extracted"), None);
    update_book(&conn, "b1", Some("Mine"), None, None, None, None).unwrap();
    update_book(&conn, "b1", Some("   "), None, None, None, None).unwrap();
    assert!(overrides(&conn).is_empty());
    assert_eq!(get_book(&conn, "b1").unwrap().unwrap().title.as_deref(), Some("Extracted"));
}

#[test]
fn an_edit_matching_the_extracted_value_apart_from_spacing_stores_no_override() {
    // Retyping the same name with a stray space must not create a redundant override row that then
    // shadows the book's own metadata forever.
    let conn = db_with_book(Some("Alice"), None);
    update_book(&conn, "b1", Some(" Alice "), None, None, None, None).unwrap();
    assert!(overrides(&conn).is_empty());
}

// ── the folded search shadow must follow the EFFECTIVE value ─────────────────────────────────────

#[test]
fn healing_a_title_makes_the_book_findable() {
    // A book with no title cannot be searched for. After the extraction lands, the folded shadow has
    // to be rebuilt or the library search still cannot see it.
    let conn = db_with_book(None, None);
    set_extracted_metadata(&conn, "b1", Some("Alice"), None).unwrap();
    let fold: Option<String> = base(&conn, "title_fold");
    assert_eq!(fold.as_deref(), Some("alice"));
}

#[test]
fn an_extraction_does_not_make_a_renamed_book_findable_under_the_old_name() {
    // The shadow tracks what the reader SEES. Rebuilding it from the base column would resurrect the
    // embedded name in search results while the card shows the override — the same class of
    // disagreement WP-3 exists to end.
    let conn = db_with_book(None, None);
    update_book(&conn, "b1", Some("Renamed"), None, None, None, None).unwrap();
    set_extracted_metadata(&conn, "b1", Some("Embedded"), None).unwrap();
    assert_eq!(base(&conn, "title_fold").as_deref(), Some("renamed"));
}

#[test]
fn arabic_survives_the_round_trip() {
    // PS 5.1 has destroyed Arabic in this project before; the storage path must not.
    let conn = db_with_book(None, None);
    let row = set_extracted_metadata(&conn, "b1", Some("الشوقيات"), Some("أحمد شوقي"))
        .unwrap()
        .unwrap();
    assert_eq!(row.title.as_deref(), Some("الشوقيات"));
    assert_eq!(row.author.as_deref(), Some("أحمد شوقي"));
}

// ── (2) one displayed value, for every surface ───────────────────────────────────────────────────

#[test]
fn get_book_and_list_books_report_the_same_effective_values() {
    // `book_get` (new in WP-3, what the reader now calls) and `library_list_books` (what the library
    // has always called) must be the same book. They share `book_select()`; this proves the sharing
    // is real, so the reading chrome cannot drift from the shelf.
    let conn = db_with_book(Some("Extracted"), Some("Extracted Author"));
    update_book(&conn, "b1", Some("Reader's Title"), None, None, None, None).unwrap();

    let one = get_book(&conn, "b1").unwrap().unwrap();
    let listed = super::list_books(&conn, "title", "asc", None, None, None).unwrap();
    let many = listed.iter().find(|b| b.id == "b1").expect("the book is listed");

    assert_eq!(one.title, many.title);
    assert_eq!(one.author, many.author);
    assert_eq!(one.title.as_deref(), Some("Reader's Title"));
    assert_eq!(one.meta_provenance, many.meta_provenance);
}
