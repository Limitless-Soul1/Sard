//! The model adapters: how one pipeline request becomes the exact exchange with the engine that the evaluated
//! pipeline had, and how the engine's answer becomes a raw output. Nothing is decided here — planning, checks and
//! statuses stay in the pipeline — and nothing is retried: a failed exchange is returned as it is.
//!
//! The two models are reached by different routes, as they were evaluated:
//! * **Model A** (the translation model): every request is a plain completion of the fixed prompt
//!   `Translate this from English to Arabic:\nEnglish: {text}\nArabic:`, stopping at the next `\nEnglish:`. A chunk
//!   after the first continues the previous chunk's output, after one space.
//! * **Model B** (the general model): the first translation, the damped retry and the sentence units go to the chat
//!   endpoint with a fixed instruction and thinking switched off. A chunk instead asks the engine to apply its chat
//!   template — for every chunk — and completes that prompt with the previous chunk's output appended directly. The
//!   two routes give different greedy output, which is why each request keeps the route it was evaluated with.
//!
//! Every request is greedy, never reuses a cached prompt, and carries the pipeline's token budget.
//!
//! Each exchange is bounded, end to end, by the timeout the caller gives: from connecting until the answer has been
//! read. A chunk of model B is two exchanges, each with its own budget. There is no paragraph deadline and no
//! default: `PROVISIONAL_GPU_EXCHANGE_TIMEOUT` is a proposed value for an engine on the GPU only, and no value for
//! the CPU exists yet. A cancellation is checked before every exchange, so an exchange already sent runs until its
//! answer or its timeout.

use super::text::{is_space, strip};
use super::{Kind, Profile, Raw, Request, Sampling, Source};
use crate::translation::catalog::{self, Artifact};
use crate::translation::engine::{http, Endpoint, HttpError};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const A_HEAD: &str = "Translate this from English to Arabic:\nEnglish: ";
const A_TAIL: &str = "\nArabic:";
const A_STOP: &str = "\nEnglish:";
const B_INSTRUCTION: &str = "Translate the following English text into Modern Standard Arabic. Output only the translation, nothing else.\n\n";

/// A proposed timeout for one exchange with an engine on the GPU — provisional, not a measured production value. It
/// is not meant for the CPU: there, a generation that runs to its token budget can take several times as long, and
/// a timeout that ends it first would turn the recovery of a looping output into an error.
pub const PROVISIONAL_GPU_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(120);

/// The two translation models.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    /// The translation model, on the completion route.
    A,
    /// The general model, on the chat route (and the template route for chunks).
    B,
}

impl Model {
    /// The model a catalog entry is, if it is one.
    pub fn of(artifact: &Artifact) -> Option<Model> {
        if artifact.id == catalog::MODEL_A.id {
            Some(Model::A)
        } else if artifact.id == catalog::MODEL_B.id {
            Some(Model::B)
        } else {
            None
        }
    }

    /// The pipeline's constant for the model: its Arabic/English length relative to model A's.
    pub fn profile(self) -> Profile {
        Profile { k: if self == Model::A { 1.0 } else { 0.932 } }
    }
}

/// Why an exchange gave no answer. Every one of these leaves the paragraph untranslated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    /// Cancelled before the exchange was sent.
    Cancelled,
    /// No complete answer within the caller's timeout.
    Timeout { path: &'static str },
    /// The engine answered with an error status.
    Status { path: &'static str, status: u16 },
    /// The exchange failed before an answer (connection refused or reset, …).
    Transport { path: &'static str, detail: String },
    /// The answer is not what the route returns: not JSON, or without the field the evaluated client read.
    Malformed { path: &'static str, what: String },
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdapterError::Cancelled => write!(f, "cancelled"),
            AdapterError::Timeout { path } => write!(f, "{path}: no answer in time"),
            AdapterError::Status { path, status } => write!(f, "{path}: status {status}"),
            AdapterError::Transport { path, detail } => write!(f, "{path}: {detail}"),
            AdapterError::Malformed { path, what } => write!(f, "{path}: {what}"),
        }
    }
}

/// The pipeline's source of answers: a running engine, reached through its endpoint.
pub struct EngineSource {
    endpoint: Endpoint,
    model: Model,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
}

impl EngineSource {
    /// `timeout` bounds every single exchange (a chunk of model B is two); there is no default. `cancel`, once set,
    /// stops the next exchange from being sent.
    pub fn new(endpoint: Endpoint, model: Model, timeout: Duration, cancel: Arc<AtomicBool>) -> EngineSource {
        EngineSource { endpoint, model, timeout, cancel }
    }

    fn post(&self, path: &'static str, body: &Value) -> Result<Value, AdapterError> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(AdapterError::Cancelled);
        }
        let reply = http(self.endpoint.port, "POST", path, Some(&self.endpoint.key), Some(&body.to_string()), self.timeout)
            .map_err(|e| match e {
                HttpError::Timeout => AdapterError::Timeout { path },
                HttpError::Other(detail) => AdapterError::Transport { path, detail },
            })?;
        if !(200..300).contains(&reply.status) {
            return Err(AdapterError::Status { path, status: reply.status });
        }
        let v: Value = serde_json::from_str(&reply.body).map_err(|e| AdapterError::Malformed { path, what: format!("not JSON: {e}") })?;
        if !v.is_object() {
            return Err(AdapterError::Malformed { path, what: "not an object".into() });
        }
        Ok(v)
    }
}

/// The repetition-damping sampler's settings, as evaluated.
fn damped(body: &mut Map<String, Value>) {
    body.insert("dry_multiplier".into(), json!(0.8));
    body.insert("dry_base".into(), json!(1.75));
    body.insert("dry_allowed_length".into(), json!(2));
    body.insert("dry_penalty_last_n".into(), json!(4096));
}

/// The previous chunk's output as the continuation is written: nothing when it is empty, otherwise stripped — after
/// one space on the completion route.
fn continuation(prefill: &Option<String>, spaced: bool) -> String {
    match prefill {
        Some(p) if !p.is_empty() => {
            if spaced {
                format!(" {}", strip(p))
            } else {
                strip(p).to_string()
            }
        }
        _ => String::new(),
    }
}

fn messages(text: &str) -> Value {
    json!([{ "role": "user", "content": format!("{B_INSTRUCTION}{text}") }])
}

/// The request body of a completion (model A, or a model B chunk after its template).
pub(crate) fn completion_body(prompt: String, limit: u32, stop: Value, sampling: Sampling) -> Value {
    let mut b = Map::new();
    b.insert("prompt".into(), json!(prompt));
    b.insert("n_predict".into(), json!(limit));
    b.insert("temperature".into(), json!(0.0));
    b.insert("stop".into(), stop);
    b.insert("cache_prompt".into(), json!(false));
    if sampling == Sampling::Damped {
        damped(&mut b);
    }
    Value::Object(b)
}

/// The request body of a chat completion (model B).
pub(crate) fn chat_body(text: &str, limit: u32, sampling: Sampling) -> Value {
    let mut b = Map::new();
    b.insert("messages".into(), messages(text));
    b.insert("max_tokens".into(), json!(limit));
    b.insert("temperature".into(), json!(0.0));
    b.insert("cache_prompt".into(), json!(false));
    b.insert("chat_template_kwargs".into(), json!({ "enable_thinking": false }));
    if sampling == Sampling::Damped {
        damped(&mut b);
    }
    Value::Object(b)
}

/// The request body that asks the engine to apply model B's chat template.
pub(crate) fn template_body(text: &str) -> Value {
    json!({ "messages": messages(text), "chat_template_kwargs": { "enable_thinking": false } })
}

/// Python's truth value of a JSON field: absent, null, false, 0, "" and empty containers are false.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

fn text_field(v: &Value, key: &str, path: &'static str) -> Result<String, AdapterError> {
    match v.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(AdapterError::Malformed { path, what: format!("`{key}` is not text") }),
        None => Err(AdapterError::Malformed { path, what: format!("no `{key}`") }),
    }
}

/// A token count: absent or null is unknown; anything but a whole number is malformed.
fn count(v: Option<&Value>, path: &'static str) -> Result<Option<u64>, AdapterError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(x) => x.as_u64().map(Some).ok_or_else(|| AdapterError::Malformed { path, what: "a token count is not a whole number".into() }),
    }
}

/// The completion route's answer.
fn completion_raw(r: &Value, path: &'static str, plain_stop_reasons: bool) -> Result<Raw, AdapterError> {
    let out = text_field(r, "content", path)?;
    let tokens = count(r.get("tokens_predicted"), path)?;
    let stop = if !plain_stop_reasons {
        if truthy(r.get("stopped_limit")) { "limit" } else { "eos" }.to_string()
    } else if truthy(r.get("stopped_eos")) {
        "eos".into()
    } else if truthy(r.get("stopped_word")) {
        "word".into()
    } else if truthy(r.get("stopped_limit")) {
        "limit".into()
    } else {
        match r.get("stop_type") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        }
    };
    Ok(Raw { out, tokens, stop })
}

/// A leading `<think>…</think>` pair with only whitespace inside, and the whitespace around it, removed.
fn without_empty_thinking(s: &str) -> String {
    let skip = |t: &str| t.trim_start_matches(is_space).to_string();
    let rest = skip(s);
    if let Some(after_open) = rest.strip_prefix("<think>") {
        if let Some(after_close) = skip(after_open).strip_prefix("</think>") {
            return skip(after_close);
        }
    }
    s.to_string()
}

/// The chat route's answer.
fn chat_raw(r: &Value, path: &'static str) -> Result<Raw, AdapterError> {
    let choice = r
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .ok_or_else(|| AdapterError::Malformed { path, what: "no first choice".into() })?;
    let message = match choice.get("message") {
        Some(m @ Value::Object(_)) => m,
        Some(_) => return Err(AdapterError::Malformed { path, what: "the message is not an object".into() }),
        None => return Err(AdapterError::Malformed { path, what: "no message".into() }),
    };
    let content = match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        v if !truthy(v) => String::new(),
        _ => return Err(AdapterError::Malformed { path, what: "the content is not text".into() }),
    };
    let stop = if choice.get("finish_reason").and_then(Value::as_str) == Some("length") { "limit" } else { "eos" };
    let tokens = match r.get("usage") {
        v if !truthy(v) => None,
        Some(u @ Value::Object(_)) => count(u.get("completion_tokens"), path)?,
        Some(_) => return Err(AdapterError::Malformed { path, what: "the usage is not an object".into() }),
        None => None,
    };
    Ok(Raw { out: without_empty_thinking(&content), tokens, stop: stop.into() })
}

impl Source for EngineSource {
    type Error = AdapterError;

    fn answer(&mut self, r: &Request) -> Result<Raw, AdapterError> {
        match (self.model, r.kind) {
            (Model::A, _) => {
                let prompt = format!("{A_HEAD}{}{A_TAIL}{}", r.text, continuation(&r.prefill, true));
                let reply = self.post("/completion", &completion_body(prompt, r.limit, json!([A_STOP]), r.sampling))?;
                completion_raw(&reply, "/completion", true)
            }
            (Model::B, Kind::Chunked) => {
                let template = self.post("/apply-template", &template_body(&r.text))?;
                let prompt = text_field(&template, "prompt", "/apply-template")?;
                let body = completion_body(format!("{prompt}{}", continuation(&r.prefill, false)), r.limit, json!([]), r.sampling);
                let reply = self.post("/completion", &body)?;
                completion_raw(&reply, "/completion", false)
            }
            (Model::B, _) => {
                if r.prefill.is_some() {
                    return Err(AdapterError::Malformed { path: "/v1/chat/completions", what: "a continuation on the chat route".into() });
                }
                let reply = self.post("/v1/chat/completions", &chat_body(&r.text, r.limit, r.sampling))?;
                chat_raw(&reply, "/v1/chat/completions")
            }
        }
    }
}
