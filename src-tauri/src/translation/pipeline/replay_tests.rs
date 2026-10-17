//! The full replay: the pipeline against every recorded paragraph of the evaluation, and against the reference values
//! of the evaluated implementation. The recordings hold book text, so they are never part of the repository; this
//! test runs only when pointed at them:
//!
//! ```text
//! SARD_TRANSLATION_REPLAY_FIXTURES=<fixture dir> SARD_TRANSLATION_REPLAY_REFERENCE=<reference dir> \
//! SARD_TRANSLATION_REPLAY_ORACLE=<oracle dir> cargo test --lib -- --ignored --exact \
//! translation::pipeline::replay_tests::the_recorded_evaluation_replays_exactly --nocapture
//! ```
//!
//! Every file is checked against its manifest first. Every comparison must match; a mismatch is a defect.

use super::chunk::{fix_abbrev, quote_units, recovery_spans, sentence_units, splittable};
use super::complete::{ar_segs, en_sents as d1_sents, letters};
use super::decide::{cap, is_repetition};
use super::detect::{ar_sents, detect, detect_b, detect_base, en_sents, features_b, latin_run, near_dupes, runs_b};
use super::pipeline_tests::{
    compare_judgements, d1_json, decision_json, features_json, judged, lines, planned, py_repr, same_raise, spans_json, strs, Served,
};
use super::script::check;
use super::text::{chars, lower, norm, similarity, split_ws, strip, words};
use super::{translate, Candidate, Kind, Paragraph, PipelineError, Profile, Raw, Request, Sampling, Source};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn dir(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| panic!("{var} is not set — this test needs the private recordings")))
}

fn sha256(p: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))))
}

fn verify_manifest(d: &Path) -> Value {
    let m: Value = serde_json::from_str(&std::fs::read_to_string(d.join("manifest.json")).unwrap()).unwrap();
    for (name, info) in m["outputs"].as_object().unwrap() {
        assert_eq!(sha256(&d.join(name)), info["sha256"].as_str().unwrap(), "{name} differs from its manifest");
    }
    m
}

#[derive(Default)]
struct Tally {
    checked: BTreeMap<&'static str, usize>,
    bad: Vec<String>,
}

impl Tally {
    fn eq(&mut self, level: &'static str, at: &str, got: &Value, want: &Value) {
        *self.checked.entry(level).or_default() += 1;
        if got != want {
            self.bad.push(format!("{level} {at}: got {} want {}", short(got), short(want)));
        }
    }
    fn ok(&mut self, level: &'static str, at: &str, cond: bool, what: &str) {
        *self.checked.entry(level).or_default() += 1;
        if !cond {
            self.bad.push(format!("{level} {at}: {what}"));
        }
    }
}

/// Mismatch text without book text: lengths and the first differing position only.
fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() <= 120 && !s.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)) {
        s
    } else {
        format!("<{} chars, sha256 {}>", s.chars().count(), &format!("{:x}", Sha256::digest(s.as_bytes()))[..12])
    }
}

/// The request plan the pipeline makes for one candidate, answered from a given list of chunk outputs.
struct Planner<'a> {
    chunk_outs: Option<Vec<String>>,
    seen: &'a mut Vec<Request>,
}

impl Source for Planner<'_> {
    type Error = std::convert::Infallible;
    fn answer(&mut self, r: &Request) -> Result<Raw, Self::Error> {
        self.seen.push(r.clone());
        let out = match (&self.chunk_outs, r.kind) {
            (Some(outs), Kind::Chunked) => outs.get(r.index).cloned().unwrap_or_default(),
            (None, Kind::Chunked) => "<<STUB>>".to_string(),
            _ => String::new(),
        };
        Ok(Raw { out, tokens: Some(1), stop: "eos".into() })
    }
}

const A_PROMPT: &str = "Translate this from English to Arabic:\nEnglish: ";
const INSTR: &str = "Translate the following English text into Modern Standard Arabic. Output only the translation, nothing else.\n\n";

/// The parts of a recorded request body the pure pipeline decides: the token limit, the sampler, the English text and
/// the continued output. (How a body is built from them is the adapters' job, and is not tested here.)
fn body_parts(model: &str, body: &Value) -> (u64, bool, String, String) {
    let limit = body.get("n_predict").or_else(|| body.get("max_tokens")).and_then(Value::as_u64).expect("a token limit");
    let damped = body.get("dry_multiplier").is_some();
    if let Some(p) = body.get("prompt").and_then(Value::as_str) {
        if model == "A" {
            let rest = p.strip_prefix(A_PROMPT).expect("the frozen prompt");
            let (text, tail) = rest.split_once("\nArabic:").expect("the frozen prompt");
            return (limit, damped, text.to_string(), tail.to_string());
        }
        let (stub, tail) = p.split_once(">>").expect("the template stub");
        let msgs: Value = serde_json::from_str(stub.strip_prefix("<<APPLY-TEMPLATE ").expect("the template stub")).unwrap();
        let text = msgs[0]["content"].as_str().unwrap().strip_prefix(INSTR).expect("the frozen instruction");
        return (limit, damped, text.to_string(), tail.to_string());
    }
    let text = body["messages"][0]["content"].as_str().unwrap().strip_prefix(INSTR).expect("the frozen instruction");
    (limit, damped, text.to_string(), String::new())
}

#[test]
#[ignore = "needs the private recordings (see the module documentation)"]
fn the_recorded_evaluation_replays_exactly() {
    let fixtures = dir("SARD_TRANSLATION_REPLAY_FIXTURES");
    let reference = dir("SARD_TRANSLATION_REPLAY_REFERENCE");
    let oracle = dir("SARD_TRANSLATION_REPLAY_ORACLE");
    verify_manifest(&fixtures);
    let rman = verify_manifest(&reference);
    assert_eq!(rman["fixtures_manifest_sha256"].as_str().unwrap(), sha256(&fixtures.join("manifest.json")));
    let mut t = Tally::default();

    for name in ["locked-A.jsonl", "locked-B.jsonl", "confirm-A.jsonl", "confirm-B.jsonl"] {
        let fx = lines(&fixtures.join(name));
        let fns = lines(&reference.join(format!("functions-{name}")));
        let decs = lines(&reference.join(format!("decisions-{name}")));
        let reqs = lines(&reference.join(format!("requests-{name}")));
        for (((f, fv), dv), rv) in fx.iter().zip(&fns).zip(&decs).zip(&reqs) {
            let key = f["key"].as_str().unwrap();
            let at = format!("{name}:{key}");
            assert!(fv["key"] == f["key"] && dv["key"] == f["key"] && rv["key"] == f["key"], "{at}: files out of step");
            let model = f["model"].as_str().unwrap();
            let k = f["k"].as_f64().unwrap();
            let src = f["src"].as_str().unwrap();
            let sents = strs(&f["sents"]);
            // L0 — inputs and the paragraph's own values
            t.eq("L0 words/cap", &at, &json!([words(src), cap(words(src))]), &json!([f["words"], f["cap"]]));
            paragraph_values(&mut t, &at, src, &sents, &fv["paragraph"]);
            // function level — every recorded candidate and chunk against the reference values
            for (kind, c) in f["candidates"].as_object().unwrap() {
                if c.get("skipped").is_some() {
                    continue;
                }
                candidate_values(&mut t, &format!("{at}:{kind}"), src, c, k, &fv["candidates"][kind]);
            }
            // the decision, with the recorded outputs as the source
            let p = Paragraph { text: src.to_string(), sentences: sents.clone() };
            let mut s = Served { candidates: &f["candidates"], src: chars(src), missing: Vec::new(), problems: Vec::new() };
            let o = match translate(&mut s, &Profile { k }, &p) {
                Ok(o) => o,
                Err(PipelineError::Input(e)) => {
                    t.bad.push(format!("{at}: input error {e}"));
                    continue;
                }
                Err(PipelineError::Source { error, .. }) => match error {},
            };
            // L1 — reason lists of every candidate the pipeline produced (every recorded candidate, including those only
            // the earlier pipeline asked for, is also judged one by one at the function level above)
            let (flags, _) = judged(&o);
            *t.checked.entry("L1 reasons + script").or_default() += flags.len();
            compare_judgements(&at, &o, &f["expected"]["flags"], &f["expected"]["script"], &f["expected"]["decision"], &mut t.bad);
            // L2 — assembly of the chunked and per-sentence candidates
            for (kind, c) in &o.candidates {
                let rec = &f["candidates"][kind.name()];
                match c {
                    Candidate::Skipped(sk) => t.eq("L2 skip", &at, &json!(sk.reason()), &rec["skipped"]),
                    Candidate::Produced(pr) if *kind == Kind::Chunked => {
                        t.eq("L2 spans", &at, &json!(pr.spans.iter().map(|&(a, b)| json!([a, b])).collect::<Vec<_>>()), &rec["spans"]);
                        t.eq("L2 chunk sources", &at, &json!(pr.chunks.iter().map(|c| c.src.clone()).collect::<Vec<_>>()),
                            &json!(rec["chunks"].as_array().unwrap().iter().map(|c| c["src"].clone()).collect::<Vec<_>>()));
                        t.eq("L2 join", &at, &json!([pr.out, pr.tokens, pr.stop]), &json!([rec["out"], rec["tokens"], rec["stop"]]));
                    }
                    Candidate::Produced(pr) if *kind == Kind::Sentences => t.eq("L2 units", &at, &json!(pr.units), &rec["units"]),
                    _ => {}
                }
            }
            t.ok("L2 served", &at, s.problems.is_empty(), &format!("{:?}", s.problems));
            // L3 — the candidates requested, in order
            let mut want_order: Vec<String> = vec!["fast".into()];
            for st in strs(&f["expected"]["decision"]["steps"]) {
                let k = st.trim_start_matches("2:").to_string();
                let skipped = f["candidates"][&k].get("skipped").is_some();
                if !want_order.contains(&k) && !skipped {
                    want_order.push(k);
                }
            }
            let mut got_order: Vec<String> = Vec::new();
            for (kind, _) in &o.requests {
                let n = kind.name().to_string();
                if !got_order.contains(&n) {
                    got_order.push(n);
                }
            }
            t.eq("L3 request order", &at, &json!(got_order), &json!(want_order));
            t.ok("L3 nothing unrecorded", &at, s.missing.is_empty(), &format!("requested unrecorded {:?}", s.missing));
            // L4 — the decision; why_review where it was recorded, the evaluated code's own value otherwise
            let got = decision_json(&o);
            let mut want = f["expected"]["decision"].clone();
            if !f["expected"]["why_review_in_record"].as_bool().unwrap() {
                if let Some(w) = dv["decision"].get("why_review") {
                    want["why_review"] = w.clone();
                    *t.checked.entry("L4 why_review (derived)").or_default() += 1;
                }
            }
            t.eq("L4 decision", &at, &got, &want);
            t.eq("L4 decision vs reference", &at, &got, &dv["decision"]);
            // L5 — the final text
            t.eq("L5 final text", &at, &json!(o.text), &f["expected"]["final_text"]);
            // the request plan against the recorded request bodies (limits, sampler, text, continuation)
            request_plan(&mut t, &at, model, src, &sents, &f["candidates"], rv);
        }
    }

    for name in ["secondary-dev-A.jsonl", "secondary-dev-B.jsonl", "secondary-deveval-A.jsonl", "secondary-deveval-B.jsonl"] {
        let fx = lines(&fixtures.join(name));
        let fns = lines(&reference.join(format!("functions-{name}")));
        for (f, fv) in fx.iter().zip(&fns) {
            let at = format!("{name}:{}", f["key"].as_str().unwrap());
            let k = f["k"].as_f64().unwrap();
            let src = f["src"].as_str().unwrap();
            paragraph_values(&mut t, &at, src, &strs(&f["sents"]), &fv["paragraph"]);
            for (kind, c) in f["candidates"].as_object().unwrap() {
                if c.get("skipped").is_some() {
                    continue;
                }
                let at = format!("{at}:{kind}");
                candidate_values(&mut t, &at, src, c, k, &fv["candidates"][kind]);
                let out = c["out"].as_str().unwrap();
                let limit = c["stop"] == "limit";
                let tokens = c["tokens"].as_u64().unwrap_or(0);
                let chunked = |base: Vec<String>, per: &dyn Fn(&Value) -> Vec<String>| {
                    let mut v = base;
                    if let Some(chs) = c.get("chunks").and_then(Value::as_array) {
                        for ch in chs {
                            v.extend(per(ch).into_iter().map(|w| format!("chunk {}: {w}", ch["k"].as_u64().unwrap() + 1)));
                        }
                    }
                    v
                };
                let ch_args = |ch: &Value| {
                    (ch["src"].as_str().unwrap().to_string(), ch["out"].as_str().unwrap().to_string(), ch["stop"] == "limit", ch["tokens"].as_u64().unwrap_or(0))
                };
                let b = chunked(detect_b(src, out, limit, tokens, k), &|ch| {
                    let (s, o, l, n) = ch_args(ch);
                    detect_b(&s, &o, l, n, k)
                });
                t.eq("secondary detector b", &at, &json!(b), &f["expected"]["detector_b"][kind]);
                if let Some(want) = f["expected"]["detector_frozen"].get(kind) {
                    let fr = chunked(detect_base(src, out, limit, tokens), &|ch| {
                        let (s, o, l, n) = ch_args(ch);
                        detect_base(&s, &o, l, n)
                    });
                    t.eq("secondary detector base", &at, &json!(fr), want);
                }
                t.eq("secondary script", &at, &json!(check(src, out)), &f["expected"]["script"][kind]);
            }
            if let (Some(acc), Some(d1)) = (f["expected"]["accepted_b"].as_str(), f["expected"]["d1_b"].as_bool()) {
                if let Some(c) = f["candidates"].get(acc).filter(|c| c.get("out").is_some()) {
                    let got = super::complete::suspects(src, c["out"].as_str().unwrap(), k).suspect();
                    t.eq("secondary d1", &at, &json!(got), &json!(d1));
                }
            }
        }
    }

    // the character tables against the reference interpreter's
    let ut: Value = serde_json::from_str(&std::fs::read_to_string(reference.join("unicode-tables.json")).unwrap()).unwrap();
    let sig: Value = serde_json::from_str(&std::fs::read_to_string(oracle.join("sigma.json")).unwrap()).unwrap();
    let ranges = |r: &[(u32, u32)]| json!(r.iter().map(|&(a, b)| json!([a, b])).collect::<Vec<_>>());
    use super::unicode_tables as tb;
    t.eq("tables", "whitespace", &ranges(tb::WHITESPACE), &ut["isspace"]);
    t.eq("tables", "word", &ranges(tb::WORD), &ut["re_w"]);
    t.eq("tables", "letter", &ranges(tb::LETTER), &ut["letter"]);
    t.eq("tables", "lowercase", &ranges(tb::LOWERCASE), &ut["islower"]);
    t.eq("tables", "cased", &ranges(tb::CASED_NOT_IGNORABLE), &sig["cased_not_ignorable"]);
    t.eq("tables", "case-ignorable", &ranges(tb::CASE_IGNORABLE), &sig["case_ignorable"]);
    let lm: BTreeMap<String, Value> = tb::LOWER_MAP.iter().map(|&(c, v)| (c.to_string(), json!(v))).collect();
    t.eq("tables", "lower map", &json!(lm), &ut["lower_map"]);
    // every character's lowercase, one at a time, against the map (the sigma rule aside)
    for cp in (0u32..0x110000).filter(|c| !(0xD800..=0xDFFF).contains(c)) {
        let c = char::from_u32(cp).unwrap();
        if c == '\u{03A3}' {
            continue;
        }
        let want: String = ut["lower_map"].get(cp.to_string()).map_or(c.to_string(), |v| {
            v.as_array().unwrap().iter().map(|x| char::from_u32(x.as_u64().unwrap() as u32).unwrap()).collect()
        });
        if lower(&c.to_string()) != want {
            t.bad.push(format!("lower U+{cp:04X}"));
        }
    }

    // similarity: every pair the near-duplicate check compares in the recorded outputs, as one digest
    let dl: Value = serde_json::from_str(&std::fs::read_to_string(reference.join("difflib.json")).unwrap()).unwrap();
    let mut h = Sha256::new();
    let mut pairs = 0u64;
    for name in ["locked-A.jsonl", "locked-B.jsonl", "confirm-A.jsonl", "confirm-B.jsonl"] {
        for f in lines(&fixtures.join(name)) {
            let key = f["key"].as_str().unwrap().to_string();
            let mut texts = vec![("src".to_string(), en_sents(f["src"].as_str().unwrap()))];
            for (kind, c) in f["candidates"].as_object().unwrap() {
                if let Some(o) = c.get("out").and_then(Value::as_str) {
                    texts.push((kind.clone(), ar_sents(o)));
                }
            }
            for (label, sents) in texts {
                let ss: Vec<Vec<char>> = sents.iter().map(|s| norm(s)).filter(|s| s.chars().filter(|&c| c != ' ').count() >= 20).map(|s| chars(&s)).collect();
                for i in 1..ss.len() {
                    for j in 0..i {
                        h.update(format!("{name}|{key}|{label}|{i}|{j}|{}\n", py_repr(similarity(&ss[i], &ss[j]))).as_bytes());
                        pairs += 1;
                    }
                }
            }
        }
    }
    t.eq("similarity digest", "pairs", &json!(pairs), &dl["recorded_pairs"]);
    t.eq("similarity digest", "sha256", &json!(format!("{:x}", h.finalize())), &dl["recorded_digest_sha256"]);
    // The synthetic pairs: compared by their matching blocks (integers). Their ratios have up to 17 significant
    // digits, which a JSON number does not always read back exactly; the ratios are compared exactly, as text, by the
    // digest above and by the in-tree test on the same pairs.
    for p in dl["synthetic"].as_array().unwrap() {
        let (a, b) = (chars(p["a"].as_str().unwrap()), chars(p["b"].as_str().unwrap()));
        let blocks: Vec<Value> = super::text::matching_blocks(&a, &b).iter().map(|&(i, j, k)| json!([i, j, k])).collect();
        t.eq("similarity synthetic blocks", p["a"].as_str().unwrap(), &json!(blocks), &p["blocks"]);
    }

    for (level, n) in &t.checked {
        eprintln!("{level:<34} {n:>8}");
    }
    eprintln!("mismatches: {}", t.bad.len());
    for b in t.bad.iter().take(40) {
        eprintln!("MISMATCH {b}");
    }
    assert!(t.bad.is_empty(), "{} mismatches", t.bad.len());
}

fn paragraph_values(t: &mut Tally, at: &str, src: &str, sents: &[String], v: &Value) {
    t.eq("F paragraph words/cap", at, &json!([words(src), cap(words(src))]), &json!([v["words"], v["cap"]]));
    t.eq("F en_sents", at, &json!(en_sents(src)), &v["en_sents_detect"]);
    t.eq("F d1 sentences", at, &json!(d1_sents(src)), &v["en_sents_d1"]);
    t.eq("F letters", at, &json!(letters(src)), &v["letters"]);
    t.eq("F near_dupes (source)", at, &json!(near_dupes(&en_sents(src))), &v["near_dupes"]);
    t.eq("F runs_b (source)", at, &json!(runs_b(src)), &v["runs_b"]);
    t.eq("F lower tokens", at, &json!(split_ws(src).iter().map(|x| lower(&norm(x))).collect::<Vec<_>>()), &v["norm_tokens_lower"]);
    t.eq("F fix_abbrev", at, &json!(fix_abbrev(sents)), &v["fix_abbrev"]);
    for (field, got) in [
        ("sentence_units", planned(sentence_units(src, sents))),
        ("quote_units", planned(quote_units(src, sents))),
        ("recovery_spans", spans_json(recovery_spans(src, sents))),
        ("splittable", planned(splittable(src, sents))),
    ] {
        *t.checked.entry("F planners").or_default() += 1;
        if !same_raise(&got, &v[field]) {
            t.bad.push(format!("F planners {at} {field}: got {} want {}", short(&got), short(&v[field])));
        }
    }
}

fn candidate_values(t: &mut Tally, at: &str, src: &str, c: &Value, k: f64, v: &Value) {
    let out = c["out"].as_str().unwrap();
    let limit = c["stop"] == "limit";
    let tokens = c["tokens"].as_u64().unwrap_or(0);
    t.eq("F features (base)", at, &features_json(&super::detect::features_base(src, out, limit, tokens)), &v["features_frozen"]);
    t.eq("F features (b)", at, &features_json(&features_b(src, out, limit, tokens)), &v["features_b"]);
    t.eq("F detector (base)", at, &json!(detect_base(src, out, limit, tokens)), &v["detect_frozen"]);
    t.eq("F detector (b)", at, &json!(detect_b(src, out, limit, tokens, k)), &v["detect_b"]);
    let d = detect(src, out, limit, tokens, k);
    t.eq("F detector", at, &json!(d), &v["detect_g1"]);
    t.eq("F repetition class", at, &json!(d.iter().map(|w| is_repetition(w)).collect::<Vec<_>>()), &v["repetition_class"]);
    t.eq("F script", at, &json!(check(src, out)), &v["lang"]);
    t.eq("F d1", at, &d1_json(src, out, k, true), &v["d1"]);
    t.eq("F ar_sents", at, &json!(ar_sents(out)), &v["ar_sents"]);
    t.eq("F ar_segs", at, &json!(ar_segs(out)), &v["ar_segs"]);
    t.eq("F letters (output)", at, &json!(letters(out)), &v["letters"]);
    t.eq("F near_dupes", at, &json!(near_dupes(&ar_sents(out))), &v["near_dupes"]);
    t.eq("F runs_b", at, &json!(runs_b(out)), &v["runs_b"]);
    let (lr, lh) = latin_run(out);
    t.eq("F latin_run", at, &json!([lr, lh]), &v["latin_run"]);
    t.eq("F norm tokens", at, &json!(split_ws(out).iter().map(|x| norm(x)).collect::<Vec<_>>()), &v["norm_tokens"]);
    if let (Some(chs), Some(vchs)) = (c.get("chunks").and_then(Value::as_array), v.get("chunks").and_then(Value::as_array)) {
        for (ch, vc) in chs.iter().zip(vchs) {
            let (s, o) = (ch["src"].as_str().unwrap(), ch["out"].as_str().unwrap());
            let (l, n) = (ch["stop"] == "limit", ch["tokens"].as_u64().unwrap_or(0));
            let at = format!("{at}:chunk{}", ch["k"]);
            t.eq("F chunk detector", &at, &json!(detect(s, o, l, n, k)), &vc["detect_g1"]);
            t.eq("F chunk detector (b)", &at, &json!(detect_b(s, o, l, n, k)), &vc["detect_b"]);
            t.eq("F chunk detector (base)", &at, &json!(detect_base(s, o, l, n)), &vc["detect_frozen"]);
            t.eq("F chunk features (b)", &at, &features_json(&features_b(s, o, l, n)), &vc["features_b"]);
        }
    }
}

/// The requests the pipeline's own code makes for one candidate.
fn plan_of(p: &Paragraph, k: f64, kind: Kind, chunk_outs: Option<Vec<String>>) -> Vec<Request> {
    let mut seen = Vec::new();
    let mut pl = Planner { chunk_outs, seen: &mut seen };
    super::decide::produce(&mut pl, &Profile { k }, p, kind).expect("the plan is made without error");
    seen
}

fn request_plan(t: &mut Tally, at: &str, model: &str, src: &str, sents: &[String], cands: &Value, rv: &Value) {
    let p = Paragraph { text: src.to_string(), sentences: sents.to_vec() };
    let k = if model == "A" { 1.0 } else { 0.932 };
    // fast and damped: the whole paragraph, the paragraph's budget
    for (kind, rec) in [(Kind::Fast, &rv["fast"]), (Kind::Damped, &rv["A1"])] {
        let plan = plan_of(&p, k, kind, None);
        let (lim, damped, text, tail) = body_parts(model, &rec[0]["body"]);
        let at = format!("{at}:{}", kind.name());
        t.eq("R requests", &at, &json!(plan.len()), &json!(rec.as_array().unwrap().len()));
        t.eq("R limit", &at, &json!(lim), &json!(plan[0].limit));
        t.ok("R sampler", &at, damped == (plan[0].sampling == Sampling::Damped), "sampler differs");
        t.ok("R text", &at, text == plan[0].text && tail.is_empty() && plan[0].prefill.is_none(), "text differs");
    }
    // chunks: the pipeline's own plan, answered with the outputs the recorder answered with
    if let Ok(true) = splittable(src, sents) {
        let recorded = cands.get("B").and_then(|b| b.get("chunks")).and_then(Value::as_array);
        let outs = recorded.map(|chs| chs.iter().map(|c| c["out"].as_str().unwrap().to_string()).collect::<Vec<_>>());
        let plan = plan_of(&p, k, Kind::Chunked, outs);
        let bodies: Vec<&Value> = rv["B"]["requests"].as_array().unwrap().iter().filter(|r| r["path"] == "/completion").map(|r| &r["body"]).collect();
        t.eq("R chunk count", at, &json!(plan.len()), &json!(bodies.len()));
        for (r, body) in plan.iter().zip(bodies) {
            let (lim, damped, text, tail) = body_parts(model, body);
            let at = format!("{at}:B{}", r.index);
            t.eq("R chunk limit", &at, &json!(lim), &json!(r.limit));
            t.ok("R chunk sampler", &at, !damped, "a chunk is greedy");
            t.ok("R chunk text", &at, text == r.text, "chunk text differs");
            let want_tail = match &r.prefill {
                Some(pf) if !pf.is_empty() => if model == "A" { format!(" {}", strip(pf)) } else { strip(pf).to_string() },
                _ => String::new(),
            };
            t.ok("R chunk continuation", &at, tail == want_tail, "the continued output differs");
        }
    }
    // units: one request each, with its own budget, from the pipeline's own per-unit path
    if let Ok(units) = quote_units(src, sents) {
        if units.len() >= 2 {
            let plan = plan_of(&p, k, Kind::Sentences, None);
            let bodies: Vec<&Value> = rv["S"]["requests"].as_array().unwrap().iter().map(|r| &r["body"]).collect();
            t.eq("R unit count", at, &json!(plan.len()), &json!(bodies.len()));
            for (r, body) in plan.iter().zip(bodies) {
                let (lim, damped, text, tail) = body_parts(model, body);
                let at = format!("{at}:S{}", r.index);
                t.eq("R unit limit", &at, &json!(lim), &json!(r.limit));
                t.ok("R unit", &at, !damped && text == r.text && tail.is_empty() && r.prefill.is_none(), "unit request differs");
            }
        }
    }
}
