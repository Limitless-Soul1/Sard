//! How a translation runs: on the GPU or on the CPU, chosen from the user's preference and the hardware check.
//!
//! Three parts, each small enough to test on its own:
//!
//! * **The preference** (`Preference`), kept under one settings key, `translation_execution`: `auto` (the default),
//!   `gpu` or `cpu`. A missing value, or anything that is not exactly one of the three, is read as `auto`.
//! * **The decision** (`decide`), a pure function of the preference and a fresh hardware assessment (`Assessment`,
//!   the S3 check run twice on one reading: once with the engine's GPUs, once with none). It returns one of three
//!   things: run on this path; the CPU can run it, but only with the user's consent; or refused, with what would
//!   work instead, if anything.
//! * **The start** (`start`, built on `start_with`), which assesses the hardware again immediately before every
//!   start, decides again, and starts the engine only when that fresh decision allows it.
//!
//! Nothing here is reachable from the interface yet. The future screens read `decide`'s result to explain the
//! choice, ask for consent with a `ConsentRequest`, and call `start` with the `Consent` the user gave.
//!
//! ## The rules
//!
//! * **`auto`:** the GPU when the hardware check confirms it can take the model. When it cannot, or cannot say,
//!   and the CPU can, the CPU — but **never without the user's consent**: falling back to the CPU is the user's
//!   choice (the translation design's decision D5), so `auto` asks rather than switches. When neither path can
//!   run, refused.
//! * **`gpu`:** the GPU only when the check confirms it. Otherwise refused, with the CPU named as the alternative
//!   when it can run — never switched to.
//! * **`cpu`:** the CPU whenever its path can run, even when the GPU is recommended: the user's choice stands, and
//!   the recommendation is only reported. Otherwise refused, with the GPU named as the alternative when it fits.
//! * **The whole model on one GPU, or the CPU.** There is no partial offload anywhere here.
//! * **Nothing here measures anything.** Every verdict is the hardware check's; in particular, whether the GPU fits
//!   never comes from the engine's own "free memory" figure, which the check never reads.
//!
//! ## Consent
//!
//! Consent is given to one `ConsentRequest`: for one model, to run on the CPU, for one reason the GPU is not used.
//! A `Consent` authorises a start only while a fresh decision asks for exactly that again, and only for
//! `CONSENT_LIFETIME` after it was given. A consent for another model, another reason, or an earlier situation —
//! or a decision that no longer needs consent at all — authorises nothing: the start is not made, and the fresh
//! decision is returned so that the user can be asked again. In particular, a consent to the CPU never becomes a
//! start on the GPU, nor the other way round.

use std::time::{Duration, Instant};

use rusqlite::Connection;

use super::catalog::{self, Artifact, EngineSpec};
use super::engine::{EngineError, EngineInfo, EngineManager, Execution, NotLaunched};
use super::hardware::{classify, disk_still_needed, probe, EngineDevice, Fit, HardwareError, NoGpu, Undetermined};
use super::store::Store;

/// The settings key the preference is kept under.
pub const PREFERENCE_KEY: &str = "translation_execution";

/// The CPU threads a CPU translation is given. PROVISIONAL: the fewest measured — two threads disturbed reading the
/// least (+48 ms on the heaviest jump, against +158 ms at six), and the translations are identical at any count
/// (the evaluation, on one PC). Not configurable yet.
pub const CPU_THREADS: u16 = 2;

/// How long a consent stays good after it was given. It is meant for the start that follows the user's answer at
/// once, not for one made later.
pub const CONSENT_LIFETIME: Duration = Duration::from_secs(120);

/// How the user wants translation to run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Preference {
    /// The GPU when the hardware check confirms it; otherwise the CPU, with the user's consent.
    #[default]
    Auto,
    /// The GPU only.
    Gpu,
    /// The CPU only.
    Cpu,
}

impl Preference {
    /// The stored form.
    pub fn as_str(self) -> &'static str {
        match self {
            Preference::Auto => "auto",
            Preference::Gpu => "gpu",
            Preference::Cpu => "cpu",
        }
    }

    /// The preference a stored value stands for. Exactly `auto`, `gpu` or `cpu`; anything else — nothing stored,
    /// another spelling, another word — is `Auto`, the safe default.
    pub fn from_stored(value: Option<&str>) -> Preference {
        match value {
            Some("gpu") => Preference::Gpu,
            Some("cpu") => Preference::Cpu,
            _ => Preference::Auto,
        }
    }
}

/// The stored preference. A value that is missing or not understood is `Auto`; a database that cannot be read is
/// an error, as with every other setting.
pub fn load_preference(conn: &Connection) -> rusqlite::Result<Preference> {
    Ok(Preference::from_stored(crate::settings::get(conn, PREFERENCE_KEY)?.as_deref()))
}

/// Store the preference. Only the three valid values can be written.
pub fn save_preference(conn: &Connection, preference: Preference) -> rusqlite::Result<()> {
    crate::settings::set(conn, PREFERENCE_KEY, preference.as_str())
}

/// Where a translation runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Path {
    /// Every layer of the model on this GPU, by the engine's name for it.
    Gpu { device: String },
    /// The CPU, with `CPU_THREADS` threads.
    Cpu,
}

impl Path {
    /// How the engine is started for this path.
    pub fn execution(&self) -> Execution {
        match self {
            Path::Gpu { device } => Execution::Gpu { device: device.clone() },
            Path::Cpu => Execution::Cpu { threads: CPU_THREADS },
        }
    }
}

/// The hardware check's two verdicts for one model, from one reading of the computer: with the engine's GPUs, and
/// with none — the CPU path alone. Made only by `Assessment::of`, so that the two always come from the same reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    model: String,
    gpu: Fit,
    cpu: Fit,
}

impl Assessment {
    /// Classify `model` (with `needs`) on what the probe `found`, with `disk_needed` bytes still to fetch, whose engine
    /// offers `devices` (`None` if that list is not known).
    pub fn of(model: &str, needs: &catalog::ModelNeeds, disk_needed: u64, found: &super::hardware::HardwareReport, devices: Option<&[EngineDevice]>) -> Assessment {
        Assessment {
            model: model.to_string(),
            gpu: classify(needs, disk_needed, found, devices),
            cpu: classify(needs, disk_needed, found, Some(&[])),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// The verdict with the engine's GPUs: `GpuFits` is the only confirmation the GPU can take the model.
    pub fn gpu(&self) -> &Fit {
        &self.gpu
    }

    /// The verdict on the CPU path alone: `CpuOnly` means it can run.
    pub fn cpu(&self) -> &Fit {
        &self.cpu
    }

    fn gpu_device(&self) -> Option<&str> {
        match &self.gpu {
            Fit::GpuFits { device } => Some(device),
            _ => None,
        }
    }

    fn cpu_runs(&self) -> bool {
        matches!(self.cpu, Fit::CpuOnly { .. })
    }
}

/// Probe the computer and assess `model` for it, with the engine's device list if it could be had.
pub fn assess(store: &Store, spec: &EngineSpec, model: &Artifact, devices: Option<&[EngineDevice]>) -> Result<Assessment, HardwareError> {
    let needs = catalog::needs(model).ok_or(HardwareError::NotAModel)?;
    let found = probe(store.root())?;
    let disk = disk_still_needed(store, spec, model).map_err(|e| HardwareError::Io(e.to_string()))?;
    Ok(Assessment::of(model.id, &needs, disk, &found, devices))
}

/// What may happen, for one preference and one assessment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Start on `path`. `gpu_recommended` names the GPU when the user chose the CPU although the GPU can take the
    /// model: reported, never acted on.
    Run { path: Path, gpu_recommended: Option<String> },
    /// The CPU can run the model, but only if the user agrees: the GPU is not used, for the reason in the request.
    NeedsConsent(ConsentRequest),
    /// Nothing is started. `why` is the hardware check's verdict for the path that was asked for (in `auto`, the CPU
    /// path, the last one tried); `alternative` is the other path, when it can run — offered, never taken.
    Refused { why: Fit, alternative: Option<Path> },
}

/// What the user is asked to agree to: running `model` on the CPU, because the GPU is not used for `gpu_verdict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentRequest {
    pub model: String,
    pub path: Path,
    /// The hardware check's verdict on the GPU path: why the GPU is not used.
    pub gpu_verdict: Fit,
}

impl ConsentRequest {
    /// The user's consent to this request, given at `at`.
    pub fn grant(&self, at: Instant) -> Consent {
        Consent { basis: Basis::of(self), granted: at }
    }
}

/// A consent the user gave. It can be made only from a `ConsentRequest`, and holds only what it was given to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    basis: Basis,
    granted: Instant,
}

impl Consent {
    /// Whether this consent covers `request` at `now`: the same model, path and reason, and not expired.
    pub fn covers(&self, request: &ConsentRequest, now: Instant) -> bool {
        self.basis == Basis::of(request)
            && now.checked_duration_since(self.granted).is_some_and(|age| age <= CONSENT_LIFETIME)
    }
}

/// What a consent is tied to: the model, the path, and the reason the GPU is not used — without the figures that
/// change from one reading to the next (free memory), so that the same situation a moment later is still the same.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Basis {
    model: String,
    path: Path,
    reason: Reason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Reason {
    NoEngineDevice,
    TooLittleDedicatedMemory(String),
    TooLittleFreeMemory(String),
    Undetermined(Undetermined),
    /// Any other verdict: it can only be the same situation if it is the same verdict.
    Other(Fit),
}

impl Basis {
    fn of(request: &ConsentRequest) -> Basis {
        let reason = match &request.gpu_verdict {
            Fit::CpuOnly { why: NoGpu::NoEngineDevice } => Reason::NoEngineDevice,
            Fit::CpuOnly { why: NoGpu::TooLittleDedicatedMemory { adapter, .. } } => Reason::TooLittleDedicatedMemory(adapter.clone()),
            Fit::CpuOnly { why: NoGpu::TooLittleFreeMemory { adapter, .. } } => Reason::TooLittleFreeMemory(adapter.clone()),
            Fit::NotDetermined { why, .. } => Reason::Undetermined(why.clone()),
            other => Reason::Other(other.clone()),
        };
        Basis { model: request.model.clone(), path: request.path.clone(), reason }
    }
}

/// The decision for `preference` on `assessment`. Pure: the same inputs always give the same decision.
pub fn decide(preference: Preference, assessment: &Assessment) -> Decision {
    let gpu = assessment.gpu_device().map(|device| Path::Gpu { device: device.to_string() });
    let cpu_runs = assessment.cpu_runs();
    match preference {
        Preference::Auto => match gpu {
            Some(path) => Decision::Run { path, gpu_recommended: None },
            None if cpu_runs => Decision::NeedsConsent(ConsentRequest {
                model: assessment.model.clone(),
                path: Path::Cpu,
                gpu_verdict: assessment.gpu.clone(),
            }),
            None => Decision::Refused { why: assessment.cpu.clone(), alternative: None },
        },
        Preference::Gpu => match gpu {
            Some(path) => Decision::Run { path, gpu_recommended: None },
            None => Decision::Refused { why: assessment.gpu.clone(), alternative: cpu_runs.then_some(Path::Cpu) },
        },
        Preference::Cpu if cpu_runs => {
            Decision::Run { path: Path::Cpu, gpu_recommended: assessment.gpu_device().map(str::to_string) }
        }
        Preference::Cpu => Decision::Refused { why: assessment.cpu.clone(), alternative: gpu },
    }
}

/// Why a start was not made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotStarted {
    /// The computer could not be read at all (on another platform: `HardwareError::Unsupported`).
    Assessment(HardwareError),
    /// The CPU can run the model, with the user's consent, and none that covers this was given.
    NeedsConsent(ConsentRequest),
    /// The fresh decision refuses the start.
    Refused { why: Fit, alternative: Option<Path> },
    /// A consent was given, but it does not cover what the fresh decision is: another situation, another model, an
    /// expired consent, or a decision that now needs no consent — on another path. The user is asked again.
    ConsentDoesNotApply(Decision),
    /// The decision allowed the start, and the engine itself failed — or the start cannot be made at all: the engine
    /// is not installed, an engine is already running or starting, its runtime is missing or too old, a stop ended
    /// the start (`EngineError::Cancelled`).
    Engine(EngineError),
}

/// The path the fresh decision allows for `assessment`, or why none: the decision, and the consent rules.
fn authorise(preference: Preference, consent: Option<&Consent>, now: Instant, assessment: &Assessment) -> Result<Path, NotStarted> {
    let decision = decide(preference, assessment);
    match &decision {
        // A consent was given to the CPU. A decision that needs none is fine on that same path, never on another.
        Decision::Run { path, .. } if consent.is_some_and(|c| c.basis.path != *path) => Err(NotStarted::ConsentDoesNotApply(decision.clone())),
        Decision::Run { path, .. } => Ok(path.clone()),
        Decision::NeedsConsent(request) => match consent {
            Some(c) if c.covers(request, now) => Ok(request.path.clone()),
            Some(_) => Err(NotStarted::ConsentDoesNotApply(decision.clone())),
            None => Err(NotStarted::NeedsConsent(request.clone())),
        },
        Decision::Refused { why, alternative } => Err(NotStarted::Refused { why: why.clone(), alternative: alternative.clone() }),
    }
}

/// The start, with its two effects given: `assess` reads the computer now, and `launch` starts the engine.
///
/// `assess` is called exactly once, before anything else: no earlier assessment can authorise this start. `launch`
/// is called at most once, and only when the fresh decision is to run — or needs a consent that `consent` covers at
/// `now`. Every other outcome returns without starting anything.
pub fn start_with(
    preference: Preference,
    consent: Option<&Consent>,
    now: Instant,
    assess: impl FnOnce() -> Result<Assessment, HardwareError>,
    launch: impl FnOnce(Execution) -> Result<EngineInfo, EngineError>,
) -> Result<(Path, EngineInfo), NotStarted> {
    let assessment = assess().map_err(NotStarted::Assessment)?;
    let path = authorise(preference, consent, now, &assessment)?;
    let info = launch(path.execution()).map_err(NotStarted::Engine)?;
    Ok((path, info))
}

/// What a start can use of the engine's device list: the GPUs it offers, or `None` when the list itself could not
/// be had or understood (`DeviceListFailed`) — the GPU is then not determined, and the hardware check's policy
/// applies. Any other error means that no start can be made, on any path — the engine is not installed or not as it
/// was installed, its runtime is missing or too old, it could not be run, another engine is active, a stop ended
/// the start — and it is returned as it is, so that nobody is asked to agree to a start that would fail anyway.
pub fn discovered(listing: Result<Vec<EngineDevice>, EngineError>) -> Result<Option<Vec<EngineDevice>>, EngineError> {
    match listing {
        Ok(devices) => Ok(Some(devices)),
        Err(EngineError::DeviceListFailed(_)) => Ok(None),
        Err(other) => Err(other),
    }
}

/// Start `model` with `manager` the way `preference` says, asking the engine for its GPUs and assessing the computer
/// immediately before — all of it one start of the manager's (`EngineManager::start_after_listing`), so that a stop
/// at any point ends it. Load the preference right before calling (`load_preference`), and do not hold the database
/// while this runs: a start can take minutes.
///
/// If the engine's device list cannot be had, the GPU is not determined: never assumed. If the engine cannot be
/// started at all, that is the answer (`NotStarted::Engine`), and no consent is asked for.
pub fn start(
    manager: &EngineManager,
    store: &Store,
    spec: &EngineSpec,
    model: &Artifact,
    preference: Preference,
    consent: Option<&Consent>,
) -> Result<(Path, EngineInfo), NotStarted> {
    start_using(manager, store, spec, model, preference, consent, |devices| assess(store, spec, model, devices))
}

/// `start`, with the reading of the computer given: `assess` is called once, after the listing, with the engine's
/// GPUs (`None` if they could not be had) — and not at all if the start cannot be made.
pub(crate) fn start_using(
    manager: &EngineManager,
    store: &Store,
    spec: &EngineSpec,
    model: &Artifact,
    preference: Preference,
    consent: Option<&Consent>,
    assess: impl FnOnce(Option<&[EngineDevice]>) -> Result<Assessment, HardwareError>,
) -> Result<(Path, EngineInfo), NotStarted> {
    let started = manager.start_after_listing(store, spec, model, |listing| {
        let devices = discovered(listing).map_err(NotStarted::Engine)?;
        let assessment = assess(devices.as_deref()).map_err(NotStarted::Assessment)?;
        // The consent is judged when the decision is made, after the listing.
        authorise(preference, consent, Instant::now(), &assessment).map(|path| path.execution())
    });
    match started {
        Ok(info) => {
            let path = match &info.execution {
                Execution::Gpu { device } => Path::Gpu { device: device.clone() },
                Execution::Cpu { .. } => Path::Cpu,
            };
            Ok((path, info))
        }
        Err(NotLaunched::Declined(why)) => Err(why),
        Err(NotLaunched::Engine(error)) => Err(NotStarted::Engine(error)),
    }
}
