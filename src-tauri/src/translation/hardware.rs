//! The hardware check: what this computer offers a model, and which way — if any — the model can run on it.
//!
//! Two halves, kept apart so that the decision can be tested on any computer:
//!
//! * **The probe** (`probe`) reads the computer and changes nothing: its memory, the free space on the volume that
//!   holds the translation directory, and every graphics adapter (DXGI) with what every program on the computer
//!   holds of its memory (Windows' GPU performance counters) and the budget the operating system gives this
//!   process. Windows only; elsewhere it returns `HardwareError::Unsupported`.
//! * **The classifier** (`classify`) is a pure function of what the probe found, the engine's device list
//!   (`parse_device_list`) and the model's estimated needs (`catalog::needs`). It returns one of five outcomes:
//!   the GPU fits, the CPU only, not enough memory, not enough disk space, or not determined.
//!
//! Nothing here loads a model, starts the engine or uses the GPU. Nothing is reachable from the interface yet.
//!
//! ## What the decision rests on, and what it never uses
//!
//! * **Free video memory is Sard's own measurement:** the adapter's dedicated memory less what every program holds
//!   of it now, from Windows' GPU performance counters (matched to the DXGI adapter by its LUID, and read by their
//!   English names, so that a Windows in another language reads the same counter) — and never more than what is
//!   left of the budget DXGI gives this process.
//! * **Not the DXGI budget alone, and never the engine's figure.** When measured, the budget did not show other
//!   programs' use: it read 7,256 MiB while 6,093 MiB of the card were free (FACT, 2026-10-15). That is the very
//!   figure the engine's device list prints as "free", which the evaluation saw unchanged while other programs held
//!   6 GB of the card. The engine's figure is never read: `EngineDevice` has no field for it, so nothing can use it
//!   by mistake.
//! * **The whole model on one GPU, or the CPU.** There is no partial offload. The launch profiles put every layer
//!   on the GPU, and a model that does not fit there in full runs on the CPU, by the user's choice.
//! * **A GPU is used only when it is identified without doubt:** the engine offers exactly one GPU, and exactly one
//!   hardware adapter has its name. Anything else — two GPUs offered, no adapter of that name, two of the same
//!   name, free memory that cannot be measured — is `NotDetermined`, and only the CPU is offered. Which of several
//!   GPUs to use is not decided, so it is not guessed.
//! * **An integrated GPU is not used.** Its own video memory is far below any model's need; what it would really
//!   use is the system's memory, and that was never measured. The CPU is offered instead. It is recognised only by
//!   that small dedicated memory: one that reserves several GB of the system's memory for itself is treated like a
//!   card (NOT MEASURED).
//!
//! ## The thresholds are provisional
//!
//! A model's needs are the catalog's estimates from one PC, and the headroom below is added to them. Neither is a
//! final requirement until the weaker-hardware evaluation has calibrated them.

use std::io;
use std::path::Path;

use super::catalog::{self, Artifact, EngineSpec, ModelNeeds};
use super::install::{self, EngineState};
use super::store::{State, Store};

const MIB: u64 = 1024 * 1024;

/// Video memory left free beyond a model's need. PROVISIONAL: it is the margin the runtime's own memory-fit logic
/// leaves by default (recorded by the evaluation), not a figure calibrated for Sard.
pub const VRAM_HEADROOM: u64 = 1024 * MIB;
/// System memory left free beyond the engine's need — for Windows, Sard and the book being read. PROVISIONAL: it is
/// the floor the real-engine validation kept throughout its run.
pub const RAM_HEADROOM: u64 = 2048 * MIB;
/// Disk space left free beyond what is still to be downloaded and installed: the margin a download keeps.
pub const DISK_HEADROOM: u64 = 512 * MIB;

/// The computer's memory, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Memory {
    pub total: u64,
    /// What a program can have now without anything being paged out.
    pub available: u64,
}

/// An adapter's local video memory as DXGI accounts it to this process, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoMemory {
    /// The budget this process should stay within. It is a cap, not a measure of what is free: when measured it did
    /// not show other programs' use of the card (see the module notes).
    pub budget: u64,
    /// What this process uses of it now.
    pub usage: u64,
}

impl VideoMemory {
    /// What is left of the budget. A usage above the budget leaves nothing — never a wrapped-around figure.
    pub fn free(&self) -> u64 {
        self.budget.saturating_sub(self.usage)
    }
}

/// One graphics adapter, as DXGI lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adapter {
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
    /// The adapter's locally unique identifier (high part, low part), which also names it in the GPU counters.
    pub luid: u64,
    /// Video memory that belongs to the adapter alone. An integrated GPU has little or none.
    pub dedicated: u64,
    /// A software renderer (such as the Microsoft Basic Render Driver): never a GPU for the engine.
    pub software: bool,
    /// `None` if the budget could not be read.
    pub video: Option<VideoMemory>,
    /// What every program on the computer holds of the adapter's own memory now, from Windows' GPU performance
    /// counters. `None` if they could not be read.
    pub in_use: Option<u64>,
}

impl Adapter {
    /// What the engine could have of the adapter's own memory now: the dedicated memory less what every program
    /// holds of it, and never more than what is left of this process's budget. `None` if either is not known.
    pub fn free_video_memory(&self) -> Option<u64> {
        let video = self.video?;
        let in_use = self.in_use?;
        Some(self.dedicated.saturating_sub(in_use).min(video.free()))
    }
}

/// What every program holds of the adapter with `luid`, from the GPU counters' instances and their values. An
/// adapter's instances are named `luid_0x<high>_0x<low>_phys_<n>`, one per physical part of it, and are added up.
/// `None` if no instance is that adapter's.
pub fn dedicated_in_use(luid: u64, instances: &[(String, u64)]) -> Option<u64> {
    let prefix = format!("luid_0x{:08x}_0x{:08x}_phys_", luid >> 32, luid & 0xFFFF_FFFF);
    let mut total: Option<u64> = None;
    for (name, bytes) in instances {
        let part = name.get(..prefix.len()).filter(|head| head.eq_ignore_ascii_case(&prefix)).map(|_| &name[prefix.len()..]);
        if part.is_some_and(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())) {
            total = Some(total.unwrap_or(0).saturating_add(*bytes));
        }
    }
    total
}

/// What the probe found. Each part is `None` if it could not be read; the classifier never guesses one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareReport {
    pub memory: Option<Memory>,
    /// Free bytes available to this user on the volume that holds the translation directory.
    pub disk_free: Option<u64>,
    pub adapters: Option<Vec<Adapter>>,
}

/// A GPU as the engine names it: the name `Execution::Gpu` takes, and its description. Nothing else from the
/// engine's list is kept (see the module notes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDevice {
    pub name: String,
    pub description: String,
}

/// The outcome of the hardware check for one model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fit {
    /// The whole model fits on this GPU; `device` is the engine's name for it.
    GpuFits { device: String },
    /// No GPU can take the whole model, and the CPU path has the memory it needs.
    CpuOnly { why: NoGpu },
    /// Not even the path that needs the least has enough system memory.
    InsufficientRam { needed: u64, available: u64 },
    /// What is still to be downloaded and installed does not fit on the disk.
    InsufficientDisk { needed: u64, available: u64 },
    /// Whether the GPU can take the model cannot be said safely. `cpu_offered`: the CPU path has the memory it needs.
    NotDetermined { why: Undetermined, cpu_offered: bool },
}

/// Why the GPU is not used, when that is certain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoGpu {
    /// The engine offers no GPU.
    NoEngineDevice,
    /// The adapter's own video memory is smaller than the model needs: an integrated GPU, or a small card.
    TooLittleDedicatedMemory { adapter: String, dedicated: u64, needed: u64 },
    /// The adapter's free video memory is smaller than the model needs: other programs hold the rest.
    TooLittleFreeMemory { adapter: String, free: u64, needed: u64 },
}

/// Why the outcome is not determined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Undetermined {
    /// The engine's device list was not given.
    DeviceListUnknown,
    /// The graphics adapters could not be read.
    AdaptersUnknown,
    /// The engine offers this many GPUs. Which to use is not decided.
    SeveralEngineDevices(usize),
    /// No hardware adapter has the name of the engine's GPU.
    NoMatchingAdapter(String),
    /// More than one hardware adapter has the name of the engine's GPU.
    SeveralMatchingAdapters(String),
    /// The matched adapter's free video memory could not be measured: its budget, or what all programs hold of it.
    VideoMemoryUnknown(String),
    /// The computer's memory could not be read.
    MemoryUnknown,
    /// Something is still to be downloaded, and the free disk space could not be read.
    DiskSpaceUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HardwareError {
    /// The hardware check exists on Windows only, like the engine itself.
    Unsupported,
    /// The artifact is not a model in the catalog.
    NotAModel,
    Io(String),
}

impl std::fmt::Display for HardwareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => write!(f, "the hardware check is not available on this platform"),
            Self::NotAModel => write!(f, "not a model in the catalog"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for HardwareError {}

/// Read the computer: its memory, the free space where `store_root` is, and its graphics adapters. Read-only.
pub fn probe(store_root: &Path) -> Result<HardwareReport, HardwareError> {
    #[cfg(windows)]
    {
        Ok(HardwareReport {
            memory: win::memory(),
            disk_free: super::download::available_space(store_root),
            adapters: win::adapters(),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = store_root;
        Err(HardwareError::Unsupported)
    }
}

/// Probe the computer and classify `model` for it: the whole check, for a caller that has the engine's device list
/// (`None` if it has not).
pub fn assess(store: &Store, spec: &EngineSpec, model: &Artifact, devices: Option<&[EngineDevice]>) -> Result<Fit, HardwareError> {
    let needs = catalog::needs(model).ok_or(HardwareError::NotAModel)?;
    let found = probe(store.root())?;
    let disk = disk_still_needed(store, spec, model).map_err(|e| HardwareError::Io(e.to_string()))?;
    Ok(classify(&needs, disk, &found, devices))
}

/// The bytes still to be downloaded and installed before `model` can run: the model, the runtime archive and the
/// installed engine, each counted in full unless it is already installed. A partial download is not subtracted, so
/// the figure errs on the side of more.
pub fn disk_still_needed(store: &Store, spec: &EngineSpec, model: &Artifact) -> io::Result<u64> {
    let mut needed = 0u64;
    for a in [model, spec.archive] {
        if store.state(a)? != State::Installed {
            needed = needed.saturating_add(a.size);
        }
    }
    if install::state(store, spec)? != EngineState::Installed {
        let files: u64 = spec.files.iter().map(|f| f.size).sum();
        needed = needed.saturating_add(files).saturating_add(spec.notices.len() as u64);
    }
    Ok(needed)
}

/// The GPUs in the engine's device list (`llama-server --list-devices`), by name and description.
///
/// The list is a header line, `Available devices:`, and one indented line per GPU:
/// `  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8024 MiB, 7256 MiB free)`. Anything before the header is ignored. After
/// it, a line that is not exactly of that form makes the whole list unreadable: a list that is only partly
/// understood is not used. The figures in brackets are checked for their form and then dropped.
pub fn parse_device_list(text: &str) -> Result<Vec<EngineDevice>, String> {
    let mut lines = text.lines();
    loop {
        match lines.next() {
            None => return Err("the device list has no \"Available devices:\" line".into()),
            Some(line) if line.trim_end() == "Available devices:" => break,
            Some(_) => {}
        }
    }
    let mut devices = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        devices.push(device_line(line).ok_or_else(|| format!("not a device line: {line:?}"))?);
    }
    Ok(devices)
}

fn device_line(line: &str) -> Option<EngineDevice> {
    if !line.starts_with(|c: char| c == ' ' || c == '\t') {
        return None;
    }
    let (name, rest) = line.trim().split_once(": ")?;
    // The same rule `engine_args` applies to a device name, so that whatever is found here can be started.
    let plain = !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !plain || name.eq_ignore_ascii_case("none") {
        return None;
    }
    let open = rest.rfind(" (")?;
    let (description, figures) = (rest[..open].trim(), &rest[open + 2..]);
    let (total, free) = figures.strip_suffix(" MiB free)")?.split_once(" MiB, ")?;
    let number = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    if description.is_empty() || !number(total) || !number(free) {
        return None;
    }
    Some(EngineDevice { name: name.to_string(), description: description.to_string() })
}

/// The outcome of the hardware check for a model with `needs`, when `disk_needed` bytes are still to be downloaded
/// and installed (`disk_still_needed`), on a computer the probe found to be `found`, whose engine offers `devices`
/// (`None` if that list is not known). Pure: the same inputs always give the same outcome.
pub fn classify(needs: &ModelNeeds, disk_needed: u64, found: &HardwareReport, devices: Option<&[EngineDevice]>) -> Fit {
    // 1. The files must fit before anything else matters. Nothing to fetch, nothing to check.
    if disk_needed > 0 {
        let needed = disk_needed.saturating_add(DISK_HEADROOM);
        match found.disk_free {
            None => return Fit::NotDetermined { why: Undetermined::DiskSpaceUnknown, cpu_offered: false },
            Some(available) if available < needed => return Fit::InsufficientDisk { needed, available },
            Some(_) => {}
        }
    }
    // 2. System memory, which both paths need.
    let Some(memory) = found.memory else {
        return Fit::NotDetermined { why: Undetermined::MemoryUnknown, cpu_offered: false };
    };
    let available = memory.available;
    let gpu_needed = needs.gpu_ram.saturating_add(RAM_HEADROOM);
    let cpu_needed = needs.cpu_ram.saturating_add(RAM_HEADROOM);
    let cpu_fits = available >= cpu_needed;
    // 3. The GPU, then the CPU.
    match gpu(needs, found.adapters.as_deref(), devices) {
        Gpu::Fits(device) if available >= gpu_needed => Fit::GpuFits { device },
        Gpu::Fits(_) => Fit::InsufficientRam { needed: gpu_needed, available },
        Gpu::Unusable(why) if cpu_fits => Fit::CpuOnly { why },
        Gpu::Unusable(_) => Fit::InsufficientRam { needed: cpu_needed, available },
        Gpu::Undetermined(_) if available < gpu_needed.min(cpu_needed) => {
            Fit::InsufficientRam { needed: gpu_needed.min(cpu_needed), available }
        }
        Gpu::Undetermined(why) => Fit::NotDetermined { why, cpu_offered: cpu_fits },
    }
}

enum Gpu {
    Fits(String),
    Unusable(NoGpu),
    Undetermined(Undetermined),
}

fn gpu(needs: &ModelNeeds, adapters: Option<&[Adapter]>, devices: Option<&[EngineDevice]>) -> Gpu {
    let device = match devices {
        None => return Gpu::Undetermined(Undetermined::DeviceListUnknown),
        Some([]) => return Gpu::Unusable(NoGpu::NoEngineDevice),
        Some([one]) => one,
        Some(several) => return Gpu::Undetermined(Undetermined::SeveralEngineDevices(several.len())),
    };
    let Some(adapters) = adapters else {
        return Gpu::Undetermined(Undetermined::AdaptersUnknown);
    };
    let named: Vec<&Adapter> = adapters.iter().filter(|a| !a.software && same_name(&a.description, &device.description)).collect();
    let adapter = match named.as_slice() {
        [] => return Gpu::Undetermined(Undetermined::NoMatchingAdapter(device.description.clone())),
        [one] => *one,
        _ => return Gpu::Undetermined(Undetermined::SeveralMatchingAdapters(device.description.clone())),
    };
    let needed = needs.gpu_vram.saturating_add(VRAM_HEADROOM);
    if adapter.dedicated < needed {
        return Gpu::Unusable(NoGpu::TooLittleDedicatedMemory {
            adapter: adapter.description.clone(),
            dedicated: adapter.dedicated,
            needed,
        });
    }
    let Some(free) = adapter.free_video_memory() else {
        return Gpu::Undetermined(Undetermined::VideoMemoryUnknown(adapter.description.clone()));
    };
    if free < needed {
        return Gpu::Unusable(NoGpu::TooLittleFreeMemory { adapter: adapter.description.clone(), free, needed });
    }
    Gpu::Fits(device.name.clone())
}

/// The engine and DXGI name a GPU the same way, from the same driver. Only surrounding spaces and letter case may
/// differ; anything else is a different name.
fn same_name(adapter: &str, device: &str) -> bool {
    adapter.trim().eq_ignore_ascii_case(device.trim())
}

#[cfg(windows)]
mod win {
    use windows::core::{w, Interface, PCWSTR};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND,
        DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY,
        PDH_MORE_DATA,
    };
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    use super::{dedicated_in_use, Adapter, Memory, VideoMemory};

    /// More adapters than any computer has; the list ends long before.
    const MAX_ADAPTERS: u32 = 64;

    pub fn memory() -> Option<Memory> {
        let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        // SAFETY: `status` is a MEMORYSTATUSEX whose length field is set, and it outlives the call.
        unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
        Some(Memory { total: status.ullTotalPhys, available: status.ullAvailPhys })
    }

    /// Every adapter DXGI lists, or `None` if the list cannot be read in full: an adapter missing from it could be
    /// the one the engine means.
    pub fn adapters() -> Option<Vec<Adapter>> {
        // SAFETY: creating a DXGI factory has no preconditions; the interface is released when dropped.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
        let in_use = dedicated_use_by_instance();
        let mut found = Vec::new();
        for i in 0..MAX_ADAPTERS {
            // SAFETY: enumeration by index on a live factory; DXGI_ERROR_NOT_FOUND ends the list.
            let adapter = match unsafe { factory.EnumAdapters1(i) } {
                Ok(adapter) => adapter,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => return Some(found),
                Err(_) => return None,
            };
            // SAFETY: a query of a live adapter, returning a plain struct.
            let desc = unsafe { adapter.GetDesc1() }.ok()?;
            let video = adapter.cast::<IDXGIAdapter3>().ok().and_then(|adapter| {
                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                // SAFETY: node 0 exists on every adapter, and `info` is a valid place for the answer for the
                // duration of the call.
                unsafe { adapter.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info) }.ok()?;
                Some(VideoMemory { budget: info.Budget, usage: info.CurrentUsage })
            });
            let name = &desc.Description[..desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len())];
            let luid = (u64::from(desc.AdapterLuid.HighPart as u32) << 32) | u64::from(desc.AdapterLuid.LowPart);
            found.push(Adapter {
                description: String::from_utf16_lossy(name).trim().to_string(),
                vendor_id: desc.VendorId,
                device_id: desc.DeviceId,
                luid,
                dedicated: desc.DedicatedVideoMemory as u64,
                software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
                video,
                in_use: in_use.as_deref().and_then(|instances| dedicated_in_use(luid, instances)),
            });
        }
        None
    }

    /// The query, closed whatever happens.
    struct Query(PDH_HQUERY);

    impl Drop for Query {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by PdhOpenQueryW and is closed exactly once.
            unsafe {
                let _ = PdhCloseQuery(self.0);
            }
        }
    }

    /// Every instance of the counter `\GPU Adapter Memory(*)\Dedicated Usage` — what all programs hold of each
    /// adapter's own memory — with its value in bytes; `None` if the counter cannot be read in full. One sample
    /// suffices: the counter is a plain amount, not a rate.
    fn dedicated_use_by_instance() -> Option<Vec<(String, u64)>> {
        let mut handle = PDH_HQUERY::default();
        // SAFETY: a local query on this computer; `handle` is a valid place for the handle.
        if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut handle) } != 0 {
            return None;
        }
        let query = Query(handle);
        let mut counter = PDH_HCOUNTER::default();
        // SAFETY: the path is a NUL-terminated wide literal; `counter` is a valid place for the handle.
        if unsafe { PdhAddEnglishCounterW(query.0, w!(r"\GPU Adapter Memory(*)\Dedicated Usage"), 0, &mut counter) } != 0 {
            return None;
        }
        // SAFETY: a live query.
        if unsafe { PdhCollectQueryData(query.0) } != 0 {
            return None;
        }
        let (mut size, mut count) = (0u32, 0u32);
        // SAFETY: asking only for the size the answer needs; no buffer is passed.
        if unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_LARGE, &mut size, &mut count, None) } != PDH_MORE_DATA {
            return None;
        }
        // The answer is the items followed by their names, all in one buffer; items keep it aligned.
        let item = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let mut buffer = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); (size as usize).div_ceil(item) + 1];
        let mut size = u32::try_from(buffer.len() * item).ok()?;
        // SAFETY: `buffer` holds at least `size` bytes, aligned for the items; PDH writes the items and their names
        // into it and nowhere else.
        if unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_LARGE, &mut size, &mut count, Some(buffer.as_mut_ptr())) } != 0 {
            return None;
        }
        if count as usize > buffer.len() {
            return None;
        }
        let mut found = Vec::new();
        for item in &buffer[..count as usize] {
            if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && item.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA {
                return None;
            }
            // SAFETY: PDH_FMT_LARGE was asked for, so the value is the 64-bit integer.
            let value = unsafe { item.FmtValue.Anonymous.largeValue };
            // SAFETY: the name is a NUL-terminated wide string inside `buffer`, which is still alive.
            let name = unsafe { item.szName.to_string() }.ok()?;
            found.push((name, u64::try_from(value).ok()?));
        }
        Some(found)
    }
}
