//! AN IMPORTED BOOK IS THE READER'S, WHETHER OR NOT IT HAS BEEN FILED YET.
//!
//! Two facts of different weight travel together through an import, and these tests exist to keep
//! them from being confused again:
//!
//!   THE BOOK    - on disk, with its metadata, its annotations, its reading position; recognised by
//!                 de-duplication through its content id. This is what the reader added.
//!   ITS PLACE   - which shelf holds it, in what order. Organisational, changeable, and perfectly
//!                 answerable with "none": a book on no shelf is unfiled, which is a real state the
//!                 library draws, not an error.
//!
//! The defect that started this was the library reading the SECOND as if it were the first: every
//! container was built from `placements` rows, so a book whose row was missing belonged to no
//! container and was drawn by no grouped format - while it was on disk, counted, and answered
//! "duplicate" to a second import. In the library and nowhere in it.
//!
//! The cure is NOT to make the place compulsory. A book whose filing failed must still be the
//! reader's book, or a filing clerk gets a veto over ownership: de-duplication would know the id for
//! ever while nothing could show it, and the reader could never add that book again. So the book row
//! is committed on its own, the filing is attempted afterwards, and the library derives "unfiled"
//! from "no shelf holds it" rather than from the row that records it.
//!
//! These tests hold both halves: that an ordinary import is filed, and that an import whose filing
//! cannot be written is still, in every way the reader can observe, a book in their library.

use std::io::{Cursor, Write as _};
use std::path::Path;

use rusqlite::Connection;

use super::import_books;

const UNFILED: &str = "__unshelved";

/// The smallest EPUB the importer will accept, with a caller-chosen title so two fixtures differ in
/// their bytes — and therefore in their content-hash id, which is what de-duplication keys on.
fn epub(title: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        z.start_file("mimetype", stored).unwrap();
        z.write_all(b"application/epub+zip").unwrap();
        let deflate = zip::write::SimpleFileOptions::default();
        z.start_file("META-INF/container.xml", deflate).unwrap();
        z.write_all(
            br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
        )
        .unwrap();
        z.start_file("OEBPS/content.opf", deflate).unwrap();
        z.write_all(
            format!(
                r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:{title}</dc:identifier><dc:title>{title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/></spine></package>"#
            )
            .as_bytes(),
        )
        .unwrap();
        z.start_file("OEBPS/c0.xhtml", deflate).unwrap();
        z.write_all(
            format!(r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><p>Body text.</p></body></html>"#)
                .as_bytes(),
        )
        .unwrap();
        z.finish().unwrap();
    }
    buf
}

/// Import one freshly built book into a fresh database, and hand back the connection and its id.
fn import_one(tag: &str, title: &str) -> (Connection, std::path::PathBuf, String) {
    let base = std::env::temp_dir().join(format!("sard_placement_{tag}"));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join(format!("{title}.epub"));
    std::fs::write(&src, epub(title)).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "the fixture must actually import: {:?}", res[0].message);
    let id = res[0].id.clone();
    (conn, base, id)
}

fn containers(conn: &Connection, id: &str) -> Vec<String> {
    let mut stmt = conn.prepare("SELECT container FROM placements WHERE book_id=?1 ORDER BY container").unwrap();
    let rows = stmt.query_map([id], |r| r.get::<_, String>(0)).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

/// THE INVARIANT ITSELF. A book that exists is a book that has somewhere to be.
#[test]
fn an_imported_book_lands_among_the_unfiled() {
    let (conn, base, id) = import_one("lands", "Landing");

    assert_eq!(
        containers(&conn, &id),
        vec![UNFILED.to_string()],
        "a newly imported book belongs to the unfiled run and nothing else"
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// The ordinary path, end to end: a book imported with nothing in the way is both registered AND
/// filed, and the two agree.
#[test]
fn an_ordinary_import_is_both_registered_and_filed() {
    let (conn, base, id) = import_one("noplace", "Placeless");

    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    let places: i64 = conn.query_row("SELECT COUNT(*) FROM placements WHERE book_id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "the book row is written");
    assert_eq!(places, 1, "and, nothing having gone wrong, so is its place");

    let _ = std::fs::remove_dir_all(&base);
}

/// Importing the same bytes twice is refused, and the refusal changes nothing — in particular it
/// does not leave a second, placeless row behind, which is how a de-duplicated book could otherwise
/// come to exist without being anywhere.
#[test]
fn a_refused_duplicate_leaves_the_placement_alone() {
    let (conn, base, id) = import_one("dup", "Doubled");
    let src = base.join("Doubled.epub");

    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate");
    assert_eq!(again[0].id, id, "the duplicate is recognised as the same book");

    assert_eq!(containers(&conn, &id), vec![UNFILED.to_string()], "its place is untouched");
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM placements", [], |r| r.get(0)).unwrap();
    assert_eq!(total, 1, "and no second placement row was written");

    let _ = std::fs::remove_dir_all(&base);
}

/// A FILING FAILURE MUST NOT COST THE READER THE BOOK.
///
/// The placement write is made to fail for real - a trigger that refuses every insert - rather than
/// by asserting that some error path exists. What must survive it is everything the reader can
/// observe: the book is imported, it is in `books`, it keeps its metadata, and its file is stored.
#[test]
fn a_book_survives_a_filing_failure_and_is_merely_unfiled() {
    let base = std::env::temp_dir().join("sard_placement_nofile");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join("Unfilable.epub");
    std::fs::write(&src, epub("Unfilable")).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_placement BEFORE INSERT ON placements \
         BEGIN SELECT RAISE(ABORT, 'no placements today'); END;",
    )
    .unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "the BOOK imported: filing is not what makes it a book");
    let id = res[0].id.clone();

    // The book is entirely present, and carries everything an imported book carries.
    let (title, path): (String, String) = conn
        .query_row("SELECT title, file_path FROM books WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("the book row is there");
    assert_eq!(title, "Unfilable");
    assert!(std::path::Path::new(&path).is_file(), "and its file is in managed storage");

    // It has no place - which is a state, not a fault. The library reads "no shelf holds it" as
    // "unfiled", so this is exactly what an unfiled book looks like before a row has been written.
    assert!(containers(&conn, &id).is_empty(), "no placement row was written, as the trigger required");
    let shelved: i64 = conn
        .query_row("SELECT COUNT(*) FROM placements WHERE book_id=?1 AND container<>?2", (&id, UNFILED), |r| r.get(0))
        .unwrap();
    assert_eq!(shelved, 0, "no shelf holds it - so the library shows it among the unfiled");

    let _ = std::fs::remove_dir_all(&base);
}

/// AND IT IS NOT A TRAP. The one sentence the reader must never meet is "this book already exists"
/// from a library that cannot show it. Here the book IS recognised as a duplicate - correctly, it is
/// genuinely there - and that recognition is harmless, because the book is reachable.
#[test]
fn an_unfiled_book_is_recognised_without_becoming_unreachable() {
    let base = std::env::temp_dir().join("sard_placement_trap");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join("Trapped.epub");
    std::fs::write(&src, epub("Trapped")).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_placement BEFORE INSERT ON placements \
         BEGIN SELECT RAISE(ABORT, 'no placements today'); END;",
    )
    .unwrap();
    let id = import_books(&conn, &base, &[src.to_string_lossy().into_owned()])[0].id.clone();
    assert!(containers(&conn, &id).is_empty());

    // De-duplication answers "duplicate" - and it is telling the truth.
    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate");

    // What makes that harmless is that the book is genuinely reachable: the library lists it, so it
    // is counted, searchable and openable, and it needs no second import to be recovered.
    let listed = crate::library::list_books(&conn, "title", "asc", None, None, None).unwrap();
    assert!(listed.iter().any(|b| b.id == id), "the query that feeds the library, the count and search holds it");

    // AND IT RECOVERS BY ITSELF. The next placement write that touches it settles the invariant, so
    // a library repairs itself as it is used - no migration, no re-import, nothing for the reader
    // to do.
    conn.execute_batch("DROP TRIGGER refuse_placement").unwrap();
    crate::library::placement::settle_unfiled(&conn, &id).unwrap();
    assert_eq!(containers(&conn, &id), vec![UNFILED.to_string()], "it files itself the moment it can");

    let _ = std::fs::remove_dir_all(&base);
}

/// AN IMPORT THAT REALLY FAILS still fails, and leaves nothing behind to block a retry. The two
/// failures are different and must stay different: the book could not be registered at all here,
/// so there is no book - and therefore nothing for de-duplication to recognise later.
#[test]
fn a_failed_registration_leaves_nothing_behind() {
    let base = std::env::temp_dir().join("sard_placement_realfail");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join("Broken.epub");
    std::fs::write(&src, epub("Broken")).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_books BEFORE INSERT ON books \
         BEGIN SELECT RAISE(ABORT, 'no books today'); END;",
    )
    .unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "error", "a book that cannot be registered has not been imported");
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "and nothing was left behind");

    // So the reader is free to add it once the cause is gone - no duplicate verdict in the way.
    conn.execute_batch("DROP TRIGGER refuse_books").unwrap();
    let retry = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(retry[0].status, "imported", "a failed import never blocks a later one");
    assert_eq!(containers(&conn, &retry[0].id), vec![UNFILED.to_string()]);

    let _ = std::fs::remove_dir_all(&base);
}

/// A PDF takes a different branch of the importer, and the invariant is not the EPUB branch's
/// private business — it is the library's.
#[test]
fn a_pdf_lands_among_the_unfiled_too() {
    let base = std::env::temp_dir().join("sard_placement_pdf");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join("Paper.pdf");
    std::fs::write(&src, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").unwrap();

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "{:?}", res[0].message);
    assert_eq!(containers(&conn, &res[0].id), vec![UNFILED.to_string()], "a PDF has a place like anything else");

    let _ = std::fs::remove_dir_all(&base);
}

/// The unfiled run is not where a book STAYS — it is where it is when nothing else holds it.
/// Filing it moves it out, and the invariant still holds: it is somewhere, just not there.
#[test]
fn filing_an_imported_book_moves_it_out_of_the_unfiled_run() {
    let (conn, base, id) = import_one("file", "Filed");
    conn.execute(
        "INSERT INTO collections(id, name, sort_order, created_at) VALUES('sh', 'A shelf', 0, 0)",
        [],
    )
    .unwrap();

    crate::library::placement::place_book(&conn, &id, "sh", None, None).unwrap();

    assert_eq!(containers(&conn, &id), vec!["sh".to_string()], "on a shelf, and no longer unfiled");

    let _ = std::fs::remove_dir_all(&base);
}

/// And the reverse: taken off its only shelf, it settles back among the unfiled rather than
/// vanishing — which is the other half of what «خارج الخزائن» is for.
#[test]
fn unfiling_it_again_puts_it_back_in_the_run() {
    let (conn, base, id) = import_one("unfile", "Unfiled");
    conn.execute(
        "INSERT INTO collections(id, name, sort_order, created_at) VALUES('sh', 'A shelf', 0, 0)",
        [],
    )
    .unwrap();
    crate::library::placement::place_book(&conn, &id, "sh", None, None).unwrap();
    assert_eq!(containers(&conn, &id), vec!["sh".to_string()]);

    crate::library::collection_remove_book(&conn, "sh", &id).unwrap();

    assert_eq!(
        containers(&conn, &id),
        vec![UNFILED.to_string()],
        "a book taken off its last shelf is unfiled, never placeless"
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// The path `Path` import uses for storage is the app data directory, and the test above hands it a
/// temporary one — this keeps that assumption honest if the signature ever changes.
#[allow(dead_code)]
fn _signature_guard(conn: &Connection, dir: &Path, paths: &[String]) {
    let _ = import_books(conn, dir, paths);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A BRIDGE ROW IS NOT A BOOK.
//
// `books::ensure` writes a row so reading progress has a parent — an id, a path, a timestamp, and
// nothing else. It is reached on every book open, and it can therefore exist for a file the reader
// has not imported: after the book was deleted and something opened it again by id, or any other
// route that opens before importing.
//
// THE FAILURE IT CAUSED, WHICH THESE TESTS EXIST TO KEEP AWAY. De-duplication asked only whether a
// row existed, so a bridge row answered "Already in your library" — while the book had no format, no
// title and no placement, so every grouped view drew it nowhere and any shelf filter excluded it. The
// reader was told they already had a book that the library could not show them, and no second
// attempt could ever succeed. Both halves are asserted below, because fixing either alone leaves the
// reader stuck.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Build a fixture on disk and return its bytes, path and the content id the importer will use.
fn fixture(tag: &str, title: &str) -> (std::path::PathBuf, std::path::PathBuf, String) {
    let base = std::env::temp_dir().join(format!("sard_bridge_{tag}"));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join(format!("{title}.epub"));
    let bytes = epub(title);
    std::fs::write(&src, &bytes).unwrap();
    let id = super::hex_sha256(&bytes);
    (base, src, id)
}

fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn
}

#[test]
fn a_bridge_row_does_not_block_a_real_import() {
    let (base, src, id) = fixture("blocks", "Bridged");
    let conn = fresh_db();

    // The exact failure state: a row for this content id, carrying nothing, filed nowhere by an
    // older build that did not file bridges.
    conn.execute(
        "INSERT INTO books(id, file_path, added_at) VALUES(?1, ?2, 0)",
        rusqlite::params![id, src.to_string_lossy()],
    )
    .unwrap();
    assert!(containers(&conn, &id).is_empty(), "the fixture must start unplaced");

    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(
        res[0].status, "imported",
        "a bridge row must not be mistaken for a book the reader already has: {:?}",
        res[0].message
    );

    // And the import must have made it a real book, not merely reported one.
    let (title, format): (Option<String>, Option<String>) = conn
        .query_row("SELECT title, format FROM books WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(title.as_deref(), Some("Bridged"), "the import writes the real title over the bridge");
    assert_eq!(format.as_deref(), Some("epub"), "and the format that tells a book from a bridge");
    assert_eq!(containers(&conn, &id), vec![UNFILED.to_string()], "and it is filed, like any import");

    // The library can see it: one row, and no duplicate row left behind by the upsert.
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "the bridge is filled in place, never doubled");

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn an_import_over_a_bridge_row_keeps_reading_progress() {
    let (base, src, id) = fixture("progress", "Resumed");
    let conn = fresh_db();

    // A reader who was already reading this file before it was imported.
    super::ensure(&conn, &id, &src.to_string_lossy()).unwrap();
    crate::library::progress_save(&conn, &id, "epubcfi(/6/14!/4/2/1:7)", 0.42).unwrap();

    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "{:?}", res[0].message);

    // `reading_progress` cascades on delete, so an import that replaced the row rather than updating
    // it would take the reader's place in the book with it. This is why the upsert exists.
    let (cfi, frac): (String, f64) = conn
        .query_row("SELECT locator_cfi, fraction FROM reading_progress WHERE book_id=?1", [&id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(cfi, "epubcfi(/6/14!/4/2/1:7)", "the reader keeps their place");
    assert!((frac - 0.42).abs() < 1e-9, "and how far through they were");

    let _ = std::fs::remove_dir_all(&base);
}

/// Every book the library SHOWS has somewhere to be. That is the invariant worth keeping, and it is
/// not "every row is filed": a bridge row is not a book, so it is neither shown nor filed.
#[test]
fn every_book_the_library_lists_has_a_placement() {
    let (base, src, id) = fixture("unfiled", "Filed");
    let conn = fresh_db();

    // A bridge first, so the database holds one while the invariant is checked.
    super::ensure(&conn, &id, &src.to_string_lossy()).unwrap();
    // Then the import, over that same row.
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "{:?}", res[0].message);
    assert_eq!(containers(&conn, &id), vec![UNFILED.to_string()], "filed exactly once");

    let listed = crate::library::list_books(&conn, "date_added", "desc", None, None, None).unwrap();
    for b in &listed {
        assert!(
            !containers(&conn, &b.id).is_empty(),
            "the library listed a book with no placement: {}",
            b.id
        );
    }
    assert_eq!(listed.len(), 1, "one book, listed once");

    let _ = std::fs::remove_dir_all(&base);
}

/// A bridge row is scaffolding. It must not be counted, drawn, or filed — filing it is exactly what
/// turned one into an untitled, coverless card on the reader's shelves after a restart.
#[test]
fn a_bridge_row_is_invisible_to_the_library_and_is_never_filed() {
    let (base, src, id) = fixture("invisible", "Bridged");
    let conn = fresh_db();

    super::ensure(&conn, &id, &src.to_string_lossy()).unwrap();

    let listed = crate::library::list_books(&conn, "date_added", "desc", None, None, None).unwrap();
    assert!(listed.is_empty(), "a bridge row is not a book the library has to show");
    assert!(containers(&conn, &id).is_empty(), "and nothing files it");

    // The launch sweep is what used to dress it as a book. It must pass over it now.
    let filed = crate::library::placement::ensure(&conn).unwrap();
    assert_eq!(filed, 0, "the launch sweep files books, not scaffolding");
    assert!(containers(&conn, &id).is_empty(), "so it is still unfiled after a restart");

    // And the reader's own library is unchanged by its presence.
    let listed_again = crate::library::list_books(&conn, "date_added", "desc", None, None, None).unwrap();
    assert!(listed_again.is_empty(), "still nothing to show");

    let _ = std::fs::remove_dir_all(&base);
}

/// THE OTHER ROUTE TO THE SAME SYMPTOM. Filing is best-effort, so an import can write a whole book
/// and fail to place it: a real book, correctly recognised as a duplicate, invisible under any shelf.
/// The reader's own response is to add it again — so that attempt repairs the placement.
#[test]
fn a_stranded_book_is_repaired_when_the_reader_tries_again() {
    let (conn, base, id) = import_one("stranded", "Stranded");
    let src = base.join("Stranded.epub");

    // The state a failed filing leaves behind.
    conn.execute("DELETE FROM placements WHERE book_id = ?1", [&id]).unwrap();
    assert!(containers(&conn, &id).is_empty(), "the fixture must start stranded");

    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate", "it is genuinely already the reader's book");
    assert_eq!(
        containers(&conn, &id),
        vec![UNFILED.to_string()],
        "and answering the reader put it back where they can find it"
    );

    let listed = crate::library::list_books(&conn, "date_added", "desc", None, None, None).unwrap();
    assert_eq!(listed.len(), 1, "one book, and no second row made by the retry");

    let _ = std::fs::remove_dir_all(&base);
}

/// The sequence the investigation named: a book is deleted, something opens it again by its id, and
/// the bridge row comes back. That row must not become a headstone the reader can never dig up.
#[test]
fn a_register_after_a_delete_leaves_the_book_addable_again() {
    let (base, src, id) = fixture("resurrect", "Returned");
    let conn = fresh_db();

    let first = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(first[0].status, "imported", "{:?}", first[0].message);
    let managed: String = conn
        .query_row("SELECT file_path FROM books WHERE id=?1", [&id], |r| r.get(0))
        .unwrap();

    // Gone from the library, with every child row cascading away.
    conn.execute("DELETE FROM books WHERE id = ?1", [&id]).unwrap();
    assert!(containers(&conn, &id).is_empty(), "the placement cascades with the book");

    // A stale reference opens it again: the bridge row returns, under the same content id.
    super::ensure(&conn, &id, &managed).unwrap();
    let resurrected: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(resurrected, 1, "opening a deleted book does write a row again");

    // And the reader can still add the book back — which is the whole point.
    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(
        again[0].status, "imported",
        "a resurrected bridge row must not refuse the book for ever: {:?}",
        again[0].message
    );
    let format: Option<String> = conn
        .query_row("SELECT format FROM books WHERE id=?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(format.as_deref(), Some("epub"), "and it is a whole book again");
    assert_eq!(containers(&conn, &id), vec![UNFILED.to_string()], "filed, as any import is");

    let _ = std::fs::remove_dir_all(&base);
}

/// D — A BOOK ON A SHELF THE READER CHOSE. The reconciliation on a duplicate must be able to see a
/// book that is filed and do nothing at all; moving someone's book is worse than the bug.
#[test]
fn a_duplicate_never_disturbs_a_book_the_reader_shelved() {
    let (conn, base, id) = import_one("shelved", "Shelved");
    let src = base.join("Shelved.epub");

    crate::library::placement::place_book(&conn, &id, "sh", None, None).unwrap();
    let before = containers(&conn, &id);
    assert_eq!(before, vec!["sh".to_string()], "the fixture must start on the reader's own shelf");
    let rank_before: Option<String> = conn
        .query_row("SELECT rank FROM placements WHERE book_id=?1 AND container='sh'", [&id], |r| r.get(0))
        .unwrap();

    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate");

    assert_eq!(containers(&conn, &id), before, "the shelf is exactly as it was");
    let rank_after: Option<String> = conn
        .query_row("SELECT rank FROM placements WHERE book_id=?1 AND container='sh'", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(rank_after, rank_before, "and so is its place in that shelf's order");
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM placements WHERE book_id=?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "no second placement was invented");

    let _ = std::fs::remove_dir_all(&base);
}

/// The reconciliation runs on EVERY duplicate, so it must be idempotent: the tenth attempt must leave
/// the database exactly as the second did.
#[test]
fn reconciling_a_duplicate_is_idempotent() {
    let (conn, base, id) = import_one("idem", "Idem");
    let src = base.join("Idem.epub");
    let snapshot = |c: &Connection| -> (i64, i64, Vec<String>) {
        (
            c.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap(),
            c.query_row("SELECT COUNT(*) FROM placements", [], |r| r.get(0)).unwrap(),
            containers(c, &id),
        )
    };

    let first = snapshot(&conn);
    for _ in 0..5 {
        let r = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
        assert_eq!(r[0].status, "duplicate");
    }
    assert_eq!(snapshot(&conn), first, "five more attempts changed nothing");

    let _ = std::fs::remove_dir_all(&base);
}

/// F — THE ROW IS RECONCILED IN PLACE, NEVER RE-ADDED. Everything hanging off the book's id must
/// survive an import that meets an existing row, whichever kind of row it meets.
#[test]
fn an_import_over_an_existing_row_keeps_every_child_of_that_book() {
    let (conn, base, id) = import_one("children", "Children");
    let src = base.join("Children.epub");

    // The things a reader accumulates, each hung off the book's id.
    crate::library::progress_save(&conn, &id, "epubcfi(/6/4!/2/1:3)", 0.31).unwrap();
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, end_cfi, color, text_excerpt, created_at)          VALUES('h1',?1,'s','e','amber','a passage',1)",
        [&id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes(id, book_id, locator_cfi, body, created_at, updated_at) VALUES('n1',?1,'cfi','a note',1,1)",
        [&id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO bookmarks(id, book_id, locator_cfi, created_at) VALUES('bm1',?1,'cfi',1)",
        [&id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1,'title','The Reader''s Own Title')",
        [&id],
    )
    .unwrap();

    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate");

    let count = |t: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {t} WHERE book_id = ?1"), [&id], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count("reading_progress"), 1, "the reader keeps their place");
    assert_eq!(count("highlights"), 1, "and their highlights");
    assert_eq!(count("notes"), 1, "and their notes");
    assert_eq!(count("bookmarks"), 1, "and their bookmarks");
    assert_eq!(count("metadata_overrides"), 1, "and the title they chose themselves");
    let kept: String = conn
        .query_row(
            "SELECT value FROM metadata_overrides WHERE book_id=?1 AND field='title'",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, "The Reader's Own Title", "unchanged, not rewritten by the import");

    let _ = std::fs::remove_dir_all(&base);
}

/// A bridge row must not be gathered by a rule shelf either — "recently added" needs only a row to
/// exist, and "reading" joins the very table a bridge exists to support.
#[test]
fn a_bridge_row_is_gathered_by_no_rule_shelf() {
    let (base, src, id) = fixture("rules", "Ruled");
    let conn = fresh_db();

    super::ensure(&conn, &id, &src.to_string_lossy()).unwrap();
    crate::library::progress_save(&conn, &id, "epubcfi(/6/4!/2/1:1)", 0.5).unwrap();

    for rule in ["added", "reading", "finished"] {
        let n = crate::library::structure::auto_count_for_tests(&conn, rule).unwrap();
        assert_eq!(n, 0, "rule shelf «{rule}» counted a bridge row");
    }

    let _ = std::fs::remove_dir_all(&base);
}

/// §5 — A LIBRARY THAT LOOKS LIKE SOMEONE'S. The question this answers is the only one that matters
/// for shipping: can the distinction alter, hide, move, duplicate or delete a book the reader has?
///
/// It builds the states a real library is made of — ordinary books, a book on a shelf of the
/// reader's own, a book being read, a book with marks — and then puts the two pathological rows
/// beside them, because the fix must be harmless in their company and not merely in isolation.
#[test]
fn nothing_legitimate_is_altered_by_the_distinction() {
    let base = std::env::temp_dir().join("sard_bridge_realistic");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let conn = fresh_db();

    // Six ordinary books, as a reader would have.
    let mut ids = Vec::new();
    for name in ["One", "Two", "Three", "Four", "Five", "Six"] {
        let src = base.join(format!("{name}.epub"));
        std::fs::write(&src, epub(name)).unwrap();
        let r = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
        assert_eq!(r[0].status, "imported", "{:?}", r[0].message);
        ids.push(r[0].id.clone());
    }

    // One on a shelf of their own; one being read; one carrying marks.
    crate::library::placement::place_book(&conn, &ids[0], "sh", None, None).unwrap();
    crate::library::progress_save(&conn, &ids[1], "epubcfi(/6/4!/2/1:9)", 0.44).unwrap();
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, end_cfi, color, text_excerpt, created_at) \
         VALUES('h',?1,'s','e','amber','kept',1)",
        [&ids[2]],
    )
    .unwrap();

    // The two pathological rows, side by side with all of that.
    let ghost = base.join("Ghost.epub");
    std::fs::write(&ghost, epub("Ghost")).unwrap();
    let ghost_id = super::hex_sha256(&epub("Ghost"));
    super::ensure(&conn, &ghost_id, &ghost.to_string_lossy()).unwrap(); // a bridge
    conn.execute("DELETE FROM placements WHERE book_id = ?1", [&ids[5]]).unwrap(); // a stranded book

    // WHAT THE READER HAS, BEFORE.
    let before = crate::library::list_books(&conn, "title", "asc", None, None, None).unwrap();
    let names_before: Vec<String> = before.iter().filter_map(|b| b.title.clone()).collect();
    assert_eq!(before.len(), 6, "six books, and the bridge is not among them");

    // The launch sweep, then the reader adding a book they already have.
    crate::library::placement::ensure(&conn).unwrap();
    let src6 = base.join("Six.epub");
    let dup = import_books(&conn, &base, &[src6.to_string_lossy().into_owned()]);
    assert_eq!(dup[0].status, "duplicate", "a book they have is still a book they have");

    // WHAT THE READER HAS, AFTER. Nothing lost, nothing renamed, nothing doubled.
    let after = crate::library::list_books(&conn, "title", "asc", None, None, None).unwrap();
    let names_after: Vec<String> = after.iter().filter_map(|b| b.title.clone()).collect();
    assert_eq!(names_after, names_before, "the same books, with the same names, in the same order");
    assert_eq!(after.len(), 6, "and no seventh row invented");

    // The shelf the reader chose is untouched; the stranded book was put back where it belongs.
    assert_eq!(containers(&conn, &ids[0]), vec!["sh".to_string()], "their own shelf is theirs still");
    assert_eq!(containers(&conn, &ids[5]), vec![UNFILED.to_string()], "the stranded book is filed again");

    // Their reading and their marks are where they left them.
    let frac: f64 = conn
        .query_row("SELECT fraction FROM reading_progress WHERE book_id=?1", [&ids[1]], |r| r.get(0))
        .unwrap();
    assert!((frac - 0.44).abs() < 1e-9, "their place in the book they were reading");
    let marks: i64 = conn
        .query_row("SELECT COUNT(*) FROM highlights WHERE book_id=?1", [&ids[2]], |r| r.get(0))
        .unwrap();
    assert_eq!(marks, 1, "and the passage they marked");

    // Every book the library shows has somewhere to be — both directions of the invariant.
    for b in &after {
        assert!(!containers(&conn, &b.id).is_empty(), "a listed book with no placement: {}", b.id);
    }
    let placeless_books: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM books b LEFT JOIN placements p ON p.book_id = b.id \
                 WHERE p.book_id IS NULL AND {}",
                super::IS_A_BOOK
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(placeless_books, 0, "no BOOK in this database is placeless");

    // And the ghost is still a ghost: present for its id, absent from everything the reader sees.
    assert!(!after.iter().any(|b| b.id == ghost_id), "the bridge is not shown");
    assert!(containers(&conn, &ghost_id).is_empty(), "nor filed");
    for rule in ["added", "reading", "finished"] {
        let listed = crate::library::structure::auto_count_for_tests(&conn, rule).unwrap();
        assert!(listed <= 6, "rule shelf «{rule}» counted more than the reader's books: {listed}");
    }

    let _ = std::fs::remove_dir_all(&base);
}

/// A book the reader genuinely has is still refused a second time. The fix narrows de-duplication;
/// it must not switch it off.
#[test]
fn a_real_book_is_still_a_duplicate() {
    let (conn, base, id) = import_one("still_dup", "Twice");
    let src = base.join("Twice.epub");

    let again = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate", "an imported book is still recognised");
    assert_eq!(again[0].id, id, "and recognised as the same book");

    let _ = std::fs::remove_dir_all(&base);
}
