//! Execution-choice tests. The decision and the start's rules are pure, so they are tested on every platform, on
//! hardware readings built here: the computer is never probed, no engine is started and no model is involved.
//! The preference is stored in a real, migrated database held in memory.

use std::cell::Cell;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use super::catalog::{self, ModelNeeds, ENGINE_WINDOWS_X64, MODEL_A, MODEL_B};
use super::engine::{EngineError, EngineInfo, Execution, PhaseTimes};
use super::execution::{
    decide, load_preference, save_preference, start_with, Assessment, Consent, ConsentRequest, Decision, NotStarted, Path, Preference,
    CONSENT_LIFETIME, CPU_THREADS, PREFERENCE_KEY,
};
use super::hardware::{
    parse_device_list, Adapter, EngineDevice, Fit, HardwareError, HardwareReport, Memory, NoGpu, Undetermined, VideoMemory, DISK_HEADROOM,
    RAM_HEADROOM,
};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const RTX: &str = "NVIDIA GeForce RTX 3060 Ti";

// --- Readings of a computer --------------------------------------------------------------------------------------

fn b() -> ModelNeeds {
    catalog::needs(&MODEL_B).unwrap()
}

/// An 8 GB card with `free` of it left by other programs.
fn card(free: u64) -> Adapter {
    Adapter {
        description: RTX.into(),
        vendor_id: 0x10DE,
        device_id: 0x2489,
        luid: 0xE1AD,
        dedicated: 8 * GIB,
        software: false,
        video: Some(VideoMemory { budget: 8 * GIB, usage: 0 }),
        in_use: Some(8 * GIB - free),
    }
}

fn reading(available: u64, disk_free: u64, adapters: Vec<Adapter>) -> HardwareReport {
    HardwareReport { memory: Some(Memory { total: 16 * GIB, available }), disk_free: Some(disk_free), adapters: Some(adapters) }
}

fn one_gpu() -> Vec<EngineDevice> {
    vec![EngineDevice { name: "Vulkan0".into(), description: RTX.into() }]
}

fn two_gpus() -> Vec<EngineDevice> {
    vec![EngineDevice { name: "Vulkan0".into(), description: RTX.into() }, EngineDevice { name: "Vulkan1".into(), description: "Other".into() }]
}

const PLENTY: u64 = 12 * GIB;
const ROOMY_DISK: u64 = 100 * GIB;

fn gpu_ram() -> u64 {
    b().gpu_ram + RAM_HEADROOM
}

fn cpu_ram() -> u64 {
    b().cpu_ram + RAM_HEADROOM
}

/// One situation the decision must handle: a name, and the assessment of model B in it.
struct Situation {
    name: &'static str,
    assessment: Assessment,
}

fn situation(name: &'static str, disk_needed: u64, found: HardwareReport, devices: Option<Vec<EngineDevice>>) -> Situation {
    Situation { name, assessment: Assessment::of(MODEL_B.id, &b(), disk_needed, &found, devices.as_deref()) }
}

fn gpu_fits() -> Situation {
    situation("the GPU fits", 0, reading(PLENTY, ROOMY_DISK, vec![card(7 * GIB)]), Some(one_gpu()))
}

fn gpu_full() -> Situation {
    situation("other programs fill the GPU", 0, reading(PLENTY, ROOMY_DISK, vec![card(GIB)]), Some(one_gpu()))
}

fn no_gpu() -> Situation {
    situation("the engine offers no GPU", 0, reading(PLENTY, ROOMY_DISK, vec![]), Some(vec![]))
}

fn two_gpus_offered() -> Situation {
    situation("two GPUs offered", 0, reading(PLENTY, ROOMY_DISK, vec![card(7 * GIB)]), Some(two_gpus()))
}

fn no_device_list() -> Situation {
    situation("the device list could not be had", 0, reading(PLENTY, ROOMY_DISK, vec![card(7 * GIB)]), None)
}

fn ram_for_the_gpu_only() -> Situation {
    situation("memory for the GPU path only", 0, reading(gpu_ram(), ROOMY_DISK, vec![card(7 * GIB)]), Some(one_gpu()))
}

fn ram_for_the_gpu_only_but_it_is_full() -> Situation {
    situation("memory for the GPU path only, and the GPU full", 0, reading(gpu_ram(), ROOMY_DISK, vec![card(GIB)]), Some(one_gpu()))
}

fn ram_short() -> Situation {
    situation("too little memory for either path", 0, reading(gpu_ram() - 1, ROOMY_DISK, vec![card(7 * GIB)]), Some(one_gpu()))
}

fn disk_short() -> Situation {
    situation("too little disk space", 3 * GIB, reading(PLENTY, 3 * GIB + DISK_HEADROOM - 1, vec![card(7 * GIB)]), Some(one_gpu()))
}

fn memory_unknown() -> Situation {
    let mut found = reading(PLENTY, ROOMY_DISK, vec![card(7 * GIB)]);
    found.memory = None;
    situation("the memory could not be read", 0, found, Some(one_gpu()))
}

fn undetermined_and_too_little_for_the_cpu() -> Situation {
    situation("two GPUs offered, and memory for the GPU path only", 0, reading(gpu_ram(), ROOMY_DISK, vec![card(7 * GIB)]), Some(two_gpus()))
}

fn every_situation() -> Vec<Situation> {
    vec![
        gpu_fits(),
        gpu_full(),
        no_gpu(),
        two_gpus_offered(),
        no_device_list(),
        ram_for_the_gpu_only(),
        ram_for_the_gpu_only_but_it_is_full(),
        ram_short(),
        disk_short(),
        memory_unknown(),
        undetermined_and_too_little_for_the_cpu(),
    ]
}

const EVERY_PREFERENCE: [Preference; 3] = [Preference::Auto, Preference::Gpu, Preference::Cpu];

fn on_gpu() -> Path {
    Path::Gpu { device: "Vulkan0".into() }
}

fn consent_for(s: &Situation) -> Decision {
    Decision::NeedsConsent(ConsentRequest { model: MODEL_B.id.into(), path: Path::Cpu, gpu_verdict: s.assessment.gpu().clone() })
}

// --- The preference ----------------------------------------------------------------------------------------------

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn, None).unwrap();
    conn
}

#[test]
fn the_preference_is_automatic_until_one_is_saved() {
    assert_eq!(PREFERENCE_KEY, "translation_execution");
    assert_eq!(load_preference(&database()), Ok(Preference::Auto));
    assert_eq!(Preference::default(), Preference::Auto);
}

#[test]
fn each_preference_is_kept_as_saved() {
    let conn = database();
    for p in [Preference::Gpu, Preference::Cpu, Preference::Auto] {
        save_preference(&conn, p).unwrap();
        assert_eq!(load_preference(&conn), Ok(p));
        assert_eq!(crate::settings::get(&conn, PREFERENCE_KEY).unwrap().as_deref(), Some(p.as_str()));
    }
}

#[test]
fn a_stored_value_that_is_not_understood_is_automatic() {
    let conn = database();
    for value in ["", "GPU", "Cpu", " gpu", "gpu ", "auto\n", "partial", "gpu,cpu", "1", "null", "تلقائي"] {
        crate::settings::set(&conn, PREFERENCE_KEY, value).unwrap();
        assert_eq!(load_preference(&conn), Ok(Preference::Auto), "{value:?}");
    }
}

#[test]
fn saving_the_preference_touches_no_other_setting() {
    let conn = database();
    crate::settings::set(&conn, "some_other_setting", "kept").unwrap();
    save_preference(&conn, Preference::Cpu).unwrap();
    assert_eq!(crate::settings::get(&conn, "some_other_setting").unwrap().as_deref(), Some("kept"));
}

#[test]
fn a_database_that_cannot_be_read_is_an_error_not_a_default() {
    // No settings table at all: reading fails, as every other setting's does — it is not taken for "nothing saved".
    let broken = Connection::open_in_memory().unwrap();
    assert!(load_preference(&broken).is_err());
    assert!(save_preference(&broken, Preference::Gpu).is_err());
}

// --- The decision ------------------------------------------------------------------------------------------------

#[test]
fn every_preference_in_every_situation() {
    use Preference::{Auto, Cpu, Gpu};
    let cases: Vec<(Situation, [Decision; 3])> = vec![
        (gpu_fits(), [
            Decision::Run { path: on_gpu(), gpu_recommended: None },
            Decision::Run { path: on_gpu(), gpu_recommended: None },
            Decision::Run { path: Path::Cpu, gpu_recommended: Some("Vulkan0".into()) },
        ]),
        (gpu_full(), [
            consent_for(&gpu_full()),
            Decision::Refused { why: gpu_full().assessment.gpu().clone(), alternative: Some(Path::Cpu) },
            Decision::Run { path: Path::Cpu, gpu_recommended: None },
        ]),
        (no_gpu(), [
            consent_for(&no_gpu()),
            Decision::Refused { why: Fit::CpuOnly { why: NoGpu::NoEngineDevice }, alternative: Some(Path::Cpu) },
            Decision::Run { path: Path::Cpu, gpu_recommended: None },
        ]),
        (two_gpus_offered(), [
            consent_for(&two_gpus_offered()),
            Decision::Refused {
                why: Fit::NotDetermined { why: Undetermined::SeveralEngineDevices(2), cpu_offered: true },
                alternative: Some(Path::Cpu),
            },
            Decision::Run { path: Path::Cpu, gpu_recommended: None },
        ]),
        (no_device_list(), [
            consent_for(&no_device_list()),
            Decision::Refused { why: Fit::NotDetermined { why: Undetermined::DeviceListUnknown, cpu_offered: true }, alternative: Some(Path::Cpu) },
            Decision::Run { path: Path::Cpu, gpu_recommended: None },
        ]),
        (ram_for_the_gpu_only(), [
            Decision::Run { path: on_gpu(), gpu_recommended: None },
            Decision::Run { path: on_gpu(), gpu_recommended: None },
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() }, alternative: Some(on_gpu()) },
        ]),
        (ram_for_the_gpu_only_but_it_is_full(), [
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() }, alternative: None },
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() }, alternative: None },
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() }, alternative: None },
        ]),
        (ram_short(), [
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() - 1 }, alternative: None },
            Decision::Refused { why: Fit::InsufficientRam { needed: gpu_ram(), available: gpu_ram() - 1 }, alternative: None },
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() - 1 }, alternative: None },
        ]),
        (disk_short(), [
            Decision::Refused { why: Fit::InsufficientDisk { needed: 3 * GIB + DISK_HEADROOM, available: 3 * GIB + DISK_HEADROOM - 1 }, alternative: None },
            Decision::Refused { why: Fit::InsufficientDisk { needed: 3 * GIB + DISK_HEADROOM, available: 3 * GIB + DISK_HEADROOM - 1 }, alternative: None },
            Decision::Refused { why: Fit::InsufficientDisk { needed: 3 * GIB + DISK_HEADROOM, available: 3 * GIB + DISK_HEADROOM - 1 }, alternative: None },
        ]),
        (memory_unknown(), [
            Decision::Refused { why: Fit::NotDetermined { why: Undetermined::MemoryUnknown, cpu_offered: false }, alternative: None },
            Decision::Refused { why: Fit::NotDetermined { why: Undetermined::MemoryUnknown, cpu_offered: false }, alternative: None },
            Decision::Refused { why: Fit::NotDetermined { why: Undetermined::MemoryUnknown, cpu_offered: false }, alternative: None },
        ]),
        (undetermined_and_too_little_for_the_cpu(), [
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() }, alternative: None },
            Decision::Refused {
                why: Fit::NotDetermined { why: Undetermined::SeveralEngineDevices(2), cpu_offered: false },
                alternative: None,
            },
            Decision::Refused { why: Fit::InsufficientRam { needed: cpu_ram(), available: gpu_ram() }, alternative: None },
        ]),
    ];
    assert_eq!(cases.len(), every_situation().len(), "every situation is in the table");
    for (s, expected) in cases {
        for (preference, expected) in [Auto, Gpu, Cpu].into_iter().zip(expected) {
            assert_eq!(decide(preference, &s.assessment), expected, "{} / {preference:?}", s.name);
        }
    }
}

#[test]
fn no_decision_names_a_gpu_the_check_did_not_confirm() {
    for s in every_situation() {
        for preference in EVERY_PREFERENCE {
            let named = match decide(preference, &s.assessment) {
                Decision::Run { path: Path::Gpu { device }, .. } | Decision::Refused { alternative: Some(Path::Gpu { device }), .. } => Some(device),
                _ => None,
            };
            if let Some(device) = named {
                assert_eq!(s.assessment.gpu(), &Fit::GpuFits { device }, "{} / {preference:?}", s.name);
            }
        }
    }
}

#[test]
fn no_decision_offers_the_cpu_when_its_path_cannot_run() {
    for s in every_situation() {
        for preference in EVERY_PREFERENCE {
            let cpu = match decide(preference, &s.assessment) {
                Decision::Run { path: Path::Cpu, .. } | Decision::NeedsConsent(_) | Decision::Refused { alternative: Some(Path::Cpu), .. } => true,
                _ => false,
            };
            if cpu {
                assert!(matches!(s.assessment.cpu(), Fit::CpuOnly { .. }), "{} / {preference:?}", s.name);
            }
        }
    }
}

#[test]
fn automatic_never_runs_on_the_cpu_without_consent() {
    for s in every_situation() {
        let decision = decide(Preference::Auto, &s.assessment);
        assert!(!matches!(decision, Decision::Run { path: Path::Cpu, .. }), "{}: {decision:?}", s.name);
    }
}

#[test]
fn a_choice_of_the_cpu_stands_against_a_recommended_gpu() {
    assert_eq!(decide(Preference::Cpu, &gpu_fits().assessment), Decision::Run { path: Path::Cpu, gpu_recommended: Some("Vulkan0".into()) });
}

#[test]
fn the_engines_free_figure_changes_no_decision() {
    let found = reading(PLENTY, ROOMY_DISK, vec![card(GIB)]);
    let lists = ["(8024 MiB, 0 MiB free)", "(8024 MiB, 7256 MiB free)", "(99999 MiB, 99999 MiB free)"]
        .map(|figures| parse_device_list(&format!("Available devices:\n  Vulkan0: {RTX} {figures}\n")).unwrap());
    for preference in EVERY_PREFERENCE {
        let decisions: Vec<Decision> = lists.iter().map(|d| decide(preference, &Assessment::of(MODEL_B.id, &b(), 0, &found, Some(d)))).collect();
        assert!(decisions.iter().all(|d| *d == decisions[0]), "{preference:?}: {decisions:?}");
    }
}

#[test]
fn each_path_starts_the_engine_as_it_says() {
    assert_eq!(Path::Cpu.execution(), Execution::Cpu { threads: CPU_THREADS });
    assert_eq!(CPU_THREADS, 2);
    assert_eq!(on_gpu().execution(), Execution::Gpu { device: "Vulkan0".into() });
}

// --- Consent ----------------------------------------------------------------------------------------------------

fn request_of(s: &Situation) -> ConsentRequest {
    match decide(Preference::Auto, &s.assessment) {
        Decision::NeedsConsent(request) => request,
        other => panic!("{}: {other:?}", s.name),
    }
}

#[test]
fn a_consent_covers_its_own_request_for_its_lifetime_only() {
    let request = request_of(&gpu_full());
    let given = Instant::now();
    let consent = request.grant(given);
    assert!(consent.covers(&request, given));
    assert!(consent.covers(&request, given + CONSENT_LIFETIME));
    assert!(!consent.covers(&request, given + CONSENT_LIFETIME + Duration::from_millis(1)));
    // Nor before it was given.
    assert!(!request.grant(given + Duration::from_secs(1)).covers(&request, given));
}

#[test]
fn a_consent_survives_a_change_of_figures_but_not_of_reasons() {
    let consent = request_of(&gpu_full()).grant(Instant::now());
    // The same card, a little more free — still too little: the same situation.
    let a_moment_later = situation("a moment later", 0, reading(PLENTY - GIB, ROOMY_DISK, vec![card(GIB + 300 * MIB)]), Some(one_gpu()));
    assert!(consent.covers(&request_of(&a_moment_later), Instant::now()));
    // Another reason the GPU is not used, or another model: not what was agreed to.
    for other in [request_of(&two_gpus_offered()), request_of(&no_device_list()), request_of(&no_gpu())] {
        assert!(!consent.covers(&other, Instant::now()), "{other:?}");
    }
    let mut model_a = request_of(&gpu_full());
    model_a.model = MODEL_A.id.into();
    assert!(!consent.covers(&model_a, Instant::now()));
}

// --- The start ---------------------------------------------------------------------------------------------------

fn info(execution: Execution) -> EngineInfo {
    EngineInfo { pid: 1, port: 1, model_id: MODEL_B.id.into(), execution, phases: PhaseTimes::default() }
}

/// A start in `s`, counting the assessments made and recording what the engine was started with, if anything.
fn try_start(preference: Preference, consent: Option<&Consent>, s: &Situation, now: Instant) -> (Result<Path, NotStarted>, usize, Option<Execution>) {
    let assessed = Cell::new(0);
    let launched = Cell::new(None);
    let result = start_with(
        preference,
        consent,
        now,
        || {
            assessed.set(assessed.get() + 1);
            Ok(s.assessment.clone())
        },
        |execution| {
            launched.set(Some(execution.clone()));
            Ok(info(execution))
        },
    );
    (result.map(|(path, _)| path), assessed.get(), launched.take())
}

#[test]
fn a_start_that_is_allowed_starts_the_engine_as_decided() {
    let (result, assessed, launched) = try_start(Preference::Auto, None, &gpu_fits(), Instant::now());
    assert_eq!((result, assessed, launched), (Ok(on_gpu()), 1, Some(Execution::Gpu { device: "Vulkan0".into() })));
    let (result, _, launched) = try_start(Preference::Cpu, None, &gpu_fits(), Instant::now());
    assert_eq!((result, launched), (Ok(Path::Cpu), Some(Execution::Cpu { threads: CPU_THREADS })));
}

#[test]
fn no_refusal_and_no_missing_consent_ever_starts_the_engine() {
    for s in every_situation() {
        for preference in EVERY_PREFERENCE {
            let (result, assessed, launched) = try_start(preference, None, &s, Instant::now());
            assert_eq!(assessed, 1, "{} / {preference:?}", s.name);
            match decide(preference, &s.assessment) {
                Decision::Run { .. } => assert!(launched.is_some() && result.is_ok(), "{} / {preference:?}", s.name),
                Decision::NeedsConsent(request) => {
                    assert_eq!(result, Err(NotStarted::NeedsConsent(request)), "{} / {preference:?}", s.name);
                    assert_eq!(launched, None, "{} / {preference:?}", s.name);
                }
                Decision::Refused { why, alternative } => {
                    assert_eq!(result, Err(NotStarted::Refused { why, alternative }), "{} / {preference:?}", s.name);
                    assert_eq!(launched, None, "{} / {preference:?}", s.name);
                }
            }
        }
    }
}

#[test]
fn consent_starts_the_cpu_only_for_what_was_agreed_and_only_now() {
    let now = Instant::now();
    let consent = request_of(&gpu_full()).grant(now);
    // The same situation, in time: the CPU.
    let (result, _, launched) = try_start(Preference::Auto, Some(&consent), &gpu_full(), now + Duration::from_secs(5));
    assert_eq!((result, launched), (Ok(Path::Cpu), Some(Execution::Cpu { threads: CPU_THREADS })));
    // Too late: asked again, nothing started.
    let (result, _, launched) = try_start(Preference::Auto, Some(&consent), &gpu_full(), now + CONSENT_LIFETIME + Duration::from_secs(1));
    assert_eq!(result, Err(NotStarted::ConsentDoesNotApply(consent_for(&gpu_full()))));
    assert_eq!(launched, None);
    // Another situation: asked again, nothing started.
    let (result, _, launched) = try_start(Preference::Auto, Some(&consent), &two_gpus_offered(), now);
    assert_eq!(result, Err(NotStarted::ConsentDoesNotApply(consent_for(&two_gpus_offered()))));
    assert_eq!(launched, None);
}

#[test]
fn a_consent_to_the_cpu_never_becomes_a_start_on_the_gpu() {
    // Agreed to the CPU when the card was full; by the start, the card has room. Automatic would now choose the GPU
    // — that is a different start from the one agreed to, so the user is told rather than switched.
    let now = Instant::now();
    let consent = request_of(&gpu_full()).grant(now);
    let (result, _, launched) = try_start(Preference::Auto, Some(&consent), &gpu_fits(), now);
    assert_eq!(result, Err(NotStarted::ConsentDoesNotApply(Decision::Run { path: on_gpu(), gpu_recommended: None })));
    assert_eq!(launched, None);
    // A consent left over when the user has since chosen the CPU outright is harmless: the same path.
    let (result, _, launched) = try_start(Preference::Cpu, Some(&consent), &gpu_fits(), now);
    assert_eq!((result, launched), (Ok(Path::Cpu), Some(Execution::Cpu { threads: CPU_THREADS })));
}

#[test]
fn every_start_assesses_again_and_an_earlier_verdict_authorises_nothing() {
    // The first start sees the card free and starts on the GPU; by the second, other programs have filled it.
    let readings = [gpu_fits(), gpu_full()];
    let next = Cell::new(0);
    let launched = Cell::new(0);
    let mut results = Vec::new();
    for _ in 0..2 {
        results.push(start_with(
            Preference::Gpu,
            None,
            Instant::now(),
            || {
                let s = &readings[next.get()];
                next.set(next.get() + 1);
                Ok(s.assessment.clone())
            },
            |execution| {
                launched.set(launched.get() + 1);
                Ok(info(execution))
            },
        ));
    }
    assert_eq!(next.get(), 2, "one assessment per start");
    assert_eq!(launched.get(), 1);
    assert!(results[0].is_ok());
    assert_eq!(results[1], Err(NotStarted::Refused { why: gpu_full().assessment.gpu().clone(), alternative: Some(Path::Cpu) }));
}

#[test]
fn a_reading_that_fails_or_an_engine_that_fails_is_reported() {
    let launched = Cell::new(false);
    let result = start_with(Preference::Auto, None, Instant::now(), || Err(HardwareError::Unsupported), |e| {
        launched.set(true);
        Ok(info(e))
    });
    assert_eq!(result, Err(NotStarted::Assessment(HardwareError::Unsupported)));
    assert!(!launched.get());
    let result = start_with(Preference::Auto, None, Instant::now(), || Ok(gpu_fits().assessment), |_| Err(EngineError::AlreadyActive));
    assert_eq!(result, Err(NotStarted::Engine(EngineError::AlreadyActive)));
}

/// The real start on this computer, with an empty translation directory: there is no engine to list devices with,
/// so the GPU is not determined, and without consent nothing can be started — whatever this computer has.
#[test]
fn without_an_engine_the_real_start_never_assumes_a_gpu_and_starts_nothing() {
    // The engine slot is the whole process's: the tests that take it run one at a time.
    let _serial = super::slot::serial_for_tests();
    let tmp = super::install_tests::TempDir::new("execution_start");
    let store = super::store::Store::open(tmp.0.join("translation")).unwrap();
    let manager = super::engine::EngineManager::new(super::engine::EngineConfig::default());
    let result = super::execution::start(&manager, &store, &ENGINE_WINDOWS_X64, &MODEL_B, Preference::Auto, None);
    match &result {
        Err(NotStarted::Assessment(HardwareError::Unsupported)) => assert!(!cfg!(windows), "{result:?}"),
        Err(NotStarted::NeedsConsent(request)) => {
            assert!(matches!(request.gpu_verdict, Fit::NotDetermined { why: Undetermined::DeviceListUnknown, .. }), "{result:?}")
        }
        Err(NotStarted::Refused { .. }) => {}
        other => panic!("{other:?}"),
    }
}

#[cfg(not(windows))]
#[test]
fn elsewhere_the_engine_lists_nothing() {
    let _serial = super::slot::serial_for_tests();
    let tmp = super::install_tests::TempDir::new("execution_list");
    let store = super::store::Store::open(tmp.0.join("translation")).unwrap();
    let manager = super::engine::EngineManager::new(super::engine::EngineConfig::default());
    assert_eq!(manager.list_devices(&store, &ENGINE_WINDOWS_X64), Err(EngineError::Unsupported));
}
