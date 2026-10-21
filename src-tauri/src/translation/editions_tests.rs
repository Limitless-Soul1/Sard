//! Translation editions: the store's guarantees, checked from the outside against a real Sard database opened
//! the way the app opens one (foreign keys on) — the migration, the frozen inputs and the identity, the input
//! contract, sessions and resume, the reader-safety rules, and the deletion boundaries.
//!
//! Tests named `synthetic_…` feed inputs that no measured book contained (U+001C–001F, U+0085, U+FEFF). They
//! pin what the store does with such input. They are NOT validation of what a real WebView2 runtime produces.

use std::collections::BTreeMap;
use std::io::{Cursor, Write as _};
use std::path::PathBuf;

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::editions::*;
use super::pipeline::{Candidate, ChunkOut, Kind, Outcome, Produced, Raw, ReviewReason, Skip, Status, Step};
use crate::db::migrations::{self, MIGRATIONS};

// ---- Fixtures ----

struct Db {
    conn: Option<Connection>,
    dir: PathBuf,
}

impl Db {
    fn c(&self) -> &Connection {
        self.conn.as_ref().unwrap()
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        drop(self.conn.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn dir_for(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sard_editions_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A fresh database, opened as the app opens one, with every migration applied.
fn scratch(tag: &str) -> Db {
    let dir = dir_for(tag);
    let conn = crate::db::open_database(&dir.join("sard.db")).unwrap();
    migrations::run(&conn, None).unwrap();
    Db { conn: Some(conn), dir }
}

fn add_book(c: &Connection, id: &str) {
    c.execute("INSERT INTO books(id, file_path, format, title, added_at) VALUES(?1, ?2, 'epub', ?1, 1)", params![id, format!("nowhere/{id}.epub")]).unwrap();
}

/// One row in each of the reader's own tables for `id`, as the replace tests seed them.
fn seed_reader_state(c: &Connection, id: &str) {
    for sql in [
        "INSERT INTO reading_progress(book_id, locator_cfi, fraction, updated_at) VALUES(?1, 'epubcfi(/6/2!/4/2:5)', 0.42, 11)",
        "INSERT INTO highlights(id, book_id, start_cfi, end_cfi, color, text_excerpt, chapter_label, created_at, alpha) VALUES('h-' || ?1, ?1, 'epubcfi(/6/2!/4/2:1)', 'epubcfi(/6/2!/4/2:9)', 'yellow', 'Body', 'One', 12, 0.5)",
        "INSERT INTO notes(id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at, title) VALUES('n-' || ?1, ?1, 'h-' || ?1, 'epubcfi(/6/2!/4/2:1)', 'yellow', 'A note', 'One', 13, 14, 'T')",
        "INSERT INTO bookmarks(id, book_id, locator_cfi, label, created_at, chapter_label, fraction, color) VALUES('b-' || ?1, ?1, 'epubcfi(/6/2!/4/2:3)', 'here', 15, 'One', 0.3, 'red')",
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1, 'title', 'My own title')",
    ] {
        c.execute(sql, [id]).unwrap_or_else(|e| panic!("seed failed: {sql}\n{e}"));
    }
}

fn sha(i: u8) -> String {
    format!("{i:x}").repeat(64)
}

fn engine() -> EngineConfig {
    EngineConfig {
        model_id: "model-b".into(),
        model_sha256: sha(1),
        runtime_id: "runtime-b11501-vulkan-x64".into(),
        runtime_sha256: sha(2),
        execution: Execution::Gpu { device: "Vulkan0".into() },
        launch_flags: vec!["-ngl".into(), "99".into(), "-c".into(), "6144".into()],
        pipeline_id: "G2/1".into(),
        profile_k: 0.932,
    }
}

fn config() -> EditionConfig {
    EditionConfig {
        source_lang: "en".into(),
        target_lang: "ar".into(),
        target_dir: "rtl".into(),
        engine: engine(),
        extraction_id: "leafblocks-1/pyws-3.12.0-ucd15/segmenter-en-1".into(),
        webview_version: "155.0.4283.62".into(),
    }
}

fn para(path: &[u32], text: &str, sentences: &[&str]) -> ParagraphInput {
    ParagraphInput { path: path.to_vec(), tag: "p".into(), atoms: BTreeMap::new(), text: text.into(), sentences: sentences.iter().map(|s| s.to_string()).collect() }
}

fn section(index: u32, paragraphs: Vec<ParagraphInput>) -> SectionInput {
    let n = paragraphs.len() as u32;
    SectionInput { index, href: format!("OEBPS/s{index}.xhtml"), linear: true, content_type: "application/xhtml+xml".into(), leaves: n, dropped_empty: 0, body_fallback: false, paragraphs }
}

/// Four paragraphs in two sections; the third breaks the input contract (two spaces) and is never sent.
fn manifest() -> Vec<SectionInput> {
    vec![
        section(3, vec![
            para(&[0], "It was a dark night. The rain fell.", &["It was a dark night.", "The rain fell."]),
            para(&[1], "She ran.", &["She ran."]),
            para(&[2], "Two  spaces here.", &["Two  spaces here."]),
        ]),
        section(5, vec![para(&[0, 1], "The end.", &["The end."])]),
    ]
}

fn make(c: &Connection, book: &str) -> String {
    create(c, book, &config(), "1.4.1 TEST", &manifest(), 100).unwrap()
}

fn produced(out: &str) -> Produced {
    Produced { out: out.into(), tokens: Some(7), stop: "eos".into(), spans: vec![], chunks: vec![], units: None, flags: vec![], script: vec![] }
}

fn flagged(out: &str, why: &str) -> Produced {
    Produced { flags: vec![why.into()], ..produced(out) }
}

/// A pipeline result of each status, shaped as the pipeline makes them.
fn outcome(status: Status) -> Outcome {
    let mut candidates = BTreeMap::new();
    let (final_kind, text, steps, d1, why_review, requests) = match status {
        Status::Ok => {
            candidates.insert(Kind::Fast, Candidate::Produced(produced("كانت ليلة مظلمة.")));
            (Some(Kind::Fast), Some("كانت ليلة مظلمة."), vec![], Some(false), None, vec![(Kind::Fast, 0)])
        }
        Status::Recovered => {
            candidates.insert(Kind::Fast, Candidate::Produced(flagged("كانت كانت كانت", "repetition")));
            candidates.insert(Kind::Damped, Candidate::Produced(produced("كانت ليلة.")));
            (Some(Kind::Damped), Some("كانت ليلة."), vec![Step::Recovery(Kind::Damped)], Some(false), None, vec![(Kind::Fast, 0), (Kind::Damped, 0)])
        }
        Status::Second => {
            candidates.insert(Kind::Fast, Candidate::Produced(produced("ليلة.")));
            let mut b = produced("كانت ليلة مظلمة. وهطل المطر.");
            b.spans = vec![(0, 1), (1, 2)];
            b.chunks = vec![
                ChunkOut { index: 0, src: "It was a dark night.".into(), raw: Raw { out: "كانت ليلة مظلمة.".into(), tokens: Some(5), stop: "eos".into() } },
                ChunkOut { index: 1, src: "It was a dark night. The rain fell.".into(), raw: Raw { out: "وهطل المطر.".into(), tokens: Some(4), stop: "eos".into() } },
            ];
            candidates.insert(Kind::Chunked, Candidate::Produced(b));
            (Some(Kind::Chunked), Some("كانت ليلة مظلمة. وهطل المطر."), vec![Step::Second(Kind::Chunked)], Some(true), Some(ReviewReason::Incomplete), vec![(Kind::Fast, 0), (Kind::Chunked, 0), (Kind::Chunked, 1)])
        }
        Status::Review => {
            let mut f = produced("كانت night مظلمة.");
            f.script = vec!["untranslated Latin run".into()];
            candidates.insert(Kind::Fast, Candidate::Produced(f));
            candidates.insert(Kind::Chunked, Candidate::Skipped(Skip::CannotSplit));
            (Some(Kind::Fast), Some("كانت night مظلمة."), vec![Step::Recovery(Kind::Chunked)], None, Some(ReviewReason::ScriptLeak), vec![(Kind::Fast, 0)])
        }
        Status::Failed => {
            candidates.insert(Kind::Fast, Candidate::Produced(flagged("…", "too short")));
            candidates.insert(Kind::Damped, Candidate::Produced(flagged("…", "too short")));
            candidates.insert(Kind::Sentences, Candidate::Skipped(Skip::SingleSentence));
            (None, None, vec![Step::Recovery(Kind::Damped), Step::Recovery(Kind::Sentences)], None, None, vec![(Kind::Fast, 0), (Kind::Damped, 0)])
        }
    };
    Outcome { status, final_kind, text: text.map(String::from), steps, d1, why_review, candidates, requests }
}

fn render(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => "NULL".into(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => format!("{f:?}"),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => format!("blob:{}", hex_of(b)),
    }
}

fn hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Every row of every table, each rendered whole, sorted per table.
fn dump(c: &Connection) -> BTreeMap<String, Vec<Vec<String>>> {
    let mut out = BTreeMap::new();
    for t in crate::db::list_tables(c).unwrap() {
        let mut st = c.prepare(&format!("SELECT * FROM \"{t}\"")).unwrap();
        let n = st.column_count();
        let mut rows = st.query([]).unwrap();
        let mut v = Vec::new();
        while let Some(r) = rows.next().unwrap() {
            v.push((0..n).map(|i| render(r.get_ref(i).unwrap())).collect::<Vec<_>>());
        }
        v.sort();
        out.insert(t, v);
    }
    out
}

/// `before` without every row that holds one of `ids` in some column.
fn without(before: &BTreeMap<String, Vec<Vec<String>>>, ids: &[String]) -> BTreeMap<String, Vec<Vec<String>>> {
    before.iter().map(|(t, rows)| (t.clone(), rows.iter().filter(|r| !r.iter().any(|c| ids.contains(c))).cloned().collect())).collect()
}

fn count(c: &Connection, table: &str) -> i64 {
    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
}

const TRANSLATION_TABLES: [&str; 6] = ["translation_editions", "translation_sections", "translation_paragraphs", "translation_sessions", "translation_results", "translation_failures"];

// ═══ A · THE MIGRATION ═══════════════════════════════════════════════════════════════════════════════════

/// A library made by the Sard before this migration, with a book and the reader's marks on it: the upgrade
/// adds exactly the six tables and their indexes, changes no existing object, and leaves every row as it was.
#[test]
fn upgrading_a_populated_library_adds_only_the_new_tables_and_changes_no_row() {
    let dir = dir_for("upgrade");
    let c = crate::db::open_database(&dir.join("sard.db")).unwrap();
    c.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);").unwrap();
    crate::db::register_functions(&c).unwrap();
    for (v, name, sql) in MIGRATIONS.iter().filter(|(_, n, _)| *n != "translation_editions") {
        c.execute_batch(sql).unwrap_or_else(|e| panic!("apply v{v}: {e}"));
        c.execute("INSERT INTO schema_migrations(version, name, applied_at) VALUES(?1, ?2, 0)", params![v, name]).unwrap();
    }
    add_book(&c, "bookA");
    seed_reader_state(&c, "bookA");
    c.execute("INSERT INTO settings(key, value) VALUES('reader_font', 'Amiri')", []).unwrap();
    let schema = |c: &Connection| -> Vec<String> {
        let mut st = c.prepare("SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").unwrap();
        let v = st.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        v
    };
    let (schema_before, rows_before) = (schema(&c), dump(&c));

    migrations::run(&c, None).unwrap();

    let (schema_after, mut rows_after) = (schema(&c), dump(&c));
    for s in &schema_before {
        assert!(schema_after.contains(s), "an existing object changed or vanished: {s}");
    }
    let mut added: Vec<String> = schema_after.iter().filter(|s| !schema_before.contains(s)).map(|s| s.split(' ').take(2).collect::<Vec<_>>().join(" ")).collect();
    added.sort();
    assert_eq!(
        added,
        [
            "index idx_translation_editions_book", "index idx_translation_failures_edition", "index idx_translation_sessions_edition",
            "table translation_editions", "table translation_failures", "table translation_paragraphs", "table translation_results",
            "table translation_sections", "table translation_sessions",
        ]
    );
    let mut rows_before = rows_before;
    rows_before.remove("schema_migrations");
    rows_after.remove("schema_migrations");
    for t in TRANSLATION_TABLES {
        assert_eq!(rows_after.remove(t), Some(vec![]), "{t} starts empty");
    }
    assert_eq!(rows_after, rows_before, "the upgrade changed an existing row");
    assert!(rows_before["highlights"].len() == 1 && rows_before["books"].len() == 1, "the fixture held the reader's rows");
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

// ═══ B · AN EDITION FREEZES ITS INPUTS ═══════════════════════════════════════════════════════════════════

#[test]
fn an_edition_freezes_every_input_with_its_hashes_and_is_ready() {
    let db = scratch("freeze");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let ed = get(db.c(), &id).unwrap().unwrap();
    assert_eq!(ed.state, EditionState::Ready);
    assert_eq!(ed.counts, Counts { paragraphs: 4, rejected: 1, done: 0, pending: 3 });
    assert_eq!(ed.config, config(), "the configuration reads back exactly");
    assert_eq!(list_for_book(db.c(), "bookA").unwrap(), vec![id.clone()]);

    let mut st = db.c().prepare("SELECT source_text, source_sha256, sentences, sentences_sha256, input_state, input_detail FROM translation_paragraphs WHERE edition_id = ?1 ORDER BY section_index, ordinal").unwrap();
    let rows: Vec<(String, String, String, String, String, Option<String>)> = st.query_map([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap().map(Result::unwrap).collect();
    let inputs: Vec<ParagraphInput> = manifest().into_iter().flat_map(|s| s.paragraphs).collect();
    assert_eq!(rows.len(), inputs.len());
    for ((text, text_sha, sentences, sentences_sha, state, detail), p) in rows.iter().zip(&inputs) {
        assert_eq!(text, &p.text, "the exact source text");
        assert_eq!(serde_json::from_str::<Vec<String>>(sentences).unwrap(), p.sentences, "the exact sentence list");
        assert_eq!(text_sha, &hex_of(&Sha256::digest(p.text.as_bytes())));
        assert_eq!(sentences_sha, &hex_of(&Sha256::digest(sentences.as_bytes())));
        assert_eq!(state == "ok", detail.is_none());
    }
    assert_eq!(rows[2].4, "contract");
    assert_eq!(rows[2].5.as_deref(), Some("two spaces at code point 3"));
    let pending = pending(db.c(), &id).unwrap();
    assert_eq!(pending.iter().map(|p| (p.section_index, p.ordinal)).collect::<Vec<_>>(), [(3, 0), (3, 1), (5, 0)], "the contract breach is never pending");
}

/// Safeguard 1: the identity covers every translation-affecting input and setting — the same inputs give
/// the same identity, and changing any one of them gives another.
#[test]
fn the_identity_covers_every_translation_affecting_input_and_setting() {
    let db = scratch("identity");
    add_book(db.c(), "bookA");
    add_book(db.c(), "bookB");
    let id_of = |book: &str, cfg: &EditionConfig, m: &[SectionInput]| -> (String, String) {
        let e = create(db.c(), book, cfg, "1.4.1 TEST", m, 100).unwrap();
        let ed = get(db.c(), &e).unwrap().unwrap();
        (ed.identity_sha256, ed.manifest_sha256)
    };
    let base = id_of("bookA", &config(), &manifest());
    assert_eq!(id_of("bookA", &config(), &manifest()), base, "the same inputs, the same identity");
    let other_build = create(db.c(), "bookA", &config(), "1.4.2 OTHER", &manifest(), 200).unwrap();
    assert_eq!(get(db.c(), &other_build).unwrap().unwrap().identity_sha256, base.0, "Sard's build is recorded, not part of the identity");

    type Change = Box<dyn Fn(&mut EditionConfig, &mut Vec<SectionInput>)>;
    let changes: Vec<(&str, Change)> = vec![
        ("source_lang", Box::new(|c, _| c.source_lang = "fr".into())),
        ("target_lang", Box::new(|c, _| c.target_lang = "fa".into())),
        ("target_dir", Box::new(|c, _| c.target_dir = "ltr".into())),
        ("model_id", Box::new(|c, _| c.engine.model_id = "model-a".into())),
        ("model_sha256", Box::new(|c, _| c.engine.model_sha256 = sha(3))),
        ("runtime_id", Box::new(|c, _| c.engine.runtime_id = "runtime-other".into())),
        ("runtime_sha256", Box::new(|c, _| c.engine.runtime_sha256 = sha(4))),
        ("execution device", Box::new(|c, _| c.engine.execution = Execution::Gpu { device: "Vulkan1".into() })),
        ("execution cpu", Box::new(|c, _| c.engine.execution = Execution::Cpu { threads: 2 })),
        ("launch_flags", Box::new(|c, _| c.engine.launch_flags.push("--cache-ram".into()))),
        ("pipeline_id", Box::new(|c, _| c.engine.pipeline_id = "G2/2".into())),
        ("profile_k", Box::new(|c, _| c.engine.profile_k = 0.933)),
        ("extraction_id", Box::new(|c, _| c.extraction_id = "leafblocks-2".into())),
        ("webview_version", Box::new(|c, _| c.webview_version = "156.0.0.1".into())),
        ("a paragraph's text", Box::new(|_, m| m[0].paragraphs[1].text = "She left.".into())),
        ("a sentence boundary", Box::new(|_, m| m[0].paragraphs[0].sentences = vec!["It was a dark night. The rain fell.".into()])),
        ("a section's href", Box::new(|_, m| m[1].href = "OEBPS/other.xhtml".into())),
        ("a section's linearity", Box::new(|_, m| m[1].linear = false)),
        ("a paragraph's path", Box::new(|_, m| m[0].paragraphs[1].path = vec![9])),
        ("a paragraph's tag", Box::new(|_, m| m[0].paragraphs[1].tag = "li".into())),
        ("a paragraph's atoms", Box::new(|_, m| { m[0].paragraphs[1].atoms.insert("a".into(), 1); })),
    ];
    for (what, change) in &changes {
        let (mut c, mut m) = (config(), manifest());
        change(&mut c, &mut m);
        assert_ne!(id_of("bookA", &c, &m).0, base.0, "changing {what} must change the identity");
    }
    assert_ne!(id_of("bookB", &config(), &manifest()).0, base.0, "another book, another identity");
    let other = create_with_implementation(db.c(), "bookA", &config(), "1.4.1 TEST", &manifest(), 100, &"e".repeat(64)).unwrap();
    assert_ne!(get(db.c(), &other).unwrap().unwrap().identity_sha256, base.0, "another translation implementation, another identity");
}

/// The canonical form is pinned: these two values were computed independently of this code (in Python, from
/// the documented rules — compact JSON, keys sorted at every depth, arrays in order, `k` as its bit pattern).
/// If a library update ever changed how the hashes are formed, every stored edition would stop verifying;
/// this test fails first.
#[test]
fn the_canonical_input_and_identity_hashes_are_pinned() {
    let db = scratch("golden");
    add_book(db.c(), "bookA");
    // A fixed implementation, so that the pin holds whatever this build's translation code is.
    let id = create_with_implementation(db.c(), "bookA", &config(), "1.4.1 TEST", &manifest(), 100, &"a".repeat(64)).unwrap();
    let ed = get(db.c(), &id).unwrap().unwrap();
    assert_eq!(ed.manifest_sha256, "66c7f856ec7cd4721af728d15db53474ddbe1bd68bfb07867717ef7c7b370e22");
    assert_eq!(ed.identity_sha256, "de93fb9a37ad6802b63f42de36e20d85cbe771aa7f70bc817a4e215f132e4365");
}

#[test]
fn a_malformed_manifest_or_configuration_is_refused_and_nothing_is_written() {
    let db = scratch("malformed");
    add_book(db.c(), "bookA");
    type Spoil = Box<dyn Fn(&mut Vec<SectionInput>)>;
    let spoils: Vec<(&str, Spoil)> = vec![
        ("no section", Box::new(|m| m.clear())),
        ("sections out of order", Box::new(|m| m.swap(0, 1))),
        ("a repeated section", Box::new(|m| m[1].index = 3)),
        ("a lost paragraph", Box::new(|m| { m[0].paragraphs.pop(); })),
        ("more dropped than found", Box::new(|m| m[0].dropped_empty = 9)),
        ("an empty text", Box::new(|m| m[0].paragraphs[0].text.clear())),
        ("an empty tag", Box::new(|m| m[0].paragraphs[0].tag.clear())),
        ("no path outside the body fallback", Box::new(|m| m[0].paragraphs[0].path.clear())),
        ("a path in the body fallback", Box::new(|m| { m[1].body_fallback = true; })),
        ("a body fallback of two leaves", Box::new(|m| { m[0].body_fallback = true; })),
        ("no href", Box::new(|m| m[0].href.clear())),
    ];
    for (what, spoil) in &spoils {
        let mut m = manifest();
        spoil(&mut m);
        assert!(matches!(create(db.c(), "bookA", &config(), "1.4.1 TEST", &m, 1), Err(EditionError::Manifest(_))), "{what} must be refused");
    }
    type Bad = Box<dyn Fn(&mut EditionConfig)>;
    let bads: Vec<(&str, Bad)> = vec![
        ("an uppercase hash", Box::new(|c| c.engine.model_sha256 = "A".repeat(64))),
        ("a short hash", Box::new(|c| c.engine.runtime_sha256 = "a".repeat(63))),
        ("k not a number", Box::new(|c| c.engine.profile_k = f64::NAN)),
        ("k zero", Box::new(|c| c.engine.profile_k = 0.0)),
        ("no CPU threads", Box::new(|c| c.engine.execution = Execution::Cpu { threads: 0 })),
        ("no GPU device", Box::new(|c| c.engine.execution = Execution::Gpu { device: " ".into() })),
        ("a direction", Box::new(|c| c.target_dir = "up".into())),
        ("no webview version", Box::new(|c| c.webview_version.clear())),
        ("no extraction id", Box::new(|c| c.extraction_id.clear())),
    ];
    for (what, bad) in &bads {
        let mut c = config();
        bad(&mut c);
        assert!(matches!(create(db.c(), "bookA", &c, "1.4.1 TEST", &manifest(), 1), Err(EditionError::Config(_))), "{what} must be refused");
    }
    assert_eq!(create(db.c(), "bookA", &config(), " ", &manifest(), 1).unwrap_err(), EditionError::Config("app_build is empty".into()));
    assert_eq!(create(db.c(), "no-such-book", &config(), "1.4.1 TEST", &manifest(), 1).unwrap_err(), EditionError::NoSuchBook);
    for t in TRANSLATION_TABLES {
        assert_eq!(count(db.c(), t), 0, "nothing was written to {t}");
    }
}

// ═══ C · THE INPUT CONTRACT ══════════════════════════════════════════════════════════════════════════════

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn the_contract_accepts_well_formed_paragraphs_and_names_each_breach() {
    assert_eq!(check_contract("One. Two three.", &s(&["One.", "Two three."])), Ok(()));
    assert_eq!(check_contract("“Go,” she said.", &s(&["“Go,” she said."])), Ok(()));
    assert_eq!(check_contract("A.B.", &s(&["A.", "B."])), Ok(()), "sentences may touch with no space between");
    assert_eq!(check_contract("", &s(&[])), Err(ContractBreach::EmptyText));
    assert_eq!(check_contract("a\u{a0}b", &s(&["a\u{a0}b"])), Err(ContractBreach::Whitespace { at: 1 }));
    assert_eq!(check_contract("a\tb", &s(&["a\tb"])), Err(ContractBreach::Whitespace { at: 1 }));
    assert_eq!(check_contract(" a.", &s(&["a."])), Err(ContractBreach::OuterSpace));
    assert_eq!(check_contract("a. ", &s(&["a."])), Err(ContractBreach::OuterSpace));
    assert_eq!(check_contract("a  b", &s(&["a  b"])), Err(ContractBreach::DoubleSpace { at: 1 }));
    assert_eq!(check_contract("a.", &s(&[])), Err(ContractBreach::NoSentence));
    assert_eq!(check_contract("a. b.", &s(&["a.", ""])), Err(ContractBreach::EmptySentence { index: 1 }));
    assert_eq!(check_contract("a. b.", &s(&["a. ", "b."])), Err(ContractBreach::SentenceWhitespace { index: 0 }));
    assert_eq!(check_contract("a. b.", &s(&["b.", "a."])), Err(ContractBreach::NotInPlace { index: 0, at: 0 }));
    assert_eq!(check_contract("a. b. c.", &s(&["a.", "b."])), Err(ContractBreach::Uncovered { at: 5 }));
    assert_eq!(check_contract("أهلا. نعم.", &s(&["أهلا.", "نعم."])), Ok(()), "positions are code points, not bytes");
    assert_eq!(check_contract("أهلا. نعم. لا.", &s(&["أهلا.", "نعم."])), Err(ContractBreach::Uncovered { at: 10 }));
}

/// The collapse set is Python 3.12.0's (Unicode 15.0.0): exactly these 29 code points, derived from that
/// interpreter, not typed from a table.
#[test]
fn the_python_whitespace_set_is_the_frozen_interpreters_29_code_points() {
    let members: Vec<u32> = (0..=0x10FFFFu32).filter_map(char::from_u32).filter(|&c| is_python_whitespace(c)).map(|c| c as u32).collect();
    let expected: Vec<u32> = (0x09..=0x0D).chain(0x1C..=0x20).chain([0x85, 0xA0, 0x1680]).chain(0x2000..=0x200A).chain([0x2028, 0x2029, 0x202F, 0x205F, 0x3000]).collect();
    assert_eq!(members, expected);
    assert_eq!(members.len(), 29);
    for c in ['\u{feff}', '\u{180e}', '\u{200b}', 'a'] {
        assert!(!is_python_whitespace(c), "{:04x} is not Python whitespace", c as u32);
    }
}

/// SYNTHETIC — no measured book held these characters, so this pins the store's behaviour on them; it is
/// NOT validation of what a real WebView2 runtime extracts. Python treats U+001C–001F and U+0085 as
/// whitespace and JavaScript does not: such a paragraph breaks the contract, is stored with the reason, and
/// is never sent.
#[test]
fn synthetic_python_only_whitespace_breaks_the_contract_and_is_never_sent() {
    for (c, at) in [('\u{1c}', 1usize), ('\u{1f}', 1), ('\u{85}', 1)] {
        let text = format!("a{c}b.");
        assert_eq!(check_contract(&text, &[text.clone()]), Err(ContractBreach::Whitespace { at }));
    }
    let db = scratch("synthetic_ws");
    add_book(db.c(), "bookA");
    let m = vec![section(0, vec![para(&[0], "a\u{85}b.", &["a\u{85}b."]), para(&[1], "Fine.", &["Fine."])])];
    let id = create(db.c(), "bookA", &config(), "1.4.1 TEST", &m, 1).unwrap();
    let (state, detail): (String, String) = db.c().query_row("SELECT input_state, input_detail FROM translation_paragraphs WHERE edition_id = ?1 AND ordinal = 0", [&id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((state.as_str(), detail.as_str()), ("contract", "whitespace other than U+0020 at code point 1"));
    assert_eq!(pending(db.c(), &id).unwrap().len(), 1);
}

/// SYNTHETIC — what WebView2 actually produces for a U+FEFF here is UNMEASURED; this pins the store's
/// behaviour on the input such a sentence list would make. JavaScript's `.trim()` removes U+FEFF from the
/// sentence while the paragraph text keeps it, so the sentences no longer cover the text: a breach, never sent.
#[test]
fn synthetic_a_zero_width_no_break_space_at_a_sentence_edge_breaks_the_contract() {
    assert_eq!(check_contract("Hello.\u{feff} Next.", &s(&["Hello.", "Next."])), Err(ContractBreach::NotInPlace { index: 1, at: 6 }));
    assert_eq!(check_contract("Hello.\u{feff} Next.", &s(&["Hello.\u{feff}", "Next."])), Ok(()), "kept inside the sentence, it is ordinary text");
}

// ═══ D · SESSIONS AND RESUME ════════════════════════════════════════════════════════════════════════════

#[test]
fn a_session_runs_alone_and_resume_continues_at_the_first_pending_paragraph() {
    let db = scratch("resume");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let s1 = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", Some("{\"device\":\"Vulkan0\"}"), 200).unwrap();
    assert_eq!(get(db.c(), &id).unwrap().unwrap().state, EditionState::Running);
    assert_eq!(begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 201).unwrap_err(), EditionError::AlreadyRunning);
    record_result(db.c(), &s1, 3, 0, &outcome(Status::Ok), 500, 202).unwrap();
    assert_eq!(end_session(db.c(), &s1, EndReason::Complete, 203).unwrap_err(), EditionError::StillPending);
    assert_eq!(end_session(db.c(), &s1, EndReason::Cancelled, 204).unwrap(), EditionState::Stopped);
    assert_eq!(pending(db.c(), &id).unwrap().iter().map(|p| (p.section_index, p.ordinal)).collect::<Vec<_>>(), [(3, 1), (5, 0)]);

    let s2 = begin_session(db.c(), &id, &engine(), "1.4.2 LATER", None, 300).unwrap();
    record_result(db.c(), &s2, 3, 1, &outcome(Status::Review), 400, 301).unwrap();
    record_result(db.c(), &s2, 5, 0, &outcome(Status::Failed), 400, 302).unwrap();
    assert_eq!(end_session(db.c(), &s2, EndReason::Complete, 303).unwrap(), EditionState::Complete);
    let ed = get(db.c(), &id).unwrap().unwrap();
    assert_eq!(ed.counts, Counts { paragraphs: 4, rejected: 1, done: 3, pending: 0 });
    assert_eq!(begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 400).unwrap_err(), EditionError::NothingPending);
    assert_eq!(result(db.c(), &id, 3, 0).unwrap().unwrap().session_id, s1, "each result keeps the session that made it");
    assert_eq!(result(db.c(), &id, 5, 0).unwrap().unwrap().session_id, s2);
}

/// Safeguard 1: any change in what runs the translation refuses the resume, and leaves everything as it was.
#[test]
fn a_resume_with_any_changed_setting_is_refused() {
    let db = scratch("refuse");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let s1 = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 200).unwrap();
    end_session(db.c(), &s1, EndReason::Cancelled, 201).unwrap();
    type Change = Box<dyn Fn(&mut EngineConfig)>;
    let changes: Vec<(&str, Change)> = vec![
        ("model_id", Box::new(|e| e.model_id = "model-a".into())),
        ("model_sha256", Box::new(|e| e.model_sha256 = sha(3))),
        ("runtime_id", Box::new(|e| e.runtime_id = "runtime-other".into())),
        ("runtime_sha256", Box::new(|e| e.runtime_sha256 = sha(4))),
        ("launch_flags", Box::new(|e| e.launch_flags.pop().map(drop).unwrap_or_default())),
        ("pipeline_id", Box::new(|e| e.pipeline_id = "G2/2".into())),
        ("profile_k", Box::new(|e| e.profile_k = f64::from_bits(e.profile_k.to_bits() + 1))), // one bit away
        ("execution", Box::new(|e| e.execution = Execution::Gpu { device: "Vulkan1".into() })),
        ("execution", Box::new(|e| e.execution = Execution::Cpu { threads: 2 })),
    ];
    let before = dump(db.c());
    for (field, change) in &changes {
        let mut e = engine();
        change(&mut e);
        assert_eq!(begin_session(db.c(), &id, &e, "1.4.1 TEST", None, 300).unwrap_err(), EditionError::ConfigurationChanged { field: *field }, "{field}");
    }
    assert_eq!(dump(db.c()), before, "a refused resume writes nothing");
    assert_eq!(get(db.c(), &id).unwrap().unwrap().state, EditionState::Stopped);
}

/// D8 / N3: GPU and CPU output mix only after an explicit approval. Nothing in the store can grant it yet;
/// this test sets the column by hand to show the rule reads it — and that two models never mix even then.
#[test]
fn mixing_execution_paths_needs_the_recorded_approval_and_models_never_mix() {
    let db = scratch("mixing");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let cpu = EngineConfig { execution: Execution::Cpu { threads: 2 }, ..engine() };
    assert_eq!(begin_session(db.c(), &id, &cpu, "1.4.1 TEST", None, 200).unwrap_err(), EditionError::ConfigurationChanged { field: "execution" });
    db.c().execute("UPDATE translation_editions SET mixing_approved = 1 WHERE id = ?1", [&id]).unwrap();
    let other_model = EngineConfig { model_sha256: sha(3), ..cpu.clone() };
    assert_eq!(begin_session(db.c(), &id, &other_model, "1.4.1 TEST", None, 201).unwrap_err(), EditionError::ConfigurationChanged { field: "model_sha256" });
    let s = begin_session(db.c(), &id, &cpu, "1.4.1 TEST", None, 202).unwrap();
    let (execution, detail): (String, String) = db.c().query_row("SELECT execution, execution_detail FROM translation_sessions WHERE id = ?1", [&s], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((execution.as_str(), detail.as_str()), ("cpu", "{\"threads\":2}"), "a mixed edition stays traceable, per session");
}

/// Safeguard 1: the hashes are not only stored but checked. Before every session the store recomputes each
/// paragraph's hashes and verdict, the input hash and the identity hash from what is stored; a change to any
/// input, setting or hash after the edition was made refuses the session and writes nothing. A paragraph's
/// stored hash changed alone is caught too, though the inputs themselves still match: later stages rely on it.
#[test]
fn stored_inputs_settings_and_hashes_are_verified_before_every_session() {
    let db = scratch("verify");
    add_book(db.c(), "bookA");
    let untouched = make(db.c(), "bookA");
    assert_eq!(verify(db.c(), &untouched), Ok(()));
    let p30 = "edition_id = ?1 AND section_index = 3 AND ordinal = 0";
    let tampers: Vec<(&str, String)> = vec![
        ("a source text", format!("UPDATE translation_paragraphs SET source_text = 'It was night.' WHERE {p30}")),
        ("a sentence list", format!("UPDATE translation_paragraphs SET sentences = '[\"It was a dark night. The rain fell.\"]' WHERE {p30}")),
        ("a text's stored hash alone", format!("UPDATE translation_paragraphs SET source_sha256 = '{}' WHERE {p30}", "0".repeat(64))),
        ("a sentence list's stored hash alone", format!("UPDATE translation_paragraphs SET sentences_sha256 = '{}' WHERE {p30}", "0".repeat(64))),
        ("a text and its own hash", format!("UPDATE translation_paragraphs SET source_text = 'X.', source_sha256 = '{}', sentences = '[\"X.\"]', sentences_sha256 = '{}' WHERE {p30}", hex_of(&Sha256::digest(b"X.")), hex_of(&Sha256::digest(b"[\"X.\"]")))),
        ("a contract verdict", "UPDATE translation_paragraphs SET input_state = 'ok', input_detail = NULL WHERE edition_id = ?1 AND section_index = 3 AND ordinal = 2".into()),
        ("a path", format!("UPDATE translation_paragraphs SET path = '[7]' WHERE {p30}")),
        ("the atoms", format!("UPDATE translation_paragraphs SET atoms = '{{\"a\":1}}' WHERE {p30}")),
        ("a section's href", "UPDATE translation_sections SET href = 'OEBPS/other.xhtml' WHERE edition_id = ?1 AND section_index = 5".into()),
        ("a lost paragraph", "DELETE FROM translation_paragraphs WHERE edition_id = ?1 AND section_index = 3 AND ordinal = 2".into()),
        ("the model", "UPDATE translation_editions SET model_id = 'model-a' WHERE id = ?1".into()),
        ("the constant", "UPDATE translation_editions SET profile_k = 0.95 WHERE id = ?1".into()),
        ("the webview version", "UPDATE translation_editions SET webview_version = '156.0.0.0' WHERE id = ?1".into()),
        ("the execution", "UPDATE translation_editions SET execution_detail = '{\"device\":\"Vulkan1\"}' WHERE id = ?1".into()),
        ("the implementation", format!("UPDATE translation_editions SET implementation_sha256 = '{}' WHERE id = ?1", "e".repeat(64))),
        ("the identity hash", format!("UPDATE translation_editions SET identity_sha256 = '{}' WHERE id = ?1", "0".repeat(64))),
        ("the manifest hash", format!("UPDATE translation_editions SET manifest_sha256 = '{}' WHERE id = ?1", "0".repeat(64))),
    ];
    for (what, sql) in &tampers {
        let id = make(db.c(), "bookA");
        db.c().execute(sql, [&id]).unwrap_or_else(|e| panic!("{what}: {e}"));
        let tampered_engine = get(db.c(), &id).unwrap().unwrap().config.engine; // whatever the row now says
        for engine in [engine(), tampered_engine] {
            assert!(matches!(begin_session(db.c(), &id, &engine, "1.4.1 TEST", None, 2), Err(EditionError::Integrity(_))), "{what} must be caught");
        }
        assert!(matches!(verify(db.c(), &id), Err(EditionError::Integrity(_))), "{what}");
        assert_eq!(db.c().query_row("SELECT COUNT(*) FROM translation_sessions WHERE edition_id = ?1", [&id], |r| r.get::<_, i64>(0)).unwrap(), 0, "{what}: no session");
    }
    assert!(begin_session(db.c(), &untouched, &engine(), "1.4.1 TEST", None, 3).is_ok(), "the positive control");
}

/// The implementation fingerprint: an edition records the one it was made with, a build whose translation
/// code differs cannot resume it — even with an intact edition and an identical engine — and the same one can.
#[test]
fn an_edition_made_by_another_translation_implementation_cannot_be_resumed() {
    let db = scratch("implementation");
    add_book(db.c(), "bookA");
    let current = make(db.c(), "bookA");
    assert_eq!(get(db.c(), &current).unwrap().unwrap().implementation_sha256, implementation(), "an edition records this build's");
    let older = create_with_implementation(db.c(), "bookA", &config(), "1.4.1 TEST", &manifest(), 1, &"e".repeat(64)).unwrap();
    assert_eq!(verify(db.c(), &older), Ok(()), "the older edition is intact; only its implementation differs");
    let before = dump(db.c());
    assert_eq!(begin_session(db.c(), &older, &engine(), "1.4.1 TEST", None, 2).unwrap_err(), EditionError::ConfigurationChanged { field: "implementation" });
    assert_eq!(dump(db.c()), before, "a refused resume writes nothing");
    let s = begin_session_with_implementation(db.c(), &older, &engine(), "1.4.1 TEST", None, 3, &"e".repeat(64)).unwrap();
    let recorded: String = db.c().query_row("SELECT implementation_sha256 FROM translation_sessions WHERE id = ?1", [&s], |r| r.get(0)).unwrap();
    assert_eq!(recorded, "e".repeat(64), "each session records the implementation it ran");
    assert!(begin_session(db.c(), &current, &engine(), "1.4.1 TEST", None, 4).is_ok());
    assert_eq!(create_with_implementation(db.c(), "bookA", &config(), "1.4.1 TEST", &manifest(), 5, "not-a-hash").unwrap_err(), EditionError::Config("the implementation fingerprint is not a lowercase SHA-256".into()));
}

#[test]
fn an_interrupted_session_is_closed_at_load_and_its_edition_settled() {
    let db = scratch("recover");
    add_book(db.c(), "bookA");
    let a = make(db.c(), "bookA");
    let b = make(db.c(), "bookA");
    let sa = begin_session(db.c(), &a, &engine(), "1.4.1 TEST", None, 200).unwrap();
    record_result(db.c(), &sa, 3, 0, &outcome(Status::Ok), 1, 201).unwrap();
    let sb = begin_session(db.c(), &b, &engine(), "1.4.1 TEST", None, 202).unwrap();
    for (sec, ord) in [(3, 0), (3, 1), (5, 0)] {
        record_result(db.c(), &sb, sec, ord, &outcome(Status::Ok), 1, 203).unwrap();
    }
    // A crash: neither session is ended.
    assert_eq!(recover_interrupted(db.c(), 300).unwrap(), 2);
    for (s, ed, state) in [(&sa, &a, EditionState::Stopped), (&sb, &b, EditionState::Complete)] {
        let (ended, reason): (Option<i64>, Option<String>) = db.c().query_row("SELECT ended_at, end_reason FROM translation_sessions WHERE id = ?1", [s], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((ended, reason.as_deref()), (Some(300), Some("interrupted")));
        assert_eq!(get(db.c(), ed).unwrap().unwrap().state, state);
    }
    assert_eq!(recover_interrupted(db.c(), 400).unwrap(), 0, "nothing left to recover");
    assert_eq!(record_result(db.c(), &sa, 3, 1, &outcome(Status::Ok), 1, 401).unwrap_err(), EditionError::SessionNotOpen);
    let again = begin_session(db.c(), &a, &engine(), "1.4.1 TEST", None, 402).unwrap();
    assert_eq!(pending(db.c(), &a).unwrap().len(), 2, "the paragraph in flight is simply done again");
    end_session(db.c(), &again, EndReason::Engine, 403).unwrap();
}

// ═══ E · RESULTS AND THE READER-SAFETY RULES ═════════════════════════════════════════════════════════════

/// Safeguards 2 and 6: each status is stored whole — status, text, review reason, final candidate, the full
/// pipeline result and its session — and FAILED has no text while REVIEW and SECOND keep their reason.
#[test]
fn every_status_is_stored_whole_with_its_data() {
    let db = scratch("statuses");
    add_book(db.c(), "bookA");
    let m = vec![section(0, (0..5).map(|i| para(&[i], "Word.", &["Word."])).collect())];
    let id = create(db.c(), "bookA", &config(), "1.4.1 TEST", &m, 1).unwrap();
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let statuses = [Status::Ok, Status::Recovered, Status::Second, Status::Review, Status::Failed];
    for (i, st) in statuses.iter().enumerate() {
        record_result(db.c(), &sess, 0, i as u32, &outcome(*st), 10, 3).unwrap();
    }
    for (i, st) in statuses.iter().enumerate() {
        let o = outcome(*st);
        let r = result(db.c(), &id, 0, i as u32).unwrap().unwrap();
        assert_eq!(r.status, st.name());
        assert_eq!(r.text, o.text);
        assert_eq!(r.final_kind.as_deref(), o.final_kind.map(|k| k.name()));
        assert_eq!(r.why_review.as_deref(), o.why_review.map(|w| w.text()));
        assert_eq!(r.session_id, sess);
        assert_eq!(r.outcome_json, outcome_json(&o));
    }
    assert_eq!(result(db.c(), &id, 0, 4).unwrap().unwrap().text, None, "FAILED has no text");
    assert_eq!(result(db.c(), &id, 0, 3).unwrap().unwrap().why_review.as_deref(), Some("script leak not repaired"));
    assert_eq!(result(db.c(), &id, 0, 2).unwrap().unwrap().why_review.as_deref(), Some("D1: no clean second translation"));
}

#[test]
fn an_outcome_that_breaks_a_reader_safety_rule_is_refused_and_nothing_is_written() {
    let db = scratch("unsafe");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let bad: Vec<(&str, Outcome)> = vec![
        ("FAILED with a text", Outcome { text: Some("x".into()), ..outcome(Status::Failed) }),
        ("FAILED with a final candidate", Outcome { final_kind: Some(Kind::Fast), ..outcome(Status::Failed) }),
        ("OK without a text", Outcome { text: None, ..outcome(Status::Ok) }),
        ("REVIEW without its reason", Outcome { why_review: None, ..outcome(Status::Review) }),
        ("SECOND without its reason", Outcome { why_review: None, ..outcome(Status::Second) }),
        ("OK with a reason", Outcome { why_review: Some(ReviewReason::Incomplete), ..outcome(Status::Ok) }),
        ("RECOVERED with a reason", Outcome { why_review: Some(ReviewReason::ScriptLeak), ..outcome(Status::Recovered) }),
    ];
    for (what, o) in &bad {
        assert!(matches!(record_result(db.c(), &sess, 3, 0, o, 1, 3), Err(EditionError::InvalidOutcome(_))), "{what}");
    }
    assert_eq!(count(db.c(), "translation_results"), 0);
}

/// Safeguard 6, at the table: whatever code writes the row, the CHECKs refuse one that breaks the rules.
#[test]
fn the_tables_refuse_a_row_that_breaks_the_rules_whatever_writes_it() {
    let db = scratch("checks");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let insert = |status: &str, text: Option<&str>, kind: Option<&str>, why: Option<&str>| {
        db.c().execute(
            "INSERT INTO translation_results(edition_id, section_index, ordinal, session_id, status, text, final_kind, why_review, outcome_json, outcome_schema, took_ms, created_at) \
             VALUES(?1, 3, 0, ?2, ?3, ?4, ?5, ?6, '{}', 1, 0, 0)",
            params![id, sess, status, text, kind, why],
        )
    };
    for (what, status, text, kind, why) in [
        ("FAILED with a text", "FAILED", Some("x"), None, None),
        ("FAILED with a final candidate", "FAILED", None, Some("fast"), None),
        ("OK without a text", "OK", None, Some("fast"), None),
        ("REVIEW without its reason", "REVIEW", Some("x"), Some("fast"), None),
        ("SECOND without its reason", "SECOND", Some("x"), Some("B"), None),
        ("OK with a reason", "OK", Some("x"), Some("fast"), Some("r")),
        ("an unknown status", "MAYBE", Some("x"), Some("fast"), None),
    ] {
        assert!(insert(status, text, kind, why).is_err(), "{what} must be refused by the table");
    }
    assert!(insert("OK", Some("x"), Some("fast"), None).is_ok(), "the positive control");
}

/// A result names a session of its own edition, structurally, and a paragraph that exists in it.
#[test]
fn a_result_cannot_name_another_editions_session_or_a_missing_paragraph() {
    let db = scratch("foreign");
    add_book(db.c(), "bookA");
    let a = make(db.c(), "bookA");
    let b = make(db.c(), "bookA");
    let sb = begin_session(db.c(), &b, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let wrong = db.c().execute(
        "INSERT INTO translation_results(edition_id, section_index, ordinal, session_id, status, text, final_kind, why_review, outcome_json, outcome_schema, took_ms, created_at) \
         VALUES(?1, 3, 0, ?2, 'OK', 'x', 'fast', NULL, '{}', 1, 0, 0)",
        params![a, sb],
    );
    assert!(wrong.is_err(), "a session of edition B cannot hold a result of edition A");
    let missing = db.c().execute(
        "INSERT INTO translation_results(edition_id, section_index, ordinal, session_id, status, text, final_kind, why_review, outcome_json, outcome_schema, took_ms, created_at) \
         VALUES(?1, 9, 9, ?2, 'OK', 'x', 'fast', NULL, '{}', 1, 0, 0)",
        params![b, sb],
    );
    assert!(missing.is_err(), "a result needs its paragraph");
}

/// The database itself — not only the store — keeps a result away from a paragraph the input rules rejected,
/// and keeps the verdict of a paragraph that has a result from changing under it. Whatever writes the SQL.
#[test]
fn the_database_refuses_a_result_for_a_rejected_paragraph_and_a_verdict_change_under_a_result() {
    let db = scratch("rejected");
    add_book(db.c(), "bookA");
    let a = make(db.c(), "bookA");
    let b = make(db.c(), "bookA");
    let sa = begin_session(db.c(), &a, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let sb = begin_session(db.c(), &b, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let insert = |edition: &str, session: &str, section: u32, ordinal: u32, state: Option<&str>| {
        match state {
            None => db.c().execute(
                "INSERT INTO translation_results(edition_id, section_index, ordinal, session_id, status, text, final_kind, why_review, outcome_json, outcome_schema, took_ms, created_at) \
                 VALUES(?1, ?2, ?3, ?4, 'OK', 'x', 'fast', NULL, '{}', 1, 0, 0)",
                params![edition, section, ordinal, session],
            ),
            Some(st) => db.c().execute(
                "INSERT INTO translation_results(edition_id, section_index, ordinal, input_state, session_id, status, text, final_kind, why_review, outcome_json, outcome_schema, took_ms, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, 'OK', 'x', 'fast', NULL, '{}', 1, 0, 0)",
                params![edition, section, ordinal, st, session],
            ),
        }
    };
    // (3, 2) broke the input contract when the edition was made.
    assert!(insert(&a, &sa, 3, 2, None).is_err(), "a result for the rejected paragraph");
    assert!(insert(&a, &sa, 3, 2, Some("contract")).is_err(), "even when it says so");
    assert!(insert(&a, &sa, 3, 0, Some("contract")).is_err(), "a result can only name an 'ok' paragraph");
    // The ownership constraints still hold.
    assert!(insert(&a, &sb, 3, 0, None).is_err(), "a session of another edition");
    assert!(insert(&a, &sa, 9, 9, None).is_err(), "a paragraph that does not exist");
    // A valid paragraph accepts a valid result — and then its verdict cannot change.
    assert!(insert(&a, &sa, 3, 0, None).is_ok(), "the positive control");
    let flip = |section: u32, ordinal: u32| db.c().execute("UPDATE translation_paragraphs SET input_state = 'contract', input_detail = 'x' WHERE edition_id = ?1 AND section_index = ?2 AND ordinal = ?3", params![a, section, ordinal]);
    assert!(flip(3, 0).is_err(), "the verdict of a paragraph that has a result");
    assert_eq!(db.c().query_row("SELECT input_state FROM translation_paragraphs WHERE edition_id = ?1 AND section_index = 3 AND ordinal = 0", [&a], |r| r.get::<_, String>(0)).unwrap(), "ok");
    assert!(flip(3, 1).is_ok(), "a paragraph with no result is not held by this rule (verify catches such an edit)");
    assert!(matches!(verify(db.c(), &a), Err(EditionError::Integrity(_))), "and verify does catch it");
    // The store still answers first, with its own error.
    assert_eq!(record_result(db.c(), &sb, 3, 2, &outcome(Status::Ok), 1, 3).unwrap_err(), EditionError::NotTranslatable);
}

#[test]
fn a_paragraph_is_recorded_once_and_only_when_it_can_be() {
    let db = scratch("once");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    record_result(db.c(), &sess, 3, 0, &outcome(Status::Ok), 1, 3).unwrap();
    assert_eq!(record_result(db.c(), &sess, 3, 0, &outcome(Status::Recovered), 1, 4).unwrap_err(), EditionError::AlreadyRecorded);
    assert_eq!(record_result(db.c(), &sess, 3, 2, &outcome(Status::Ok), 1, 5).unwrap_err(), EditionError::NotTranslatable);
    assert_eq!(record_result(db.c(), &sess, 7, 0, &outcome(Status::Ok), 1, 6).unwrap_err(), EditionError::UnknownParagraph);
    assert_eq!(record_result(db.c(), "no-such-session", 3, 1, &outcome(Status::Ok), 1, 7).unwrap_err(), EditionError::NoSuchSession);
    record_failure(db.c(), &sess, 3, 1, FailureKind::Engine, "Timeout { path: \"/completion\" }", 8).unwrap();
    assert_eq!(record_failure(db.c(), &sess, 7, 7, FailureKind::Engine, "x", 9).unwrap_err(), EditionError::UnknownParagraph);
    assert_eq!(pending(db.c(), &id).unwrap().len(), 2, "a failed attempt leaves its paragraph pending");
    end_session(db.c(), &sess, EndReason::Engine, 10).unwrap();
    assert_eq!(record_result(db.c(), &sess, 3, 1, &outcome(Status::Ok), 1, 11).unwrap_err(), EditionError::SessionNotOpen);
    assert_eq!(result(db.c(), &id, 3, 0).unwrap().unwrap().status, "OK", "the first result stands");
}

/// Safeguard 2: a result is all or nothing. A failure anywhere in its transaction — here, injected at the
/// very last write — leaves no row, so no status can be seen without its data. The same for a new edition.
#[test]
fn a_result_and_an_edition_are_each_written_all_or_nothing() {
    let db = scratch("atomic");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    db.c().execute_batch("CREATE TEMP TRIGGER fail_last BEFORE UPDATE OF updated_at ON translation_editions BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(matches!(record_result(db.c(), &sess, 3, 0, &outcome(Status::Ok), 1, 3), Err(EditionError::Db(e)) if e.contains("injected")));
    assert_eq!(result(db.c(), &id, 3, 0).unwrap(), None, "no status without its commit");
    assert_eq!(pending(db.c(), &id).unwrap().len(), 3);
    db.c().execute_batch("DROP TRIGGER fail_last; CREATE TEMP TRIGGER fail_paragraph BEFORE INSERT ON translation_paragraphs WHEN NEW.section_index = 5 BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    let before = dump(db.c());
    assert!(matches!(create(db.c(), "bookA", &config(), "1.4.1 TEST", &manifest(), 4), Err(EditionError::Db(e)) if e.contains("injected")));
    assert_eq!(dump(db.c()), before, "no part of a failed edition remains");
    db.c().execute_batch("DROP TRIGGER fail_paragraph;").unwrap();
    record_result(db.c(), &sess, 3, 0, &outcome(Status::Ok), 1, 5).unwrap();
}

/// Safeguard 4: the stored result is deterministic, keeps the final candidate's output once (in the text),
/// and keeps every other raw output — chunks included.
#[test]
fn the_stored_result_is_deterministic_and_keeps_each_raw_output_once() {
    let ok = outcome(Status::Ok);
    assert_eq!(outcome_json(&ok), outcome_json(&ok.clone()));
    let v: Value = serde_json::from_str(&outcome_json(&ok)).unwrap();
    assert_eq!(v["schema"], 1);
    assert_eq!(v["raw_omitted"], false);
    assert_eq!(v["candidates"]["fast"]["produced"]["out_is_final_text"], true);
    assert!(v["candidates"]["fast"]["produced"].get("out").is_none(), "the final text is not stored twice");

    let second = outcome(Status::Second);
    let v: Value = serde_json::from_str(&outcome_json(&second)).unwrap();
    assert_eq!(v["candidates"]["fast"]["produced"]["out"], "ليلة.", "a candidate that was not chosen keeps its raw output");
    assert_eq!(v["candidates"]["B"]["produced"]["chunks"][1]["out"], "وهطل المطر.");
    assert_eq!(v["candidates"]["B"]["produced"]["out_is_final_text"], true);
    assert_eq!(v["steps"], serde_json::json!(["2:B"]));
    assert_eq!(v["why_review"], "D1: no clean second translation");
    let failed: Value = serde_json::from_str(&outcome_json(&outcome(Status::Failed))).unwrap();
    assert_eq!(failed["candidates"]["S"]["skipped"], "single sentence");
    assert_eq!(failed["final_kind"], Value::Null);
}

/// Safeguard 4, level 2: past the size bound, a result keeps every judgement, count and stop but no raw
/// output or chunk text; its final text and status are stored in full, untouched.
#[test]
fn a_result_past_the_size_bound_keeps_its_judgements_and_its_final_text() {
    let db = scratch("bound");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let mut big = outcome(Status::Recovered);
    let huge = "ب".repeat(600_000); // 1.2 MB of UTF-8 in a candidate that was not chosen
    big.candidates.insert(Kind::Fast, Candidate::Produced(flagged(&huge, "repetition")));
    let json = outcome_json(&big);
    assert!(json.len() <= MAX_OUTCOME_JSON_BYTES, "{} bytes", json.len());
    let v: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["raw_omitted"], true);
    assert!(v["candidates"]["fast"]["produced"].get("out").is_none());
    assert_eq!(v["candidates"]["fast"]["produced"]["flags"], serde_json::json!(["repetition"]), "the judgement is kept");
    record_result(db.c(), &sess, 3, 0, &big, 1, 3).unwrap();
    let r = result(db.c(), &id, 3, 0).unwrap().unwrap();
    assert_eq!((r.status.as_str(), r.text.as_deref()), ("RECOVERED", Some("كانت ليلة.")));

    // Level 2 also leaves out every chunk's source and output text, and keeps its index, tokens and stop.
    let mut chunked = outcome(Status::Second);
    chunked.candidates.insert(Kind::Fast, Candidate::Produced(flagged(&huge, "incomplete")));
    let v: Value = serde_json::from_str(&outcome_json(&chunked)).unwrap();
    let chunk = &v["candidates"]["B"]["produced"]["chunks"][1];
    assert_eq!((chunk.get("src"), chunk.get("out"), chunk["index"].clone(), chunk["tokens"].clone()), (None, None, Value::from(1), Value::from(4)));

    // Level 3: when even the judgements do not fit, a fixed summary is stored — still with its final text.
    let mut huge_judgements = outcome(Status::Review);
    let mut f = produced("كانت night مظلمة.");
    f.script = vec!["untranslated Latin run".into()];
    f.flags = (0..150_000).map(|i| format!("chunk {i}: duplicated sentence")).collect();
    huge_judgements.candidates.insert(Kind::Fast, Candidate::Produced(f));
    let json = outcome_json(&huge_judgements);
    assert!(json.len() <= MAX_OUTCOME_JSON_BYTES, "{} bytes", json.len());
    let v: Value = serde_json::from_str(&json).unwrap();
    assert_eq!((v["detail_omitted"].clone(), v["status"].clone(), v["why_review"].clone()), (Value::Bool(true), Value::from("REVIEW"), Value::from("script leak not repaired")));
    assert_eq!(v["candidates"]["B"], "skipped: cannot split (single sentence)");
    record_result(db.c(), &sess, 3, 1, &huge_judgements, 1, 4).unwrap();
    assert_eq!(result(db.c(), &id, 3, 1).unwrap().unwrap().text.as_deref(), Some("كانت night مظلمة."));
}

/// Safeguard 4, at the table: whatever code writes it, a stored result above the bound is refused.
#[test]
fn the_table_refuses_a_stored_result_above_the_bound() {
    let db = scratch("bound_table");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let sess = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let insert = |ordinal: u32, json: &str| {
        db.c().execute(
            "INSERT INTO translation_results(edition_id, section_index, ordinal, session_id, status, text, final_kind, why_review, outcome_json, outcome_schema, took_ms, created_at) \
             VALUES(?1, 3, ?2, ?3, 'OK', 'x', 'fast', NULL, ?4, 1, 0, 0)",
            params![id, ordinal, sess, json],
        )
    };
    assert!(insert(0, &"x".repeat(MAX_OUTCOME_JSON_BYTES + 1)).is_err(), "one byte over is refused");
    assert!(insert(0, &"ب".repeat(MAX_OUTCOME_JSON_BYTES / 2 + 1)).is_err(), "the bound counts bytes, not characters");
    assert!(insert(0, &"x".repeat(MAX_OUTCOME_JSON_BYTES)).is_ok(), "exactly the bound is accepted");
}

// ═══ F · DELETION BOUNDARIES ═════════════════════════════════════════════════════════════════════════════

/// Two books with the reader's marks, three editions with sessions, results and failures.
fn two_libraries(tag: &str) -> (Db, [String; 3]) {
    let db = scratch(tag);
    for b in ["bookA", "bookB"] {
        add_book(db.c(), b);
        seed_reader_state(db.c(), b);
    }
    db.c().execute("INSERT INTO settings(key, value) VALUES('reader_font', 'Amiri')", []).unwrap();
    let eds = [make(db.c(), "bookA"), make(db.c(), "bookA"), make(db.c(), "bookB")];
    for (i, e) in eds.iter().enumerate() {
        let s = begin_session(db.c(), e, &engine(), "1.4.1 TEST", None, 10 + i as i64).unwrap();
        record_result(db.c(), &s, 3, 0, &outcome(Status::Ok), 1, 20).unwrap();
        record_failure(db.c(), &s, 3, 1, FailureKind::Engine, "Transport", 21).unwrap();
        end_session(db.c(), &s, EndReason::Engine, 22).unwrap();
    }
    (db, eds)
}

/// Safeguard 5: deleting one edition removes exactly its rows — not the book's other edition, not another
/// book's, and not one row of anything else.
#[test]
fn deleting_an_edition_removes_only_its_own_rows() {
    let (db, [a1, a2, b1]) = two_libraries("delete_edition");
    let before = dump(db.c());
    assert!(delete_edition(db.c(), &a1).unwrap());
    let sessions_of_a1: Vec<String> = before["translation_sessions"].iter().filter(|r| r[1] == a1).map(|r| r[0].clone()).collect();
    assert_eq!(dump(db.c()), without(&before, &[vec![a1.clone()], sessions_of_a1].concat()));
    assert!(get(db.c(), &a2).unwrap().is_some() && get(db.c(), &b1).unwrap().is_some());
    assert!(!delete_edition(db.c(), &a1).unwrap(), "already gone");
    assert_eq!(before["highlights"].len(), 2, "the fixture held the reader's marks");
}

#[test]
fn an_edition_with_an_open_session_cannot_be_deleted() {
    let db = scratch("delete_running");
    add_book(db.c(), "bookA");
    let id = make(db.c(), "bookA");
    let s = begin_session(db.c(), &id, &engine(), "1.4.1 TEST", None, 2).unwrap();
    let before = dump(db.c());
    assert_eq!(delete_edition(db.c(), &id).unwrap_err(), EditionError::Running);
    assert_eq!(dump(db.c()), before);
    end_session(db.c(), &s, EndReason::Cancelled, 3).unwrap();
    assert!(delete_edition(db.c(), &id).unwrap());
}

/// Safeguard 5 and I6-4: deleting a book (through the library's own delete) takes its editions and their
/// rows with it — and leaves every row of the other book, its editions included, and every global row.
#[test]
fn deleting_a_book_removes_its_editions_and_nothing_of_another_book() {
    let (db, [a1, a2, b1]) = two_libraries("delete_book");
    let before = dump(db.c());
    assert!(crate::library::delete_book(db.c(), &db.dir, "bookA").unwrap());
    let gone: Vec<String> = [
        vec!["bookA".to_string(), a1.clone(), a2.clone()],
        before["translation_sessions"].iter().filter(|r| r[1] == a1 || r[1] == a2).map(|r| r[0].clone()).collect(),
        before["highlights"].iter().filter(|r| r[1] == "bookA").map(|r| r[0].clone()).collect(),
    ]
    .concat();
    assert_eq!(dump(db.c()), without(&before, &gone), "only book A's rows are gone");
    assert!(list_for_book(db.c(), "bookA").unwrap().is_empty());
    assert_eq!(list_for_book(db.c(), "bookB").unwrap(), vec![b1.clone()]);
    assert_eq!(get(db.c(), &b1).unwrap().unwrap().counts.done, 1);
}

/// A minimal EPUB the importer accepts.
fn epub(title: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        z.start_file("mimetype", stored).unwrap();
        z.write_all(b"application/epub+zip").unwrap();
        let deflate = zip::write::SimpleFileOptions::default();
        z.start_file("META-INF/container.xml", deflate).unwrap();
        z.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        z.start_file("OEBPS/content.opf", deflate).unwrap();
        z.write_all(format!(r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:{title}</dc:identifier><dc:title>{title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/></spine></package>"#).as_bytes()).unwrap();
        z.start_file("OEBPS/c0.xhtml", deflate).unwrap();
        z.write_all(format!(r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><p>Body text of {title}.</p></body></html>"#).as_bytes()).unwrap();
        z.finish().unwrap();
    }
    buf
}

/// I6-4 and `replace_file`: a book's id is the SHA-256 of its bytes, so replacing a damaged stored copy with
/// the same bytes is the same book — and keeps every row of its editions, value for value.
#[test]
fn replacing_a_damaged_copy_with_the_same_bytes_keeps_every_edition_row() {
    let db = scratch("replace");
    std::fs::create_dir_all(db.dir.join("outside")).unwrap();
    let src = db.dir.join("outside").join("book.epub");
    std::fs::write(&src, epub("Replaced")).unwrap();
    let res = crate::books::import_books(db.c(), &db.dir, &[src.to_string_lossy().into_owned()]);
    assert_eq!(res[0].status, "imported", "{:?}", res[0].message);
    let book = res[0].id.clone();
    assert_eq!(book, hex_of(&Sha256::digest(std::fs::read(&src).unwrap())), "a book's id is the SHA-256 of its bytes");
    let ed = make(db.c(), &book);
    let s = begin_session(db.c(), &ed, &engine(), "1.4.1 TEST", None, 2).unwrap();
    record_result(db.c(), &s, 3, 0, &outcome(Status::Review), 1, 3).unwrap();
    end_session(db.c(), &s, EndReason::Cancelled, 4).unwrap();
    let managed: String = db.c().query_row("SELECT file_path FROM books WHERE id = ?1", [&book], |r| r.get(0)).unwrap();
    std::fs::remove_file(&managed).unwrap(); // the stored copy is lost
    let translation = |c: &Connection| -> Vec<Vec<Vec<String>>> {
        let d = dump(c);
        TRANSLATION_TABLES.iter().map(|t| d[*t].clone()).collect()
    };
    let before = translation(db.c());
    let out = crate::books::replace_file(db.c(), &db.dir, &book, &src.to_string_lossy()).unwrap();
    assert!(out.restored_file, "the copy was written again");
    assert_eq!(translation(db.c()), before, "every edition row is kept");
}
