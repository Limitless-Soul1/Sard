//! Hardware-check tests. The classifier and the device-list parser are pure, so almost everything here is a fixture
//! and runs on every platform. Two tests read the computer itself: one checks that the probe works wherever the
//! tests run (Windows), and an `#[ignore]`d one checks the one PC the estimates were measured on. None of them loads
//! a model, starts the engine or uses the GPU.

use std::path::Path;

use super::catalog::{self, launch_profile, Artifact, Kind, Licence, ModelNeeds, ENGINE_WINDOWS_X64, MODEL_A, MODEL_B, RUNTIME_WINDOWS_X64};
use super::engine::{engine_args, Execution};
use super::hardware::{
    assess, classify, dedicated_in_use, disk_still_needed, parse_device_list, probe, Adapter, EngineDevice, Fit, HardwareError,
    HardwareReport, Memory, NoGpu, Undetermined, VideoMemory, DISK_HEADROOM, RAM_HEADROOM, VRAM_HEADROOM,
};
use super::install;
use super::install_tests::{entries, put_verified, sha, small_engine, spec_for, TempDir};
use super::slot::serial_for_tests;
use super::store::Store;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

const RTX: &str = "NVIDIA GeForce RTX 3060 Ti";
const INTEL: &str = "Intel(R) UHD Graphics 770";

/// What the engine printed on this PC for `llama-server.exe --list-devices` (b11501, 2026-10-14), byte for byte.
const THIS_PC_DEVICES: &str = "Available devices:\r\n  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, 7256 MiB free)\r\n";

fn a() -> ModelNeeds {
    catalog::needs(&MODEL_A).unwrap()
}

fn b() -> ModelNeeds {
    catalog::needs(&MODEL_B).unwrap()
}

fn vram_needed(n: &ModelNeeds) -> u64 {
    n.gpu_vram + VRAM_HEADROOM
}

fn gpu_ram_needed(n: &ModelNeeds) -> u64 {
    n.gpu_ram + RAM_HEADROOM
}

fn cpu_ram_needed(n: &ModelNeeds) -> u64 {
    n.cpu_ram + RAM_HEADROOM
}

/// A card no other program uses, with a DXGI budget of `budget`, `usage` of it this process's.
fn card(description: &str, dedicated: u64, budget: u64, usage: u64) -> Adapter {
    Adapter {
        description: description.into(),
        vendor_id: 0x10DE,
        device_id: 0x2489,
        luid: 0xE1AD,
        dedicated,
        software: false,
        video: Some(VideoMemory { budget, usage }),
        in_use: Some(0),
    }
}

/// A card of which every program together holds `in_use`.
fn busy(dedicated: u64, budget: u64, in_use: u64) -> Adapter {
    Adapter { in_use: Some(in_use), ..card(RTX, dedicated, budget, 0) }
}

/// An 8 GB card with most of it free.
fn rtx() -> Adapter {
    card(RTX, 8 * GIB, 7 * GIB, 0)
}

/// The software renderer every Windows lists.
fn basic_render() -> Adapter {
    Adapter {
        description: "Microsoft Basic Render Driver".into(),
        vendor_id: 0x1414,
        device_id: 0x8C,
        luid: 0xFBA8,
        dedicated: 0,
        software: true,
        video: Some(VideoMemory { budget: 8 * GIB, usage: 0 }),
        in_use: Some(0),
    }
}

/// An integrated GPU: almost no memory of its own, and a budget drawn from the system's memory.
fn integrated() -> Adapter {
    Adapter {
        description: INTEL.into(),
        vendor_id: 0x8086,
        device_id: 0x4680,
        luid: 0x1_0000_0042,
        dedicated: 128 * MIB,
        software: false,
        video: Some(VideoMemory { budget: 8 * GIB, usage: 0 }),
        in_use: Some(0),
    }
}

fn device(name: &str, description: &str) -> EngineDevice {
    EngineDevice { name: name.into(), description: description.into() }
}

fn machine(available: u64, disk_free: u64, adapters: Vec<Adapter>) -> HardwareReport {
    HardwareReport {
        memory: Some(Memory { total: 16 * GIB, available }),
        disk_free: Some(disk_free),
        adapters: Some(adapters),
    }
}

/// Plenty of memory and disk space: only the GPU decides.
fn roomy(adapters: Vec<Adapter>) -> HardwareReport {
    machine(12 * GIB, 100 * GIB, adapters)
}

/// Classify with nothing left to download.
fn on(needs: &ModelNeeds, found: &HardwareReport, devices: &[EngineDevice]) -> Fit {
    classify(needs, 0, found, Some(devices))
}

fn gpu_fits(device: &str) -> Fit {
    Fit::GpuFits { device: device.into() }
}

// --- The engine's device list -------------------------------------------------------------------------------

#[test]
fn this_pcs_device_list_names_one_gpu() {
    assert_eq!(parse_device_list(THIS_PC_DEVICES), Ok(vec![device("Vulkan0", RTX)]));
    // The same list with Unix line endings, and with the blank line the engine may print after it.
    let unix = THIS_PC_DEVICES.replace("\r\n", "\n") + "\n";
    assert_eq!(parse_device_list(&unix), Ok(vec![device("Vulkan0", RTX)]));
}

#[test]
fn a_description_may_hold_brackets_and_several_devices_keep_their_order() {
    let text = "Available devices:\n  Vulkan0: AMD Radeon(TM) Graphics (2048 MiB, 1900 MiB free)\n  Vulkan1: Card (Rev 2) X (8192 MiB, 8000 MiB free)\n";
    assert_eq!(
        parse_device_list(text),
        Ok(vec![device("Vulkan0", "AMD Radeon(TM) Graphics"), device("Vulkan1", "Card (Rev 2) X")])
    );
}

#[test]
fn a_list_without_devices_is_empty_and_chatter_before_it_is_ignored() {
    assert_eq!(parse_device_list("Available devices:\n"), Ok(vec![]));
    let chatty = "ggml_vulkan: Found 1 Vulkan devices:\nload_backend: loaded Vulkan backend\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, 7256 MiB free)\n";
    assert_eq!(parse_device_list(chatty), Ok(vec![device("Vulkan0", RTX)]));
}

#[test]
fn a_list_that_is_not_fully_understood_is_refused() {
    let refused = [
        ("no header", "  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, 7256 MiB free)\n"),
        ("not indented", "Available devices:\nVulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, 7256 MiB free)\n"),
        ("no figures", "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 Ti\n"),
        ("one figure", "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB)\n"),
        ("figure not a number", "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, lots MiB free)\n"),
        ("no description", "Available devices:\n  Vulkan0:  (8024 MiB, 7256 MiB free)\n"),
        ("a space in the name", "Available devices:\n  Vulkan 0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, 7256 MiB free)\n"),
        ("the CPU's name", "Available devices:\n  none: CPU (8024 MiB, 7256 MiB free)\n"),
        ("a name too long", "Available devices:\n  VulkanVulkanVulkanVulkanVulkanVulkan0: X (1 MiB, 1 MiB free)\n"),
        ("a second header", "Available devices:\n  Vulkan0: X (1 MiB, 1 MiB free)\nAvailable devices:\n"),
        ("a stray line", "Available devices:\n  Vulkan0: X (1 MiB, 1 MiB free)\n  and something else\n"),
    ];
    for (case, text) in refused {
        assert!(parse_device_list(text).is_err(), "{case}: {:?}", parse_device_list(text));
    }
}

#[test]
fn every_name_the_parser_accepts_can_be_started() {
    let text = "Available devices:\n  Vulkan0: A (1 MiB, 1 MiB free)\n  Vulkan_12: B (1 MiB, 1 MiB free)\n";
    let profile = launch_profile(&MODEL_B).unwrap();
    for d in parse_device_list(text).unwrap() {
        let args = engine_args(Path::new("model.gguf"), profile, &Execution::Gpu { device: d.name.clone() })
            .unwrap_or_else(|e| panic!("{}: {e:?}", d.name));
        assert!(args.windows(2).any(|w| w[0] == "-dev" && w[1] == d.name.as_str()), "{args:?}");
    }
}

#[test]
fn the_engines_free_figure_changes_nothing() {
    // The engine's "free" figure was seen unchanged while other programs held 6 GB of the card. It must not be
    // able to make a model fit, or stop one from fitting.
    let none_free = THIS_PC_DEVICES.replace("7256 MiB free", "0 MiB free");
    let all_free = THIS_PC_DEVICES.replace("(8024 MiB, 7256 MiB free)", "(99999 MiB, 99999 MiB free)");
    let lists = [THIS_PC_DEVICES.to_string(), none_free, all_free];
    let parsed: Vec<Vec<EngineDevice>> = lists.iter().map(|t| parse_device_list(t).unwrap()).collect();
    assert!(parsed.iter().all(|p| *p == parsed[0]), "{parsed:?}");
    // And whatever it says, the outcome follows Sard's own measurement: a card whose budget is nearly used up
    // does not take the model, and one with room does.
    for p in &parsed {
        let full = roomy(vec![card(RTX, 8 * GIB, 8 * GIB, 7 * GIB)]);
        assert!(matches!(on(&b(), &full, p), Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { .. } }));
        assert_eq!(on(&b(), &roomy(vec![rtx()]), p), gpu_fits("Vulkan0"));
    }
}

// --- The classifier ---------------------------------------------------------------------------------------------

#[test]
fn this_pc_runs_both_models_on_its_gpu() {
    let devices = parse_device_list(THIS_PC_DEVICES).unwrap();
    let found = roomy(vec![rtx(), basic_render()]);
    assert_eq!(on(&a(), &found, &devices), gpu_fits("Vulkan0"));
    assert_eq!(on(&b(), &found, &devices), gpu_fits("Vulkan0"));
}

#[test]
fn free_video_memory_is_the_budget_less_the_usage_to_the_byte() {
    for needs in [a(), b()] {
        let needed = vram_needed(&needs);
        let usage = 300 * MIB;
        let just = roomy(vec![card(RTX, 8 * GIB, needed + usage, usage)]);
        assert_eq!(on(&needs, &just, &[device("Vulkan0", RTX)]), gpu_fits("Vulkan0"));
        let short = roomy(vec![card(RTX, 8 * GIB, needed + usage - 1, usage)]);
        assert_eq!(
            on(&needs, &short, &[device("Vulkan0", RTX)]),
            Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { adapter: RTX.into(), free: needed - 1, needed } }
        );
    }
}

#[test]
fn the_cards_own_memory_must_hold_the_model_to_the_byte() {
    for needs in [a(), b()] {
        let needed = vram_needed(&needs);
        let just = roomy(vec![card(RTX, needed, 16 * GIB, 0)]);
        assert_eq!(on(&needs, &just, &[device("Vulkan0", RTX)]), gpu_fits("Vulkan0"));
        let short = roomy(vec![card(RTX, needed - 1, 16 * GIB, 0)]);
        assert_eq!(
            on(&needs, &short, &[device("Vulkan0", RTX)]),
            Fit::CpuOnly { why: NoGpu::TooLittleDedicatedMemory { adapter: RTX.into(), dedicated: needed - 1, needed } }
        );
    }
}

#[test]
fn system_memory_decides_each_path_to_the_byte() {
    for needs in [a(), b()] {
        // On the GPU.
        let gpu = gpu_ram_needed(&needs);
        assert_eq!(on(&needs, &machine(gpu, 100 * GIB, vec![rtx()]), &[device("Vulkan0", RTX)]), gpu_fits("Vulkan0"));
        assert_eq!(
            on(&needs, &machine(gpu - 1, 100 * GIB, vec![rtx()]), &[device("Vulkan0", RTX)]),
            Fit::InsufficientRam { needed: gpu, available: gpu - 1 }
        );
        // On the CPU, when the engine offers no GPU.
        let cpu = cpu_ram_needed(&needs);
        assert_eq!(on(&needs, &machine(cpu, 100 * GIB, vec![]), &[]), Fit::CpuOnly { why: NoGpu::NoEngineDevice });
        assert_eq!(on(&needs, &machine(cpu - 1, 100 * GIB, vec![]), &[]), Fit::InsufficientRam { needed: cpu, available: cpu - 1 });
    }
}

#[test]
fn what_is_still_to_download_must_fit_on_the_disk_to_the_byte() {
    let to_fetch = 3 * GIB;
    let needed = to_fetch + DISK_HEADROOM;
    let devices = [device("Vulkan0", RTX)];
    let just = machine(12 * GIB, needed, vec![rtx()]);
    assert_eq!(classify(&b(), to_fetch, &just, Some(&devices)), gpu_fits("Vulkan0"));
    let short = machine(12 * GIB, needed - 1, vec![rtx()]);
    assert_eq!(classify(&b(), to_fetch, &short, Some(&devices)), Fit::InsufficientDisk { needed, available: needed - 1 });
    // The disk is checked first: nothing else matters if the files cannot be stored.
    let nothing = HardwareReport { memory: None, disk_free: Some(0), adapters: None };
    assert_eq!(classify(&b(), to_fetch, &nothing, None), Fit::InsufficientDisk { needed, available: 0 });
}

#[test]
fn nothing_left_to_download_needs_no_disk_space() {
    let devices = [device("Vulkan0", RTX)];
    let mut found = roomy(vec![rtx()]);
    found.disk_free = None;
    assert_eq!(classify(&b(), 0, &found, Some(&devices)), gpu_fits("Vulkan0"));
    found.disk_free = Some(0);
    assert_eq!(classify(&b(), 0, &found, Some(&devices)), gpu_fits("Vulkan0"));
}

#[test]
fn without_a_gpu_the_cpu_runs_the_model() {
    for adapters in [vec![], vec![basic_render()], vec![rtx()]] {
        assert_eq!(on(&b(), &roomy(adapters), &[]), Fit::CpuOnly { why: NoGpu::NoEngineDevice });
    }
}

#[test]
fn two_gpus_offered_by_the_engine_are_not_chosen_between() {
    let devices = [device("Vulkan0", RTX), device("Vulkan1", INTEL)];
    assert_eq!(
        on(&b(), &roomy(vec![rtx(), integrated()]), &devices),
        Fit::NotDetermined { why: Undetermined::SeveralEngineDevices(2), cpu_offered: true }
    );
}

#[test]
fn two_adapters_of_the_engines_name_are_ambiguous() {
    assert_eq!(
        on(&b(), &roomy(vec![rtx(), rtx()]), &[device("Vulkan0", RTX)]),
        Fit::NotDetermined { why: Undetermined::SeveralMatchingAdapters(RTX.into()), cpu_offered: true }
    );
}

#[test]
fn the_one_gpu_offered_is_matched_among_several_adapters_by_its_name() {
    // A card beside an integrated GPU and the software renderer: only one adapter has the engine's name.
    let found = roomy(vec![integrated(), rtx(), basic_render()]);
    assert_eq!(on(&b(), &found, &[device("Vulkan0", RTX)]), gpu_fits("Vulkan0"));
}

#[test]
fn an_integrated_gpu_is_not_used_however_large_its_budget() {
    let found = roomy(vec![integrated()]);
    for needs in [a(), b()] {
        assert_eq!(
            on(&needs, &found, &[device("Vulkan0", INTEL)]),
            Fit::CpuOnly {
                why: NoGpu::TooLittleDedicatedMemory { adapter: INTEL.into(), dedicated: 128 * MIB, needed: vram_needed(&needs) }
            }
        );
    }
}

#[test]
fn a_budget_below_the_current_usage_leaves_nothing() {
    let over = VideoMemory { budget: 2 * GIB, usage: 3 * GIB };
    assert_eq!(over.free(), 0);
    let found = roomy(vec![card(RTX, 8 * GIB, 2 * GIB, 3 * GIB)]);
    assert_eq!(
        on(&b(), &found, &[device("Vulkan0", RTX)]),
        Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { adapter: RTX.into(), free: 0, needed: vram_needed(&b()) } }
    );
}

#[test]
fn what_other_programs_hold_of_the_card_counts_to_the_byte() {
    for needs in [a(), b()] {
        let needed = vram_needed(&needs);
        let just = roomy(vec![busy(8 * GIB, 8 * GIB, 8 * GIB - needed)]);
        assert_eq!(on(&needs, &just, &[device("Vulkan0", RTX)]), gpu_fits("Vulkan0"));
        let short = roomy(vec![busy(8 * GIB, 8 * GIB, 8 * GIB - needed + 1)]);
        assert_eq!(
            on(&needs, &short, &[device("Vulkan0", RTX)]),
            Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { adapter: RTX.into(), free: needed - 1, needed } }
        );
    }
}

#[test]
fn the_budget_alone_would_have_said_it_fits() {
    // The evaluation's case: other programs held about 6 GB of the 8 GB card while the per-process figure stayed at
    // 7,256 MiB. Only what they hold shows that B no longer fits.
    let card = busy(8 * GIB, 7256 * MIB, 6300 * MIB);
    assert_eq!(card.video.unwrap().free(), 7256 * MIB);
    assert_eq!(card.free_video_memory(), Some(8 * GIB - 6300 * MIB));
    assert_eq!(
        on(&b(), &roomy(vec![card]), &[device("Vulkan0", RTX)]),
        Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { adapter: RTX.into(), free: 8 * GIB - 6300 * MIB, needed: vram_needed(&b()) } }
    );
}

#[test]
fn the_budget_still_caps_what_is_free() {
    // No other program uses the card, but this process's budget is short: the smaller figure decides.
    let needed = vram_needed(&b());
    assert_eq!(
        on(&b(), &roomy(vec![busy(8 * GIB, needed - 1, 0)]), &[device("Vulkan0", RTX)]),
        Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { adapter: RTX.into(), free: needed - 1, needed } }
    );
    assert_eq!(on(&b(), &roomy(vec![busy(8 * GIB, needed, 0)]), &[device("Vulkan0", RTX)]), gpu_fits("Vulkan0"));
    // More in use than the card has leaves nothing, not a wrapped-around figure.
    assert_eq!(busy(8 * GIB, 8 * GIB, 9 * GIB).free_video_memory(), Some(0));
}

#[test]
fn this_pcs_reading_leaves_room_for_both_models() {
    // 2026-10-15: 8,024 MiB of its own, a DXGI budget of 7,256 MiB, and 1,939 MiB held by other programs
    // (nvidia-smi at the same moment: 6,093 MiB free).
    let card = busy(8024 * MIB, 7256 * MIB, 1939 * MIB);
    assert_eq!(card.free_video_memory(), Some(6085 * MIB));
    let devices = parse_device_list(THIS_PC_DEVICES).unwrap();
    for needs in [a(), b()] {
        assert_eq!(on(&needs, &roomy(vec![card.clone(), basic_render()]), &devices), gpu_fits("Vulkan0"));
    }
}

#[test]
fn the_counters_are_matched_to_an_adapter_by_its_luid() {
    // The instances this PC's counters listed on 2026-10-15.
    let this_pc = vec![("luid_0x00000000_0x0000e1ad_phys_0".to_string(), 1939 * MIB), ("luid_0x00000000_0x0000fba8_phys_0".to_string(), 0)];
    assert_eq!(dedicated_in_use(0xE1AD, &this_pc), Some(1939 * MIB));
    assert_eq!(dedicated_in_use(0xFBA8, &this_pc), Some(0));
    assert_eq!(dedicated_in_use(0xE1AE, &this_pc), None);
    // The high part of the identifier counts; letter case does not.
    assert_eq!(dedicated_in_use(0x1_0000_E1AD, &this_pc), None);
    assert_eq!(dedicated_in_use(0x1_0000_E1AD, &[("LUID_0x00000001_0x0000E1AD_PHYS_0".to_string(), 5)]), Some(5));
    // An adapter in several physical parts is added up; nothing else of a similar name is.
    let parts: Vec<(String, u64)> = [
        ("luid_0x00000000_0x0000e1ad_phys_0", 3),
        ("luid_0x00000000_0x0000e1ad_phys_1", 4),
        ("luid_0x00000000_0x0000e1ad_phys_", 100),
        ("luid_0x00000000_0x0000e1ad_phys_0x", 100),
        ("xluid_0x00000000_0x0000e1ad_phys_0", 100),
        ("luid_0x00000000_0x0000e1ad", 100),
        ("ذاكرة_0x00000000_0x0000e1ad_phys_0", 100),
    ]
    .iter()
    .map(|(n, v)| (n.to_string(), *v))
    .collect();
    assert_eq!(dedicated_in_use(0xE1AD, &parts), Some(7));
    assert_eq!(dedicated_in_use(0xE1AD, &[]), None);
}

#[test]
fn an_adapter_matches_only_by_its_exact_name() {
    // A different card of a similar name is not the one the engine means.
    assert_eq!(
        on(&b(), &roomy(vec![rtx()]), &[device("Vulkan0", "NVIDIA GeForce RTX 3060")]),
        Fit::NotDetermined { why: Undetermined::NoMatchingAdapter("NVIDIA GeForce RTX 3060".into()), cpu_offered: true }
    );
    // A software renderer of that name is not a GPU.
    let mut soft = rtx();
    soft.software = true;
    assert_eq!(
        on(&b(), &roomy(vec![soft]), &[device("Vulkan0", RTX)]),
        Fit::NotDetermined { why: Undetermined::NoMatchingAdapter(RTX.into()), cpu_offered: true }
    );
    // Letter case and surrounding spaces do not make a different name.
    assert_eq!(on(&b(), &roomy(vec![rtx()]), &[device("Vulkan0", "  nvidia geforce RTX 3060 TI ")]), gpu_fits("Vulkan0"));
}

#[test]
fn what_could_not_be_read_is_never_guessed() {
    let devices = [device("Vulkan0", RTX)];
    assert_eq!(
        classify(&b(), 0, &roomy(vec![rtx()]), None),
        Fit::NotDetermined { why: Undetermined::DeviceListUnknown, cpu_offered: true }
    );
    let mut found = roomy(vec![rtx()]);
    found.adapters = None;
    assert_eq!(on(&b(), &found, &devices), Fit::NotDetermined { why: Undetermined::AdaptersUnknown, cpu_offered: true });
    let mut no_budget = rtx();
    no_budget.video = None;
    let mut no_counters = rtx();
    no_counters.in_use = None;
    for blind in [no_budget, no_counters] {
        assert_eq!(
            on(&b(), &roomy(vec![blind]), &devices),
            Fit::NotDetermined { why: Undetermined::VideoMemoryUnknown(RTX.into()), cpu_offered: true }
        );
    }
    let mut found = roomy(vec![rtx()]);
    found.memory = None;
    assert_eq!(on(&b(), &found, &devices), Fit::NotDetermined { why: Undetermined::MemoryUnknown, cpu_offered: false });
    let mut found = roomy(vec![rtx()]);
    found.disk_free = None;
    assert_eq!(
        classify(&b(), 1, &found, Some(&devices)),
        Fit::NotDetermined { why: Undetermined::DiskSpaceUnknown, cpu_offered: false }
    );
}

#[test]
fn not_determined_offers_the_cpu_only_when_it_has_the_memory() {
    let devices = [device("Vulkan0", RTX)];
    for needs in [a(), b()] {
        let (gpu, cpu) = (gpu_ram_needed(&needs), cpu_ram_needed(&needs));
        let ambiguous = |available| machine(available, 100 * GIB, vec![rtx(), rtx()]);
        let why = Undetermined::SeveralMatchingAdapters(RTX.into());
        assert_eq!(on(&needs, &ambiguous(cpu), &devices), Fit::NotDetermined { why: why.clone(), cpu_offered: true });
        assert_eq!(on(&needs, &ambiguous(cpu - 1), &devices), Fit::NotDetermined { why, cpu_offered: false });
        // Below what either path needs, it is simply not enough memory.
        assert_eq!(on(&needs, &ambiguous(gpu - 1), &devices), Fit::InsufficientRam { needed: gpu, available: gpu - 1 });
    }
}

#[test]
fn there_is_no_partial_offload() {
    // Video memory for all but the last byte of the model — far more than any partial share — still means the CPU.
    let needs = a();
    let almost = roomy(vec![card(RTX, 8 * GIB, vram_needed(&needs) - 1, 0)]);
    assert!(matches!(on(&needs, &almost, &[device("Vulkan0", RTX)]), Fit::CpuOnly { .. }));
    // The five outcomes are all there is; a sixth would have to be added here.
    let outcomes = [
        gpu_fits("Vulkan0"),
        Fit::CpuOnly { why: NoGpu::NoEngineDevice },
        Fit::InsufficientRam { needed: 1, available: 0 },
        Fit::InsufficientDisk { needed: 1, available: 0 },
        Fit::NotDetermined { why: Undetermined::MemoryUnknown, cpu_offered: false },
    ];
    for fit in outcomes {
        match fit {
            Fit::GpuFits { .. } | Fit::CpuOnly { .. } | Fit::InsufficientRam { .. } | Fit::InsufficientDisk { .. } | Fit::NotDetermined { .. } => {}
        }
    }
    // And "GPU fits" starts the engine with every layer on the GPU.
    for model in [&MODEL_A, &MODEL_B] {
        let Fit::GpuFits { device } = on(&catalog::needs(model).unwrap(), &roomy(vec![rtx()]), &[device("Vulkan0", RTX)]) else {
            panic!("{} does not fit the card", model.id);
        };
        let args = engine_args(Path::new("model.gguf"), launch_profile(model).unwrap(), &Execution::Gpu { device }).unwrap();
        assert!(args.windows(2).any(|w| w[0] == "-ngl" && w[1] == "99"), "{args:?}");
        assert!(!args.windows(2).any(|w| w[0] == "-ngl" && w[1] != "99"), "{args:?}");
    }
}

// --- What is still to be downloaded ----------------------------------------------------------------------------

#[test]
fn everything_counts_until_it_is_installed() {
    let _serial = serial_for_tests();
    let tmp = TempDir::new("hardware_disk");
    let store = Store::open(tmp.0.join("translation")).unwrap();
    let files = small_engine();
    let archive = super::install_tests::build_zip(&entries(&files));
    let spec = spec_for("hardware_disk", &files, &archive);
    let bytes = b"a model of a few bytes".to_vec();
    let model: &'static Artifact = Box::leak(Box::new(Artifact {
        id: "test-model-hardware",
        kind: Kind::Model,
        file_name: "model.gguf",
        size: bytes.len() as u64,
        sha256: Box::leak(sha(&bytes).into_boxed_str()),
        sources: &[],
        licence: Licence::Apache2,
    }));
    let engine: u64 = files.iter().map(|(_, d)| d.len() as u64).sum::<u64>() + spec.notices.len() as u64;
    assert_eq!(disk_still_needed(&store, spec, model).unwrap(), model.size + spec.archive.size + engine);
    put_verified(&store, model, &bytes);
    assert_eq!(disk_still_needed(&store, spec, model).unwrap(), spec.archive.size + engine);
    put_verified(&store, spec.archive, &archive);
    assert_eq!(disk_still_needed(&store, spec, model).unwrap(), engine);
    install::install(&store, spec, &super::install_tests::never()).unwrap();
    assert_eq!(disk_still_needed(&store, spec, model).unwrap(), 0);
}

#[test]
fn only_a_model_can_be_assessed() {
    let tmp = TempDir::new("hardware_not_a_model");
    let store = Store::open(tmp.0.join("translation")).unwrap();
    assert_eq!(assess(&store, &ENGINE_WINDOWS_X64, &RUNTIME_WINDOWS_X64, None), Err(HardwareError::NotAModel));
}

// --- The probe ---------------------------------------------------------------------------------------------------

#[cfg(windows)]
#[test]
fn the_probe_reads_this_computer_and_changes_nothing() {
    let tmp = TempDir::new("hardware_probe");
    let found = probe(&tmp.0).unwrap();
    let memory = found.memory.expect("the memory could not be read");
    assert!(memory.total > 0 && memory.available <= memory.total, "{memory:?}");
    assert!(found.disk_free.is_some_and(|free| free > 0), "{:?}", found.disk_free);
    let adapters = found.adapters.expect("the graphics adapters could not be read");
    for adapter in &adapters {
        assert!(!adapter.description.is_empty(), "{adapter:?}");
    }
    assert_eq!(std::fs::read_dir(&tmp.0).unwrap().count(), 0, "the probe wrote something");
}

#[cfg(not(windows))]
#[test]
fn elsewhere_the_hardware_check_is_unsupported() {
    let tmp = TempDir::new("hardware_unsupported");
    assert_eq!(probe(&tmp.0), Err(HardwareError::Unsupported));
    let store = Store::open(tmp.0.join("translation")).unwrap();
    assert_eq!(assess(&store, &ENGINE_WINDOWS_X64, &MODEL_B, None), Err(HardwareError::Unsupported));
}

/// The PC the estimates were measured on. Read-only: the probe only asks Windows what it has.
#[cfg(windows)]
#[test]
#[ignore = "reads THIS PC's hardware (an RTX 3060 Ti is expected); read-only — no model, no engine, no GPU work"]
fn this_pc_is_identified_and_its_gpu_takes_both_models() {
    use super::install_tests::note;
    let tmp = TempDir::new("hardware_this_pc");
    let found = probe(&tmp.0).unwrap();
    let memory = found.memory.expect("memory");
    note(&format!("memory: total {} MiB, available {} MiB", memory.total / MIB, memory.available / MIB));
    note(&format!("disk free at the temporary folder: {:?} MiB", found.disk_free.map(|f| f / MIB)));
    let adapters = found.adapters.clone().expect("adapters");
    for x in &adapters {
        note(&format!(
            "adapter {:?}: vendor {:04x} device {:04x}, luid {:#x}, software {}, dedicated {} MiB, DXGI budget {:?} MiB, \
             DXGI usage {:?} MiB, held by all programs {:?} MiB, free {:?} MiB",
            x.description,
            x.vendor_id,
            x.device_id,
            x.luid,
            x.software,
            x.dedicated / MIB,
            x.video.map(|v| v.budget / MIB),
            x.video.map(|v| v.usage / MIB),
            x.in_use.map(|u| u / MIB),
            x.free_video_memory().map(|f| f / MIB)
        ));
    }
    let hardware: Vec<&Adapter> = adapters.iter().filter(|x| !x.software).collect();
    assert_eq!(hardware.len(), 1, "{hardware:?}");
    let card = hardware[0];
    assert_eq!(card.description, RTX);
    assert!((7 * GIB + GIB / 2..=8 * GIB + GIB / 2).contains(&card.dedicated), "{card:?}");
    let video = card.video.expect("the card's budget could not be read");
    assert!(video.budget > 0 && video.budget <= card.dedicated, "{video:?}");
    // The desktop alone holds some of the card, so the counters must see something — and no more than the card has.
    let in_use = card.in_use.expect("the GPU counters could not be read");
    assert!(in_use > 0 && in_use < card.dedicated, "{card:?}");
    let free = card.free_video_memory().unwrap();
    assert!(free <= video.free() && free == (card.dedicated - in_use).min(video.free()), "{card:?}");
    // The GPU decision on this PC's real reading. System memory varies with whatever else is running, so it is set
    // to plenty for the assertion; the outcome with the memory actually available is reported, not asserted.
    let devices = parse_device_list(THIS_PC_DEVICES).unwrap();
    let ample = HardwareReport { memory: Some(Memory { total: memory.total, available: 64 * GIB }), ..found.clone() };
    for model in [&MODEL_A, &MODEL_B] {
        let needs = catalog::needs(model).unwrap();
        note(&format!("{}: with the memory available now: {:?}", model.id, classify(&needs, 0, &found, Some(&devices))));
        assert_eq!(classify(&needs, 0, &ample, Some(&devices)), gpu_fits("Vulkan0"), "{}", model.id);
    }
}
