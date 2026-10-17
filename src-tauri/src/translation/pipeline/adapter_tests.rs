//! The adapters against a fake engine: a minimal HTTP server on 127.0.0.1 that records every request and answers from
//! a script. No model and no engine are involved, so these tests show the exchange is the evaluated one — not that a
//! real engine answers as it did.
//!
//! The expected request bodies and answer readings in `tests/fixtures/translation-pipeline/adapter-*.jsonl` were
//! produced by the evaluated client code on synthetic paragraphs, against the same scripted engine.

use super::adapter::{AdapterError, EngineSource, Model, PROVISIONAL_GPU_EXCHANGE_TIMEOUT};
use super::decide::produce;
use super::pipeline_tests::{decision_json, fixture_dir, lines, strs};
use super::{translate, Candidate, Kind, Paragraph, PipelineError, Raw, Request, Sampling, Source, Status};
use crate::translation::engine::{Endpoint, SessionKey};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// One request the fake engine received.
#[derive(Debug, Clone)]
pub(super) struct Seen {
    pub path: String,
    pub host: Option<String>,
    pub auth: Option<String>,
    pub body: Value,
}

/// How the fake engine answers one request.
pub(super) enum Reply {
    Json(Value),
    Raw { status: u16, body: String },
    /// A body that need not be valid UTF-8.
    Bytes { status: u16, body: Vec<u8> },
    Slow(Duration, Value),
    /// The headers and the first `sent` bytes of the body, then nothing for `stall`, then the connection closes.
    StallBody { sent: usize, stall: Duration, body: String },
    Hangup,
}

type Handler = dyn Fn(&str, &Value) -> Reply + Send + Sync;

pub(super) struct FakeEngine {
    pub port: u16,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeEngine {
    pub fn start(handler: impl Fn(&str, &Value) -> Reply + Send + Sync + 'static) -> FakeEngine {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let s = seen.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let (s, h) = (s.clone(), handler.clone());
                std::thread::spawn(move || {
                    let _ = serve(conn, &s, &*h);
                });
            }
        });
        FakeEngine { port, seen }
    }

    pub fn endpoint(&self) -> Endpoint {
        Endpoint { port: self.port, key: SessionKey::for_tests("test-key") }
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn serve(mut conn: TcpStream, seen: &Mutex<Vec<Seen>>, handler: &Handler) -> std::io::Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = conn.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
    let header = |name: &str| {
        head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    };
    let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + len {
        let n = conn.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
    seen.lock().unwrap().push(Seen { path: path.clone(), host: header("host"), auth: header("authorization"), body: body.clone() });
    let head = |status: u16, len: usize| {
        let reason = if status == 200 { "OK" } else { "Error" };
        format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")
    };
    let (status, bytes) = match handler(&path, &body) {
        Reply::Json(v) => (200, v.to_string().into_bytes()),
        Reply::Raw { status, body } => (status, body.into_bytes()),
        Reply::Bytes { status, body } => (status, body),
        Reply::Slow(d, v) => {
            std::thread::sleep(d);
            (200, v.to_string().into_bytes())
        }
        Reply::StallBody { sent, stall, body } => {
            conn.write_all(head(200, body.len()).as_bytes())?;
            conn.write_all(&body.as_bytes()[..sent])?;
            conn.flush()?;
            std::thread::sleep(stall);
            return Ok(());
        }
        Reply::Hangup => return Ok(()),
    };
    conn.write_all(head(status, bytes.len()).as_bytes())?;
    conn.write_all(&bytes)?;
    conn.flush()
}

/// `json.dumps(messages, ensure_ascii=False, sort_keys=True)` for the one message the template request carries.
pub(super) fn py_dumps_messages(messages: &Value) -> String {
    let m = &messages[0];
    let s = |k: &str| serde_json::to_string(m[k].as_str().unwrap()).unwrap();
    format!("[{{\"content\": {}, \"role\": {}}}]", s("content"), s("role"))
}

/// The scripted engine of the evaluated client's recordings: the template stub, and completion texts from a queue.
pub(super) fn scripted(queue: Vec<String>, tokens: u64, prompt_tokens: u64) -> FakeEngine {
    scripted_with(Arc::new(Mutex::new(VecDeque::from(queue))), tokens, prompt_tokens)
}

/// The same, with a queue the caller refills between cases (one engine for many cases).
pub(super) fn scripted_with(q: Arc<Mutex<VecDeque<String>>>, tokens: u64, prompt_tokens: u64) -> FakeEngine {
    FakeEngine::start(move |path, body| {
        if path == "/apply-template" {
            return Reply::Json(json!({ "prompt": format!("<<APPLY-TEMPLATE {}>>", py_dumps_messages(&body["messages"])) }));
        }
        let content = q.lock().unwrap().pop_front().unwrap_or_else(|| "<<STUB>>".to_string());
        if path == "/v1/chat/completions" {
            Reply::Json(json!({ "choices": [{ "message": { "content": content }, "finish_reason": "stop" }],
                               "usage": { "completion_tokens": tokens, "prompt_tokens": prompt_tokens } }))
        } else {
            Reply::Json(json!({ "content": content, "tokens_predicted": tokens, "tokens_evaluated": prompt_tokens, "stopped_eos": true }))
        }
    })
}

pub(super) fn kind_of(name: &str) -> Kind {
    match name {
        "fast" => Kind::Fast,
        "A1" => Kind::Damped,
        "B" => Kind::Chunked,
        "S" => Kind::Sentences,
        other => panic!("{other}"),
    }
}

pub(super) fn model_of(name: &str) -> Model {
    if name == "A" {
        Model::A
    } else {
        Model::B
    }
}

pub(super) fn source(engine: &FakeEngine, model: Model) -> EngineSource {
    EngineSource::new(engine.endpoint(), model, Duration::from_secs(20), Arc::new(AtomicBool::new(false)))
}

pub(super) fn seen_json(seen: &[Seen]) -> Value {
    json!(seen.iter().map(|s| json!({ "path": s.path, "body": s.body })).collect::<Vec<_>>())
}

#[test]
fn every_request_body_is_the_one_the_evaluated_client_sends() {
    let cases = lines(&fixture_dir().join("adapter-requests.jsonl"));
    assert_eq!(cases.len(), 42);
    for c in &cases {
        let id = c["id"].as_str().unwrap();
        let model = model_of(c["model"].as_str().unwrap());
        let engine = scripted(strs(&c["queue"]), 3, 9);
        let p = Paragraph { text: c["src"].as_str().unwrap().to_string(), sentences: strs(&c["sents"]) };
        let got = produce(&mut source(&engine, model), &model.profile(), &p, kind_of(c["kind"].as_str().unwrap()))
            .unwrap_or_else(|e| panic!("{id}: {e:?}"));
        let seen = engine.seen();
        assert_eq!(seen_json(&seen), c["requests"], "{id}: request bodies differ");
        assert!(seen.iter().all(|s| s.auth.as_deref() == Some("Bearer test-key")), "{id}: the session key is missing");
        let want = &c["result"];
        match got {
            Candidate::Skipped(s) => assert_eq!(json!({ "skipped": s.reason() }), *want, "{id}"),
            Candidate::Produced(p) => assert_eq!(json!({ "out": p.out, "tokens": p.tokens, "stop": p.stop }), *want, "{id}"),
        }
    }
}

#[test]
fn model_b_applies_its_template_before_every_chunk() {
    let cases = lines(&fixture_dir().join("adapter-requests.jsonl"));
    let c = cases.iter().find(|c| c["id"] == "p1-B-B-plain").expect("the case");
    let engine = scripted(strs(&c["queue"]), 3, 9);
    let p = Paragraph { text: c["src"].as_str().unwrap().to_string(), sentences: strs(&c["sents"]) };
    produce(&mut source(&engine, Model::B), &Model::B.profile(), &p, Kind::Chunked).unwrap();
    let paths: Vec<String> = engine.seen().iter().map(|s| s.path.clone()).collect();
    assert_eq!(paths, ["/apply-template", "/completion", "/apply-template", "/completion", "/apply-template", "/completion"]);
}

#[test]
fn every_answer_is_read_as_the_evaluated_client_reads_it() {
    let cases = lines(&fixture_dir().join("adapter-replies.jsonl"));
    assert_eq!(cases.len(), 30);
    for c in &cases {
        let id = c["id"].to_string();
        let route = c["route"].as_str().unwrap();
        let (template, reply) = (c["template"].clone(), c["reply"].clone());
        let engine = FakeEngine::start(move |path, _| {
            if path == "/apply-template" {
                Reply::Json(template.clone())
            } else {
                Reply::Json(reply.clone())
            }
        });
        let model = if route == "completion" { Model::A } else { Model::B };
        let kind = if route == "raw" { Kind::Chunked } else { Kind::Fast };
        let r = Request { kind, index: 0, text: "Hello there.".into(), prefill: None, sampling: Sampling::Greedy, limit: 99 };
        let got = source(&engine, model).answer(&r);
        let want = &c["frozen"];
        match (got, want.get("raises")) {
            (Err(AdapterError::Malformed { .. }), Some(_)) => {}
            (Ok(raw), None) => assert_eq!(json!({ "out": raw.out, "tokens": raw.tokens, "stop": raw.stop }), *want, "case {id}"),
            (other, _) => panic!("case {id}: got {other:?}, the evaluated client gives {want}"),
        }
    }
}

fn paragraph() -> Paragraph {
    Paragraph { text: "One two three four.".into(), sentences: vec!["One two three four.".into()] }
}

#[test]
fn an_error_status_is_returned_with_its_request_and_never_retried() {
    let engine = FakeEngine::start(|_, _| Reply::Raw { status: 500, body: "{}".into() });
    match translate(&mut source(&engine, Model::A), &Model::A.profile(), &paragraph()) {
        Err(PipelineError::Source { kind: Kind::Fast, index: 0, error: AdapterError::Status { path: "/completion", status: 500 } }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(engine.seen().len(), 1, "a failed request is never sent again");
}

#[test]
fn an_answer_that_is_not_json_or_is_empty_is_malformed() {
    for body in ["not json", "", "[1, 2]"] {
        let b = body.to_string();
        let engine = FakeEngine::start(move |_, _| Reply::Raw { status: 200, body: b.clone() });
        match translate(&mut source(&engine, Model::B), &Model::B.profile(), &paragraph()) {
            Err(PipelineError::Source { kind: Kind::Fast, error: AdapterError::Malformed { .. }, .. }) => {}
            other => panic!("{body:?}: {other:?}"),
        }
    }
}

#[test]
fn a_slow_engine_ends_the_request_at_the_given_timeout() {
    let engine = FakeEngine::start(|_, _| Reply::Slow(Duration::from_secs(5), json!({ "content": "x" })));
    let mut s = EngineSource::new(engine.endpoint(), Model::A, Duration::from_millis(400), Arc::new(AtomicBool::new(false)));
    let t = Instant::now();
    match translate(&mut s, &Model::A.profile(), &paragraph()) {
        Err(PipelineError::Source { kind: Kind::Fast, error: AdapterError::Timeout { path: "/completion" }, .. }) => {}
        other => panic!("{other:?}"),
    }
    assert!(t.elapsed() < Duration::from_secs(4), "the timeout did not bound the request ({:?})", t.elapsed());
}

#[test]
fn a_dropped_connection_is_a_transport_error() {
    let engine = FakeEngine::start(|_, _| Reply::Hangup);
    match translate(&mut source(&engine, Model::A), &Model::A.profile(), &paragraph()) {
        Err(PipelineError::Source { kind: Kind::Fast, error: AdapterError::Transport { .. }, .. }) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_cancelled_source_sends_nothing_more() {
    let engine = FakeEngine::start(|_, _| Reply::Json(json!({ "content": "x" })));
    let cancel = Arc::new(AtomicBool::new(true));
    let mut s = EngineSource::new(engine.endpoint(), Model::A, Duration::from_secs(5), cancel);
    match translate(&mut s, &Model::A.profile(), &paragraph()) {
        Err(PipelineError::Source { kind: Kind::Fast, index: 0, error: AdapterError::Cancelled }) => {}
        other => panic!("{other:?}"),
    }
    assert!(engine.seen().is_empty(), "a request was sent after cancellation");

    // Cancelled while the first answer is being produced: the paragraph stops at its next request, named.
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let engine = FakeEngine::start(move |_, _| {
        c.store(true, Ordering::SeqCst);
        Reply::Json(json!({ "content": "", "tokens_predicted": 0, "stopped_eos": true }))
    });
    let mut s = EngineSource::new(engine.endpoint(), Model::A, Duration::from_secs(5), cancel);
    match translate(&mut s, &Model::A.profile(), &paragraph()) {
        Err(PipelineError::Source { kind: Kind::Damped, index: 0, error: AdapterError::Cancelled }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(engine.seen().len(), 1);
}

/// The case a routed engine answers for.
#[derive(Default)]
pub(super) struct Case {
    pub src: String,
    pub candidates: Value,
    pub fast_answered: bool,
    /// Chunks are requested in order; the next one expected.
    pub next_chunk: usize,
    /// Requests that did not match what the case expects.
    pub problems: Vec<String>,
}

impl Case {
    pub fn new(src: String, candidates: Value) -> Case {
        Case { src, candidates, ..Case::default() }
    }
}

/// Answers each request from a case's candidates, by recognising which candidate the request is for — the damped
/// sampler, the first request for the whole paragraph, or a chunk's text. The per-sentence retry cannot be answered
/// (its candidates are recorded joined), so a unit gets an empty answer and the caller skips such cases.
pub(super) fn routed(state: Arc<Mutex<Case>>) -> FakeEngine {
    const A_HEAD: &str = "Translate this from English to Arabic:\nEnglish: ";
    const INSTR: &str = "Translate the following English text into Modern Standard Arabic. Output only the translation, nothing else.\n\n";
    FakeEngine::start(move |path, body| {
        let mut st = state.lock().unwrap();
        let src = st.src.clone();
        let candidates = st.candidates.clone();
        let para: Vec<char> = src.chars().collect();
        let damped = body.get("dry_multiplier").is_some();
        let (text, route) = match path {
            "/apply-template" => {
                let t = body["messages"][0]["content"].as_str().unwrap().strip_prefix(INSTR).unwrap().to_string();
                return Reply::Json(json!({ "prompt": format!("<<T>>{t}<</T>>") }));
            }
            "/completion" => {
                let p = body["prompt"].as_str().unwrap();
                if let Some(rest) = p.strip_prefix("<<T>>") {
                    (rest.split_once("<</T>>").unwrap().0.to_string(), "raw")
                } else {
                    (p.strip_prefix(A_HEAD).unwrap().split_once("\nArabic:").unwrap().0.to_string(), "completion")
                }
            }
            _ => (body["messages"][0]["content"].as_str().unwrap().strip_prefix(INSTR).unwrap().to_string(), "chat"),
        };
        let pick = |c: &Value| -> Option<Raw> {
            Some(Raw { out: c["out"].as_str()?.to_string(), tokens: c["tokens"].as_u64(), stop: c["stop"].as_str()?.to_string() })
        };
        let raw = if damped {
            pick(&candidates["A1"])
        } else if text == src && route != "raw" && !st.fast_answered {
            st.fast_answered = true;
            pick(&candidates["fast"])
        } else {
            // A chunk: the next one in order (two chunks' texts can be equal), checked against the text it must carry.
            let b = &candidates["B"];
            let k = st.next_chunk;
            st.next_chunk += 1;
            match b["spans"].as_array().filter(|s| k < s.len()) {
                Some(spans) => {
                    let at = |k: usize, e: usize| spans[k][e].as_u64().unwrap() as usize;
                    let want: String = if k == 0 { para[at(0, 0)..at(0, 1)].iter().collect() } else { para[at(k - 1, 0)..at(k, 1)].iter().collect() };
                    if want != text {
                        st.problems.push(format!("chunk {k}: its text is not the planned one"));
                    }
                    pick(&b["chunks"][k])
                }
                None => {
                    st.problems.push(format!("request {k} beyond the recorded chunks (route {route})"));
                    None
                }
            }
        };
        let raw = raw.unwrap_or_else(|| Raw { out: String::new(), tokens: Some(0), stop: "eos".into() });
        let limit = raw.stop == "limit";
        Reply::Json(match route {
            "chat" => json!({ "choices": [{ "message": { "content": raw.out }, "finish_reason": if limit { "length" } else { "stop" } }],
                              "usage": { "completion_tokens": raw.tokens } }),
            "raw" => json!({ "content": raw.out, "tokens_predicted": raw.tokens, "stopped_limit": limit }),
            _ => json!({ "content": raw.out, "tokens_predicted": raw.tokens, "stopped_eos": raw.stop == "eos",
                         "stopped_word": raw.stop == "word", "stopped_limit": limit }),
        })
    })
}

#[test]
fn every_synthetic_decision_is_reached_through_the_adapters_as_evaluated() {
    let cases = lines(&fixture_dir().join("decisions.jsonl"));
    let state = Arc::new(Mutex::new(Case::default()));
    let engine = routed(state.clone());
    let mut checked = 0;
    for c in &cases {
        let id = c["id"].as_str().unwrap();
        let steps = strs(&c["frozen"]["decision"]["steps"]);
        if steps.iter().any(|s| s == "S") {
            continue; // its per-sentence candidate is recorded joined, so its units cannot be answered one by one
        }
        let src = c["src"].as_str().unwrap().to_string();
        let model = model_of(c["model"].as_str().unwrap());
        *state.lock().unwrap() = Case::new(src.clone(), c["candidates"].clone());
        let p = Paragraph { text: src, sentences: strs(&c["sents"]) };
        let o = translate(&mut source(&engine, model), &model.profile(), &p).unwrap_or_else(|e| panic!("{id}: {e:?}"));
        assert!(state.lock().unwrap().problems.is_empty(), "{id}: {:?}", state.lock().unwrap().problems);
        assert_eq!(super::pipeline_tests::decision_json(&o), c["frozen"]["decision"], "{id}");
        assert_eq!(o.text.as_deref(), c["frozen"]["final_text"].as_str(), "{id}");
        assert!(matches!(o.status, Status::Ok | Status::Recovered | Status::Second | Status::Review | Status::Failed));
        checked += 1;
    }
    assert!(checked >= 40, "only {checked} decision cases ran");
}

// Exchanges that fail one at a time, cancellation between them, and answers that are not what the route returns.

/// The normal answer of each route: the template stub, and a short completion or chat answer.
fn ok(path: &str, body: &Value) -> Reply {
    match path {
        "/apply-template" => Reply::Json(json!({ "prompt": format!("<<APPLY-TEMPLATE {}>>", py_dumps_messages(&body["messages"])) })),
        "/v1/chat/completions" => Reply::Json(json!({ "choices": [{ "message": { "content": "x" }, "finish_reason": "stop" }], "usage": { "completion_tokens": 3 } })),
        _ => Reply::Json(json!({ "content": "x", "tokens_predicted": 3, "stopped_eos": true })),
    }
}

/// Answers normally, except the `n`-th request (from 0) to `path`, which gets `bad`.
fn failing_at(path: &'static str, n: usize, bad: impl Fn() -> Reply + Send + Sync + 'static) -> FakeEngine {
    let count = AtomicUsize::new(0);
    FakeEngine::start(move |p, body| if p == path && count.fetch_add(1, Ordering::SeqCst) == n { bad() } else { ok(p, body) })
}

fn no_cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

fn source_with(engine: &FakeEngine, model: Model, timeout: Duration, cancel: &Arc<AtomicBool>) -> EngineSource {
    EngineSource::new(engine.endpoint(), model, timeout, cancel.clone())
}

/// A synthetic paragraph of five sentences, which the planner splits into three chunks.
fn five_sentences() -> Paragraph {
    let cases = lines(&fixture_dir().join("adapter-requests.jsonl"));
    let c = cases.iter().find(|c| c["id"] == "p1-B-B-plain").expect("the case");
    Paragraph { text: c["src"].as_str().unwrap().to_string(), sentences: strs(&c["sents"]) }
}

fn paths(engine: &FakeEngine) -> Vec<String> {
    engine.seen().iter().map(|s| s.path.clone()).collect()
}

fn hello(kind: Kind) -> Request {
    Request { kind, index: 0, text: "Hello there.".into(), prefill: None, sampling: Sampling::Greedy, limit: 99 }
}

#[test]
fn the_provisional_gpu_timeout_is_120_seconds_per_exchange() {
    assert_eq!(PROVISIONAL_GPU_EXCHANGE_TIMEOUT, Duration::from_secs(120));
}

#[test]
fn each_exchange_of_a_model_b_chunk_times_out_on_its_own() {
    let p = five_sentences();
    let slow = || Reply::Slow(Duration::from_secs(5), json!({}));
    // The second chunk's template exchange: the chunk is named, and its completion is never sent.
    let engine = failing_at("/apply-template", 1, slow);
    let t = Instant::now();
    match produce(&mut source_with(&engine, Model::B, Duration::from_millis(400), &no_cancel()), &Model::B.profile(), &p, Kind::Chunked) {
        Err(PipelineError::Source { kind: Kind::Chunked, index: 1, error: AdapterError::Timeout { path: "/apply-template" } }) => {}
        other => panic!("{other:?}"),
    }
    assert!(t.elapsed() < Duration::from_secs(3), "the timeout did not bound the exchange ({:?})", t.elapsed());
    assert_eq!(paths(&engine), ["/apply-template", "/completion", "/apply-template"]);

    // The second chunk's completion exchange.
    let engine = failing_at("/completion", 1, slow);
    let t = Instant::now();
    match produce(&mut source_with(&engine, Model::B, Duration::from_millis(400), &no_cancel()), &Model::B.profile(), &p, Kind::Chunked) {
        Err(PipelineError::Source { kind: Kind::Chunked, index: 1, error: AdapterError::Timeout { path: "/completion" } }) => {}
        other => panic!("{other:?}"),
    }
    assert!(t.elapsed() < Duration::from_secs(3), "the timeout did not bound the exchange ({:?})", t.elapsed());
    assert_eq!(paths(&engine), ["/apply-template", "/completion", "/apply-template", "/completion"]);
}

#[test]
fn each_exchange_of_a_model_b_chunk_has_its_own_budget() {
    // The first chunk's template and completion take 0.9 s each: 1.8 s for the chunk, under a 1.5 s timeout.
    let answered = AtomicUsize::new(0);
    let engine = FakeEngine::start(move |path, body| {
        if answered.fetch_add(1, Ordering::SeqCst) < 2 {
            std::thread::sleep(Duration::from_millis(900));
        }
        ok(path, body)
    });
    let t = Instant::now();
    let got = produce(&mut source_with(&engine, Model::B, Duration::from_millis(1500), &no_cancel()), &Model::B.profile(), &five_sentences(), Kind::Chunked);
    assert!(matches!(got, Ok(Candidate::Produced(_))), "{got:?}");
    assert!(t.elapsed() >= Duration::from_millis(1800));
    assert_eq!(paths(&engine).len(), 6);
}

#[test]
fn a_failed_exchange_ends_the_candidate_with_its_chunk_named_and_nothing_resent() {
    let p = five_sentences();
    // An error status from the template exchange.
    let engine = failing_at("/apply-template", 0, || Reply::Raw { status: 500, body: "{}".into() });
    match produce(&mut source(&engine, Model::B), &Model::B.profile(), &p, Kind::Chunked) {
        Err(PipelineError::Source { kind: Kind::Chunked, index: 0, error: AdapterError::Status { path: "/apply-template", status: 500 } }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(paths(&engine), ["/apply-template"]);

    // A template answer without its prompt, or with a prompt that is not text.
    for bad in [json!({}), json!({ "prompt": 5 })] {
        let engine = failing_at("/apply-template", 1, move || Reply::Json(bad.clone()));
        match produce(&mut source(&engine, Model::B), &Model::B.profile(), &p, Kind::Chunked) {
            Err(PipelineError::Source { kind: Kind::Chunked, index: 1, error: AdapterError::Malformed { path: "/apply-template", .. } }) => {}
            other => panic!("{other:?}"),
        }
        assert_eq!(paths(&engine), ["/apply-template", "/completion", "/apply-template"]);
    }

    // The last chunk fails after two were answered: no candidate is made of the answered ones.
    let engine = failing_at("/completion", 2, || Reply::Raw { status: 503, body: "{}".into() });
    match produce(&mut source(&engine, Model::B), &Model::B.profile(), &p, Kind::Chunked) {
        Err(PipelineError::Source { kind: Kind::Chunked, index: 2, error: AdapterError::Status { path: "/completion", status: 503 } }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(paths(&engine).len(), 6);

    // Model A: a chunk's answer without its content.
    let engine = failing_at("/completion", 1, || Reply::Json(json!({ "tokens_predicted": 1 })));
    match produce(&mut source(&engine, Model::A), &Model::A.profile(), &p, Kind::Chunked) {
        Err(PipelineError::Source { kind: Kind::Chunked, index: 1, error: AdapterError::Malformed { path: "/completion", .. } }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(paths(&engine), ["/completion", "/completion"]);
}

#[test]
fn a_cancellation_between_or_during_exchanges_stops_the_next_one() {
    let p = five_sentences();
    // Set while model B's template is answered: that chunk's completion is never sent.
    let cancel = no_cancel();
    let c = cancel.clone();
    let engine = FakeEngine::start(move |path, body| {
        if path == "/apply-template" {
            c.store(true, Ordering::SeqCst);
        }
        ok(path, body)
    });
    match produce(&mut source_with(&engine, Model::B, Duration::from_secs(5), &cancel), &Model::B.profile(), &p, Kind::Chunked) {
        Err(PipelineError::Source { kind: Kind::Chunked, index: 0, error: AdapterError::Cancelled }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(paths(&engine), ["/apply-template"]);

    // Set while the first chunk is generated: that exchange is not interrupted and its answer is read, and the next
    // chunk is never started.
    for model in [Model::A, Model::B] {
        let cancel = no_cancel();
        let c = cancel.clone();
        let engine = FakeEngine::start(move |path, body| {
            if path == "/completion" {
                c.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(200));
            }
            ok(path, body)
        });
        match produce(&mut source_with(&engine, model, Duration::from_secs(5), &cancel), &model.profile(), &p, Kind::Chunked) {
            Err(PipelineError::Source { kind: Kind::Chunked, index: 1, error: AdapterError::Cancelled }) => {}
            other => panic!("{model:?}: {other:?}"),
        }
        let want: &[&str] = if model == Model::A { &["/completion"] } else { &["/apply-template", "/completion"] };
        assert_eq!(paths(&engine), want, "{model:?}");
    }

    // Set during the first sentence unit: the second unit is never sent.
    let cancel = no_cancel();
    let c = cancel.clone();
    let engine = FakeEngine::start(move |path, body| {
        c.store(true, Ordering::SeqCst);
        ok(path, body)
    });
    match produce(&mut source_with(&engine, Model::B, Duration::from_secs(5), &cancel), &Model::B.profile(), &p, Kind::Sentences) {
        Err(PipelineError::Source { kind: Kind::Sentences, index: 1, error: AdapterError::Cancelled }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(paths(&engine), ["/v1/chat/completions"]);
}

#[test]
fn a_failed_sentence_unit_is_named_and_ends_the_retry() {
    let p = five_sentences();
    for (model, path) in [(Model::A, "/completion"), (Model::B, "/v1/chat/completions")] {
        let engine = failing_at(path, 1, || Reply::Raw { status: 500, body: "{}".into() });
        match produce(&mut source(&engine, model), &model.profile(), &p, Kind::Sentences) {
            Err(PipelineError::Source { kind: Kind::Sentences, index: 1, error: AdapterError::Status { status: 500, .. } }) => {}
            other => panic!("{model:?}: {other:?}"),
        }
        assert_eq!(paths(&engine), [path, path]);
    }
}

/// Pinned, not endorsed: `engine::http` discards an error while it reads the body, so a timeout that passes after
/// the headers arrived surfaces as a malformed answer rather than a timeout. It is still an error, never a status;
/// changing it is a separate change to `engine::http`.
#[test]
fn a_timeout_while_the_body_is_read_is_reported_as_malformed() {
    let body = json!({ "content": "x", "tokens_predicted": 1, "stopped_eos": true }).to_string();
    let engine = FakeEngine::start(move |_, _| Reply::StallBody { sent: 5, stall: Duration::from_secs(5), body: body.clone() });
    let t = Instant::now();
    match translate(&mut source_with(&engine, Model::A, Duration::from_millis(400), &no_cancel()), &Model::A.profile(), &paragraph()) {
        Err(PipelineError::Source { kind: Kind::Fast, index: 0, error: AdapterError::Malformed { path: "/completion", .. } }) => {}
        other => panic!("{other:?}"),
    }
    assert!(t.elapsed() < Duration::from_secs(3), "the timeout did not bound the body ({:?})", t.elapsed());
    assert_eq!(engine.seen().len(), 1);
}

/// One answer of the completion or chat route, with `content` spliced in as raw bytes and `tokens` as JSON text.
fn answer_bytes(chat: bool, content: &[u8], tokens: &str) -> Vec<u8> {
    let (head, mid, tail) = if chat {
        ("{\"choices\": [{\"message\": {\"content\": \"", "\"}, \"finish_reason\": \"stop\"}], \"usage\": {\"completion_tokens\": ", "}}")
    } else {
        ("{\"content\": \"", "\", \"tokens_predicted\": ", ", \"stopped_eos\": true}")
    };
    [head.as_bytes(), content, mid.as_bytes(), tokens.as_bytes(), tail.as_bytes()].concat()
}

/// Lone surrogates, text that is not UTF-8, and token counts that are not whole non-negative numbers are malformed
/// on every route. The valid form of the same answer, read normally, shows the cases are otherwise well formed.
#[test]
fn surrogates_invalid_text_and_odd_token_counts_are_malformed_on_every_route() {
    let contents: [(&str, &[u8], Option<&str>); 5] = [
        ("an escaped letter (valid)", b"\\u0628 ok", Some("\u{628} ok")),
        ("a lone leading surrogate escape", b"\\ud800", None),
        ("a lone trailing surrogate escape", b"\\udc00", None),
        ("an encoded surrogate", b"\xed\xa0\x80", None),
        ("bytes that are not UTF-8", b"\xff", None),
    ];
    let tokens: [(&str, bool); 6] = [("12", true), ("12.0", false), ("12.5", false), ("-3", false), ("true", false), ("\"12\"", false)];
    let mut checked = 0;
    for (route, model, kind) in [("completion", Model::A, Kind::Fast), ("chat", Model::B, Kind::Fast), ("chunk", Model::B, Kind::Chunked)] {
        let chat = route == "chat";
        let mut cases: Vec<(String, Vec<u8>, Option<&str>)> = Vec::new();
        for (name, content, out) in contents {
            cases.push((name.to_string(), answer_bytes(chat, content, "12"), out));
        }
        for (count, valid) in tokens {
            cases.push((format!("token count {count}"), answer_bytes(chat, b"x", count), valid.then_some("x")));
        }
        for (name, body, out) in cases {
            let engine = FakeEngine::start(move |path, req| {
                if path == "/apply-template" {
                    ok(path, req)
                } else {
                    Reply::Bytes { status: 200, body: body.clone() }
                }
            });
            match (source(&engine, model).answer(&hello(kind)), out) {
                (Ok(raw), Some(out)) => assert_eq!((raw.out.as_str(), raw.tokens), (out, Some(12)), "{route}: {name}"),
                (Err(AdapterError::Malformed { .. }), None) => {}
                (other, _) => panic!("{route}: {name}: {other:?}"),
            }
            checked += 1;
        }
    }
    // The template exchange's own answer follows the same rule.
    for (name, content) in [("a lone surrogate escape", &b"\\ud800"[..]), ("bytes that are not UTF-8", &b"\xff"[..])] {
        let body = [&b"{\"prompt\": \""[..], content, b"\"}"].concat();
        let engine = FakeEngine::start(move |_, _| Reply::Bytes { status: 200, body: body.clone() });
        match source(&engine, Model::B).answer(&hello(Kind::Chunked)) {
            Err(AdapterError::Malformed { path: "/apply-template", .. }) => {}
            other => panic!("template: {name}: {other:?}"),
        }
        assert_eq!(paths(&engine), ["/apply-template"]);
        checked += 1;
    }
    assert_eq!(checked, 35);
}

#[test]
fn a_refused_connection_is_a_transport_error_on_every_route() {
    // A port that was free a moment ago, with nothing listening on it now.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    for (model, kind, path) in [(Model::A, Kind::Fast, "/completion"), (Model::B, Kind::Fast, "/v1/chat/completions"), (Model::B, Kind::Chunked, "/apply-template")] {
        let endpoint = Endpoint { port, key: SessionKey::for_tests("test-key") };
        match EngineSource::new(endpoint, model, Duration::from_secs(10), no_cancel()).answer(&hello(kind)) {
            Err(AdapterError::Transport { path: p, .. }) if p == path => {}
            other => panic!("{model:?} {kind:?}: {other:?}"),
        }
    }
}

#[test]
fn a_paragraph_redone_after_an_error_sends_exactly_what_a_fresh_one_sends() {
    let fail_at = Arc::new(AtomicUsize::new(1));
    let count = Arc::new(AtomicUsize::new(0));
    let (f, n) = (fail_at.clone(), count.clone());
    let engine = FakeEngine::start(move |path, body| {
        if n.fetch_add(1, Ordering::SeqCst) == f.load(Ordering::SeqCst) {
            Reply::Raw { status: 500, body: "{}".into() }
        } else {
            ok(path, body)
        }
    });
    let mut s = source(&engine, Model::A);
    let p = paragraph();
    // The second request fails; then the same source does the paragraph again.
    assert!(matches!(translate(&mut s, &Model::A.profile(), &p), Err(PipelineError::Source { index: 0, .. })));
    fail_at.store(usize::MAX, Ordering::SeqCst);
    engine.seen.lock().unwrap().clear();
    let again = translate(&mut s, &Model::A.profile(), &p).expect("the paragraph again");

    let fresh_engine = FakeEngine::start(ok);
    let fresh = translate(&mut source(&fresh_engine, Model::A), &Model::A.profile(), &p).expect("a fresh paragraph");
    assert!(fresh_engine.seen().len() >= 2, "the case must take more than one request");
    assert_eq!(seen_json(&engine.seen()), seen_json(&fresh_engine.seen()));
    assert_eq!(decision_json(&again), decision_json(&fresh));
    assert_eq!(again.text, fresh.text);
}

#[test]
fn every_exchange_goes_to_loopback_with_the_session_key() {
    let p = five_sentences();
    let engine = FakeEngine::start(ok);
    for model in [Model::A, Model::B] {
        for kind in [Kind::Fast, Kind::Damped, Kind::Chunked, Kind::Sentences] {
            produce(&mut source(&engine, model), &model.profile(), &p, kind).unwrap_or_else(|e| panic!("{model:?} {kind:?}: {e:?}"));
        }
    }
    let seen = engine.seen();
    assert_eq!(seen.len(), 1 + 1 + 3 + 5 + 1 + 1 + 6 + 5);
    let host = format!("127.0.0.1:{}", engine.port);
    for s in &seen {
        assert_eq!(s.host.as_deref(), Some(host.as_str()), "{}", s.path);
        assert_eq!(s.auth.as_deref(), Some("Bearer test-key"), "{}", s.path);
    }
}
