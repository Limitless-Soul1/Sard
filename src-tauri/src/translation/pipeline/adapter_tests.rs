//! The adapters against a fake engine: a minimal HTTP server on 127.0.0.1 that records every request and answers from
//! a script. No model and no engine are involved, so these tests show the exchange is the evaluated one — not that a
//! real engine answers as it did.
//!
//! The expected request bodies and answer readings in `tests/fixtures/translation-pipeline/adapter-*.jsonl` were
//! produced by the evaluated client code on synthetic paragraphs, against the same scripted engine.

use super::adapter::{AdapterError, EngineSource, Model};
use super::decide::produce;
use super::pipeline_tests::{fixture_dir, lines, strs};
use super::{translate, Candidate, Kind, Paragraph, PipelineError, Raw, Request, Sampling, Source, Status};
use crate::translation::engine::{Endpoint, SessionKey};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// One request the fake engine received.
#[derive(Debug, Clone)]
pub(super) struct Seen {
    pub path: String,
    pub auth: Option<String>,
    pub body: Value,
}

/// How the fake engine answers one request.
pub(super) enum Reply {
    Json(Value),
    Raw { status: u16, body: String },
    Slow(Duration, Value),
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
    seen.lock().unwrap().push(Seen { path: path.clone(), auth: header("authorization"), body: body.clone() });
    let (status, text) = match handler(&path, &body) {
        Reply::Json(v) => (200, v.to_string()),
        Reply::Raw { status, body } => (status, body),
        Reply::Slow(d, v) => {
            std::thread::sleep(d);
            (200, v.to_string())
        }
        Reply::Hangup => return Ok(()),
    };
    let reason = if status == 200 { "OK" } else { "Error" };
    let out = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
    conn.write_all(out.as_bytes())?;
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
    assert_eq!(cases.len(), 24);
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
