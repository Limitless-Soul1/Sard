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

use super::active::{self, Active};
use super::catalog::{self, Licence};
use super::execution::Assessment;
use super::hardware::{self, Fit, HardwareError, HardwareReport, NoGpu, Undetermined};
use super::install::{self, EngineState};
use super::manage::{self, InUseBy, LicenceStatus};
use super::store::{State, Store};

/// Where translation keeps its files. `dir` is `None` if the application-data directory could not be resolved at
/// startup: the section then has nothing to show, and the rest of Sard is unaffected. `isolated`: a development run
/// moved its data (`SARD_DATA_DIR`), which a test catalog requires.
pub struct Root {
    pub dir: Option<PathBuf>,
    pub isolated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The catalog's models, in the catalog's order.
    pub models: Vec<ModelView>,
    /// The runtime archive, which is downloaded with the first model.
    pub runtime: StateView,
    /// The runtime archive's size.
    pub runtime_size: u64,
    /// The engine installed from that archive.
    pub engine: EngineView,
    /// Why the models have no hardware verdicts, when they have none.
    pub hardware_unavailable: Option<String>,
    /// The translation engine exists for this platform (Windows x64 only).
    pub supported: bool,
    /// A development build's test catalog is in use.
    pub test_catalog: bool,
    /// The models a fetch is running for now (filled by the command; a reopened section shows them as busy).
    pub fetching: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: &'static str,
    pub size: u64,
    pub licence: LicenceView,
    /// The licence's terms must be accepted before the file may be downloaded (the catalog's rule for the Gemma Terms).
    pub licence_must_be_accepted: bool,
    /// Whether those terms are accepted in their current revision.
    pub licence_status: LicenceStatusView,
    /// This build carries the text of those terms. Without it they cannot be accepted, and the model not fetched.
    pub terms_available: bool,
    pub state: StateView,
    /// The bytes still to be downloaded and installed before the model can run (the hardware check's own figure).
    pub disk_still_needed: u64,
    /// The free disk space was read and is less than that, with the check's margin: exact arithmetic, not an estimate.
    pub not_enough_disk: bool,
    /// What has the model in use now, if anything.
    pub in_use: Option<InUseView>,
    /// The verdict with the engine's GPUs, and on the CPU path alone, from one reading for every model.
    pub gpu: Option<FitView>,
    pub cpu: Option<FitView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum LicenceStatusView {
    NotRequired,
    Accepted { revision: String, at: i64 },
    Missing { revision: String },
    Stale { revision: String, accepted: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InUseView {
    Translation,
    Engine,
}

impl From<&LicenceStatus> for LicenceStatusView {
    fn from(s: &LicenceStatus) -> Self {
        match s {
            LicenceStatus::NotRequired => Self::NotRequired,
            LicenceStatus::Accepted { revision, at } => Self::Accepted { revision: revision.to_string(), at: *at },
            LicenceStatus::Missing { revision } => Self::Missing { revision: revision.to_string() },
            LicenceStatus::Stale { revision, accepted } => Self::Stale { revision: revision.to_string(), accepted: accepted.clone() },
        }
    }
}

impl From<InUseBy> for InUseView {
    fn from(b: InUseBy) -> Self {
        match b {
            InUseBy::Translation => Self::Translation,
            InUseBy::Engine => Self::Engine,
        }
    }
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

/// The overview of the store at `root` for the catalog `active`, with each licence's acceptance read by `licence` and
/// the computer read once by `probe` (in the app, `hardware::probe`).
pub fn overview(
    root: &Path,
    active: &Active,
    licence: &dyn Fn(Licence) -> Result<LicenceStatus, String>,
    probe: impl Fn(&Path) -> Result<HardwareReport, HardwareError>,
) -> io::Result<Overview> {
    let store = Store::open(root)?;
    let spec = active.spec;
    let found = probe(store.root());
    let mut models = Vec::new();
    for a in &active.models {
        let needs = catalog::needs(a).ok_or_else(|| io::Error::other(format!("{}: the catalog gives no requirements", a.id)))?;
        let disk_still_needed = hardware::disk_still_needed(&store, spec, a)?;
        let (gpu, cpu) = match &found {
            Ok(report) => {
                let assessed = Assessment::of(a.id, &needs, disk_still_needed, report, None);
                (Some(assessed.gpu().into()), Some(assessed.cpu().into()))
            }
            Err(_) => (None, None),
        };
        let status = licence(a.licence).map_err(io::Error::other)?;
        models.push(ModelView {
            id: a.id,
            size: a.size,
            licence: a.licence.into(),
            licence_must_be_accepted: manage::terms_revision(a.licence).is_some(),
            licence_status: (&status).into(),
            terms_available: manage::terms(a.licence).is_some(),
            state: (&store.state(a)?).into(),
            disk_still_needed,
            not_enough_disk: matches!(gpu, Some(FitView::InsufficientDisk { .. })),
            in_use: manage::in_use(a.id).map(Into::into),
            gpu,
            cpu,
        });
    }
    Ok(Overview {
        models,
        runtime: (&store.state(spec.archive)?).into(),
        runtime_size: spec.archive.size,
        engine: (&install::state(&store, spec)?).into(),
        hardware_unavailable: found.err().map(|e| e.to_string()),
        supported: cfg!(all(windows, target_arch = "x86_64")),
        test_catalog: active.test,
        fetching: Vec::new(),
    })
}

/// The models section's overview. Read-only (see the module notes); the hardware is read on a blocking thread.
#[tauri::command]
pub async fn translation_models(root: tauri::State<'_, Root>, app: tauri::State<'_, crate::db::AppState>) -> Result<Overview, String> {
    let dir = root.dir.clone().ok_or("the translation directory could not be found")?;
    let active = active::active()?;
    // The acceptances, read now and briefly: the overview itself runs on another thread.
    let statuses = {
        let conn = app.conn();
        [Licence::GemmaTerms, Licence::Apache2, Licence::LlamaCppRuntime]
            .map(|l| (l, manage::licence_status(&conn, l).map_err(|e| e.to_string())))
    };
    tauri::async_runtime::spawn_blocking(move || {
        let licence = |l: Licence| statuses.iter().find(|(k, _)| *k == l).map(|(_, s)| s.clone()).unwrap_or_else(|| Err("unknown licence".into()));
        overview(&dir, &active, &licence, hardware::probe)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|mut o| {
        o.fetching = super::model_commands::running();
        o
    })
    .map_err(|e| e.to_string())
}
