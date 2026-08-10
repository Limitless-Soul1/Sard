//! RESILIENCE-1 / WP-2 — the compatibility layer through the REAL import pipeline.
//!
//! Separate from the RAWY-189 test module so those tests keep testing exactly what they always did:
//! a regression in the direction sniff must not be masked by a new file, or vice versa.
//!
//! Every case here is a defect seen in a real book, and each asserts BOTH halves — what the recovery
//! does, and what it must never do to a well-formed book.

use std::io::{Cursor, Write as _};
use std::path::Path;

use rusqlite::Connection;

use super::{backfill_compat, hex_sha256, import_books};

const EN: &str = "The quick brown fox jumps over the lazy dog and keeps running all day long. ";
const AR: &str = "السلام عليكم ورحمة الله وبركاته هذا نص عربي طويل يكفي لتجاوز الحد الأدنى للكشف ";

/// A controllable EPUB. Every knob corresponds to a defect seen in the wild.
struct Build {
    title: Option<String>,
    creator: Option<String>,
    language: Option<String>,
    identifier: String,
    producer: Option<String>,
    /// `mimetype` bytes VERBATIM — so a BOM or a wrong value can be tested exactly.
    mimetype: Vec<u8>,
    mimetype_stored: bool,
    /// Emit a `<metadata>` element at all.
    metadata_block: bool,
    /// Encode the OPF and content documents as windows-1256, declaration included.
    cp1256: bool,
    docs: Vec<(String, String, String)>,
    /// NCX entry count; `None` = no NCX declared at all.
    ncx_entries: Option<usize>,
    heading: Option<String>,
}

impl Default for Build {
    fn default() -> Self {
        Build {
            title: Some("A Good Book".into()),
            creator: Some("A Real Author".into()),
            language: Some("en".into()),
            identifier: "urn:uuid:11111111-2222-3333-4444-555555555555".into(),
            producer: None,
            mimetype: b"application/epub+zip".to_vec(),
            mimetype_stored: true,
            metadata_block: true,
            cp1256: false,
            docs: (0..4).map(|i| (format!("c{i}"), format!("c{i}.xhtml"), EN.repeat(3))).collect(),
            ncx_entries: Some(4),
            heading: None,
        }
    }
}

fn docs_of(n: usize, body: &str) -> Vec<(String, String, String)> {
    (0..n).map(|i| (format!("c{i}"), format!("c{i}.xhtml"), body.to_string())).collect()
}

/// windows-1256 encoder — the inverse of the decoder's table, built by search so a table typo
/// would break BOTH directions and be caught rather than cancel out.
fn to_cp1256(s: &str) -> Vec<u8> {
    s.chars()
        .map(|c| {
            if (c as u32) < 0x80 {
                c as u8
            } else {
                (0u8..128).find(|&i| super::compat::cp1256_char(i) == c).map(|i| i + 0x80).unwrap_or(b'?')
            }
        })
        .collect()
}

fn build(b: &Build) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let opts = zip::write::SimpleFileOptions::default();

        zw.start_file("mimetype", if b.mimetype_stored { stored } else { opts }).unwrap();
        zw.write_all(&b.mimetype).unwrap();

        zw.start_file("META-INF/container.xml", opts).unwrap();
        zw.write_all(br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();

        for (_, href, body) in &b.docs {
            zw.start_file(href.clone(), opts).unwrap();
            let h = b.heading.as_deref().map(|h| format!("<h1>{h}</h1>")).unwrap_or_default();
            let doc = format!("<html><head><title>Unknown</title></head><body>{h}<p>{body}</p></body></html>");
            let bytes = if b.cp1256 { to_cp1256(&doc) } else { doc.into_bytes() };
            zw.write_all(&bytes).unwrap();
        }

        let mut manifest: String = b
            .docs
            .iter()
            .map(|(id, href, _)| format!(r#"<item id="{id}" href="{href}" media-type="application/xhtml+xml"/>"#))
            .collect();
        if b.ncx_entries.is_some() {
            manifest.push_str(r#"<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#);
        }
        let spine: String = b.docs.iter().map(|(id, _, _)| format!(r#"<itemref idref="{id}"/>"#)).collect();
        let meta = if b.metadata_block {
            format!(
                r#"<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">{}{}{}<dc:identifier id="pid">{}</dc:identifier>{}</metadata>"#,
                b.title.as_deref().map(|t| format!("<dc:title>{t}</dc:title>")).unwrap_or_default(),
                b.creator.as_deref().map(|c| format!("<dc:creator>{c}</dc:creator>")).unwrap_or_default(),
                b.language.as_deref().map(|l| format!("<dc:language>{l}</dc:language>")).unwrap_or_default(),
                b.identifier,
                b.producer.as_deref().map(|p| format!(r#"<dc:contributor opf:role="bkp">{p}</dc:contributor>"#)).unwrap_or_default(),
            )
        } else {
            String::new()
        };
        let enc = if b.cp1256 { "windows-1256" } else { "utf-8" };
        let toc_attr = if b.ncx_entries.is_some() { r#" toc="ncx""# } else { "" };
        let opf = format!(
            r#"<?xml version="1.0" encoding="{enc}"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="pid">{meta}<manifest>{manifest}</manifest><spine{toc_attr}>{spine}</spine></package>"#
        );
        zw.start_file("content.opf", opts).unwrap();
        let opf_bytes = if b.cp1256 { to_cp1256(&opf) } else { opf.into_bytes() };
        zw.write_all(&opf_bytes).unwrap();

        if let Some(n) = b.ncx_entries {
            let points: String = (0..n)
                .map(|i| format!(r#"<navPoint id="n{i}"><navLabel><text>C{i}</text></navLabel><content src="c{i}.xhtml"/></navPoint>"#))
                .collect();
            zw.start_file("toc.ncx", opts).unwrap();
            zw.write_all(format!(r#"<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>{points}</navMap></ncx>"#).as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    buf
}

struct Imported {
    status: String,
    message: Option<String>,
    title: Option<String>,
    author: Option<String>,
    dir: Option<String>,
    producer: Option<String>,
    script: Option<String>,
    toc_degenerate: Option<i64>,
    spine_fragmented: Option<i64>,
    provenance: Option<String>,
}

/// Distinguishes two calls that build the SAME bytes. The working directory used to be keyed on the
/// EPUB's hash alone, and several cases here import a byte-identical `Build::default()` book — so
/// two of them landed on one directory and, running on separate threads as cargo does by default,
/// one called `remove_dir_all` while the other was mid-import. The loser read no row back and saw
/// every column as `None`, which reads exactly like a product bug in whichever assertion got there
/// first. It surfaced as `spine_fragmented: None` where `Some(0)` was expected, and it did not
/// reproduce on the next run. The counter makes each call's directory its own.
static IMPORT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn import(bytes: &[u8], filename: &str) -> Imported {
    let seq = IMPORT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir()
        .join(format!("sard_wp2_{seq}_{filename}_{}", &hex_sha256(bytes)[..16]));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("src")).unwrap();
    let src = base.join("src").join(format!("{filename}.epub"));
    std::fs::write(&src, bytes).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    let r = &res[0];
    type Cols = (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>, Option<String>);
    let row: Cols = conn
        .query_row(
            "SELECT title, author, dir, producer, script_detected, toc_degenerate, spine_fragmented, meta_provenance \
             FROM books WHERE id=?1",
            [&r.id],
            |q| Ok((q.get(0)?, q.get(1)?, q.get(2)?, q.get(3)?, q.get(4)?, q.get(5)?, q.get(6)?, q.get(7)?)),
        )
        .unwrap_or((None, None, None, None, None, None, None, None));
    let out = Imported {
        status: r.status.clone(),
        message: r.message.clone(),
        title: row.0,
        author: row.1,
        dir: row.2,
        producer: row.3,
        script: row.4,
        toc_degenerate: row.5,
        spine_fragmented: row.6,
        provenance: row.7,
    };
    let _ = std::fs::remove_dir_all(&base);
    out
}

// ---- 2A: decoding + mimetype tolerance ---------------------------------------------------------

#[test]
fn a_bom_on_the_mimetype_no_longer_rejects_the_book() {
    let mut mimetype = vec![0xEF, 0xBB, 0xBF];
    mimetype.extend_from_slice(b"application/epub+zip");
    let r = import(&build(&Build { mimetype, ..Default::default() }), "bom");
    assert_eq!(r.status, "imported", "rejected: {:?}", r.message);
    assert_eq!(r.title.as_deref(), Some("A Good Book"));
}

#[test]
fn a_compressed_mimetype_still_imports() {
    // الشوقيات in the real corpus does this. Tolerated before WP-2; must stay tolerated.
    let r = import(&build(&Build { mimetype_stored: false, ..Default::default() }), "deflated");
    assert_eq!(r.status, "imported", "{:?}", r.message);
}

#[test]
fn a_missing_mimetype_is_accepted_when_the_book_is_otherwise_readable() {
    let r = import(&build(&Build { mimetype: b"".to_vec(), ..Default::default() }), "nomimetype");
    assert_eq!(r.status, "imported", "rejected: {:?}", r.message);
    assert_eq!(r.title.as_deref(), Some("A Good Book"));
}

#[test]
fn a_zip_that_is_not_an_epub_is_still_refused() {
    // BACKWARD COMPATIBILITY FOR THE REJECTION PATH. Loosening the mimetype check must not let a
    // plain zip in — the OPF must still be parsable for the tolerance to apply.
    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file("mimetype", opts).unwrap();
        zw.write_all(b"application/zip").unwrap();
        zw.start_file("random.txt", opts).unwrap();
        zw.write_all(b"not a book").unwrap();
        zw.finish().unwrap();
    }
    assert_eq!(import(&buf, "notepub").status, "unsupported");
}

#[test]
fn a_windows_1256_opf_recovers_metadata_direction_and_script() {
    // v1.1.0 lost EVERYTHING on this shape: `read_to_string` failed, `parse_epub` returned None, so
    // the book got no title, no author, no language, no cover — and imported as `dir='ltr'`.
    let b = Build {
        title: Some("كتاب عربي".into()),
        creator: Some("مؤلف عربي".into()),
        language: Some("ar".into()),
        cp1256: true,
        docs: docs_of(8, &AR.repeat(8)),
        ncx_entries: Some(8),
        ..Default::default()
    };
    let r = import(&build(&b), "cp1256");
    assert_eq!(r.status, "imported", "{:?}", r.message);
    assert_eq!(r.title.as_deref(), Some("كتاب عربي"), "title recovered from cp1256");
    assert_eq!(r.author.as_deref(), Some("مؤلف عربي"));
    assert_eq!(r.dir.as_deref(), Some("rtl"), "an Arabic book must not import as ltr");
    assert_eq!(r.script.as_deref(), Some("arabic"));
}

// ---- 2C: the metadata ladder -------------------------------------------------------------------

#[test]
fn a_placeholder_title_falls_through_to_the_books_own_heading() {
    let b = Build { title: Some("Unknown".into()), heading: Some("The Real Title".into()), ..Default::default() };
    let r = import(&build(&b), "placeholder_heading");
    assert_eq!(r.title.as_deref(), Some("The Real Title"));
    assert!(r.provenance.as_deref().unwrap().contains(r#""title":"inferred""#), "{:?}", r.provenance);
}

#[test]
fn a_placeholder_title_with_no_heading_falls_through_to_the_filename() {
    let b = Build { title: Some("Unknown".into()), ..Default::default() };
    let r = import(&build(&b), "my_real_filename");
    assert_eq!(r.title.as_deref(), Some("my_real_filename"));
    assert!(r.provenance.as_deref().unwrap().contains(r#""title":"filename""#));
}

#[test]
fn a_real_title_always_wins_and_is_recorded_as_declared() {
    let b = Build { title: Some("A Good Book".into()), heading: Some("Chapter One".into()), ..Default::default() };
    let r = import(&build(&b), "good");
    assert_eq!(r.title.as_deref(), Some("A Good Book"));
    assert!(r.provenance.as_deref().unwrap().contains(r#""title":"declared""#));
}

#[test]
fn a_placeholder_author_becomes_null_never_the_string_unknown() {
    assert_eq!(import(&build(&Build { creator: Some("word".into()), ..Default::default() }), "pa").author, None);
    assert_eq!(import(&build(&Build { creator: None, ..Default::default() }), "na").author, None);
}

#[test]
fn a_missing_metadata_block_does_not_fail_the_import() {
    // `epub.js:178` throws a raw TypeError on this shape at RENDER time (WP-1 classifies it as
    // `book-malformed`); IMPORT must still produce a usable row rather than an empty one.
    let r = import(&build(&Build { metadata_block: false, ..Default::default() }), "nometa");
    assert_eq!(r.status, "imported", "{:?}", r.message);
    assert_eq!(r.title.as_deref(), Some("nometa"), "falls back to the filename");
    assert_eq!(r.author, None);
}

// ---- 2B / 2E: producer + structural flags ------------------------------------------------------

#[test]
fn the_producer_is_recorded_only_when_the_file_names_one() {
    let b = Build { producer: Some("calibre (9.9.0) [https://calibre-ebook.com]".into()), ..Default::default() };
    assert!(import(&build(&b), "calibre").producer.is_some_and(|p| p.contains("calibre")));
    assert_eq!(import(&build(&Build::default()), "noproducer").producer, None);
}

#[test]
fn a_degenerate_toc_is_flagged_and_a_sound_one_is_not() {
    let docs = docs_of(80, EN);
    let b = Build { docs: docs.clone(), ncx_entries: Some(1), ..Default::default() };
    assert_eq!(import(&build(&b), "degenerate").toc_degenerate, Some(1));
    let b = Build { docs, ncx_entries: Some(80), ..Default::default() };
    assert_eq!(import(&build(&b), "sound").toc_degenerate, Some(0));
}

#[test]
fn a_fragmented_spine_is_flagged_and_a_normal_one_is_not() {
    assert_eq!(import(&build(&Build { docs: docs_of(80, EN), ..Default::default() }), "frag").spine_fragmented, Some(1));
    let chunky = docs_of(80, &EN.repeat(120));
    assert_eq!(import(&build(&Build { docs: chunky, ..Default::default() }), "chunky").spine_fragmented, Some(0));
    // Few sections is never fragmentation, whatever their size.
    assert_eq!(import(&build(&Build::default()), "small").spine_fragmented, Some(0));
}

#[test]
fn a_book_with_no_toc_document_records_unknown_not_false() {
    // "declares no TOC" and "declares one that cannot navigate its own book" are different facts,
    // and only the second is worth recovering from.
    assert_eq!(import(&build(&Build { ncx_entries: None, ..Default::default() }), "notoc").toc_degenerate, None);
}

// ---- 2H: the backfill --------------------------------------------------------------------------

/// Import, then clear the WP-2 columns and stamp the old placeholder values — a row as it would
/// look after upgrading from v1.1.0.
fn seed_pre_wp2(base: &Path, bytes: &[u8], filename: &str) -> (Connection, String) {
    std::fs::create_dir_all(base.join("src")).unwrap();
    let src = base.join("src").join(format!("{filename}.epub"));
    std::fs::write(&src, bytes).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, base, &[src.to_string_lossy().into_owned()]);
    let id = res[0].id.clone();
    conn.execute(
        "UPDATE books SET producer=NULL, script_detected=NULL, toc_degenerate=NULL, spine_fragmented=NULL, \
         meta_provenance=NULL, title='Unknown', title_fold=afold('Unknown'), author='Unknown', \
         author_fold=afold('Unknown') WHERE id=?1",
        [&id],
    )
    .unwrap();
    (conn, id)
}

#[test]
fn the_backfill_corrects_a_placeholder_title_and_fills_the_new_columns() {
    let base = std::env::temp_dir().join("sard_wp2_bf_basic");
    let _ = std::fs::remove_dir_all(&base);
    let b = Build { title: Some("Unknown".into()), heading: Some("Recovered Heading".into()), ..Default::default() };
    let (conn, id) = seed_pre_wp2(&base, &build(&b), "seed");

    assert_eq!(backfill_compat(&conn, &base).unwrap(), (1, 1));

    let (title, author, script): (Option<String>, Option<String>, Option<String>) = conn
        .query_row("SELECT title, author, script_detected FROM books WHERE id=?1", [&id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(title.as_deref(), Some("Recovered Heading"));
    assert_eq!(author, None, "Sard's own 'Unknown' fallback is cleared");
    assert_eq!(script.as_deref(), Some("latin"));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_backfill_records_a_placeholder_it_could_not_improve() {
    // A REAL and unavoidable state for a book imported before WP-2: Sard stores every book as
    // `library/<id>.epub`, so the ORIGINAL filename — the rung that rescues the reported book on a
    // fresh import — no longer exists. Verified against a real library: the reported book's
    // title stayed "Unknown" because there was genuinely nothing better to be had.
    //
    // The backfill must NOT invent a title, and must NOT leave the field looking unexamined. It
    // records `"title":"default"` so the UI can present a placeholder as a placeholder.
    let base = std::env::temp_dir().join("sard_wp2_bf_unimprovable");
    let _ = std::fs::remove_dir_all(&base);
    // No heading anywhere, and the seeded title is itself a placeholder → nothing to fall back to.
    let (conn, id) = seed_pre_wp2(&base, &build(&Build { heading: None, ..Default::default() }), "seed");

    let (examined, retitled) = backfill_compat(&conn, &base).unwrap();
    assert_eq!((examined, retitled), (1, 0), "examined, but honestly unable to improve the title");

    let (title, prov): (String, Option<String>) = conn
        .query_row("SELECT title, meta_provenance FROM books WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(title, "Unknown", "no title is invented");
    assert!(
        prov.as_deref().unwrap().contains(r#""title":"default""#),
        "the placeholder must be RECORDED, not left indistinguishable from unexamined: {prov:?}"
    );
}

#[test]
fn the_backfill_records_provenance_for_a_book_it_leaves_alone() {
    let base = std::env::temp_dir().join("sard_wp2_bf_goodprov");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("src")).unwrap();
    let bytes = build(&Build::default());
    let src = base.join("src").join("good.epub");
    std::fs::write(&src, &bytes).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    let id = res[0].id.clone();
    conn.execute("UPDATE books SET script_detected=NULL, meta_provenance=NULL WHERE id=?1", [&id]).unwrap();

    backfill_compat(&conn, &base).unwrap();
    let prov: String = conn.query_row("SELECT meta_provenance FROM books WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert!(prov.contains(r#""title":"declared""#), "{prov}");
    assert!(prov.contains(r#""author":"declared""#), "{prov}");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_backfill_is_idempotent() {
    let base = std::env::temp_dir().join("sard_wp2_bf_idem");
    let _ = std::fs::remove_dir_all(&base);
    let b = Build { title: Some("Unknown".into()), heading: Some("Recovered".into()), ..Default::default() };
    let (conn, _) = seed_pre_wp2(&base, &build(&b), "seed");

    assert_eq!(backfill_compat(&conn, &base).unwrap(), (1, 1));
    assert_eq!(backfill_compat(&conn, &base).unwrap(), (0, 0), "a re-run must examine nothing");
    assert_eq!(backfill_compat(&conn, &base).unwrap(), (0, 0));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_backfill_never_touches_a_user_override() {
    // The guarantee that makes this safe to run on a real library: a title the reader set keeps
    // winning through COALESCE, whatever the backfill decides about the base row.
    let base = std::env::temp_dir().join("sard_wp2_bf_override");
    let _ = std::fs::remove_dir_all(&base);
    let b = Build { title: Some("Unknown".into()), heading: Some("Recovered".into()), ..Default::default() };
    let (conn, id) = seed_pre_wp2(&base, &build(&b), "seed");
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1, 'title', ?2)",
        rusqlite::params![&id, "The Reader's Own Title"],
    )
    .unwrap();

    backfill_compat(&conn, &base).unwrap();

    let ov: String = conn
        .query_row("SELECT value FROM metadata_overrides WHERE book_id=?1 AND field='title'", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(ov, "The Reader's Own Title", "the override must survive byte-for-byte");
    let effective: String = conn
        .query_row(
            "SELECT COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='title'), b.title) \
             FROM books b WHERE b.id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(effective, "The Reader's Own Title", "the reader still sees their own title");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_backfill_never_overwrites_a_real_title() {
    let base = std::env::temp_dir().join("sard_wp2_bf_realtitle");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("src")).unwrap();
    let bytes = build(&Build { title: Some("A Good Book".into()), heading: Some("Chapter One".into()), ..Default::default() });
    let src = base.join("src").join("good.epub");
    std::fs::write(&src, &bytes).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let res = import_books(&conn, &base, &[src.to_string_lossy().into_owned()]);
    let id = res[0].id.clone();
    conn.execute("UPDATE books SET script_detected=NULL WHERE id=?1", [&id]).unwrap();

    assert_eq!(backfill_compat(&conn, &base).unwrap(), (1, 0), "a real title is examined but never rewritten");
    let title: String = conn.query_row("SELECT title FROM books WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(title, "A Good Book");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_backfill_survives_a_missing_library_folder() {
    let base = std::env::temp_dir().join("sard_wp2_bf_missing");
    let _ = std::fs::remove_dir_all(&base);
    let (conn, _) = seed_pre_wp2(&base, &build(&Build::default()), "seed");
    std::fs::remove_dir_all(base.join("library")).unwrap();
    assert_eq!(backfill_compat(&conn, &base).unwrap(), (0, 0), "unreadable books are skipped, not fatal");
    let ic: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(ic, "ok");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_backfill_leaves_pdfs_alone() {
    let base = std::env::temp_dir().join("sard_wp2_bf_pdf");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn.execute(
        "INSERT INTO books(id, file_path, format, title, added_at) VALUES('p1','p1.pdf','pdf','A PDF',0)",
        [],
    )
    .unwrap();
    assert_eq!(backfill_compat(&conn, &base).unwrap(), (0, 0));
    let script: Option<String> =
        conn.query_row("SELECT script_detected FROM books WHERE id='p1'", [], |r| r.get(0)).unwrap();
    assert_eq!(script, None, "a PDF has no EPUB spine to sniff");
    let _ = std::fs::remove_dir_all(&base);
}
