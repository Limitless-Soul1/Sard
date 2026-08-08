//! RESILIENCE-1 / WP-2 — the real importer, over the permanent Regression Corpus.
//!
//! WP-0 defined three verification layers and named this one as WP-2's definition of done:
//!
//!   | `npm run corpus:verify`  | the corpus files are intact, the measuring reader has not drifted |
//!   | the byte-identity harness | **Sard's rendering** of each book is unchanged                    |
//!   | **this file**             | **Sard's IMPORT** of each book is unchanged                      |
//!
//! It runs the genuine `import_books` entry point against the real books — no fixtures, no mocks —
//! into a throwaway database and a throwaway app-data directory, and compares every column that
//! existed before WP-2 against the values v1.1.0 produced (captured from the owner's live library
//! before any of this was written).
//!
//! Books live OUTSIDE the repository (they are third-party copyrighted works — see
//! `tests/corpus/README.md`). Set `SARD_CORPUS` to point at them; without it these tests SKIP
//! loudly rather than passing vacuously.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::import_books;

fn corpus_dir() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var("SARD_CORPUS").unwrap_or_else(|_| "M:\\ProjectDocs\\sard\\Corpus".into()));
    if p.is_dir() {
        Some(p)
    } else {
        eprintln!("[corpus] SKIPPED — no corpus at {}. This is a SKIP, not a pass.", p.display());
        None
    }
}

struct Row {
    title: Option<String>,
    author: Option<String>,
    language: Option<String>,
    dir: Option<String>,
    producer: Option<String>,
    script: Option<String>,
    toc_degenerate: Option<i64>,
    spine_fragmented: Option<i64>,
}

fn import_and_read(dir: &Path, file: &str) -> Option<Row> {
    let src = dir.join(file);
    if !src.is_file() {
        eprintln!("[corpus] missing: {}", src.display());
        return None;
    }
    let tmp = std::env::temp_dir().join(format!("sard_wp2_{}", file.replace(['.', '-'], "_")));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).ok()?;

    let conn = Connection::open_in_memory().ok()?;
    crate::db::migrations::run(&conn, None).ok()?;
    let res = import_books(&conn, &tmp, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res.len(), 1);
    assert_eq!(res[0].status, "imported", "{file} failed to import: {:?}", res[0].message);

    let row: Option<Row> = conn
        .query_row(
            "SELECT title, author, language, dir, producer, script_detected, toc_degenerate, spine_fragmented \
             FROM books WHERE id = ?1",
            [&res[0].id],
            |r| {
                Ok(Row {
                    title: r.get(0)?,
                    author: r.get(1)?,
                    language: r.get(2)?,
                    dir: r.get(3)?,
                    producer: r.get(4)?,
                    script: r.get(5)?,
                    toc_degenerate: r.get(6)?,
                    spine_fragmented: r.get(7)?,
                })
            },
        )
        .ok();
    let _ = std::fs::remove_dir_all(&tmp);
    row
}

/// One book's row as v1.1.0 stored it: `(file, title, author, language, dir)`.
type V1Row = (&'static str, &'static str, Option<&'static str>, Option<&'static str>, &'static str);

/// EXACTLY what v1.1.0 stored, captured from the owner's live library before WP-2 existed.
/// Any difference here is a backward-compatibility break.
const V1_1_0_ROWS: &[V1Row] = &[
    ("control-wellformed--alice.epub", "Alice's Adventures in Wonderland", Some("Lewis Carroll"), Some("en"), "ltr"),
    ("english-normal--monte-cristo.epub", "The Count of Monte Cristo", Some("Alexandre Dumas"), Some("en-US"), "ltr"),
    ("arabic-normal--little-prince.epub", "الأمير الصغير", Some("أنطوان دو سانت إكزوبيري"), Some("ar"), "rtl"),
    ("arabic-normal--art-of-war.epub", "فن الحرب", Some("صن تزو"), Some("ar"), "rtl"),
    ("arabic-normal--metamorphosis.epub", "التحول", Some("فرانتس كافكا"), Some("ar"), "rtl"),
    ("arabic-normal--risalat-alghufran.epub", "رسالة الغفران", Some("أبو العلاء المعري"), Some("ar"), "rtl"),
    ("arabic-normal--karamazov.epub", "الإخوة كارامازوف - الجزء الأول", Some("فيودور دوستويفسكي"), Some("ar"), "rtl"),
    ("arabic-normal--ad-daa-wad-dawaa.epub", "الداء والدواء", Some("ابن قيم الجوزية"), Some("ar"), "rtl"),
    ("rtl-declared--les-miserables.epub", "البؤساء", Some("فيكتور هيجو"), Some("ar"), "rtl"),
    ("rtl-declared--red-rising.epub", "انتفاضة الحمر", Some("بيرس براون"), Some("ar"), "rtl"),
    ("poetry-rtl--shawqiyyat.epub", "الشوقيات", Some("أحمد شوقي"), Some("ar"), "rtl"),
    ("calibre-generated--lord-of-mysteries.epub", "لورد الغوامض", Some("Cuttlefish That Loves Diving"), Some("en"), "rtl"),
];

#[test]
fn every_well_formed_corpus_book_imports_exactly_as_v1_1_0_did() {
    let Some(dir) = corpus_dir() else { return };
    for (file, title, author, language, book_dir) in V1_1_0_ROWS {
        let Some(row) = import_and_read(&dir, file) else {
            panic!("{file}: could not import");
        };
        assert_eq!(row.title.as_deref(), Some(*title), "{file}: TITLE changed");
        assert_eq!(row.author.as_deref(), *author, "{file}: AUTHOR changed");
        assert_eq!(row.language.as_deref(), *language, "{file}: LANGUAGE changed");
        assert_eq!(row.dir.as_deref(), Some(*book_dir), "{file}: DIR changed");
    }
}

#[test]
fn a_sound_toc_is_never_flagged_however_many_sections_the_book_has() {
    // The half of the TOC rule that protects good books. لورد الغوامض has 1,433 sections and a
    // matching 1,432-entry NCX; حلقة الحتمية has 1,166 of each. Both are readable and must stay
    // untouched — only a TOC that cannot navigate its own book is "degenerate".
    let Some(dir) = corpus_dir() else { return };
    for file in [
        "calibre-generated--lord-of-mysteries.epub",
        "rtl-undeclared--halaqat-alhatmiyya.epub",
        "arabic-normal--ad-daa-wad-dawaa.epub",
        "english-normal--monte-cristo.epub",
        "poetry-rtl--shawqiyyat.epub",
        "control-wellformed--alice.epub",
    ] {
        let Some(row) = import_and_read(&dir, file) else { continue };
        assert_eq!(row.toc_degenerate, Some(0), "{file} must NOT be flagged as a degenerate TOC");
    }
}

#[test]
fn the_reported_word_conversions_are_recovered() {
    let Some(dir) = corpus_dir() else { return };

    // THE reported book: dc:title "Unknown", dc:creator "word", 116 sections, 1 NCX entry.
    let row = import_and_read(&dir, "word-generated--unknown-title.epub").expect("reported book");
    assert_ne!(row.title.as_deref(), Some("Unknown"), "the placeholder title must not survive");
    assert_eq!(
        row.title.as_deref(),
        Some("word-generated--unknown-title"),
        "with no usable heading, the ladder lands on the filename"
    );
    assert_eq!(row.author, None, "'word' is a placeholder — NULL, never the literal 'Unknown'");
    assert!(row.producer.as_deref().is_some_and(|p| p.contains("calibre")), "producer: {:?}", row.producer);
    assert_eq!(row.toc_degenerate, Some(1), "116 sections behind 1 TOC entry");
    assert_eq!(row.spine_fragmented, Some(1), "115 sections at a ~2.4 KB median");
    assert_eq!(row.dir.as_deref(), Some("rtl"), "Arabic content declaring en still flips (RAWY-189)");
    assert_eq!(row.script.as_deref(), Some("arabic"), "the CONTENT's script is recorded separately");
    assert_eq!(row.language.as_deref(), Some("en"), "the DECLARATION is preserved, not overwritten");

    // The second Word conversion found during WP-0 — independent confirmation this is a class.
    let row = import_and_read(&dir, "word-generated--a4.epub").expect("a4");
    assert_eq!(row.toc_degenerate, Some(1), "196 sections behind 1 TOC entry");
    assert!(row.producer.is_some(), "a Calibre conversion must be identified as one");
}

#[test]
fn the_mis_declared_arabic_books_record_both_facts() {
    // 3 of the 15 corpus books declare `en` over Arabic content. `language` keeps the declaration
    // (RAWY-189 deliberately preserves it), `script_detected` records the truth, and `dir` — the
    // operational pivot — follows the truth.
    let Some(dir) = corpus_dir() else { return };
    for file in ["rtl-undeclared--halaqat-alhatmiyya.epub", "calibre-generated--lord-of-mysteries.epub"] {
        let Some(row) = import_and_read(&dir, file) else { continue };
        assert_eq!(row.language.as_deref(), Some("en"), "{file}: the declaration is preserved");
        assert_eq!(row.script.as_deref(), Some("arabic"), "{file}: the content is recorded");
        assert_eq!(row.dir.as_deref(), Some("rtl"), "{file}: direction follows the content");
    }
}

#[test]
fn sards_own_unknown_author_fallback_is_gone() {
    // حلقة الحتمية has no dc:creator at all. v1.1.0 stored the literal 'Unknown', which made
    // "the file said Unknown" indistinguishable from "Sard gave up".
    let Some(dir) = corpus_dir() else { return };
    let Some(row) = import_and_read(&dir, "rtl-undeclared--halaqat-alhatmiyya.epub") else { return };
    assert_eq!(row.author, None, "the author fallback must be NULL, not a fake name");
    assert_eq!(row.title.as_deref(), Some("حلقة الحتمية"), "its real title is untouched");
}

#[test]
fn the_compressed_mimetype_book_still_imports() {
    // الشوقيات stores `mimetype` DEFLATE-compressed — a specification violation Sard already
    // tolerated. WP-2 must not regress that while making the check BOM-tolerant.
    let Some(dir) = corpus_dir() else { return };
    let row = import_and_read(&dir, "poetry-rtl--shawqiyyat.epub").expect("shawqiyyat");
    assert_eq!(row.title.as_deref(), Some("الشوقيات"));
}

#[test]
fn every_corpus_epub_imports_without_error() {
    // The broadest sweep: nothing in the corpus may fail outright, whatever else it does.
    let Some(dir) = corpus_dir() else { return };
    let mut n = 0;
    for entry in std::fs::read_dir(&dir).expect("corpus dir").flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("epub") {
            continue;
        }
        let file = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(import_and_read(&dir, &file).is_some(), "{file} failed to import");
        n += 1;
    }
    assert!(n >= 15, "expected the full corpus, saw {n} EPUBs");
}
