//! The catalog in use, and the commands' own layer: a development build's test catalog points every download at
//! 127.0.0.1 and nowhere else, never falls back to the built-in catalog, and keeps the built-in licences; the built-in
//! policy never accepts the test server; the commands refuse a test catalog beside real data; and what the interface
//! receives. Every download here goes to the local test server; nothing reaches the internet, starts an engine or
//! uses the GPU.

use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use super::active::{self, test};
use super::catalog::{Licence, MODEL_A, MODEL_B};
use super::download::{check_url, DownloadError, Mode};
use super::download_server_tests::{test_bytes, TestServer};
use super::hardware::{HardwareError, HardwareReport, Memory};
use super::install_tests::{build_zip, entries, sha, small_engine, TempDir, NOTICES};
use super::manage::{self, ActionError, Context, Event};
use super::model_commands::{self, ActionErrorView, EventView};
use super::overview::Root;
use super::slot::serial_for_tests;
use super::store::{State, Store};

const GIB: u64 = 1024 * 1024 * 1024;

fn roomy(_: &Path) -> Result<HardwareReport, HardwareError> {
    Ok(HardwareReport { memory: Some(Memory { total: 32 * GIB, available: 24 * GIB }), disk_free: Some(500 * GIB), adapters: Some(Vec::new()) })
}

/// A test catalog for `model_id`, its model and runtime served by the two local servers.
fn catalog_json(runtime: &TestServer, archive: &[u8], model: &TestServer, data: &[u8], model_id: &str) -> Value {
    let files: Vec<Value> = small_engine().iter().map(|(n, d)| json!({ "name": n, "size": d.len(), "sha256": sha(d) })).collect();
    json!({
        "runtime": { "url": runtime.url("/file"), "file_name": "runtime.zip", "size": archive.len(), "sha256": sha(archive) },
        "engine": { "executable": "llama-server.exe", "files": files, "notices_name": "THIRD-PARTY-NOTICES.txt", "notices": NOTICES },
        "models": [ { "id": model_id, "url": model.url("/file"), "file_name": "model.gguf", "size": data.len(), "sha256": sha(data) } ],
    })
}

fn write(tmp: &TempDir, v: &Value) -> OsString {
    let path = tmp.0.join("catalog.json");
    fs::write(&path, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    path.into_os_string()
}

fn refused(tmp: &TempDir, v: &Value) -> String {
    match test::from_variable(Some(write(tmp, v))) {
        Err(e) => e,
        Ok(_) => panic!("accepted: {v}"),
    }
}

// ═══ WHICH CATALOG ══════════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn without_the_variable_the_built_in_catalog_is_used_under_the_production_policy() {
    for value in [None, Some(OsString::new())] {
        let a = test::from_variable(value).unwrap();
        assert!(!a.test);
        assert_eq!(a.models.iter().map(|m| m.id).collect::<Vec<_>>(), [MODEL_A.id, MODEL_B.id]);
    }
    let built_in = active::builtin();
    for m in &built_in.models {
        assert!(m.sources.iter().all(|s| s.url.starts_with("https://")), "{}", m.id);
    }
    // The production policy never accepts the test server.
    assert!(check_url(&built_in.policy, "http://127.0.0.1:8123/model.gguf").is_err());
}

#[test]
fn a_test_catalog_that_cannot_be_used_is_refused_and_never_replaced_by_the_built_in_one() {
    let tmp = TempDir::new("active_refused");
    let missing = test::from_variable(Some(tmp.0.join("nothing-here.json").into_os_string()));
    assert!(matches!(&missing, Err(e) if e.contains("cannot be read")), "{:?}", missing.err());
    let server = TestServer::start(vec![1, 2, 3]);
    let archive = build_zip(&entries(&small_engine()));
    let good = catalog_json(&server, &archive, &server, b"abc", MODEL_B.id);
    for (what, url) in [
        ("https", "https://huggingface.co/x.gguf"),
        ("localhost", "http://localhost:8123/x.gguf"),
        ("another loopback address", "http://127.0.0.2:8123/x.gguf"),
        ("no port", "http://127.0.0.1/x.gguf"),
        ("user information", "http://127.0.0.1:8123@huggingface.co/x.gguf"),
    ] {
        let mut v = good.clone();
        v["models"][0]["url"] = json!(url);
        assert!(refused(&tmp, &v).contains("127.0.0.1"), "{what}");
        let mut v = good.clone();
        v["runtime"]["url"] = json!(url);
        assert!(refused(&tmp, &v).contains("127.0.0.1"), "runtime, {what}");
    }
    let mut v = good.clone();
    v["models"][0]["id"] = json!("some-other-model");
    assert!(refused(&tmp, &v).contains("not a model"));
    let mut v = good.clone();
    v["models"][0]["licence"] = json!("apache2");
    assert!(refused(&tmp, &v).contains("not valid"), "a test catalog cannot set a licence");
    let mut v = good.clone();
    v["models"][0]["sha256"] = json!("AB".repeat(32));
    assert!(refused(&tmp, &v).contains("checksum"));
    let mut v = good.clone();
    v["engine"]["executable"] = json!("elsewhere.exe");
    assert!(refused(&tmp, &v).contains("executable"));
}

#[test]
fn a_test_catalog_keeps_the_built_in_licence_and_allows_nothing_but_the_local_server() {
    let tmp = TempDir::new("active_licence");
    let server = TestServer::start(vec![1, 2, 3]);
    let archive = build_zip(&entries(&small_engine()));
    let a = test::from_variable(Some(write(&tmp, &catalog_json(&server, &archive, &server, b"abc", MODEL_A.id)))).unwrap();
    assert!(a.test);
    assert_eq!(a.models[0].licence, Licence::GemmaTerms, "model A's terms come with its id");
    assert!(check_url(&a.policy, "https://huggingface.co/x.gguf").is_err(), "the test policy never reaches the internet");
    assert!(check_url(&a.policy, &server.url("/x")).is_ok());
}

#[test]
fn a_fetch_through_a_test_catalog_reaches_only_the_local_server() {
    let _serial = serial_for_tests();
    let tmp = TempDir::new("active_fetch");
    let data = test_bytes(600_000, 7);
    let archive = build_zip(&entries(&small_engine()));
    let model_server = TestServer::start(data.clone());
    let runtime_server = TestServer::start(archive.clone());
    let a = test::from_variable(Some(write(&tmp, &catalog_json(&runtime_server, &archive, &model_server, &data, MODEL_B.id)))).unwrap();
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let conn = crate::db::open_database(&tmp.0.join("sard.db")).unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let db = Mutex::new(conn);
    let ctx = Context { db: &db, store: &store, spec: a.spec, policy: &a.policy, probe: &roomy };
    let model = a.model(MODEL_B.id).unwrap();
    let fetched = manage::fetch(&ctx, model, Mode::Start, &AtomicBool::new(false), &mut |_| {}).unwrap();
    assert!(fetched.runtime_downloaded && fetched.engine_installed && fetched.model_downloaded);
    assert_eq!(store.state(model).unwrap(), State::Installed);
    assert!(runtime_server.stats.lock().unwrap().requests > 0 && model_server.stats.lock().unwrap().requests > 0);
    assert!(model.sources.iter().chain(a.spec.archive.sources).all(|s| s.url.starts_with("http://127.0.0.1:")));
}

/// BY HAND, against `scripts/translation-test-server.mjs`: the catalog it writes is one the backend accepts and installs
/// from, model B is fetched from it, and model A is still refused by its licence gate.
///   SARD_TRANSLATION_TEST_CATALOG=<its catalog.json> cargo test --lib -- --ignored translation::active_tests::the_local_test_server
#[test]
#[ignore = "needs the local test server running"]
fn the_local_test_servers_catalog_installs_model_b_and_keeps_model_a_closed() {
    let _serial = serial_for_tests();
    let a = test::from_variable(std::env::var_os(test::VARIABLE)).unwrap();
    assert!(a.test, "the variable must name the test server's catalog");
    let tmp = TempDir::new("active_server");
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let conn = crate::db::open_database(&tmp.0.join("sard.db")).unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    let db = Mutex::new(conn);
    let ctx = Context { db: &db, store: &store, spec: a.spec, policy: &a.policy, probe: &roomy };
    let b = a.model(MODEL_B.id).unwrap();
    let fetched = manage::fetch(&ctx, b, Mode::Start, &AtomicBool::new(false), &mut |_| {}).unwrap();
    assert!(fetched.runtime_downloaded && fetched.engine_installed && fetched.model_downloaded);
    assert_eq!(store.state(b).unwrap(), State::Installed);
    let a_model = a.model(MODEL_A.id).unwrap();
    assert!(matches!(manage::fetch(&ctx, a_model, Mode::Start, &AtomicBool::new(false), &mut |_| {}), Err(ActionError::LicenceNotAccepted { .. })));
    assert_eq!(store.state(a_model).unwrap(), State::NotDownloaded);
}

// ═══ THE COMMANDS' LAYER ════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn a_test_catalog_is_used_only_beside_moved_data() {
    let tmp = TempDir::new("active_isolated");
    let server = TestServer::start(vec![1, 2, 3]);
    let archive = build_zip(&entries(&small_engine()));
    let path = write(&tmp, &catalog_json(&server, &archive, &server, b"abc", MODEL_B.id));
    let real = Root { dir: Some(tmp.0.join("translation")), isolated: false };
    let moved = Root { dir: Some(tmp.0.join("translation")), isolated: true };
    let e = model_commands::resolve(&real, test::from_variable(Some(path.clone())), MODEL_B.id).err().unwrap();
    assert!(matches!(&e, ActionErrorView::Unavailable { detail } if detail.contains("SARD_DATA_DIR")), "{e:?}");
    assert!(model_commands::resolve(&moved, test::from_variable(Some(path)), MODEL_B.id).is_ok());
    // The built-in catalog needs neither.
    assert!(model_commands::resolve(&real, Ok(active::builtin()), MODEL_B.id).is_ok());
    assert!(matches!(model_commands::resolve(&real, Ok(active::builtin()), "nope"), Err(ActionErrorView::NotAModel { .. })));
}

#[test]
fn one_fetch_per_model_and_a_cancel_reaches_it() {
    let id = "test-running-model";
    let flag = model_commands::begin(id).unwrap();
    assert!(matches!(model_commands::begin(id), Err(ActionErrorView::Running { .. })));
    assert!(model_commands::running().contains(&id.to_string()));
    assert!(model_commands::cancel(id));
    assert!(flag.load(Ordering::SeqCst));
    model_commands::end(id);
    assert!(!model_commands::cancel(id), "nothing runs after it ended");
}

#[test]
fn the_interface_receives_typed_events_and_errors() {
    let progress = EventView::of(MODEL_B.id, "rt", &Event::Progress { artifact: MODEL_B.id, done: 5, total: 10 });
    assert_eq!(serde_json::to_value(progress).unwrap(), json!({ "kind": "progress", "model": MODEL_B.id, "artifact": MODEL_B.id, "runtime": false, "done": 5, "total": 10 }));
    let runtime_step = EventView::of(MODEL_B.id, "rt", &Event::Step { artifact: "rt", step: manage::Step::Installing });
    assert_eq!(serde_json::to_value(runtime_step).unwrap(), json!({ "kind": "step", "model": MODEL_B.id, "artifact": "rt", "runtime": true, "step": "installing" }));
    let cancelled = ActionError::Download { artifact: MODEL_B.id, error: DownloadError::Cancelled { kept_bytes: 42 } };
    let failed = EventView::of(MODEL_B.id, "rt", &Event::Failed { artifact: MODEL_B.id, error: cancelled, state: State::Interrupted { bytes: 42 } });
    let v = serde_json::to_value(failed).unwrap();
    assert_eq!(v["kind"], json!("failed"));
    assert_eq!(v["state"], json!({ "kind": "interrupted", "bytes": 42 }));
    assert_eq!(v["error"]["kind"], json!("download"));
    assert_eq!(v["error"]["cause"], json!({ "kind": "cancelled", "keptBytes": 42 }));
    assert!(v["error"]["detail"].as_str().unwrap().contains("42"), "the technical text, for Details");
    let licence = ActionError::LicenceNotAccepted { model: MODEL_A.id, status: manage::LicenceStatus::Missing { revision: manage::GEMMA_TERMS_REVISION } };
    assert_eq!(serde_json::to_value(ActionErrorView::from(&licence)).unwrap()["status"], json!({ "kind": "missing", "revision": manage::GEMMA_TERMS_REVISION }));
    let in_use = ActionError::InUse { model: MODEL_B.id, by: manage::InUseBy::Engine };
    assert_eq!(serde_json::to_value(ActionErrorView::from(&in_use)).unwrap(), json!({ "kind": "in_use", "model": MODEL_B.id, "by": "engine" }));
}
