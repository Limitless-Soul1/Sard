//! The reader's side, against scripted engines and a temporary store: what each paragraph shows, the section being read
//! translated first, one job at a time, a failure said as the reader says it, and only a ready model offered — with
//! Model A closed while its terms are not accepted. No test starts a real engine or uses the GPU.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::active::Active;
use super::catalog::{Artifact, Licence, MODEL_A, MODEL_B};
use super::download::Policy;
use super::edition_run::Scope;
use super::edition_run_tests::{config_for, gpu, make, running, scratch, sentences, Db, Fault, ANSWERS, P00, P02, P10, P11, P20, TWO_SPACES};
use super::editions::{self, ParagraphInput, SectionInput};
use super::engine::{EngineError, EngineInfo};
use super::execution::NotStarted;
use super::hardware::Fit;
use super::install;
use super::install_tests::{build_zip, entries, put_verified, sha, small_engine, spec_for, TempDir};
use super::manage::{self, GEMMA_TERMS_REVISION};
use super::pipeline::{Raw, Request, Source};
use super::reader::*;
use super::slot::serial_for_tests;
use super::store::Store;
use super::supervisor::{self, Idle};

const LINKED: &str = "See the map here.";
const FLAGGED: &str = "Review this line.";
const UNANSWERED: &str = "Nobody answers this.";

/// A scripted engine: it answers from `answers` (anything else gets an empty answer, which the pipeline fails), and
/// records what it was asked.
struct Scripted {
    answers: HashMap<String, String>,
    asked: Arc<Mutex<Vec<String>>>,
    up: Mutex<Option<EngineInfo>>,
    cannot_start: bool,
}

impl Scripted {
    fn new(extra: &[(&str, &str)]) -> Arc<Scripted> {
        let mut answers: HashMap<String, String> = ANSWERS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        answers.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        Arc::new(Scripted { answers, asked: Arc::new(Mutex::new(Vec::new())), up: Mutex::new(None), cannot_start: false })
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

struct ScriptedSource {
    answers: HashMap<String, String>,
    asked: Arc<Mutex<Vec<String>>>,
    cancel: Arc<AtomicBool>,
}

impl Source for ScriptedSource {
    type Error = Fault;
    fn answer(&mut self, r: &Request) -> Result<Raw, Fault> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(Fault::Cancelled);
        }
        self.asked.lock().unwrap().push(r.text.clone());
        Ok(Raw { out: self.answers.get(&r.text).cloned().unwrap_or_default(), tokens: Some(9), stop: "eos".into() })
    }
}

impl supervisor::Engine for Scripted {
    type Source = ScriptedSource;
    fn ready(&self) -> Option<EngineInfo> {
        self.up.lock().unwrap().clone()
    }
    fn start(&self) -> Result<EngineInfo, String> {
        if self.cannot_start {
            return Err("the hardware check did not confirm the GPU".into());
        }
        let info = running(&MODEL_B, gpu("Vulkan0"));
        *self.up.lock().unwrap() = Some(info.clone());
        Ok(info)
    }
    fn source(&self, cancel: Arc<AtomicBool>) -> Result<ScriptedSource, String> {
        Ok(ScriptedSource { answers: self.answers.clone(), asked: self.asked.clone(), cancel })
    }
    fn stop(&self) -> Result<(), String> {
        *self.up.lock().unwrap() = None;
        Ok(())
    }
}

fn paragraph(i: u32, text: &str, atoms: &[(&str, u32)]) -> ParagraphInput {
    let atoms: BTreeMap<String, u32> = atoms.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    ParagraphInput { path: vec![i], tag: "p".into(), atoms, text: text.into(), sentences: sentences(text) }
}

fn sectioned(index: u32, paragraphs: Vec<ParagraphInput>) -> SectionInput {
    let n = paragraphs.len() as u32;
    SectionInput { index, href: format!("s{index}.xhtml"), linear: true, content_type: "application/xhtml+xml".into(), leaves: n, dropped_empty: 0, body_fallback: false, paragraphs }
}

fn run(db: &Db, id: &str, first: Option<u32>, engine: &Arc<Scripted>) -> Result<(), String> {
    run_counting(db, id, first, engine).0
}

/// `run`, and how many times the job said it progressed.
fn run_counting(db: &Db, id: &str, first: Option<u32>, engine: &Arc<Scripted>) -> (Result<(), String>, usize) {
    let n = Mutex::new(0);
    let r = run_book(db.m(), id, &super::catalog::ENGINE_WINDOWS_X64, &MODEL_B, "1.4.1 TEST", first, engine, &Idle::default(), &|| 1_000, &|| *n.lock().unwrap() += 1);
    (r, n.into_inner().unwrap())
}

// ═══ WHAT THE READER SHOWS ══════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn each_paragraph_shows_its_translation_or_its_original_with_the_reason() {
    let db = scratch("reader-view");
    let sections = vec![
        sectioned(
            0,
            vec![
                paragraph(0, P00, &[]),
                paragraph(1, TWO_SPACES, &[]),
                paragraph(2, LINKED, &[("a", 1)]),
                paragraph(3, FLAGGED, &[]),
                paragraph(4, UNANSWERED, &[]),
            ],
        ),
        sectioned(1, vec![paragraph(0, P10, &[])]),
    ];
    let id = editions::create(&db.m().lock().unwrap(), "book", &config_for(&MODEL_B, &gpu("Vulkan0")), "1.4.1 TEST", &sections, 10).unwrap();
    let engine = Scripted::new(&[(LINKED, "انظر الخريطة هنا."), (FLAGGED, "راجع هذا السطر ведь.")]);
    // Section 0 only: section 1 stays pending.
    let job = supervisor::Job {
        db: db.m(),
        edition_id: &id,
        spec: &super::catalog::ENGINE_WINDOWS_X64,
        model: &MODEL_B,
        app_build: "1.4.1 TEST",
        scope: &Scope::Sections([0].into()),
        cancel: Arc::new(AtomicBool::new(false)),
        now: &|| 1_000,
    };
    supervisor::translate(&job, &engine, &Idle::default(), std::time::Duration::from_secs(60)).unwrap();
    assert!(engine.asked().contains(&LINKED.to_string()), "a paragraph with a link is still translated in the background");

    let shown: Vec<ShowView> = section(&db.m().lock().unwrap(), &id, 0).unwrap().into_iter().map(|p| p.show).collect();
    assert_eq!(
        shown,
        vec![
            ShowView::Translation { text: "ألفا بيتا غاما. دلتا إبسلون.".into(), review: false },
            ShowView::NotTranslated,
            ShowView::KeptOriginal,
            ShowView::Translation { text: "راجع هذا السطر ведь.".into(), review: true },
            ShowView::NotTranslated,
        ]
    );
    let later = section(&db.m().lock().unwrap(), &id, 1).unwrap();
    assert_eq!((later.len(), &later[0].show, later[0].text.as_str(), later[0].path.as_slice()), (1, &ShowView::Pending, P10, &[0u32][..]));
}

#[test]
fn every_kind_of_atom_keeps_a_paragraph_in_the_original() {
    let db = scratch("reader-atoms");
    let kinds = ["a", "noteref", "img", "br"];
    let paragraphs = kinds.iter().enumerate().map(|(i, k)| paragraph(i as u32, &format!("Paragraph number {i}."), &[(k, 2)])).collect();
    let mut plain = paragraph(4, "Plain words only.", &[]);
    plain.atoms.insert("em".into(), 3);
    let mut all: Vec<ParagraphInput> = paragraphs;
    all.push(plain);
    let id = editions::create(&db.m().lock().unwrap(), "book", &config_for(&MODEL_B, &gpu("Vulkan0")), "1.4.1 TEST", &[sectioned(0, all)], 10).unwrap();
    let shown: Vec<ShowView> = section(&db.m().lock().unwrap(), &id, 0).unwrap().into_iter().map(|p| p.show).collect();
    assert_eq!(&shown[..4], &[ShowView::KeptOriginal, ShowView::KeptOriginal, ShowView::KeptOriginal, ShowView::KeptOriginal]);
    assert_eq!(shown[4], ShowView::Pending, "a count of anything else changes nothing");
}

// ═══ THE JOB ════════════════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn the_section_being_read_is_translated_first_then_the_rest_of_the_book() {
    let db = scratch("reader-first");
    let id = make(&db, &MODEL_B);
    let engine = Scripted::new(&[]);
    let (result, progressed) = run_counting(&db, &id, Some(2), &engine);
    result.unwrap();
    assert_eq!(engine.asked(), vec![P20, P00, P02, P10, P11]);
    assert_eq!(progressed, 2, "the reader is told once the section being read is done, and again at the end");
    assert_eq!(editions::get(&db.m().lock().unwrap(), &id).unwrap().unwrap().counts.pending, 0);

    // A section that is not the edition's is ignored: the book in order.
    let db = scratch("reader-first-none");
    let id = make(&db, &MODEL_B);
    let engine = Scripted::new(&[]);
    run(&db, &id, Some(9), &engine).unwrap();
    assert_eq!(engine.asked(), vec![P00, P02, P10, P11, P20]);
    // Nothing left to do is not a failure.
    run(&db, &id, Some(0), &engine).unwrap();
}

#[test]
fn a_job_that_cannot_start_says_why_and_the_reader_words_it() {
    let db = scratch("reader-nostart");
    let id = make(&db, &MODEL_B);
    let engine = Arc::new(Scripted { cannot_start: true, ..Arc::try_unwrap(Scripted::new(&[])).ok().unwrap() });
    assert_eq!(run(&db, &id, Some(0), &engine), Err("the hardware check did not confirm the GPU".into()));

    let memory = NotStarted::Refused { why: Fit::InsufficientRam { needed: 4, available: 2 }, alternative: None };
    assert_eq!(failure(Some(&memory), "d".into()), ReaderErrorView::Failed { memory: true, engine_busy: false, detail: "d".into() });
    let busy = NotStarted::Engine(EngineError::AlreadyActive);
    assert_eq!(failure(Some(&busy), "d".into()), ReaderErrorView::Failed { memory: false, engine_busy: true, detail: "d".into() });
    assert_eq!(failure(None, "d".into()), ReaderErrorView::Failed { memory: false, engine_busy: false, detail: "d".into() });
}

#[test]
fn one_job_at_a_time_for_the_whole_of_sard() {
    let _serial = serial_for_tests();
    begin("book-1", "edition-1").unwrap();
    assert_eq!(begin("book-2", "edition-2"), Err(ReaderErrorView::Busy));
    end();
    begin("book-2", "edition-2").unwrap();
    end();
}

// ═══ THE MODEL, AND THE STATUS ══════════════════════════════════════════════════════════════════════════════════════

/// A store with the small engine installed and both catalog models (test bytes) installed, and the active catalog
/// that names them.
struct Shelf {
    _tmp: TempDir,
    store: Store,
    active: Active,
    a: &'static Artifact,
    b: &'static Artifact,
}

fn shelf(tag: &str) -> Shelf {
    let tmp = TempDir::new(&format!("reader_{tag}"));
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let archive = build_zip(&entries(&small_engine()));
    let spec = spec_for(&format!("reader-{tag}"), &small_engine(), &archive);
    put_verified(&store, spec.archive, &archive);
    install::install(&store, spec, &AtomicBool::new(false)).unwrap();
    let data: Vec<u8> = (0..2048u32).map(|i| (i * 7) as u8).collect();
    let digest: &'static str = Box::leak(sha(&data).into_boxed_str());
    let like = |m: &Artifact| -> &'static Artifact { Box::leak(Box::new(Artifact { sha256: digest, size: data.len() as u64, sources: &[], ..*m })) };
    let (a, b) = (like(&MODEL_A), like(&MODEL_B));
    for m in [a, b] {
        fs::create_dir_all(store.artifact_dir(m)).unwrap();
        put_verified(&store, m, &data);
    }
    let active = Active { spec, models: vec![a, b], policy: Policy::loopback_for_tests(), test: true };
    Shelf { _tmp: tmp, store, active, a, b }
}

fn prepared(db: &Db, s: &Shelf, m: &Artifact, device: &str) {
    db.m()
        .lock()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO translation_prepared(model, model_sha256, engine_sha256, device, prepared_at) VALUES(?1, ?2, ?3, ?4, 5)",
            rusqlite::params![m.id, m.sha256, s.active.spec.archive.sha256, device],
        )
        .unwrap();
}

fn ready_id(db: &Db, s: &Shelf, prefer: Option<&str>) -> Option<&'static str> {
    ready_model(&db.m().lock().unwrap(), &s.store, &s.active, prefer).unwrap().map(|(m, _)| m.id)
}

#[test]
fn only_a_ready_model_is_offered_model_a_only_with_its_terms_and_the_books_own_model_first() {
    let _serial = serial_for_tests();
    let db = scratch("reader-ready");
    let s = shelf("ready");
    assert_eq!(ready_id(&db, &s, None), None, "downloaded is not ready");
    prepared(&db, &s, s.a, "Vulkan0");
    assert_eq!(ready_id(&db, &s, None), None, "model A is prepared, but its terms are not accepted: it is not offered");
    prepared(&db, &s, s.b, "Vulkan0");
    assert_eq!(ready_id(&db, &s, None), Some(MODEL_B.id));
    // With A's terms accepted (a build that carries them), the catalog's order — unless the book began with B.
    manage::record_acceptance(&db.m().lock().unwrap(), Licence::GemmaTerms, GEMMA_TERMS_REVISION, 9).unwrap();
    assert_eq!(ready_id(&db, &s, None), Some(MODEL_A.id));
    assert_eq!(ready_id(&db, &s, Some(MODEL_B.id)), Some(MODEL_B.id));
}

#[test]
fn the_status_names_the_ready_model_and_the_books_edition_which_stays_readable_without_one() {
    let _serial = serial_for_tests();
    let db = scratch("reader-status");
    let s = shelf("status");
    let id = make(&db, &MODEL_B);
    let without = status(&db.m().lock().unwrap(), &s.store, &s.active, "book", None).unwrap();
    assert_eq!(without.model, None);
    assert_eq!(without.edition.as_ref().map(|e| (e.id.as_str(), e.model.as_str(), e.pending)), Some((id.as_str(), MODEL_B.id, 5)), "D7: an edition stays readable");
    prepared(&db, &s, s.b, "Vulkan0");
    assert_eq!(without.supported, cfg!(all(windows, target_arch = "x86_64")));
    let with = status(&db.m().lock().unwrap(), &s.store, &s.active, "book", Some(("book".into(), id.clone()))).unwrap();
    assert_eq!(with.model, Some(ReadyModelView { id: MODEL_B.id.into(), device: "Vulkan0".into() }));
    assert!(with.translating && !with.translating_other);
    let other = status(&db.m().lock().unwrap(), &s.store, &s.active, "book", Some(("another".into(), "e".into()))).unwrap();
    assert!(!other.translating && other.translating_other);
}

#[test]
fn the_wire_format_is_what_the_reader_reads() {
    assert_eq!(serde_json::to_value(ShowView::Translation { text: "ت".into(), review: true }).unwrap(), json!({ "kind": "translation", "text": "ت", "review": true }));
    assert_eq!(serde_json::to_value(ShowView::KeptOriginal).unwrap(), json!({ "kind": "kept_original" }));
    assert_eq!(serde_json::to_value(ReaderErrorView::NoReadyModel).unwrap(), json!({ "kind": "no_ready_model" }));
    assert_eq!(
        serde_json::to_value(ReaderErrorView::Failed { memory: true, engine_busy: false, detail: "d".into() }).unwrap(),
        json!({ "kind": "failed", "memory": true, "engineBusy": false, "detail": "d" })
    );
    let p = ParagraphView { ordinal: 1, path: vec![0, 2], tag: "p".into(), text: "t".into(), show: ShowView::Pending };
    assert_eq!(serde_json::to_value(p).unwrap(), json!({ "ordinal": 1, "path": [0, 2], "tag": "p", "text": "t", "show": { "kind": "pending" } }));
    let e = EditionEventView::Ended { book: "b".into(), edition: "e".into() };
    assert_eq!(serde_json::to_value(e).unwrap(), json!({ "kind": "ended", "book": "b", "edition": "e" }));
}
