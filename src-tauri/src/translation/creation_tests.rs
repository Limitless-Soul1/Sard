//! Making an edition: the extraction module's output read field for field, the runtime version required and checked,
//! and everything else decided from the catalog — against a real Sard database opened as the app opens one.
//!
//! The extraction sample is shared with the extraction module's own tests, which check that the module produces
//! exactly it: so the page's output and what this side reads are one contract, held from both ends.

use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::Value;

use super::catalog::{ENGINE_WINDOWS_X64, MODEL_A, MODEL_B, RUNTIME_WINDOWS_X64};
use super::creation::*;
use super::edition_run::engine_config;
use super::editions::*;
use super::engine;
use super::runtime_identity::{resolve, RuntimeError};
use crate::db::migrations;

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

fn scratch(tag: &str) -> Db {
    let dir = std::env::temp_dir().join(format!("sard_creation_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = crate::db::open_database(&dir.join("sard.db")).unwrap();
    migrations::run(&conn, None).unwrap();
    conn.execute("INSERT INTO books(id, file_path, format, title, added_at) VALUES('book', 'nowhere/book.epub', 'epub', 'book', 1)", []).unwrap();
    Db { conn: Some(conn), dir }
}

fn sample_text() -> String {
    std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/translation/extraction-sample.json")).unwrap()
}

fn sample() -> ExtractionInput {
    serde_json::from_str(&sample_text()).unwrap()
}

fn gpu() -> ExecutionInput {
    ExecutionInput::Gpu { device: "Vulkan0".into() }
}

const RUNTIME: &str = "155.0.4283.62";

fn editions_count(c: &Connection) -> i64 {
    c.query_row("SELECT COUNT(*) FROM translation_editions", [], |r| r.get(0)).unwrap()
}

#[test]
fn the_extraction_modules_output_makes_an_edition_with_everything_else_from_the_catalog() {
    let db = scratch("made");
    let id = create_edition(db.c(), "book", MODEL_B.id, &gpu(), &sample(), Ok(RUNTIME.into()), "1.4.1 TEST", 7).unwrap();
    let ed = get(db.c(), &id).unwrap().unwrap();
    assert_eq!(ed.config.webview_version, RUNTIME, "the resolved runtime is the one recorded");
    assert_eq!(ed.config.extraction_id, SUPPORTED_EXTRACTION_ID);
    assert_eq!((ed.config.source_lang.as_str(), ed.config.target_lang.as_str(), ed.config.target_dir.as_str()), ("en", "ar", "rtl"));
    assert_eq!(ed.config.engine, engine_config(&ENGINE_WINDOWS_X64, &MODEL_B, &engine::Execution::Gpu { device: "Vulkan0".into() }).unwrap());
    assert_eq!((ed.state, ed.counts.paragraphs, ed.counts.rejected, ed.counts.pending), (EditionState::Ready, 3, 0, 3));
    let p = pending(db.c(), &id).unwrap();
    assert_eq!(p.iter().map(|p| (p.section_index, p.ordinal, p.text.as_str())).collect::<Vec<_>>(), vec![(0, 0, "Chapter One"), (0, 1, "First. Second."), (1, 0, "Just text.")]);
    assert_eq!(p[1].sentences, vec!["First.".to_string(), "Second.".to_string()]);
    let linear: bool = db.c().query_row("SELECT linear FROM translation_sections WHERE edition_id = ?1 AND section_index = 1", [&id], |r| r.get(0)).unwrap();
    assert!(!linear, "a non-linear section is stored as one");
    let cpu = create_edition(db.c(), "book", MODEL_A.id, &ExecutionInput::Cpu { threads: 6 }, &sample(), Ok(RUNTIME.into()), "t", 8).unwrap();
    assert_eq!(get(db.c(), &cpu).unwrap().unwrap().config.engine.execution, Execution::Cpu { threads: 6 });
}

#[test]
fn a_field_the_module_does_not_send_or_one_it_lacks_is_refused() {
    let whole: Value = serde_json::from_str(&sample_text()).unwrap();
    type Spoil = Box<dyn Fn(&mut Value)>;
    let spoils: Vec<(&str, Spoil)> = vec![
        ("an extra field on the extraction", Box::new(|v| v["runtime"] = "156.0.0.0".into())),
        ("an extra field on a section", Box::new(|v| v["sections"][0]["lang"] = "en".into())),
        ("an extra field on a paragraph", Box::new(|v| v["sections"][0]["paragraphs"][0]["html"] = "<h1/>".into())),
        ("no atoms", Box::new(|v| { v["sections"][0]["paragraphs"][0].as_object_mut().unwrap().remove("atoms"); })),
        ("no sentences", Box::new(|v| { v["sections"][1]["paragraphs"][0].as_object_mut().unwrap().remove("sentences"); })),
        ("no extraction id", Box::new(|v| { v.as_object_mut().unwrap().remove("extraction_id"); })),
        ("a negative index", Box::new(|v| v["sections"][0]["index"] = (-1).into())),
    ];
    for (what, spoil) in &spoils {
        let mut v = whole.clone();
        spoil(&mut v);
        assert!(serde_json::from_value::<ExtractionInput>(v).is_err(), "{what} must be refused");
    }
    assert!(serde_json::from_value::<ExtractionInput>(whole).is_ok());
}

#[test]
fn the_execution_is_read_strictly() {
    let read = |s: &str| serde_json::from_str::<ExecutionInput>(s);
    assert_eq!(read(r#"{"kind":"gpu","device":"Vulkan0"}"#).unwrap(), ExecutionInput::Gpu { device: "Vulkan0".into() });
    assert_eq!(read(r#"{"kind":"cpu","threads":6}"#).unwrap(), ExecutionInput::Cpu { threads: 6 });
    for bad in [r#"{"kind":"tpu"}"#, r#"{"kind":"gpu"}"#, r#"{"kind":"cpu","threads":6,"device":"x"}"#, r#"{"device":"Vulkan0"}"#] {
        assert!(read(bad).is_err(), "{bad} must be refused");
    }
}

#[test]
fn no_edition_is_made_without_an_established_runtime() {
    let db = scratch("runtime");
    let cases = [
        RuntimeError::Mismatch { installed: "156.0.1.0".into(), running: RUNTIME.into() },
        RuntimeError::Unavailable { which: "running", detail: "the webview did not answer".into() },
    ];
    for e in cases {
        assert_eq!(create_edition(db.c(), "book", MODEL_B.id, &gpu(), &sample(), Err(e.clone()), "t", 1), Err(CreateError::Runtime(e)));
    }
    assert_eq!(editions_count(db.c()), 0, "nothing was written");
}

#[test]
fn the_runtime_is_the_installed_one_only_when_the_running_webview_is_on_it() {
    assert_eq!(resolve(Ok(RUNTIME.into()), Ok(RUNTIME.into())), Ok(RUNTIME.into()));
    assert_eq!(resolve(Ok("156.0.1.0".into()), Ok(RUNTIME.into())), Err(RuntimeError::Mismatch { installed: "156.0.1.0".into(), running: RUNTIME.into() }));
    assert_eq!(resolve(Ok(format!("{RUNTIME} ")), Ok(RUNTIME.into())), Err(RuntimeError::Mismatch { installed: format!("{RUNTIME} "), running: RUNTIME.into() }), "compared exactly");
    assert_eq!(resolve(Err("no runtime".into()), Ok(RUNTIME.into())), Err(RuntimeError::Unavailable { which: "installed", detail: "no runtime".into() }));
    assert_eq!(resolve(Ok(RUNTIME.into()), Err("no answer".into())), Err(RuntimeError::Unavailable { which: "running", detail: "no answer".into() }));
    assert_eq!(resolve(Ok(String::new()), Ok(RUNTIME.into())), Err(RuntimeError::Unavailable { which: "installed", detail: "empty".into() }));
    assert_eq!(resolve(Ok(RUNTIME.into()), Ok(String::new())), Err(RuntimeError::Unavailable { which: "running", detail: "empty".into() }));
}

#[test]
fn an_unknown_model_book_or_extraction_is_refused_and_nothing_is_written() {
    let db = scratch("refused");
    for id in ["no-such-model", RUNTIME_WINDOWS_X64.id] {
        assert_eq!(create_edition(db.c(), "book", id, &gpu(), &sample(), Ok(RUNTIME.into()), "t", 1), Err(CreateError::NotAModel(id.into())));
    }
    assert_eq!(create_edition(db.c(), "no-such-book", MODEL_B.id, &gpu(), &sample(), Ok(RUNTIME.into()), "t", 1), Err(CreateError::Store(EditionError::NoSuchBook)));
    let mut other = sample();
    other.extraction_id = "leafblocks-1/pyws-3.12.0-ucd15/segmenter-en-1".into();
    assert!(matches!(create_edition(db.c(), "book", MODEL_B.id, &gpu(), &other, Ok(RUNTIME.into()), "t", 1), Err(CreateError::Store(EditionError::Config(_)))));
    assert_eq!(editions_count(db.c()), 0);
}
