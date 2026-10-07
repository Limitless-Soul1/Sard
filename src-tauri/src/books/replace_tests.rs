//! «REPLACE» KEEPS THE BOOK.
//!
//! A duplicate is offered a replacement, and these tests hold what that replacement may and may not
//! do. A book's id is the SHA-256 of its bytes and a duplicate is recognised by that id, so the file
//! a reader replaces with IS the book — which is what makes it possible to keep everything the reader
//! has built on it. The tests check that promise from the outside: every row in every table that
//! carries the book's id is compared, value for value, before and after.

use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use super::{import_books, replace_file, ReplaceOutcome};

/// A tiny PNG: enough bytes to be a cover the importer will extract.
const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

/// A minimal EPUB the importer accepts, distinct per `title`, optionally with a cover image.
fn epub(title: &str, cover: bool) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        z.start_file("mimetype", stored).unwrap();
        z.write_all(b"application/epub+zip").unwrap();
        let deflate = zip::write::SimpleFileOptions::default();
        z.start_file("META-INF/container.xml", deflate).unwrap();
        z.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        let cover_item = if cover { r#"<item id="cv" href="cover.png" media-type="image/png" properties="cover-image"/>"# } else { "" };
        z.start_file("OEBPS/content.opf", deflate).unwrap();
        z.write_all(format!(r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:{title}</dc:identifier><dc:title>{title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/>{cover_item}</manifest><spine><itemref idref="c0"/></spine></package>"#).as_bytes()).unwrap();
        z.start_file("OEBPS/c0.xhtml", deflate).unwrap();
        z.write_all(format!(r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><p>Body text of {title}.</p></body></html>"#).as_bytes()).unwrap();
        if cover {
            z.start_file("OEBPS/cover.png", stored).unwrap();
            z.write_all(PNG).unwrap();
        }
        z.finish().unwrap();
    }
    buf
}

struct Lib {
    conn: Connection,
    base: PathBuf,
    id: String,
    src: PathBuf,
}

impl Drop for Lib {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// A fresh library holding one imported book; `src` is the reader's own copy of its file.
fn library(tag: &str, cover: bool) -> Lib {
    let base = std::env::temp_dir().join(format!("sard_replace_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("outside")).unwrap();
    let src = base.join("outside").join(format!("{tag}.epub"));
    std::fs::write(&src, epub(tag, cover)).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "the fixture must import: {:?}", res[0].message);
    let id = res[0].id.clone();
    Lib { conn, base, id, src }
}

fn managed(lib: &Lib) -> PathBuf {
    let p: String = lib.conn.query_row("SELECT file_path FROM books WHERE id=?1", [&lib.id], |r| r.get(0)).unwrap();
    PathBuf::from(p)
}

/// Everything a reader can have built on a book, one row in every table that holds the book's id.
fn seed_reader_state(lib: &Lib) {
    let c = &lib.conn;
    let id = lib.id.as_str();
    c.execute_batch("INSERT INTO collections(id, name, created_at) VALUES('S1', 'Shelf One', 1)").unwrap();
    for sql in [
        "INSERT INTO reading_progress(book_id, locator_cfi, fraction, updated_at) VALUES(?1, 'epubcfi(/6/2!/4/2:5)', 0.42, 11)",
        "INSERT INTO highlights(id, book_id, start_cfi, end_cfi, color, text_excerpt, chapter_label, created_at, alpha) VALUES('h1', ?1, 'epubcfi(/6/2!/4/2:1)', 'epubcfi(/6/2!/4/2:9)', 'yellow', 'Body', 'One', 12, 0.5)",
        "INSERT INTO notes(id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at, title) VALUES('n1', ?1, 'h1', 'epubcfi(/6/2!/4/2:1)', 'yellow', 'A note', 'One', 13, 14, 'T')",
        "INSERT INTO bookmarks(id, book_id, locator_cfi, label, created_at, chapter_label, fraction, color) VALUES('b1', ?1, 'epubcfi(/6/2!/4/2:3)', 'here', 15, 'One', 0.3, 'red')",
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1, 'title', 'My own title')",
        "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at, cfi) VALUES('r1', ?1, 'Body', 'body', 1, 'a ref', 16, 17, 'epubcfi(/6/2!/4/2:1)')",
        "INSERT INTO reps(id, book_id, phrase, phrase_fold, replacement, word_count, enabled, created_at, updated_at, cfi) VALUES('p1', ?1, 'Body', 'body', 'Corps', 1, 1, 18, 19, NULL)",
        "INSERT INTO book_index(book_id, toc_json, section_fractions_json, built_at) VALUES(?1, '[]', '[]', 20)",
        "INSERT INTO deposits(id, book_id, sender, inscription, signed, created_at, received_at) VALUES('d1', ?1, 'friend', 'for you', 'F', 21, 22)",
        "INSERT INTO photo_cards(id, book_id, book_title, created_at) VALUES('c1', ?1, 'X', 23)",
        "INSERT INTO view_orders(format, scope, section, book_id, rank, arranged_at) VALUES('covers', 'root', 'all', ?1, 'm', 24)",
        "INSERT INTO placements(book_id, container, rank) VALUES(?1, 'S1', 'm')",
        "INSERT INTO book_collections(book_id, collection_id, position) VALUES(?1, 'S1', 0)",
        "INSERT INTO legacy_memberships(book_id, collection_id, reason) VALUES(?1, 'S9', 'a second manual shelf')",
        "INSERT INTO settings(key, value) VALUES('book_theme:' || ?1, 'moonlit')",
    ] {
        c.execute(sql, [id]).unwrap_or_else(|e| panic!("seed failed: {sql}\n{e}"));
    }
}

/// Every row, in every table carrying `book_id`, plus the book row and its per-book settings — each
/// value rendered, so two snapshots compare equal only if nothing at all changed.
fn snapshot(lib: &Lib) -> Vec<String> {
    let c = &lib.conn;
    let tables: Vec<String> = c
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
    let mut out = Vec::new();
    let mut dump = |sql: &str, label: &str| {
        let mut st = c.prepare(sql).unwrap();
        let n = st.column_count();
        let mut rows = st.query([&lib.id]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let vals: Vec<String> = (0..n).map(|i| match row.get_ref(i).unwrap() {
                ValueRef::Null => "NULL".into(),
                ValueRef::Integer(v) => v.to_string(),
                ValueRef::Real(v) => v.to_string(),
                ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                ValueRef::Blob(b) => format!("blob:{}", b.len()),
            }).collect();
            out.push(format!("{label}: {}", vals.join(" | ")));
        }
    };
    for t in &tables {
        let has_book_id: bool = c
            .prepare(&format!("SELECT 1 FROM pragma_table_info('{t}') WHERE name='book_id'")).unwrap()
            .exists([]).unwrap();
        if has_book_id {
            // No ORDER BY: some of these tables are WITHOUT ROWID. The rendered rows are sorted below.
            dump(&format!("SELECT * FROM \"{t}\" WHERE book_id = ?1"), t);
        }
    }
    dump("SELECT * FROM books WHERE id = ?1", "books");
    dump("SELECT * FROM settings WHERE instr(key, ?1) > 0", "settings");
    out.sort();
    out
}

/// The positive control: a snapshot that silently held nothing would make every comparison pass.
fn assert_seeded(snap: &[String]) {
    for t in [
        "reading_progress", "highlights", "notes", "bookmarks", "metadata_overrides", "refs", "reps",
        "book_index", "deposits", "photo_cards", "view_orders", "placements", "book_collections",
        "legacy_memberships", "books", "settings",
    ] {
        assert!(snap.iter().any(|l| l.starts_with(&format!("{t}: "))), "the snapshot must include {t}: {snap:#?}");
    }
}

/// Every file under the library folder, as a sorted list of relative names.
fn library_files(lib: &Lib) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() { walk(&p, root, out) } else { out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")) }
            }
        }
    }
    let mut v = Vec::new();
    walk(&lib.base.join("library"), &lib.base, &mut v);
    v.sort();
    v
}

fn count(lib: &Lib, sql: &str) -> i64 {
    lib.conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn replace(lib: &Lib, src: &Path) -> Result<ReplaceOutcome, String> {
    replace_file(&lib.conn, &lib.base, &lib.id, &src.to_string_lossy())
}

// ---------------------------------------------------------------------------------------------------

#[test]
fn a_duplicate_carries_the_file_it_came_from() {
    let lib = library("source", false);
    let again = import_books(&lib.conn, &lib.base, &[lib.src.to_string_lossy().into_owned()]);
    assert_eq!(again[0].status, "duplicate");
    assert_eq!(again[0].id, lib.id);
    assert_eq!(again[0].source.as_deref(), Some(lib.src.to_string_lossy().as_ref()), "the offer to replace needs the file");
}

#[test]
fn replacing_an_intact_copy_changes_nothing_at_all() {
    let lib = library("intact", true);
    seed_reader_state(&lib);
    let before = snapshot(&lib);
    assert_seeded(&before);
    let files = library_files(&lib);

    let out = replace(&lib, &lib.src).unwrap();
    assert_eq!(out, ReplaceOutcome { id: lib.id.clone(), restored_file: false, restored_cover: false });
    assert_eq!(snapshot(&lib), before, "not one row of the reader's state moved");
    assert_eq!(library_files(&lib), files, "no file was added, removed or left behind");
}

#[test]
fn a_missing_copy_is_restored_and_the_book_keeps_everything() {
    let lib = library("missing", false);
    seed_reader_state(&lib);
    let before = snapshot(&lib);
    assert_seeded(&before);
    let files = library_files(&lib);
    std::fs::remove_file(managed(&lib)).unwrap();

    let out = replace(&lib, &lib.src).unwrap();
    assert!(out.restored_file, "the stored copy was missing, so it was written");
    assert_eq!(std::fs::read(managed(&lib)).unwrap(), std::fs::read(&lib.src).unwrap());
    assert_eq!(snapshot(&lib), before, "same id, same row, same date added, same annotations, same shelves");
    assert_eq!(library_files(&lib), files, "exactly the files there were — no temporary left behind");
    assert_eq!(count(&lib, "SELECT COUNT(*) FROM books"), 1, "no second row");
}

#[test]
fn a_damaged_copy_is_repaired() {
    let lib = library("damaged", false);
    seed_reader_state(&lib);
    let before = snapshot(&lib);
    assert_seeded(&before);
    std::fs::write(managed(&lib), b"not a book any more").unwrap();

    assert!(replace(&lib, &lib.src).unwrap().restored_file);
    assert_eq!(std::fs::read(managed(&lib)).unwrap(), std::fs::read(&lib.src).unwrap());
    assert_eq!(snapshot(&lib), before);
}

#[test]
fn a_file_that_is_not_this_book_is_refused_and_nothing_moves() {
    let lib = library("other", false);
    seed_reader_state(&lib);
    std::fs::write(managed(&lib), b"damaged").unwrap(); // even a broken copy is not overwritten by the wrong book
    let before = snapshot(&lib);
    let files = library_files(&lib);
    let wrong = lib.base.join("outside").join("another.epub");
    std::fs::write(&wrong, epub("A different book", false)).unwrap();

    let err = replace(&lib, &wrong).unwrap_err();
    assert!(err.contains("not the same book"), "{err}");
    assert_eq!(std::fs::read(managed(&lib)).unwrap(), b"damaged");
    assert_eq!(snapshot(&lib), before);
    assert_eq!(library_files(&lib), files);
}

#[test]
fn a_corrupt_file_is_refused_and_the_original_is_untouched() {
    let lib = library("corrupt", false);
    let original = std::fs::read(managed(&lib)).unwrap();
    let before = snapshot(&lib);
    let mut bytes = std::fs::read(&lib.src).unwrap();
    let n = bytes.len();
    bytes.truncate(n / 2); // a half-downloaded copy of the same book
    let corrupt = lib.base.join("outside").join("corrupt.epub");
    std::fs::write(&corrupt, &bytes).unwrap();

    assert!(replace(&lib, &corrupt).is_err());
    assert_eq!(std::fs::read(managed(&lib)).unwrap(), original);
    assert_eq!(snapshot(&lib), before);
}

#[test]
fn an_unreadable_file_is_refused_and_nothing_moves() {
    let lib = library("unreadable", false);
    let before = snapshot(&lib);
    let files = library_files(&lib);
    let err = replace(&lib, &lib.base.join("outside").join("gone.epub")).unwrap_err();
    assert!(err.contains("Couldn't read"), "{err}");
    assert_eq!(snapshot(&lib), before);
    assert_eq!(library_files(&lib), files);
}

/// A FAILED WRITE leaves the previous state and no temporary file. The stored copy is made
/// impossible to replace — a directory where the file should be — which fails the rename on every
/// platform without depending on permissions.
#[test]
fn a_failed_write_leaves_the_previous_state_and_no_temporary() {
    let lib = library("failwrite", false);
    let target = managed(&lib);
    std::fs::remove_file(&target).unwrap();
    std::fs::create_dir_all(target.join("blocker")).unwrap();
    let files = library_files(&lib);
    let before = snapshot(&lib);

    let err = replace(&lib, &lib.src).unwrap_err();
    assert!(err.contains("Couldn't store the file"), "{err}");
    assert!(target.join("blocker").is_dir(), "what was there is still there");
    assert_eq!(library_files(&lib), files, "the temporary file was removed");
    assert_eq!(snapshot(&lib), before);
}

/// The same, with a real damaged FILE that cannot be overwritten (a read-only file, which Windows
/// refuses to rename over): the damaged bytes are exactly what they were.
#[cfg(windows)]
#[test]
fn a_failed_write_over_a_file_keeps_its_bytes() {
    let lib = library("readonly", false);
    let target = managed(&lib);
    std::fs::write(&target, b"damaged").unwrap();
    let mut perm = std::fs::metadata(&target).unwrap().permissions();
    perm.set_readonly(true);
    std::fs::set_permissions(&target, perm.clone()).unwrap();
    let files = library_files(&lib);

    assert!(replace(&lib, &lib.src).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"damaged");
    assert_eq!(library_files(&lib), files);
    #[allow(clippy::permissions_set_readonly_false)]
    perm.set_readonly(false);
    std::fs::set_permissions(&target, perm).unwrap();
}

#[test]
fn a_bridge_row_is_not_a_book_and_is_not_replaced() {
    let lib = library("bridge", false);
    let bytes = epub("Never imported", false);
    let path = lib.base.join("outside").join("never.epub");
    std::fs::write(&path, &bytes).unwrap();
    let bridge_id = super::hex_sha256(&bytes);
    super::ensure(&lib.conn, &bridge_id, &path.to_string_lossy()).unwrap();
    let books_before = count(&lib, &format!("SELECT COUNT(*) FROM books b WHERE {}", super::IS_A_BOOK));

    let err = replace_file(&lib.conn, &lib.base, &bridge_id, &path.to_string_lossy()).unwrap_err();
    assert!(err.contains("no longer in your library"), "{err}");
    assert_eq!(count(&lib, &format!("SELECT COUNT(*) FROM books b WHERE {}", super::IS_A_BOOK)), books_before, "the bridge did not become a book");
    let bridge: (Option<String>, Option<String>) = lib.conn
        .query_row("SELECT format, title FROM books WHERE id=?1", [&bridge_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(bridge, (None, None), "and it is still exactly a bridge");
}

#[test]
fn a_missing_extracted_cover_is_restored_and_a_readers_cover_is_never_touched() {
    let lib = library("cover", true);
    let cover: String = lib.conn.query_row("SELECT cover_path FROM books WHERE id=?1", [&lib.id], |r| r.get(0)).unwrap();
    assert!(Path::new(&cover).is_file(), "the fixture's cover was extracted on import");
    lib.conn.execute("INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1, 'cover', 'library/covers/mine.png')", [&lib.id]).unwrap();
    std::fs::remove_file(&cover).unwrap();

    let out = replace(&lib, &lib.src).unwrap();
    assert!(out.restored_cover && !out.restored_file);
    assert_eq!(std::fs::read(&cover).unwrap(), PNG, "the book's own cover is back where it was");
    let mine: String = lib.conn.query_row("SELECT value FROM metadata_overrides WHERE book_id=?1 AND field='cover'", [&lib.id], |r| r.get(0)).unwrap();
    assert_eq!(mine, "library/covers/mine.png", "the reader's chosen cover is untouched");

    assert!(!replace(&lib, &lib.src).unwrap().restored_cover, "a cover that is there is left alone");
}

#[test]
fn a_pdf_is_replaced_the_same_way() {
    let base = std::env::temp_dir().join(format!("sard_replace_pdf_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let src = base.join("doc.pdf");
    std::fs::write(&src, b"%PDF-1.4\n% fixture\n").unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let id = import_books(&conn, &base, &[src.to_string_lossy().into_owned()])[0].id.clone();
    let stored: String = conn.query_row("SELECT file_path FROM books WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    std::fs::remove_file(&stored).unwrap();

    let out = replace_file(&conn, &base, &id, &src.to_string_lossy()).unwrap();
    assert!(out.restored_file && !out.restored_cover, "a PDF has no extracted cover to restore here");
    assert_eq!(std::fs::read(&stored).unwrap(), std::fs::read(&src).unwrap());
    let _ = std::fs::remove_dir_all(&base);
}
