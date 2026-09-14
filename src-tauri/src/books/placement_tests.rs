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
