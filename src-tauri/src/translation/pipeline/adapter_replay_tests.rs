//! The adapters against the evaluation's recordings, through a fake engine. Like `replay_tests`, this needs the
//! private recordings and runs only when pointed at them:
//!
//! ```text
//! SARD_TRANSLATION_REPLAY_FIXTURES=<fixture dir> SARD_TRANSLATION_REPLAY_REFERENCE=<reference dir> \
//! cargo test --lib -- --ignored --exact <test> --nocapture
//! ```
//!
//! * `every_recorded_request_body_is_sent_exactly`: for every recorded paragraph and every candidate the pipeline can
//!   request, the bodies the adapters send equal the bodies the evaluated client sent, one by one and in order.
//! * `every_recorded_paragraph_is_decided_through_the_adapters`: the whole pipeline, through the adapters and an
//!   engine that answers with the recorded outputs, reaches every recorded decision and final text. (The paragraphs
//!   whose decision used the per-sentence retry are left out: its units were recorded joined.)
//!
//! A fake engine shows the exchange is the evaluated one. It does not show a real engine answers as it did.

use super::adapter_tests::{kind_of, model_of, routed, scripted_with, seen_json, source, Case};
use super::decide::produce;
use super::pipeline_tests::{decision_json, judged, lines, strs};
use super::{translate, Candidate, Kind, Paragraph};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const PRIMARY: [&str; 4] = ["locked-A.jsonl", "locked-B.jsonl", "confirm-A.jsonl", "confirm-B.jsonl"];

fn dir(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| panic!("{var} is not set — this test needs the private recordings")))
}

fn verify_manifest(d: &Path) {
    let m: Value = serde_json::from_str(&std::fs::read_to_string(d.join("manifest.json")).unwrap()).unwrap();
    for (name, info) in m["outputs"].as_object().unwrap() {
        let got = format!("{:x}", Sha256::digest(std::fs::read(d.join(name)).unwrap()));
        assert_eq!(got, info["sha256"].as_str().unwrap(), "{name} differs from its manifest");
    }
}

#[test]
#[ignore = "needs the private recordings (see the module documentation)"]
fn every_recorded_request_body_is_sent_exactly() {
    let fixtures = dir("SARD_TRANSLATION_REPLAY_FIXTURES");
    let reference = dir("SARD_TRANSLATION_REPLAY_REFERENCE");
    verify_manifest(&fixtures);
    verify_manifest(&reference);
    let queue = Arc::new(Mutex::new(VecDeque::new()));
    let engine = scripted_with(queue.clone(), 1, 1);
    let (mut sets, mut bodies, mut bad) = (0usize, 0usize, Vec::new());
    for name in PRIMARY {
        for (f, rq) in lines(&fixtures.join(name)).iter().zip(lines(&reference.join(format!("requests-{name}")))) {
            let key = f["key"].as_str().unwrap();
            assert_eq!(rq["key"].as_str(), Some(key));
            let model = model_of(f["model"].as_str().unwrap());
            let p = Paragraph { text: f["src"].as_str().unwrap().to_string(), sentences: strs(&f["sents"]) };
            for kind in ["fast", "A1", "B", "S"] {
                let want: Value = match kind {
                    "fast" | "A1" => rq[kind].clone(),
                    _ => rq[kind]["requests"].clone(),
                };
                // The recorder answered chunks with the recorded chunk outputs where they exist, otherwise with a stub.
                let mut q = queue.lock().unwrap();
                q.clear();
                if kind == "B" {
                    if let Some(chs) = f["candidates"]["B"].get("chunks").and_then(Value::as_array) {
                        q.extend(chs.iter().map(|c| c["out"].as_str().unwrap().to_string()));
                    }
                }
                drop(q);
                engine.seen.lock().unwrap().clear();
                let got = produce(&mut source(&engine, model), &model.profile(), &p, kind_of(kind));
                if let Err(e) = got {
                    bad.push(format!("{name}:{key}:{kind}: {e:?}"));
                    continue;
                }
                let seen = seen_json(&engine.seen());
                sets += 1;
                bodies += want.as_array().map_or(0, Vec::len);
                if seen != want {
                    bad.push(format!("{name}:{key}:{kind}: {} bodies sent, {} recorded, first difference at {:?}",
                        seen.as_array().unwrap().len(), want.as_array().map_or(0, Vec::len),
                        seen.as_array().unwrap().iter().zip(want.as_array().unwrap()).position(|(a, b)| a != b)));
                }
            }
        }
    }
    eprintln!("request sets {sets}, recorded bodies {bodies}, mismatches {}", bad.len());
    for b in bad.iter().take(20) {
        eprintln!("MISMATCH {b}");
    }
    assert!(bad.is_empty());
    assert_eq!(sets, 4 * 5522, "every paragraph's four candidates are compared");
    assert!(bodies > 0);
}

#[test]
#[ignore = "needs the private recordings (see the module documentation)"]
fn every_recorded_paragraph_is_decided_through_the_adapters() {
    let fixtures = dir("SARD_TRANSLATION_REPLAY_FIXTURES");
    verify_manifest(&fixtures);
    let state = Arc::new(Mutex::new(Case::default()));
    let engine = routed(state.clone());
    let (mut checked, mut skipped, mut requests, mut bad) = (0usize, 0usize, 0usize, Vec::new());
    for name in PRIMARY {
        for f in lines(&fixtures.join(name)) {
            let key = f["key"].as_str().unwrap();
            let expected = &f["expected"];
            if strs(&expected["decision"]["steps"]).iter().any(|s| s == "S") {
                skipped += 1;
                continue;
            }
            let model = model_of(f["model"].as_str().unwrap());
            let src = f["src"].as_str().unwrap().to_string();
            *state.lock().unwrap() = Case::new(src.clone(), f["candidates"].clone());
            engine.seen.lock().unwrap().clear();
            let p = Paragraph { text: src, sentences: strs(&f["sents"]) };
            let o = match translate(&mut source(&engine, model), &model.profile(), &p) {
                Ok(o) => o,
                Err(e) => {
                    bad.push(format!("{name}:{key}: {e:?}"));
                    continue;
                }
            };
            requests += engine.seen().len();
            let mut want = expected["decision"].clone();
            if !expected["why_review_in_record"].as_bool().unwrap() {
                if let Some(o) = want.as_object_mut() {
                    o.remove("why_review");
                }
            }
            let mut got = decision_json(&o);
            if !expected["why_review_in_record"].as_bool().unwrap() {
                got.as_object_mut().unwrap().remove("why_review");
            }
            let (flags, _) = judged(&o);
            let flags_ok = flags.iter().all(|(k, v)| &expected["flags"][k] == &json!(v));
            let chunks_ok = o.candidates.get(&Kind::Chunked).is_none_or(|c| match c {
                Candidate::Produced(p) => json!([p.out, p.tokens, p.stop]) == json!([f["candidates"]["B"]["out"], f["candidates"]["B"]["tokens"], f["candidates"]["B"]["stop"]]),
                Candidate::Skipped(s) => f["candidates"]["B"]["skipped"] == json!(s.reason()),
            });
            let problems = std::mem::take(&mut state.lock().unwrap().problems);
            if !problems.is_empty() {
                bad.push(format!("{name}:{key}: {problems:?}"));
            }
            if got != want || json!(o.text) != expected["final_text"] || !flags_ok || !chunks_ok {
                bad.push(format!("{name}:{key}: decision {} want {}, text ok {}, flags ok {flags_ok}, chunks ok {chunks_ok}",
                    got, want, json!(o.text) == expected["final_text"]));
            }
            checked += 1;
        }
    }
    eprintln!("paragraphs {checked} (left out, per-sentence retry: {skipped}), requests {requests}, mismatches {}", bad.len());
    for b in bad.iter().take(20) {
        eprintln!("MISMATCH {b}");
    }
    assert!(bad.is_empty());
    assert_eq!(checked + skipped, 5522);
}
