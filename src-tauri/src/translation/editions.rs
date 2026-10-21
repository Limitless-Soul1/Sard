//! Translation editions — a book's translation, kept so that it can be made, resumed, explained and removed
//! without touching the book or anything the reader has built on it.
//!
//! An edition belongs to ONE book and ONE configuration. The book is its id, which is the SHA-256 of its
//! bytes, so an edition is bound to the exact source it was made from. The configuration is everything
//! besides the inputs that decides the output: the model, the engine, the execution path, the engine's
//! flags, the pipeline and its constant — and the translation implementation itself, a fingerprint of its code
//! taken when Sard is built (`implementation`). All of it is summed up in the edition's identity
//! (`identity_sha256`).
//!
//! THE INPUTS ARE FROZEN WHEN THE EDITION IS MADE. Every paragraph's exact text and sentence list, as the
//! extraction took them from the book, is checked against the pipeline's input contract and stored, with
//! the extraction's identity and the WebView2 runtime that ran it. Translation and resume read only these
//! stored inputs, so nothing outside — a WebView2 update, a re-parse — can change an edition halfway.
//!
//! A PARAGRAPH'S RESULT IS WRITTEN WHOLE. Its status, its text, its review reason, the whole pipeline result
//! and the session that made it go into one row, in one transaction, together with the checks that the
//! session is open and the paragraph is still untranslated. A status therefore never exists without its
//! data, and a crash loses at most the paragraph in flight, which is simply done again: the pipeline keeps
//! no state between paragraphs.
//!
//! THE READER-SAFETY RULES HOLD IN THREE PLACES — this module refuses an `Outcome` that breaks them, the
//! tables' CHECKs refuse such a row whatever writes it, and the tests try both. A FAILED paragraph has no
//! text and no final candidate. A REVIEW or SECOND paragraph keeps its review reason, and no other status
//! has one (the pipeline sets one exactly for those two).
//!
//! A RESUME IS REFUSED, FIELD BY FIELD, when anything in the configuration differs from the edition's: two
//! models are never mixed in one edition, and neither are GPU and CPU output unless the reader explicitly
//! approved it — and nothing here can grant that approval yet.
//!
//! Nothing here is reachable from the interface; the translation run that uses it comes later.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::pipeline::{Candidate, Outcome, Status};
use super::store::{hex, random_hex};

/// The version of the stored pipeline result's JSON.
pub const OUTCOME_SCHEMA: i64 = 1;
/// The version of the identity's canonical form.
pub const IDENTITY_SCHEMA: i64 = 1;
/// The most a stored pipeline result may take, in bytes; the table refuses more, whatever writes it. The
/// result is stored at the first of three levels that fits:
/// 1. **whole** — every candidate's raw output (the final one only as the final text), chunk sources and
///    outputs, judgements, token counts, stops and requests;
/// 2. **judgements** (`"raw_omitted": true`) — the same without any raw output or chunk source text;
/// 3. **summary** (`"detail_omitted": true`) — status, final candidate, steps, completeness, review reason, and
///    which candidates were produced or skipped.
///
/// The final text and the status are kept in full at every level, in their own columns. Each request's output
/// is already capped by the pipeline's token budget, so level 1 is what the recordings need (largest seen:
/// about 8 KB a paragraph).
pub const MAX_OUTCOME_JSON_BYTES: usize = 1 << 20;

/// The translation implementation this build carries: the fingerprint of the code that decides what a
/// translation is (`fingerprint`), computed when Sard is built. An edition records the one it was made with,
/// and a session runs only with the same one — so a build whose translation code differs never resumes it.
pub fn implementation() -> &'static str {
    env!("SARD_TRANSLATION_IMPLEMENTATION")
}

/// Python 3.12.0's whitespace (`str.isspace`, which is `re`'s `\s`; Unicode 15.0.0), as inclusive ranges.
/// It is the set the measured extraction collapses and trims with, derived from that interpreter, not typed
/// from a table: 29 code points. It differs from JavaScript's `\s` by U+001C–001F and U+0085 (Python only)
/// and U+FEFF (JavaScript only).
pub const PYTHON_WHITESPACE: [(u32, u32); 10] = [
    (0x09, 0x0D),
    (0x1C, 0x20),
    (0x85, 0x85),
    (0xA0, 0xA0),
    (0x1680, 0x1680),
    (0x2000, 0x200A),
    (0x2028, 0x2029),
    (0x202F, 0x202F),
    (0x205F, 0x205F),
    (0x3000, 0x3000),
];

pub fn is_python_whitespace(c: char) -> bool {
    let c = c as u32;
    PYTHON_WHITESPACE.iter().any(|&(a, b)| a <= c && c <= b)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// The one canonical text of a JSON value that the identity hashes are taken over: compact, every object's
/// keys sorted at every depth, arrays in order. Explicit, so that it never depends on a library feature (an
/// insertion-ordered map) or a library version. The identities carry no floating-point number (`k` is kept as
/// its bit pattern), so number formatting cannot change them either. A golden test pins the result.
fn canonical(v: &Value) -> String {
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String((*k).clone()).to_string());
                    out.push(':');
                    write(&m[k.as_str()], out);
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(x, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    write(v, &mut out);
    out
}

// ---- What an edition is made with ----

/// Where the model runs. The CPU thread count is part of it: it is proven not to change the output only for
/// one of the two models.
#[derive(Debug, Clone, PartialEq)]
pub enum Execution {
    Gpu { device: String },
    Cpu { threads: u32 },
}

impl Execution {
    fn kind(&self) -> &'static str {
        match self {
            Execution::Gpu { .. } => "gpu",
            Execution::Cpu { .. } => "cpu",
        }
    }

    fn detail(&self) -> Value {
        match self {
            Execution::Gpu { device } => json!({ "device": device }),
            Execution::Cpu { threads } => json!({ "threads": threads }),
        }
    }

    fn from_stored(kind: &str, detail: &str) -> Result<Execution, EditionError> {
        let v: Value = serde_json::from_str(detail).map_err(|e| EditionError::Db(format!("execution detail: {e}")))?;
        match kind {
            "gpu" => Ok(Execution::Gpu { device: v["device"].as_str().unwrap_or_default().to_string() }),
            "cpu" => Ok(Execution::Cpu { threads: v["threads"].as_u64().unwrap_or_default() as u32 }),
            other => Err(EditionError::Db(format!("unknown execution {other}"))),
        }
    }
}

/// What runs the translation. Compared, field by field, before every session.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineConfig {
    pub model_id: String,
    pub model_sha256: String,
    pub runtime_id: String,
    pub runtime_sha256: String,
    pub execution: Execution,
    /// The engine flags the model is launched with.
    pub launch_flags: Vec<String>,
    pub pipeline_id: String,
    /// The pipeline's per-model constant.
    pub profile_k: f64,
}

/// Everything besides the inputs that decides an edition's output, and how its inputs were taken.
#[derive(Debug, Clone, PartialEq)]
pub struct EditionConfig {
    pub source_lang: String,
    pub target_lang: String,
    /// `rtl` for Arabic: the reader shows the edition with Sard's Arabic reading defaults.
    pub target_dir: String,
    pub engine: EngineConfig,
    /// How paragraphs and sentences were taken from the book.
    pub extraction_id: String,
    /// The WebView2 runtime that took them.
    pub webview_version: String,
}

/// One section of the book, as the extraction saw it, with its paragraphs in order.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionInput {
    pub index: u32,
    pub href: String,
    pub linear: bool,
    pub content_type: String,
    /// Leaf blocks found, before those whose text collapses to nothing were dropped.
    pub leaves: u32,
    pub dropped_empty: u32,
    /// The section had no block container, so its body was the one leaf.
    pub body_fallback: bool,
    pub paragraphs: Vec<ParagraphInput>,
}

/// One paragraph: where it is, what is inside it, and the exact text and sentences the pipeline receives.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphInput {
    /// Child-element indices from `<body>` down to the leaf block (empty for the body itself).
    pub path: Vec<u32>,
    pub tag: String,
    /// Counts of the inline elements inside it (links, note references, images, line breaks…).
    pub atoms: BTreeMap<String, u32>,
    pub text: String,
    pub sentences: Vec<String>,
}

// ---- The input contract (the pipeline's) ----

/// Why a paragraph cannot be given to the pipeline. Positions are code points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractBreach {
    EmptyText,
    /// A whitespace character other than U+0020.
    Whitespace { at: usize },
    DoubleSpace { at: usize },
    OuterSpace,
    NoSentence,
    EmptySentence { index: usize },
    SentenceWhitespace { index: usize },
    /// The sentence is not where the previous one ended (after at most one space).
    NotInPlace { index: usize, at: usize },
    /// The sentences end before the text does.
    Uncovered { at: usize },
}

impl ContractBreach {
    fn describe(&self) -> String {
        match self {
            ContractBreach::EmptyText => "empty text".into(),
            ContractBreach::Whitespace { at } => format!("whitespace other than U+0020 at code point {at}"),
            ContractBreach::DoubleSpace { at } => format!("two spaces at code point {at}"),
            ContractBreach::OuterSpace => "a space at either end".into(),
            ContractBreach::NoSentence => "no sentence".into(),
            ContractBreach::EmptySentence { index } => format!("sentence {index} is empty"),
            ContractBreach::SentenceWhitespace { index } => format!("sentence {index} has whitespace at an end"),
            ContractBreach::NotInPlace { index, at } => format!("sentence {index} is not at code point {at}"),
            ContractBreach::Uncovered { at } => format!("the text continues after the last sentence, at code point {at}"),
        }
    }
}

/// The pipeline's input contract: single U+0020 spaces only, nothing at either end; at least one sentence;
/// each sentence non-empty and trimmed; the sentences, in order, cover the text with one space at most
/// between them. Every paragraph of the pipeline's evaluation satisfies it.
pub fn check_contract(text: &str, sentences: &[String]) -> Result<(), ContractBreach> {
    if text.is_empty() {
        return Err(ContractBreach::EmptyText);
    }
    let t: Vec<char> = text.chars().collect();
    if let Some(at) = t.iter().position(|&c| c != ' ' && is_python_whitespace(c)) {
        return Err(ContractBreach::Whitespace { at });
    }
    if t[0] == ' ' || t[t.len() - 1] == ' ' {
        return Err(ContractBreach::OuterSpace);
    }
    if let Some(at) = t.windows(2).position(|w| w == [' ', ' ']) {
        return Err(ContractBreach::DoubleSpace { at });
    }
    if sentences.is_empty() {
        return Err(ContractBreach::NoSentence);
    }
    let mut pos = 0;
    for (index, s) in sentences.iter().enumerate() {
        if s.is_empty() {
            return Err(ContractBreach::EmptySentence { index });
        }
        if s.starts_with(is_python_whitespace) || s.ends_with(is_python_whitespace) {
            return Err(ContractBreach::SentenceWhitespace { index });
        }
        if index > 0 && t.get(pos) == Some(&' ') {
            pos += 1;
        }
        let sc: Vec<char> = s.chars().collect();
        if !t[pos..].starts_with(&sc) {
            return Err(ContractBreach::NotInPlace { index, at: pos });
        }
        pos += sc.len();
    }
    if pos != t.len() {
        return Err(ContractBreach::Uncovered { at: pos });
    }
    Ok(())
}

// ---- Errors and read-back types ----

#[derive(Debug, Clone, PartialEq)]
pub enum EditionError {
    NoSuchBook,
    NoSuchEdition,
    NoSuchSession,
    /// The configuration is incomplete or malformed.
    Config(String),
    /// The extraction's output is malformed (not a contract breach: those are stored, and never sent).
    Manifest(String),
    /// A session is already open on this edition.
    AlreadyRunning,
    /// Every paragraph that can be translated has its result.
    NothingPending,
    /// The edition was made with something else (`field`); resuming would mix configurations.
    ConfigurationChanged { field: &'static str },
    SessionNotOpen,
    UnknownParagraph,
    /// The paragraph broke the input contract when the edition was made; it is never sent.
    NotTranslatable,
    AlreadyRecorded,
    /// The pipeline result breaks a reader-safety rule.
    InvalidOutcome(&'static str),
    /// `Complete` was asked while paragraphs are still pending.
    StillPending,
    /// What is stored no longer matches the edition's own hashes: an input, a setting or a hash changed after
    /// the edition was made. Nothing is translated from it.
    Integrity(String),
    /// The edition has an open session.
    Running,
    Db(String),
    Io(String),
}

impl From<rusqlite::Error> for EditionError {
    fn from(e: rusqlite::Error) -> Self {
        EditionError::Db(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditionState {
    Ready,
    Running,
    Stopped,
    Complete,
}

impl EditionState {
    fn name(self) -> &'static str {
        match self {
            EditionState::Ready => "ready",
            EditionState::Running => "running",
            EditionState::Stopped => "stopped",
            EditionState::Complete => "complete",
        }
    }

    fn parse(s: &str) -> Result<EditionState, EditionError> {
        match s {
            "ready" => Ok(EditionState::Ready),
            "running" => Ok(EditionState::Running),
            "stopped" => Ok(EditionState::Stopped),
            "complete" => Ok(EditionState::Complete),
            other => Err(EditionError::Db(format!("unknown edition state {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub paragraphs: u64,
    /// Never sent: they broke the input contract.
    pub rejected: u64,
    pub done: u64,
    pub pending: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edition {
    pub id: String,
    pub book_id: String,
    pub config: EditionConfig,
    /// The translation implementation it was made with (`implementation`).
    pub implementation_sha256: String,
    pub app_build: String,
    pub manifest_sha256: String,
    pub identity_sha256: String,
    pub mixing_approved: bool,
    pub state: EditionState,
    pub counts: Counts,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A paragraph still to translate, with its frozen input.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub section_index: u32,
    pub ordinal: u32,
    pub text: String,
    pub sentences: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredResult {
    pub session_id: String,
    pub status: String,
    pub text: Option<String>,
    pub final_kind: Option<String>,
    pub why_review: Option<String>,
    pub outcome_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Input,
    Engine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// Every pending paragraph has its result.
    Complete,
    Cancelled,
    /// The engine failed, and the run stopped.
    Engine,
}

// ---- Identity ----

fn validate_config(c: &EditionConfig) -> Result<(), EditionError> {
    let e = &c.engine;
    for (name, v) in [
        ("source_lang", &c.source_lang),
        ("target_lang", &c.target_lang),
        ("model_id", &e.model_id),
        ("runtime_id", &e.runtime_id),
        ("pipeline_id", &e.pipeline_id),
        ("extraction_id", &c.extraction_id),
        ("webview_version", &c.webview_version),
    ] {
        if v.trim().is_empty() {
            return Err(EditionError::Config(format!("{name} is empty")));
        }
    }
    if c.target_dir != "rtl" && c.target_dir != "ltr" {
        return Err(EditionError::Config(format!("target_dir {} is neither rtl nor ltr", c.target_dir)));
    }
    for (name, v) in [("model_sha256", &e.model_sha256), ("runtime_sha256", &e.runtime_sha256)] {
        if v.len() != 64 || !v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(EditionError::Config(format!("{name} is not a lowercase SHA-256")));
        }
    }
    validate_engine(e)
}

fn validate_engine(e: &EngineConfig) -> Result<(), EditionError> {
    if !(e.profile_k.is_finite() && e.profile_k > 0.0) {
        return Err(EditionError::Config("profile_k is not a positive number".into()));
    }
    match &e.execution {
        Execution::Gpu { device } if device.trim().is_empty() => Err(EditionError::Config("the GPU device is empty".into())),
        Execution::Cpu { threads: 0 } => Err(EditionError::Config("zero CPU threads".into())),
        _ => Ok(()),
    }
}

/// Every section and paragraph input, in order, as one canonical JSON value (keys sorted, arrays in order).
fn manifest_value(sections: &[(SectionInput, Vec<Checked>)]) -> Value {
    Value::Array(
        sections
            .iter()
            .map(|(s, ps)| {
                json!({
                    "index": s.index, "href": s.href, "linear": s.linear, "content_type": s.content_type,
                    "leaves": s.leaves, "dropped_empty": s.dropped_empty, "body_fallback": s.body_fallback,
                    "paragraphs": ps.iter().map(|p| json!({
                        "path": p.input.path, "tag": p.input.tag, "atoms": p.input.atoms,
                        "source_sha256": p.source_sha256, "sentences_sha256": p.sentences_sha256,
                        "input_state": p.state, "input_detail": p.detail,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// The edition's identity: every translation-affecting input and setting, as one canonical JSON value.
pub fn identity(book_id: &str, c: &EditionConfig, manifest_sha256: &str, implementation_sha256: &str) -> Value {
    let e = &c.engine;
    json!({
        "schema": IDENTITY_SCHEMA,
        "book_id": book_id,
        "implementation_sha256": implementation_sha256,
        "source_lang": c.source_lang, "target_lang": c.target_lang, "target_dir": c.target_dir,
        "model_id": e.model_id, "model_sha256": e.model_sha256,
        "runtime_id": e.runtime_id, "runtime_sha256": e.runtime_sha256,
        "execution": e.execution.kind(), "execution_detail": e.execution.detail(),
        "launch_flags": e.launch_flags,
        "pipeline_id": e.pipeline_id, "profile_k_bits": format!("{:016x}", e.profile_k.to_bits()),
        "extraction_id": c.extraction_id, "webview_version": c.webview_version,
        "manifest_sha256": manifest_sha256,
    })
}

struct Checked {
    input: ParagraphInput,
    source_sha256: String,
    sentences_json: String,
    sentences_sha256: String,
    state: &'static str,
    detail: Option<String>,
}

fn validate_manifest(sections: &[SectionInput]) -> Result<Vec<(SectionInput, Vec<Checked>)>, EditionError> {
    if sections.is_empty() {
        return Err(EditionError::Manifest("no section".into()));
    }
    let mut out = Vec::with_capacity(sections.len());
    let mut last: Option<u32> = None;
    for s in sections {
        if last.is_some_and(|l| s.index <= l) {
            return Err(EditionError::Manifest(format!("section {} is not after section {}", s.index, last.unwrap_or_default())));
        }
        last = Some(s.index);
        if s.href.is_empty() || s.content_type.is_empty() {
            return Err(EditionError::Manifest(format!("section {} has no href or content type", s.index)));
        }
        if s.dropped_empty > s.leaves || s.paragraphs.len() as u64 != u64::from(s.leaves - s.dropped_empty) {
            return Err(EditionError::Manifest(format!("section {}: {} paragraphs from {} leaves less {} dropped", s.index, s.paragraphs.len(), s.leaves, s.dropped_empty)));
        }
        if s.body_fallback && s.leaves > 1 {
            return Err(EditionError::Manifest(format!("section {}: the body fallback is one leaf", s.index)));
        }
        let mut ps = Vec::with_capacity(s.paragraphs.len());
        for (i, p) in s.paragraphs.iter().enumerate() {
            if p.text.is_empty() || p.tag.is_empty() || p.path.is_empty() != s.body_fallback {
                return Err(EditionError::Manifest(format!("section {} paragraph {i}: empty text, no tag, or a path that does not match the body fallback", s.index)));
            }
            let sentences_json = serde_json::to_string(&p.sentences).map_err(|e| EditionError::Manifest(e.to_string()))?;
            let (state, detail) = match check_contract(&p.text, &p.sentences) {
                Ok(()) => ("ok", None),
                Err(b) => ("contract", Some(b.describe())),
            };
            ps.push(Checked {
                input: p.clone(),
                source_sha256: sha256_hex(p.text.as_bytes()),
                sentences_sha256: sha256_hex(sentences_json.as_bytes()),
                sentences_json,
                state,
                detail,
            });
        }
        out.push((s.clone(), ps));
    }
    Ok(out)
}

fn immediate(conn: &Connection) -> Result<Transaction<'_>, EditionError> {
    Ok(Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?)
}

// ---- The store ----

/// Make an edition of `book_id` with this build's translation implementation: validate the configuration and
/// the extraction's output, check every paragraph against the input contract, and store everything in one
/// transaction. Returns the new id.
pub fn create(conn: &Connection, book_id: &str, config: &EditionConfig, app_build: &str, sections: &[SectionInput], now: i64) -> Result<String, EditionError> {
    create_as(conn, book_id, config, app_build, sections, now, implementation())
}

/// `create`, as a build with another translation implementation would have made it.
#[cfg(test)]
pub(crate) fn create_with_implementation(conn: &Connection, book_id: &str, config: &EditionConfig, app_build: &str, sections: &[SectionInput], now: i64, implementation: &str) -> Result<String, EditionError> {
    create_as(conn, book_id, config, app_build, sections, now, implementation)
}

fn is_sha256(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn create_as(conn: &Connection, book_id: &str, config: &EditionConfig, app_build: &str, sections: &[SectionInput], now: i64, implementation: &str) -> Result<String, EditionError> {
    validate_config(config)?;
    if app_build.trim().is_empty() {
        return Err(EditionError::Config("app_build is empty".into()));
    }
    if !is_sha256(implementation) {
        return Err(EditionError::Config("the implementation fingerprint is not a lowercase SHA-256".into()));
    }
    let checked = validate_manifest(sections)?;
    let manifest_sha256 = sha256_hex(canonical(&manifest_value(&checked)).as_bytes());
    let identity_sha256 = sha256_hex(canonical(&identity(book_id, config, &manifest_sha256, implementation)).as_bytes());
    let id = random_hex(16).map_err(|e| EditionError::Io(e.to_string()))?;
    let e = &config.engine;

    let tx = immediate(conn)?;
    let known: bool = tx.query_row("SELECT 1 FROM books WHERE id = ?1", [book_id], |_| Ok(true)).optional()?.unwrap_or(false);
    if !known {
        return Err(EditionError::NoSuchBook);
    }
    tx.execute(
        "INSERT INTO translation_editions(id, book_id, source_lang, target_lang, target_dir, model_id, model_sha256, \
         runtime_id, runtime_sha256, execution, execution_detail, launch_flags, pipeline_id, implementation_sha256, profile_k, \
         extraction_id, webview_version, app_build, manifest_sha256, identity_sha256, mixing_approved, state, created_at, updated_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,0,'ready',?21,?21)",
        params![
            id, book_id, config.source_lang, config.target_lang, config.target_dir, e.model_id, e.model_sha256,
            e.runtime_id, e.runtime_sha256, e.execution.kind(), e.execution.detail().to_string(),
            serde_json::to_string(&e.launch_flags).map_err(|x| EditionError::Config(x.to_string()))?,
            e.pipeline_id, implementation, e.profile_k, config.extraction_id, config.webview_version, app_build,
            manifest_sha256, identity_sha256, now
        ],
    )?;
    for (s, ps) in &checked {
        tx.execute(
            "INSERT INTO translation_sections(edition_id, section_index, href, linear, content_type, leaves, dropped_empty, body_fallback) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, s.index, s.href, s.linear, s.content_type, s.leaves, s.dropped_empty, s.body_fallback],
        )?;
        for (ordinal, p) in ps.iter().enumerate() {
            tx.execute(
                "INSERT INTO translation_paragraphs(edition_id, section_index, ordinal, path, tag, atoms, source_text, \
                 source_sha256, sentences, sentences_sha256, input_state, input_detail) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    id, s.index, ordinal as i64, serde_json::to_string(&p.input.path).unwrap_or_default(), p.input.tag,
                    serde_json::to_string(&p.input.atoms).unwrap_or_default(), p.input.text, p.source_sha256,
                    p.sentences_json, p.sentences_sha256, p.state, p.detail
                ],
            )?;
        }
    }
    tx.commit()?;
    Ok(id)
}

fn counts(conn: &Connection, edition_id: &str) -> Result<Counts, EditionError> {
    let (paragraphs, rejected, done): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(p.input_state <> 'ok'), 0), COUNT(r.edition_id) FROM translation_paragraphs p \
         LEFT JOIN translation_results r ON r.edition_id = p.edition_id AND r.section_index = p.section_index AND r.ordinal = p.ordinal \
         WHERE p.edition_id = ?1",
        [edition_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (paragraphs, rejected, done) = (paragraphs as u64, rejected as u64, done as u64);
    Ok(Counts { paragraphs, rejected, done, pending: paragraphs.saturating_sub(rejected).saturating_sub(done) })
}

/// The edition, with its configuration, state and counts.
pub fn get(conn: &Connection, edition_id: &str) -> Result<Option<Edition>, EditionError> {
    let row = conn
        .query_row(
            "SELECT id, book_id, source_lang, target_lang, target_dir, model_id, model_sha256, runtime_id, runtime_sha256, \
             execution, execution_detail, launch_flags, pipeline_id, profile_k, extraction_id, webview_version, app_build, \
             manifest_sha256, identity_sha256, mixing_approved, state, created_at, updated_at, implementation_sha256 \
             FROM translation_editions WHERE id = ?1",
            [edition_id],
            |r| {
                Ok((
                    [r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?],
                    r.get::<_, f64>(13)?,
                    [r.get::<_, String>(14)?, r.get(15)?, r.get(16)?, r.get(17)?, r.get(18)?, r.get(23)?],
                    r.get::<_, bool>(19)?,
                    r.get::<_, String>(20)?,
                    r.get::<_, i64>(21)?,
                    r.get::<_, i64>(22)?,
                ))
            },
        )
        .optional()?;
    let Some((a, profile_k, b, mixing_approved, state, created_at, updated_at)) = row else {
        return Ok(None);
    };
    let [id, book_id, source_lang, target_lang, target_dir, model_id, model_sha256, runtime_id, runtime_sha256, execution, execution_detail, launch_flags, pipeline_id] = a;
    let [extraction_id, webview_version, app_build, manifest_sha256, identity_sha256, implementation_sha256] = b;
    let config = EditionConfig {
        source_lang,
        target_lang,
        target_dir,
        engine: EngineConfig {
            model_id,
            model_sha256,
            runtime_id,
            runtime_sha256,
            execution: Execution::from_stored(&execution, &execution_detail)?,
            launch_flags: serde_json::from_str(&launch_flags).map_err(|e| EditionError::Db(format!("launch flags: {e}")))?,
            pipeline_id,
            profile_k,
        },
        extraction_id,
        webview_version,
    };
    let counts = counts(conn, &id)?;
    Ok(Some(Edition { id, book_id, config, implementation_sha256, app_build, manifest_sha256, identity_sha256, mixing_approved, state: EditionState::parse(&state)?, counts, created_at, updated_at }))
}

/// The ids of a book's editions, oldest first.
pub fn list_for_book(conn: &Connection, book_id: &str) -> Result<Vec<String>, EditionError> {
    let mut st = conn.prepare("SELECT id FROM translation_editions WHERE book_id = ?1 ORDER BY created_at, id")?;
    let ids = st.query_map([book_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

/// The paragraphs still to translate, in reading order, with their frozen inputs.
pub fn pending(conn: &Connection, edition_id: &str) -> Result<Vec<Pending>, EditionError> {
    let mut st = conn.prepare(
        "SELECT p.section_index, p.ordinal, p.source_text, p.sentences FROM translation_paragraphs p \
         LEFT JOIN translation_results r ON r.edition_id = p.edition_id AND r.section_index = p.section_index AND r.ordinal = p.ordinal \
         WHERE p.edition_id = ?1 AND p.input_state = 'ok' AND r.edition_id IS NULL ORDER BY p.section_index, p.ordinal",
    )?;
    let rows = st.query_map([edition_id], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (section_index, ordinal, text, sentences) = row?;
        let sentences = serde_json::from_str(&sentences).map_err(|e| EditionError::Db(format!("sentences: {e}")))?;
        out.push(Pending { section_index, ordinal, text, sentences });
    }
    Ok(out)
}

/// Recompute everything the edition's identity covers from what is stored — each paragraph's two hashes and
/// its contract verdict, the manifest hash and the identity hash, by the same code that made them — and
/// compare. Any difference is an `Integrity` error: an input, a setting or a hash changed after the edition
/// was made. Every session runs it before anything is translated.
pub fn verify(conn: &Connection, edition_id: &str) -> Result<(), EditionError> {
    let Some(ed) = get(conn, edition_id)? else {
        return Err(EditionError::NoSuchEdition);
    };
    let mut sections: Vec<SectionInput> = {
        let mut st = conn.prepare(
            "SELECT section_index, href, linear, content_type, leaves, dropped_empty, body_fallback FROM translation_sections \
             WHERE edition_id = ?1 ORDER BY section_index",
        )?;
        let rows = st.query_map([edition_id], |r| {
            Ok(SectionInput { index: r.get(0)?, href: r.get(1)?, linear: r.get(2)?, content_type: r.get(3)?, leaves: r.get(4)?, dropped_empty: r.get(5)?, body_fallback: r.get(6)?, paragraphs: Vec::new() })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    // What is stored for each paragraph, in reading order: its key, two hashes, sentence text and verdict.
    type Stored = (u32, u32, String, String, String, String, Option<String>);
    let mut stored: Vec<Stored> = Vec::new();
    {
        let mut st = conn.prepare(
            "SELECT section_index, ordinal, path, tag, atoms, source_text, source_sha256, sentences, sentences_sha256, input_state, input_detail \
             FROM translation_paragraphs WHERE edition_id = ?1 ORDER BY section_index, ordinal",
        )?;
        let mut rows = st.query([edition_id])?;
        while let Some(r) = rows.next()? {
            let (si, ord): (u32, u32) = (r.get(0)?, r.get(1)?);
            let bad = |what: &str| EditionError::Integrity(format!("paragraph {si}:{ord}: {what}"));
            let sentences_text: String = r.get(7)?;
            let p = ParagraphInput {
                path: serde_json::from_str(&r.get::<_, String>(2)?).map_err(|_| bad("its path cannot be read"))?,
                tag: r.get(3)?,
                atoms: serde_json::from_str(&r.get::<_, String>(4)?).map_err(|_| bad("its atoms cannot be read"))?,
                text: r.get(5)?,
                sentences: serde_json::from_str(&sentences_text).map_err(|_| bad("its sentences cannot be read"))?,
            };
            let Some(section) = sections.iter_mut().find(|s| s.index == si) else {
                return Err(bad("its section is missing"));
            };
            if ord as usize != section.paragraphs.len() {
                return Err(bad("a paragraph before it is missing"));
            }
            section.paragraphs.push(p);
            stored.push((si, ord, r.get(6)?, sentences_text, r.get(8)?, r.get(9)?, r.get(10)?));
        }
    }
    let checked = validate_manifest(&sections).map_err(|e| EditionError::Integrity(format!("the stored inputs: {e:?}")))?;
    for ((si, ord, source_sha256, sentences_text, sentences_sha256, state, detail), c) in stored.iter().zip(checked.iter().flat_map(|(_, ps)| ps.iter())) {
        let bad = |what: &str| EditionError::Integrity(format!("paragraph {si}:{ord}: {what}"));
        if &c.source_sha256 != source_sha256 {
            return Err(bad("its source text does not match its hash"));
        }
        if &c.sentences_json != sentences_text || &c.sentences_sha256 != sentences_sha256 {
            return Err(bad("its sentences do not match their hash"));
        }
        if c.state != state.as_str() || &c.detail != detail {
            return Err(bad("its contract verdict is not the one its input gives"));
        }
    }
    let manifest_sha256 = sha256_hex(canonical(&manifest_value(&checked)).as_bytes());
    if manifest_sha256 != ed.manifest_sha256 {
        return Err(EditionError::Integrity("the inputs do not match the edition's manifest hash".into()));
    }
    if sha256_hex(canonical(&identity(&ed.book_id, &ed.config, &manifest_sha256, &ed.implementation_sha256)).as_bytes()) != ed.identity_sha256 {
        return Err(EditionError::Integrity("the configuration or the inputs do not match the edition's identity hash".into()));
    }
    Ok(())
}

/// Open a session on the edition, if what is stored still matches its hashes (`verify`), this build's
/// translation implementation is the one the edition was made with, and the engine configuration is the
/// edition's in every field.
pub fn begin_session(conn: &Connection, edition_id: &str, engine: &EngineConfig, app_build: &str, engine_info: Option<&str>, now: i64) -> Result<String, EditionError> {
    begin_session_as(conn, edition_id, engine, app_build, engine_info, now, implementation())
}

/// `begin_session`, as a build with another translation implementation would run it.
#[cfg(test)]
pub(crate) fn begin_session_with_implementation(conn: &Connection, edition_id: &str, engine: &EngineConfig, app_build: &str, engine_info: Option<&str>, now: i64, implementation: &str) -> Result<String, EditionError> {
    begin_session_as(conn, edition_id, engine, app_build, engine_info, now, implementation)
}

fn begin_session_as(conn: &Connection, edition_id: &str, engine: &EngineConfig, app_build: &str, engine_info: Option<&str>, now: i64, implementation: &str) -> Result<String, EditionError> {
    validate_engine(engine)?;
    let tx = immediate(conn)?;
    let Some(ed) = get(&tx, edition_id)? else {
        return Err(EditionError::NoSuchEdition);
    };
    verify(&tx, edition_id)?;
    let open: bool = tx
        .query_row("SELECT 1 FROM translation_sessions WHERE edition_id = ?1 AND ended_at IS NULL", [edition_id], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if open || ed.state == EditionState::Running {
        return Err(EditionError::AlreadyRunning);
    }
    if ed.counts.pending == 0 {
        return Err(EditionError::NothingPending);
    }
    let have = &ed.config.engine;
    let field = if ed.implementation_sha256 != implementation {
        Some("implementation")
    } else if have.model_id != engine.model_id {
        Some("model_id")
    } else if have.model_sha256 != engine.model_sha256 {
        Some("model_sha256")
    } else if have.runtime_id != engine.runtime_id {
        Some("runtime_id")
    } else if have.runtime_sha256 != engine.runtime_sha256 {
        Some("runtime_sha256")
    } else if have.launch_flags != engine.launch_flags {
        Some("launch_flags")
    } else if have.pipeline_id != engine.pipeline_id {
        Some("pipeline_id")
    } else if have.profile_k.to_bits() != engine.profile_k.to_bits() {
        Some("profile_k")
    } else if have.execution != engine.execution && !ed.mixing_approved {
        Some("execution")
    } else {
        None
    };
    if let Some(field) = field {
        return Err(EditionError::ConfigurationChanged { field });
    }
    let id = random_hex(16).map_err(|e| EditionError::Io(e.to_string()))?;
    tx.execute(
        "INSERT INTO translation_sessions(id, edition_id, started_at, model_sha256, runtime_sha256, execution, execution_detail, implementation_sha256, app_build, engine_info) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![id, edition_id, now, engine.model_sha256, engine.runtime_sha256, engine.execution.kind(), engine.execution.detail().to_string(), implementation, app_build, engine_info],
    )?;
    tx.execute("UPDATE translation_editions SET state = 'running', updated_at = ?2 WHERE id = ?1", params![edition_id, now])?;
    tx.commit()?;
    Ok(id)
}

/// The edition of an open session.
fn open_session(tx: &Transaction<'_>, session_id: &str) -> Result<String, EditionError> {
    let row: Option<(String, Option<i64>)> = tx
        .query_row("SELECT edition_id, ended_at FROM translation_sessions WHERE id = ?1", [session_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        None => Err(EditionError::NoSuchSession),
        Some((_, Some(_))) => Err(EditionError::SessionNotOpen),
        Some((edition_id, None)) => Ok(edition_id),
    }
}

fn paragraph_state(tx: &Transaction<'_>, edition_id: &str, section_index: u32, ordinal: u32) -> Result<String, EditionError> {
    tx.query_row(
        "SELECT input_state FROM translation_paragraphs WHERE edition_id = ?1 AND section_index = ?2 AND ordinal = ?3",
        params![edition_id, section_index, ordinal],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(EditionError::UnknownParagraph)
}

/// Check a pipeline result against the reader-safety rules before anything is written.
pub fn check_outcome(o: &Outcome) -> Result<(), EditionError> {
    let failed = o.status == Status::Failed;
    if failed != o.text.is_none() {
        return Err(EditionError::InvalidOutcome("a FAILED paragraph has no text, and every other status has one"));
    }
    if failed != o.final_kind.is_none() {
        return Err(EditionError::InvalidOutcome("a FAILED paragraph has no final candidate, and every other status has one"));
    }
    if matches!(o.status, Status::Review | Status::Second) != o.why_review.is_some() {
        return Err(EditionError::InvalidOutcome("REVIEW and SECOND keep their review reason, and no other status has one"));
    }
    Ok(())
}

fn outcome_value(o: &Outcome, raw: bool) -> Value {
    // `raw` false is level 2: no candidate output and no chunk text at all.
    let mut candidates = Map::new();
    for (kind, c) in &o.candidates {
        let v = match c {
            Candidate::Skipped(s) => json!({ "skipped": s.reason() }),
            Candidate::Produced(p) => {
                let mut m = Map::new();
                if o.final_kind == Some(*kind) && o.text.as_deref() == Some(p.out.as_str()) {
                    m.insert("out_is_final_text".into(), json!(true)); // stored once, in the result's text
                } else if raw {
                    m.insert("out".into(), json!(p.out));
                }
                m.insert("tokens".into(), json!(p.tokens));
                m.insert("stop".into(), json!(p.stop));
                m.insert("spans".into(), json!(p.spans));
                m.insert(
                    "chunks".into(),
                    Value::Array(
                        p.chunks
                            .iter()
                            .map(|ch| {
                                let mut cm = Map::new();
                                cm.insert("index".into(), json!(ch.index));
                                if raw {
                                    cm.insert("src".into(), json!(ch.src));
                                    cm.insert("out".into(), json!(ch.raw.out));
                                }
                                cm.insert("tokens".into(), json!(ch.raw.tokens));
                                cm.insert("stop".into(), json!(ch.raw.stop));
                                Value::Object(cm)
                            })
                            .collect(),
                    ),
                );
                m.insert("units".into(), json!(p.units));
                m.insert("flags".into(), json!(p.flags));
                m.insert("script".into(), json!(p.script));
                json!({ "produced": Value::Object(m) })
            }
        };
        candidates.insert(kind.name().to_string(), v);
    }
    json!({
        "schema": OUTCOME_SCHEMA,
        "status": o.status.name(),
        "final_kind": o.final_kind.map(|k| k.name()),
        "steps": o.steps.iter().map(|s| s.name()).collect::<Vec<_>>(),
        "d1": o.d1,
        "why_review": o.why_review.map(|r| r.text()),
        "requests": o.requests.iter().map(|(k, i)| json!([k.name(), i])).collect::<Vec<_>>(),
        "raw_omitted": !raw,
        "candidates": Value::Object(candidates),
    })
}

/// Level 3: what stays when even the judgements do not fit — a fixed, small shape.
fn summary_value(o: &Outcome) -> Value {
    let candidates: Map<String, Value> = o
        .candidates
        .iter()
        .map(|(k, c)| {
            let v = match c {
                Candidate::Skipped(s) => format!("skipped: {}", s.reason()),
                Candidate::Produced(_) => "produced".to_string(),
            };
            (k.name().to_string(), Value::String(v))
        })
        .collect();
    json!({
        "schema": OUTCOME_SCHEMA,
        "status": o.status.name(),
        "final_kind": o.final_kind.map(|k| k.name()),
        "steps": o.steps.iter().map(|s| s.name()).collect::<Vec<_>>(),
        "d1": o.d1,
        "why_review": o.why_review.map(|r| r.text()),
        "raw_omitted": true,
        "detail_omitted": true,
        "candidates": Value::Object(candidates),
    })
}

/// The pipeline result as stored: canonical (keys sorted), the final candidate's output not repeated, at the
/// first level of `MAX_OUTCOME_JSON_BYTES` that fits.
pub fn outcome_json(o: &Outcome) -> String {
    for raw in [true, false] {
        let s = canonical(&outcome_value(o, raw));
        if s.len() <= MAX_OUTCOME_JSON_BYTES {
            return s;
        }
    }
    canonical(&summary_value(o))
}

/// Store one paragraph's result, whole, in one transaction — or nothing.
pub fn record_result(conn: &Connection, session_id: &str, section_index: u32, ordinal: u32, outcome: &Outcome, took_ms: u64, now: i64) -> Result<(), EditionError> {
    check_outcome(outcome)?;
    let tx = immediate(conn)?;
    let edition_id = open_session(&tx, session_id)?;
    if paragraph_state(&tx, &edition_id, section_index, ordinal)? != "ok" {
        return Err(EditionError::NotTranslatable);
    }
    let recorded: bool = tx
        .query_row(
            "SELECT 1 FROM translation_results WHERE edition_id = ?1 AND section_index = ?2 AND ordinal = ?3",
            params![edition_id, section_index, ordinal],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if recorded {
        return Err(EditionError::AlreadyRecorded);
    }
    tx.execute(
        "INSERT INTO translation_results(edition_id, section_index, ordinal, session_id, status, text, final_kind, why_review, \
         outcome_json, outcome_schema, took_ms, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            edition_id, section_index, ordinal, session_id, outcome.status.name(), outcome.text,
            outcome.final_kind.map(|k| k.name()), outcome.why_review.map(|r| r.text()), outcome_json(outcome),
            OUTCOME_SCHEMA, took_ms as i64, now
        ],
    )?;
    tx.execute("UPDATE translation_editions SET updated_at = ?2 WHERE id = ?1", params![edition_id, now])?;
    tx.commit()?;
    Ok(())
}

/// Log an attempt that produced no result. The paragraph stays pending.
pub fn record_failure(conn: &Connection, session_id: &str, section_index: u32, ordinal: u32, kind: FailureKind, detail: &str, now: i64) -> Result<(), EditionError> {
    let tx = immediate(conn)?;
    let edition_id = open_session(&tx, session_id)?;
    paragraph_state(&tx, &edition_id, section_index, ordinal)?;
    let kind = match kind {
        FailureKind::Input => "input",
        FailureKind::Engine => "engine",
    };
    tx.execute(
        "INSERT INTO translation_failures(edition_id, section_index, ordinal, session_id, kind, detail, at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![edition_id, section_index, ordinal, session_id, kind, detail, now],
    )?;
    tx.commit()?;
    Ok(())
}

/// The state an edition is in once no session is open: complete only when nothing is pending.
fn settle(tx: &Transaction<'_>, edition_id: &str, now: i64) -> Result<EditionState, EditionError> {
    let state = if counts(tx, edition_id)?.pending == 0 { EditionState::Complete } else { EditionState::Stopped };
    tx.execute("UPDATE translation_editions SET state = ?2, updated_at = ?3 WHERE id = ?1", params![edition_id, state.name(), now])?;
    Ok(state)
}

/// Close a session. The edition becomes `complete` in the same transaction only if no paragraph is pending.
pub fn end_session(conn: &Connection, session_id: &str, reason: EndReason, now: i64) -> Result<EditionState, EditionError> {
    let tx = immediate(conn)?;
    let edition_id = open_session(&tx, session_id)?;
    let pending = counts(&tx, &edition_id)?.pending;
    if reason == EndReason::Complete && pending > 0 {
        return Err(EditionError::StillPending);
    }
    let reason = match reason {
        EndReason::Complete => "complete",
        EndReason::Cancelled => "cancelled",
        EndReason::Engine => "engine",
    };
    tx.execute("UPDATE translation_sessions SET ended_at = ?2, end_reason = ?3 WHERE id = ?1", params![session_id, now, reason])?;
    let state = settle(&tx, &edition_id, now)?;
    tx.commit()?;
    Ok(state)
}

/// After a crash or a kill: close every session still open as `interrupted`, and settle its edition.
/// Returns how many sessions were closed.
pub fn recover_interrupted(conn: &Connection, now: i64) -> Result<usize, EditionError> {
    let tx = immediate(conn)?;
    let editions: Vec<String> = {
        let mut st = tx.prepare("SELECT DISTINCT edition_id FROM translation_sessions WHERE ended_at IS NULL UNION SELECT id FROM translation_editions WHERE state = 'running'")?;
        let ids = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        ids
    };
    let closed = tx.execute("UPDATE translation_sessions SET ended_at = ?1, end_reason = 'interrupted' WHERE ended_at IS NULL", [now])?;
    for e in &editions {
        settle(&tx, e, now)?;
    }
    tx.commit()?;
    Ok(closed)
}

/// Remove one edition and only its rows. Refused while it has an open session. `false`: no such edition.
pub fn delete_edition(conn: &Connection, edition_id: &str) -> Result<bool, EditionError> {
    let tx = immediate(conn)?;
    let state: Option<String> = tx.query_row("SELECT state FROM translation_editions WHERE id = ?1", [edition_id], |r| r.get(0)).optional()?;
    let Some(state) = state else {
        return Ok(false);
    };
    let open: bool = tx
        .query_row("SELECT 1 FROM translation_sessions WHERE edition_id = ?1 AND ended_at IS NULL", [edition_id], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if open || state == "running" {
        return Err(EditionError::Running);
    }
    let removed = tx.execute("DELETE FROM translation_editions WHERE id = ?1", [edition_id])?;
    tx.commit()?;
    Ok(removed > 0)
}

/// One paragraph's stored result.
pub fn result(conn: &Connection, edition_id: &str, section_index: u32, ordinal: u32) -> Result<Option<StoredResult>, EditionError> {
    Ok(conn
        .query_row(
            "SELECT session_id, status, text, final_kind, why_review, outcome_json FROM translation_results \
             WHERE edition_id = ?1 AND section_index = ?2 AND ordinal = ?3",
            params![edition_id, section_index, ordinal],
            |r| Ok(StoredResult { session_id: r.get(0)?, status: r.get(1)?, text: r.get(2)?, final_kind: r.get(3)?, why_review: r.get(4)?, outcome_json: r.get(5)? }),
        )
        .optional()?)
}
