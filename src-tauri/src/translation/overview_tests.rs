//! The models overview: the store's states as they are on disk, the hardware verdicts passed through from one reading,
//! the wire format the interface reads, and the one thing it may write. The computer is a fixture, so every test runs
//! on every platform; none downloads, hashes, starts an engine or uses the GPU.

use std::fs;

use serde_json::{json, Value};

use super::catalog::{self, ENGINE_WINDOWS_X64, MODEL_A, MODEL_B, RUNTIME_WINDOWS_X64};
use super::hardware::{classify, HardwareError, HardwareReport, Memory};
use super::install_tests::TempDir;
use super::overview::*;
use super::store::Store;

const GIB: u64 = 1024 * 1024 * 1024;

/// Plenty of memory and disk space, and no graphics adapter: the classifier decides on memory alone.
fn roomy(_root: &std::path::Path) -> Result<HardwareReport, HardwareError> {
    Ok(HardwareReport { memory: Some(Memory { total: 32 * GIB, available: 24 * GIB }), disk_free: Some(500 * GIB), adapters: Some(Vec::new()) })
}

fn unsupported(_root: &std::path::Path) -> Result<HardwareReport, HardwareError> {
    Err(HardwareError::Unsupported)
}

/// Everything a model needs on an empty store: the model, the runtime archive and the installed engine, in full.
fn full_need(model: &catalog::Artifact) -> u64 {
    let spec = &ENGINE_WINDOWS_X64;
    model.size + spec.archive.size + spec.files.iter().map(|f| f.size).sum::<u64>() + spec.notices.len() as u64
}

#[test]
fn an_empty_store_has_nothing_and_needs_everything() {
    let tmp = TempDir::new("overview_empty");
    let o = overview(&tmp.0.join("translation"), roomy).unwrap();
    assert_eq!(o.models.iter().map(|m| m.id).collect::<Vec<_>>(), [MODEL_A.id, MODEL_B.id], "the catalog's models, in its order");
    for (m, a) in o.models.iter().zip([&MODEL_A, &MODEL_B]) {
        assert_eq!(m.state, StateView::NotDownloaded, "{}", a.id);
        assert_eq!(m.size, a.size);
        assert_eq!(m.disk_still_needed, full_need(a), "{}", a.id);
    }
    assert_eq!(o.runtime, StateView::NotDownloaded);
    assert_eq!(o.engine, EngineView::NotInstalled);
    assert_eq!(o.hardware_unavailable, None);
}

#[test]
fn each_state_is_reported_as_it_is_on_disk() {
    let tmp = TempDir::new("overview_states");
    let root = tmp.0.join("translation");
    let store = Store::open(&root).unwrap();
    // A: a download stopped part-way. B: a file in place with no record of its verification. The runtime: a record
    // that cannot be read.
    fs::write(store.partial_path(&MODEL_A), vec![0u8; 4096]).unwrap();
    fs::create_dir_all(store.artifact_dir(&MODEL_B)).unwrap();
    fs::write(store.installed_path(&MODEL_B), b"not the model").unwrap();
    fs::create_dir_all(store.artifact_dir(&RUNTIME_WINDOWS_X64)).unwrap();
    fs::write(store.record_path(&RUNTIME_WINDOWS_X64), b"{ not a record").unwrap();
    let o = overview(&root, roomy).unwrap();
    assert_eq!(o.models[0].state, StateView::Interrupted { bytes: 4096 });
    assert_eq!(o.models[1].state, StateView::Unverified);
    assert!(matches!(&o.runtime, StateView::Damaged { reason } if reason.contains("cannot be read")), "{:?}", o.runtime);
    // A partial download is not subtracted from what is still needed (the hardware check errs on the side of more).
    assert_eq!(o.models[0].disk_still_needed, full_need(&MODEL_A));
}

#[test]
fn the_verdicts_are_the_classifiers_with_the_device_list_unknown() {
    let tmp = TempDir::new("overview_fit");
    let o = overview(&tmp.0.join("translation"), roomy).unwrap();
    let report = roomy(&tmp.0).unwrap();
    for (m, a) in o.models.iter().zip([&MODEL_A, &MODEL_B]) {
        let needs = catalog::needs(a).unwrap();
        assert_eq!(m.gpu, Some((&classify(&needs, m.disk_still_needed, &report, None)).into()), "{}", a.id);
        assert_eq!(m.cpu, Some((&classify(&needs, m.disk_still_needed, &report, Some(&[]))).into()), "{}", a.id);
        // The device list is never asked for here (that runs the engine), so the GPU stays undetermined.
        assert!(matches!(m.gpu, Some(FitView::NotDetermined { why: UndeterminedView::DeviceListUnknown, .. })), "{}: {:?}", a.id, m.gpu);
    }
}

#[test]
fn without_a_hardware_reading_the_verdicts_are_absent_and_the_reason_given() {
    let tmp = TempDir::new("overview_nohw");
    let o = overview(&tmp.0.join("translation"), unsupported).unwrap();
    assert!(o.models.iter().all(|m| m.gpu.is_none() && m.cpu.is_none()));
    assert_eq!(o.hardware_unavailable.as_deref(), Some("the hardware check is not available on this platform"));
    assert_eq!(o.models[0].state, StateView::NotDownloaded, "the rest of the overview still answers");
}

#[test]
fn the_wire_format_is_what_the_interface_reads() {
    let tmp = TempDir::new("overview_wire");
    let v: Value = serde_json::to_value(overview(&tmp.0.join("translation"), roomy).unwrap()).unwrap();
    let a = &v["models"][0];
    assert_eq!(a["id"], json!(MODEL_A.id));
    assert_eq!(a["licence"], json!("gemma_terms"));
    assert_eq!(a["licenceMustBeAccepted"], json!(true));
    assert_eq!(v["models"][1]["licence"], json!("apache2"));
    assert_eq!(v["models"][1]["licenceMustBeAccepted"], json!(false));
    assert_eq!(a["state"], json!({ "kind": "not_downloaded" }));
    assert_eq!(a["diskStillNeeded"], json!(full_need(&MODEL_A)));
    assert_eq!(a["gpu"]["kind"], json!("not_determined"));
    assert_eq!(a["gpu"]["why"], json!({ "kind": "device_list_unknown" }));
    assert!(a["gpu"]["cpuOffered"].is_boolean(), "{}", a["gpu"]);
    assert_eq!(v["runtime"], json!({ "kind": "not_downloaded" }));
    assert_eq!(v["engine"], json!({ "kind": "not_installed" }));
    assert_eq!(v["hardwareUnavailable"], Value::Null);
    let interrupted = serde_json::to_value(StateView::Interrupted { bytes: 7 }).unwrap();
    assert_eq!(interrupted, json!({ "kind": "interrupted", "bytes": 7 }));
    let fit = serde_json::to_value(FitView::InsufficientDisk { needed: 2, available: 1 }).unwrap();
    assert_eq!(fit, json!({ "kind": "insufficient_disk", "needed": 2, "available": 1 }));
}

#[test]
fn it_writes_nothing_but_the_stores_empty_folders() {
    let tmp = TempDir::new("overview_writes");
    let root = tmp.0.join("translation");
    overview(&root, roomy).unwrap();
    overview(&root, roomy).unwrap();
    let mut found: Vec<(String, bool)> = Vec::new();
    for e in walk(&tmp.0) {
        found.push((e.strip_prefix(&tmp.0).unwrap().to_string_lossy().replace('\\', "/"), e.is_dir()));
    }
    found.sort();
    let expected: Vec<(String, bool)> = ["translation", "translation/models", "translation/partial", "translation/runtime"].iter().map(|p| (p.to_string(), true)).collect();
    assert_eq!(found, expected, "only the store's own folders, all empty");
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(walk(&p));
        }
        out.push(p);
    }
    out
}
