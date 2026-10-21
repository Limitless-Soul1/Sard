//! What the "Translation models" section shows, in one read: each model in the catalog with its state on disk, the
//! licence it comes under, what is still to be downloaded for it and the hardware check's two verdicts; and the
//! state of the runtime and of the engine installed from it.
//!
//! It downloads, installs, hashes and starts nothing. The only thing it may write is the translation directory's own
//! empty folders, the first time it is read (`Store::open`). The engine's device list is not asked for, because that
//! runs the engine: until a model has been prepared, the GPU verdict is "not determined" (`DeviceListUnknown`), and
//! the CPU verdict is the classifier's own.
//!
//! The types here are the interface's view, kept apart from the store's and the hardware check's own, so that a change
//! inside those modules does not silently change what the interface receives.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::catalog::{self, Kind, Licence, ENGINE_WINDOWS_X64};
use super::execution::Assessment;
use super::hardware::{self, Fit, HardwareError, HardwareReport, NoGpu, Undetermined};
use super::install::{self, EngineState};
use super::store::{State, Store};

/// Where translation keeps its files. `None` if the application-data directory could not be resolved at startup:
/// the section then has nothing to show, and the rest of Sard is unaffected.
pub struct Root(pub Option<PathBuf>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The catalog's models, in the catalog's order.
    pub models: Vec<ModelView>,
    /// The runtime archive, which is downloaded with the first model.
    pub runtime: StateView,
    /// The engine installed from that archive.
    pub engine: EngineView,
    /// Why the models have no hardware verdicts, when they have none.
    pub hardware_unavailable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: &'static str,
    pub size: u64,
    pub licence: LicenceView,
    /// The licence's terms must be accepted before the file may be downloaded (the catalog's rule for the Gemma Terms).
    pub licence_must_be_accepted: bool,
    pub state: StateView,
    /// The bytes still to be downloaded and installed before the model can run (the hardware check's own figure).
    pub disk_still_needed: u64,
    /// The verdict with the engine's GPUs, and on the CPU path alone, from one reading for every model.
    pub gpu: Option<FitView>,
    pub cpu: Option<FitView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenceView {
    GemmaTerms,
    Apache2,
    LlamaCppRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StateView {
    NotDownloaded,
    Interrupted { bytes: u64 },
    Installed,
    Unverified,
    Damaged { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum EngineView {
    NotInstalled,
    Installed,
    Unverified,
    Damaged { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum FitView {
    GpuFits { device: String },
    CpuOnly { why: NoGpuView },
    InsufficientRam { needed: u64, available: u64 },
    InsufficientDisk { needed: u64, available: u64 },
    NotDetermined { why: UndeterminedView, cpu_offered: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum NoGpuView {
    NoEngineDevice,
    TooLittleDedicatedMemory { adapter: String, dedicated: u64, needed: u64 },
    TooLittleFreeMemory { adapter: String, free: u64, needed: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum UndeterminedView {
    DeviceListUnknown,
    AdaptersUnknown,
    SeveralEngineDevices { count: usize },
    NoMatchingAdapter { name: String },
    SeveralMatchingAdapters { name: String },
    VideoMemoryUnknown { adapter: String },
    MemoryUnknown,
    DiskSpaceUnknown,
}

impl From<Licence> for LicenceView {
    fn from(l: Licence) -> Self {
        match l {
            Licence::GemmaTerms => Self::GemmaTerms,
            Licence::Apache2 => Self::Apache2,
            Licence::LlamaCppRuntime => Self::LlamaCppRuntime,
        }
    }
}

impl From<&State> for StateView {
    fn from(s: &State) -> Self {
        match s {
            State::NotDownloaded => Self::NotDownloaded,
            State::Interrupted { bytes } => Self::Interrupted { bytes: *bytes },
            State::Installed => Self::Installed,
            State::Unverified => Self::Unverified,
            State::Damaged { reason } => Self::Damaged { reason: reason.clone() },
        }
    }
}

impl From<&EngineState> for EngineView {
    fn from(s: &EngineState) -> Self {
        match s {
            EngineState::NotInstalled => Self::NotInstalled,
            EngineState::Installed => Self::Installed,
            EngineState::Unverified => Self::Unverified,
            EngineState::Damaged { reason } => Self::Damaged { reason: reason.clone() },
        }
    }
}

impl From<&Fit> for FitView {
    fn from(f: &Fit) -> Self {
        match f {
            Fit::GpuFits { device } => Self::GpuFits { device: device.clone() },
            Fit::CpuOnly { why } => Self::CpuOnly { why: why.into() },
            Fit::InsufficientRam { needed, available } => Self::InsufficientRam { needed: *needed, available: *available },
            Fit::InsufficientDisk { needed, available } => Self::InsufficientDisk { needed: *needed, available: *available },
            Fit::NotDetermined { why, cpu_offered } => Self::NotDetermined { why: why.into(), cpu_offered: *cpu_offered },
        }
    }
}

impl From<&NoGpu> for NoGpuView {
    fn from(n: &NoGpu) -> Self {
        match n {
            NoGpu::NoEngineDevice => Self::NoEngineDevice,
            NoGpu::TooLittleDedicatedMemory { adapter, dedicated, needed } => {
                Self::TooLittleDedicatedMemory { adapter: adapter.clone(), dedicated: *dedicated, needed: *needed }
            }
            NoGpu::TooLittleFreeMemory { adapter, free, needed } => {
                Self::TooLittleFreeMemory { adapter: adapter.clone(), free: *free, needed: *needed }
            }
        }
    }
}

impl From<&Undetermined> for UndeterminedView {
    fn from(u: &Undetermined) -> Self {
        match u {
            Undetermined::DeviceListUnknown => Self::DeviceListUnknown,
            Undetermined::AdaptersUnknown => Self::AdaptersUnknown,
            Undetermined::SeveralEngineDevices(count) => Self::SeveralEngineDevices { count: *count },
            Undetermined::NoMatchingAdapter(name) => Self::NoMatchingAdapter { name: name.clone() },
            Undetermined::SeveralMatchingAdapters(name) => Self::SeveralMatchingAdapters { name: name.clone() },
            Undetermined::VideoMemoryUnknown(adapter) => Self::VideoMemoryUnknown { adapter: adapter.clone() },
            Undetermined::MemoryUnknown => Self::MemoryUnknown,
            Undetermined::DiskSpaceUnknown => Self::DiskSpaceUnknown,
        }
    }
}

/// The overview of the store at `root`, with the computer read once by `probe` (in the app, `hardware::probe`).
pub fn overview(root: &Path, probe: impl Fn(&Path) -> Result<HardwareReport, HardwareError>) -> io::Result<Overview> {
    let store = Store::open(root)?;
    let spec = &ENGINE_WINDOWS_X64;
    let found = probe(store.root());
    let mut models = Vec::new();
    for a in catalog::ALL.iter().filter(|a| a.kind == Kind::Model) {
        let needs = catalog::needs(a).ok_or_else(|| io::Error::other(format!("{}: the catalog gives no requirements", a.id)))?;
        let disk_still_needed = hardware::disk_still_needed(&store, spec, a)?;
        let (gpu, cpu) = match &found {
            Ok(report) => {
                let assessed = Assessment::of(a.id, &needs, disk_still_needed, report, None);
                (Some(assessed.gpu().into()), Some(assessed.cpu().into()))
            }
            Err(_) => (None, None),
        };
        models.push(ModelView {
            id: a.id,
            size: a.size,
            licence: a.licence.into(),
            licence_must_be_accepted: a.licence == Licence::GemmaTerms,
            state: (&store.state(a)?).into(),
            disk_still_needed,
            gpu,
            cpu,
        });
    }
    Ok(Overview {
        models,
        runtime: (&store.state(spec.archive)?).into(),
        engine: (&install::state(&store, spec)?).into(),
        hardware_unavailable: found.err().map(|e| e.to_string()),
    })
}

/// The models section's overview. Read-only (see the module notes); the hardware is read on a blocking thread.
#[tauri::command]
pub async fn translation_models(root: tauri::State<'_, Root>) -> Result<Overview, String> {
    let root = root.0.clone().ok_or("the translation directory could not be found")?;
    tauri::async_runtime::spawn_blocking(move || overview(&root, hardware::probe))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
