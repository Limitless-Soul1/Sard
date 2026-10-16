//! The pipeline against the values of the evaluated implementation, on synthetic inputs only.
//!
//! Every input in `tests/fixtures/translation-pipeline/` was written for these tests; every expected value in it was
//! computed by the evaluated implementation. Nothing here comes from a book.

use super::chunk::{fix_abbrev, quote_units, recovery_spans, sentence_units, split_long_sentence, splittable};
use super::complete::{align, ar_segs, en_sents as d1_sents, letters, suspects};
use super::decide::{cap, is_repetition};
use super::detect::{
    ar_sents, detect, detect_b, detect_base, en_sents, features_base, features_b, latin_run, near_dupes, runs_b, Features,
};
use super::script::check;
use super::text::{fixed, lower, matching_blocks, norm, percent0, round3, similarity, split_ws, words};
use super::{
    translate, Candidate, InputError, Kind, Outcome, Paragraph, PipelineError, Profile, Raw, Request, Source, Status,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("translation-pipeline")
}

pub(super) fn lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("a JSON line"))
        .collect()
}

pub(super) fn strs(v: &Value) -> Vec<String> {
    v.as_array().expect("an array").iter().map(|x| x.as_str().expect("a string").to_string()).collect()
}

pub(super) fn features_json(f: &Features) -> Value {
    json!({
        "src_words": f.src_words, "out_words": f.out_words, "src_letters": f.src_letters, "out_letters": f.out_letters,
        "r_char": f.r_char, "en_sents": f.en_sents, "ar_sents": f.ar_sents, "word_run": f.word_run,
        "src_word_run": f.src_word_run, "top_word": f.top_word, "top_share": f.top_share, "rep8": f.rep8,
        "src_rep8": f.src_rep8, "dup_sents": f.dup_sents, "char_run": f.char_run, "src_char_run": f.src_char_run,
        "harakat_share": f.harakat_share, "latin_run": f.latin_run, "latin_en_stop": f.latin_en_stop, "limit": f.limit,
        "tokens": f.tokens, "src_terminal": f.src_terminal, "out_terminal": f.out_terminal, "src_q": f.src_q, "out_q": f.out_q,
    })
}

pub(super) fn d1_json(src: &str, out: &str, k: f64, with_beads: bool) -> Value {
    let v = suspects(src, out, k);
    let (un, beads) = align(src, out, 0.82 * k);
    let mut j = json!({
        "suspect": v.suspect(),
        "sentences": v.sentences.iter().cloned().collect::<Vec<_>>(),
        "why": v.why,
        "unmatched": un.iter().map(|(s, w)| json!([s, w])).collect::<Vec<_>>(),
    });
    if with_beads {
        j["beads"] = beads
            .iter()
            .map(|b| json!({"en": b.en, "ar": b.ar, "l1": b.l1, "l2": b.l2, "deficit": b.deficit, "words": b.words}))
            .collect::<Vec<_>>()
            .into();
    }
    j
}

/// A planner result as the evaluation records it: the value, or the exception the evaluated code raised.
pub(super) fn planned<T: Into<Value>>(r: Result<T, InputError>) -> Value {
    match r {
        Ok(v) => json!({ "value": v.into() }),
        Err(InputError::Unlocatable { .. }) => json!({ "raises": "ValueError" }),
        Err(InputError::EmptySentence { .. }) => json!({ "raises": "IndexError" }),
    }
}

pub(super) fn same_raise(got: &Value, want: &Value) -> bool {
    match (got.get("raises"), want.get("raises")) {
        (Some(g), Some(w)) => g == w,
        (None, None) => got == want,
        _ => false,
    }
}

pub(super) fn spans_json(r: Result<(Vec<(usize, usize)>, bool), InputError>) -> Value {
    planned(r.map(|(s, ok)| json!([s.iter().map(|&(a, b)| json!([a, b])).collect::<Vec<_>>(), ok])))
}

/// Answers from a fixture's candidates; a candidate it does not hold is answered with an empty output, as the
/// evaluated runs answered it (and listed in `missing`).
pub(super) struct Served<'a> {
    pub candidates: &'a Value,
    pub src: Vec<char>,
    pub missing: Vec<String>,
    pub problems: Vec<String>,
}

fn raw_of(v: &Value) -> Raw {
    Raw {
        out: v["out"].as_str().expect("out").to_string(),
        tokens: v["tokens"].as_u64(),
        stop: v["stop"].as_str().expect("stop").to_string(),
    }
}

fn empty_raw() -> Raw {
    Raw { out: String::new(), tokens: Some(0), stop: "eos".to_string() }
}

impl Source for Served<'_> {
    type Error = std::convert::Infallible;
    fn answer(&mut self, r: &Request) -> Result<Raw, Self::Error> {
        let name = r.kind.name();
        let c = &self.candidates[name];
        if c.is_null() || c.get("skipped").is_some() {
            self.missing.push(name.to_string());
            return Ok(empty_raw());
        }
        match r.kind {
            Kind::Chunked => {
                let chunks = c["chunks"].as_array().expect("chunks");
                let spans = c["spans"].as_array().expect("spans");
                let Some(ch) = chunks.get(r.index) else {
                    self.problems.push(format!("chunk {} beyond the recording", r.index));
                    return Ok(empty_raw());
                };
                let at = |k: usize, e: usize| spans[k][e].as_u64().expect("a span bound") as usize;
                let want = if r.index == 0 {
                    self.src[at(0, 0)..at(0, 1)].iter().collect::<String>()
                } else {
                    self.src[at(r.index - 1, 0)..at(r.index, 1)].iter().collect::<String>()
                };
                let want_pre = (r.index > 0).then(|| chunks[r.index - 1]["out"].as_str().expect("out").to_string());
                if r.text != want || r.prefill != want_pre {
                    self.problems.push(format!("chunk {} request differs from the recording", r.index));
                }
                Ok(raw_of(ch))
            }
            Kind::Sentences => {
                self.problems.push("a unit was requested one by one".to_string());
                Ok(empty_raw())
            }
            _ => Ok(raw_of(c)),
        }
    }
    fn joined_units(&mut self, units: &[String], _limits: &[u32]) -> Option<Result<Raw, Self::Error>> {
        let c = &self.candidates["S"];
        if c.is_null() || c.get("skipped").is_some() {
            self.missing.push("S".to_string());
            return Some(Ok(empty_raw()));
        }
        if let Some(n) = c.get("units").and_then(Value::as_u64) {
            if n as usize != units.len() {
                self.problems.push(format!("{} units planned, {} recorded", units.len(), n));
            }
        }
        Some(Ok(raw_of(c)))
    }
}

pub(super) fn decision_json(o: &Outcome) -> Value {
    let mut d = json!({
        "steps": o.steps.iter().map(|s| s.name()).collect::<Vec<_>>(),
        "final": o.final_kind.map_or("FAILED", |k| k.name()),
        "status": o.status.name(),
    });
    if let Some(x) = o.d1 {
        d["d1"] = x.into();
    }
    if let Some(w) = o.why_review {
        d["why_review"] = w.text().into();
    }
    d
}

pub(super) fn judged(o: &Outcome) -> (BTreeMap<String, Vec<String>>, BTreeMap<String, Vec<String>>) {
    let (mut flags, mut script) = (BTreeMap::new(), BTreeMap::new());
    for (k, c) in &o.candidates {
        if let Candidate::Produced(p) = c {
            flags.insert(k.name().to_string(), p.flags.clone());
            script.insert(k.name().to_string(), p.script.clone());
        }
    }
    (flags, script)
}

/// The candidates the pipeline produced must be judged exactly as the evaluated run judged them. The evaluated runs
/// also produced candidates for the earlier pipeline they were compared with; those are not part of this pipeline,
/// so they may be missing here — but only if this pipeline's decision never used them.
pub(super) fn compare_judgements(id: &str, o: &Outcome, flags: &Value, script: &Value, decision: &Value, bad: &mut Vec<String>) {
    let (got_flags, got_script) = judged(o);
    for (kind, f) in &got_flags {
        if &flags[kind] != &json!(f) || &script[kind] != &json!(got_script[kind]) {
            bad.push(format!("{id}: {kind} judged {} / {}, evaluated {} / {}", json!(f), json!(got_script[kind]), flags[kind], script[kind]));
        }
    }
    let used: Vec<String> = strs(&decision["steps"]).into_iter().map(|s| s.trim_start_matches("2:").to_string()).collect();
    for kind in flags.as_object().expect("flags").keys() {
        if !got_flags.contains_key(kind) && (used.contains(kind) || kind == "fast") {
            bad.push(format!("{id}: {kind} was used by the evaluated decision but not produced"));
        }
    }
}

fn k_of(model: &str) -> f64 {
    if model == "A" {
        1.0
    } else {
        0.932
    }
}

fn report(what: &str, checked: usize, bad: &[String]) {
    for b in bad.iter().take(25) {
        eprintln!("MISMATCH {what}: {b}");
    }
    assert!(bad.is_empty(), "{what}: {} mismatches of {checked}", bad.len());
    assert!(checked > 0, "{what}: nothing was checked");
}

#[test]
fn every_check_function_matches_the_evaluated_values() {
    let cases = lines(&fixture_dir().join("functions.jsonl"));
    let mut bad = Vec::new();
    let mut checked = 0;
    for c in &cases {
        let id = c["id"].to_string();
        let src = c["src"].as_str().unwrap();
        let out = c["out"].as_str().unwrap();
        let limit = c["stop"] == "limit";
        let tokens = c["tokens"].as_u64().unwrap_or(0);
        let common = &c["common"];
        let mut eq = |field: &str, got: Value, want: &Value| {
            checked += 1;
            if &got != want {
                bad.push(format!("case {id} {field}: got {got} want {want}"));
            }
        };
        eq("features_b", features_json(&features_b(src, out, limit, tokens)), &common["features_b"]);
        let fb = features_base(src, out, limit, tokens);
        eq("base_char_run", json!([fb.char_run, fb.src_char_run]), &common["base_char_run"]);
        eq("detect_base", json!(detect_base(src, out, limit, tokens)), &common["detect_base"]);
        eq("script", json!(check(src, out)), &common["script"]);
        eq("ar_sents", json!(ar_sents(out)), &common["ar_sents"]);
        eq("ar_segs", json!(ar_segs(out)), &common["ar_segs"]);
        eq("letters", json!(letters(out)), &common["letters"]);
        eq("near_dupes", json!(near_dupes(&ar_sents(out))), &common["near_dupes"]);
        eq("runs_b", json!(runs_b(out)), &common["runs_b"]);
        let (lr, lh) = latin_run(out);
        eq("latin_run", json!([lr, lh]), &common["latin_run"]);
        eq("norm_tokens", json!(split_ws(out).iter().map(|t| norm(t)).collect::<Vec<_>>()), &common["norm_tokens"]);
        for (kk, v) in c["by_k"].as_object().unwrap() {
            let k: f64 = kk.parse().unwrap();
            eq(&format!("detect_b@{kk}"), json!(detect_b(src, out, limit, tokens, k)), &v["detect_b"]);
            let d = detect(src, out, limit, tokens, k);
            eq(&format!("detect@{kk}"), json!(d), &v["detect"]);
            eq(&format!("repetition@{kk}"), json!(d.iter().map(|w| is_repetition(w)).collect::<Vec<_>>()), &v["repetition_class"]);
            eq(&format!("d1@{kk}"), d1_json(src, out, k, false), &v["d1"]);
        }
    }
    report("check functions", checked, &bad);
}

#[test]
fn the_planners_match_the_evaluated_values() {
    let cases = lines(&fixture_dir().join("planner.jsonl"));
    let mut bad = Vec::new();
    let mut checked = 0;
    for c in &cases {
        let id = c["id"].to_string();
        let src = c["src"].as_str().unwrap();
        let sents = strs(&c["sents"]);
        let v = &c["values"];
        let mut eq = |field: &str, got: Value, want: &Value| {
            checked += 1;
            if &got != want {
                bad.push(format!("case {id} {field}: got {got} want {want}"));
            }
        };
        eq("words", json!(words(src)), &v["words"]);
        eq("cap", json!(cap(words(src))), &v["cap"]);
        eq("en_sents_detect", json!(en_sents(src)), &v["en_sents_detect"]);
        eq("en_sents_d1", json!(d1_sents(src)), &v["en_sents_d1"]);
        eq("letters", json!(letters(src)), &v["letters"]);
        eq("near_dupes", json!(near_dupes(&en_sents(src))), &v["near_dupes"]);
        eq("runs_b", json!(runs_b(src)), &v["runs_b"]);
        eq("norm_tokens_lower", json!(split_ws(src).iter().map(|t| lower(&norm(t))).collect::<Vec<_>>()), &v["norm_tokens_lower"]);
        eq("fix_abbrev", json!(fix_abbrev(&sents)), &v["fix_abbrev"]);
        eq("split_long_sentence", json!(split_long_sentence(src, 150)), &v["split_long_sentence"]);
        eq("ar_sents", json!(ar_sents(src)), &v["ar_sents"]);
        eq("ar_segs", json!(ar_segs(src)), &v["ar_segs"]);
        for (field, got) in [
            ("sentence_units", planned(sentence_units(src, &sents))),
            ("quote_units", planned(quote_units(src, &sents))),
            ("recovery_spans", spans_json(recovery_spans(src, &sents))),
            ("splittable", planned(splittable(src, &sents))),
        ] {
            checked += 1;
            if !same_raise(&got, &v[field]) {
                bad.push(format!("case {id} {field}: got {got} want {}", v[field]));
            }
        }
    }
    report("planners", checked, &bad);
}

#[test]
fn every_synthetic_decision_matches_the_evaluated_one() {
    let cases = lines(&fixture_dir().join("decisions.jsonl"));
    let mut bad = Vec::new();
    for c in &cases {
        let id = c["id"].as_str().unwrap();
        let src = c["src"].as_str().unwrap().to_string();
        let p = Paragraph { text: src.clone(), sentences: strs(&c["sents"]) };
        let mut s = Served { candidates: &c["candidates"], src: src.chars().collect(), missing: Vec::new(), problems: Vec::new() };
        let o = match translate(&mut s, &Profile { k: k_of(c["model"].as_str().unwrap()) }, &p) {
            Ok(o) => o,
            Err(PipelineError::Input(e)) => {
                bad.push(format!("{id}: input error {e}"));
                continue;
            }
            Err(PipelineError::Source { error, .. }) => match error {},
        };
        let f = &c["frozen"];
        if decision_json(&o) != f["decision"] {
            bad.push(format!("{id}: decision {} want {}", decision_json(&o), f["decision"]));
        }
        if o.text.as_deref() != f["final_text"].as_str() {
            bad.push(format!("{id}: final text differs"));
        }
        compare_judgements(id, &o, &f["flags"], &f["script"], &f["decision"], &mut bad);
        if !s.problems.is_empty() {
            bad.push(format!("{id}: {:?}", s.problems));
        }
    }
    report("synthetic decisions", cases.len(), &bad);
}

#[test]
fn the_four_branches_the_recordings_never_reach_are_decided_as_evaluated() {
    let cases = lines(&fixture_dir().join("decisions.jsonl"));
    let ids: Vec<&str> = cases.iter().filter_map(|c| c["id"].as_str()).filter(|i| i.starts_with("s3-")).collect();
    for want in ["s3-a-A", "s3-a3-B", "s3-a2-A", "s3-b-A", "s3-b-B", "s3-c-A", "s3-c0-A", "s3-c2-A", "s3-d-A", "s3-d0-A", "s3-e-A", "s3-e0-A"] {
        assert!(ids.contains(&want), "{want} is missing from the branch cases");
    }
    // The branch cases run through the same comparison as every other decision case.
    let statuses: BTreeMap<&str, &str> = cases
        .iter()
        .filter(|c| c["id"].as_str().is_some_and(|i| i.starts_with("s3-")))
        .map(|c| (c["id"].as_str().unwrap(), c["frozen"]["decision"]["status"].as_str().unwrap()))
        .collect();
    assert_eq!(statuses["s3-a-A"], "SECOND");
    assert_eq!(statuses["s3-b-A"], "REVIEW");
    assert_eq!(statuses["s3-c-A"], "SECOND");
    assert_eq!(statuses["s3-d-A"], "REVIEW");
    assert_eq!(statuses["s3-d0-A"], "SECOND");
    assert_eq!(statuses["s3-e-A"], "REVIEW");
    assert_eq!(statuses["s3-e0-A"], "SECOND");
}

/// Why "ends mid-sentence" needs no separate list of allowed endings: every terminator and every allowed opening
/// mark is a non-letter, so the letter test already excludes them all. (A change that drops either list therefore
/// cannot change any result — recorded here so that the redundancy is a checked fact, not an assumption.)
#[test]
fn the_allowed_endings_are_never_letters() {
    for c in ['.', '!', '?', '\u{061F}', '\u{2026}', '\u{201D}', '\u{2019}', '"', '\u{00BB}', ')', '\'', '\u{201C}', '\u{00AB}', '\u{2014}', '\u{2013}', '-', ':', ';', ','] {
        assert!(!super::text::is_letter(c), "{c:?} is a letter");
    }
}

/// Python's `repr` of a float, for the values these tests print (no exponent form is needed for them).
pub(super) fn py_repr(x: f64) -> String {
    assert!(x == 0.0 || (1e-4..1e16).contains(&x.abs()), "{x}: outside the fixed-notation range");
    let s = format!("{x}");
    if s.contains('.') || s.contains("inf") || s.contains("NaN") {
        s
    } else {
        format!("{s}.0")
    }
}

#[test]
fn rounding_and_percentages_match_over_every_ratio() {
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(fixture_dir().join("meta.json")).unwrap()).unwrap();
    let r = &meta["rounding"];
    let mut h = Sha256::new();
    let mut n = 0u64;
    for b in 1u64..=1500 {
        for a in 0..=2 * b {
            let x = a as f64 / b as f64;
            let r3 = round3(x);
            h.update(format!("{a}/{b} {} {} {} {}\n", py_repr(r3), fixed(r3, 2), percent0(r3), percent0(x)).as_bytes());
            n += 1;
        }
    }
    assert_eq!(n, r["lines"].as_u64().unwrap());
    assert_eq!(format!("{:x}", h.finalize()), r["sha256"].as_str().unwrap(), "the rounding digest differs");
}

#[test]
fn similarity_matches_on_the_reference_pairs() {
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(fixture_dir().join("meta.json")).unwrap()).unwrap();
    for p in meta["difflib"].as_array().unwrap() {
        let a: Vec<char> = p["a"].as_str().unwrap().chars().collect();
        let b: Vec<char> = p["b"].as_str().unwrap().chars().collect();
        assert_eq!(py_repr(similarity(&a, &b)), p["ratio_repr"].as_str().unwrap(), "{p}");
        let blocks: Vec<Value> = matching_blocks(&a, &b).iter().map(|&(i, j, k)| json!([i, j, k])).collect();
        assert_eq!(json!(blocks), p["blocks"], "{p}");
    }
}

#[test]
fn lowercase_matches_including_final_sigma() {
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(fixture_dir().join("meta.json")).unwrap()).unwrap();
    for (s, want) in meta["lower_checks"].as_object().unwrap() {
        assert_eq!(lower(s), want.as_str().unwrap(), "{s:?}");
    }
}

#[test]
fn a_source_error_is_returned_unchanged_and_is_never_a_status() {
    struct Failing;
    impl Source for Failing {
        type Error = &'static str;
        fn answer(&mut self, _: &Request) -> Result<Raw, Self::Error> {
            Err("engine stopped")
        }
    }
    let p = Paragraph { text: "One two three.".into(), sentences: vec!["One two three.".into()] };
    match translate(&mut Failing, &Profile { k: 1.0 }, &p) {
        Err(PipelineError::Source { kind: Kind::Fast, index: 0, error }) => assert_eq!(error, "engine stopped"),
        other => panic!("expected the source error, got {other:?}"),
    }
}

#[test]
fn an_unplannable_paragraph_is_an_input_error_at_the_planner_not_before() {
    // The first translation is empty, so the chunked retry is needed — and its sentence is not in the paragraph.
    struct Empty;
    impl Source for Empty {
        type Error = std::convert::Infallible;
        fn answer(&mut self, _: &Request) -> Result<Raw, Self::Error> {
            Ok(Raw { out: String::new(), tokens: Some(0), stop: "eos".into() })
        }
    }
    let p = Paragraph { text: "Alpha beta gamma. Delta epsilon.".into(), sentences: vec!["Alpha beta gamma.".into(), "Zeta eta.".into()] };
    match translate(&mut Empty, &Profile { k: 1.0 }, &p) {
        Err(PipelineError::Input(InputError::Unlocatable { .. })) => {}
        other => panic!("expected an input error, got {other:?}"),
    }
    // A paragraph whose first translation passes never reaches a planner, whatever its sentences.
    struct Good;
    impl Source for Good {
        type Error = std::convert::Infallible;
        fn answer(&mut self, _: &Request) -> Result<Raw, Self::Error> {
            Ok(Raw { out: "ألفا بيتا غاما. دلتا إبسلون.".into(), tokens: Some(9), stop: "eos".into() })
        }
    }
    let o = translate(&mut Good, &Profile { k: 1.0 }, &p).expect("no planner is involved");
    assert_eq!(o.status, Status::Ok);
    assert_eq!(o.requests, vec![(Kind::Fast, 0)]);
}
