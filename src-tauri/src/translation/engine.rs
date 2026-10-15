//! The inference engine process: started on request, locked down, checked, and never left behind.
//!
//! Windows only. On any other platform `EngineManager::start` returns `EngineError::Unsupported`; shared code
//! compiling there is not support.
//!
//! ## What a start does, in order
//!
//! 1. Takes the process-wide engine slot: one engine at a time, never during an installation.
//! 2. Re-verifies the installed engine (`install::verify`: the record, the exact file set, no links, every
//!    SHA-256) and keeps every file held open, so that none can be changed or replaced from then until the
//!    engine has exited. Checks that the model is installed, and holds it the same way: opened as itself,
//!    proved from that handle to be a plain file with no other name, exactly where the store keeps it and of
//!    its size — and from then until the engine has exited, no other handle can open it for writing, delete
//!    it, or rename it or a folder above it. A model that some program already has open for writing cannot
//!    be held, and nothing is started (`ModelNotHeld`). Checks that the Visual C++ runtime the engine needs
//!    is present and recent enough.
//! 3. Starts `llama-server.exe` from its own directory, which is also its working directory: ggml loads backend
//!    libraries from both. The process is started
//!    * suspended and without a console window;
//!    * with a cleared environment: only the variables in `PASSED_ENV`, a fixed `PATH`, and the session key;
//!    * then attached to a kill-on-close Job Object;
//!    * and resumed only after its directory has been checked once more for anything ADDED to it.
//!
//!    So it never runs a single instruction outside the job, and it cannot outlive this process.
//! 4. Finds the port it bound in the operating system's table of that process's listening sockets. The engine
//!    is given `--port 0` and binds a free port itself, so there is no window between choosing a port and
//!    binding it. (It prints its address only after the model has loaded, so its log cannot be used for this.)
//!    A listener anywhere but 127.0.0.1 ends the start at once.
//! 5. Waits for `/health` to report the model loaded, then refuses the engine unless every self-check passes:
//!    * its TCP listeners are all on 127.0.0.1;
//!    * a request without the key is rejected;
//!    * CORS names only the closed origin;
//!    * there is no web UI;
//!    * the slots endpoint, tools and the proxy each report themselves switched off;
//!    * its directory still holds exactly its own files.
//! 6. Sends one short, deterministic completion — the readiness probe. Only a successful probe makes the
//!    engine ready. Nothing ever falls back to the CPU or to another model.
//!
//! ## The session key
//!
//! 32 bytes from the operating system's secure random source, new for every start. It reaches the engine only
//! through the `LLAMA_API_KEY` environment variable — never the command line, and never a file. It is not
//! written to disk anywhere.
//!
//! The engine prints a hint of it only at trace level (the last four characters), and it is started at
//! `-lv 3` (info), so that line is never produced. Every captured log line is redacted anyway, and no error
//! carries the key.
//!
//! ### Who the key keeps out, and who it does not
//!
//! The engine listens on 127.0.0.1, which every program on the computer can connect to. The key decides who
//! gets an answer.
//!
//! * **Not a program running as the same Windows user.** Such a program can read the key out of the engine's
//!   environment — shown with a stand-in process, not assumed — or out of Sard's own memory. It could as
//!   easily read the user's books and everything Sard does. The key is no defence against it, and none is
//!   claimed. The environment is still the best of the three channels the engine offers: the command line is
//!   shown by ordinary tools, Task Manager among them, and a key file would put the key on disk.
//! * **Something that can reach the port but cannot read this user's processes.** A page in a web browser is
//!   the case that matters: it can send requests to 127.0.0.1, gets 401 without the key, and CORS names an
//!   origin no page has.
//! * **Another Windows account on the same computer** can connect to the port too. Whether it can read the
//!   key rests on Windows' default process permissions, which do not let one ordinary account open another's
//!   processes. That default was not tested here, and an administrator can always read it.
//!
//! ## What a start takes on trust
//!
//! What the steps above do not cover. None of it gives a program anything Windows would otherwise deny it;
//! it is listed so that nothing above is read as covering it.
//!
//! * **The model's contents.** The model was hashed in full when its download was verified. At launch its
//!   record, its size and its place are checked, and from then on it is held, so it cannot change while the
//!   engine may read it. Its bytes are not hashed again: a file of the same size put in its place while Sard
//!   was not holding it — before the launch — is loaded.
//! * **What the engine does with the model.** Holding it denies other handles writing, deleting and
//!   renaming. That the real engine reads its model while held this way is INFERRED — it opens it for reading
//!   only, as it does the engine files it was seen to load while they were held — and was shown with the
//!   stand-in engine, not the real one.
//! * **A file that comes and goes.** The engine's directory is checked before the process runs its first
//!   instruction and again once it has loaded everything. A file added after the first check and removed
//!   before the second is not seen.
//! * **Handles marked to be inherited.** The engine is not limited to a list of handles (the standard library
//!   has no stable way to pass one), so it receives every handle that anything in this process has marked
//!   inheritable. A file opened the ordinary way is not marked, and the engine does not get it.
//! * **One Sard.** The engine slot belongs to this process. Two processes sharing one data directory could
//!   each start an engine; Sard runs as a single instance, and nothing here adds to that.

// The process code is Windows-only; elsewhere only the types and the pure helpers are compiled.
#![cfg_attr(not(windows), allow(dead_code, unused_imports, unused_mut, unused_variables))]

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::catalog::{launch_profile, Artifact, EngineSpec, LaunchProfile};
use super::install::{self, VerifiedEngine};
use super::slot::{self, Holder, SlotGuard};
use super::store::{random_hex, State as ArtifactState, Store};

pub const LOOPBACK: &str = "127.0.0.1";
/// A CORS origin no page can have: `.invalid` is reserved and never resolves. The engine sends any value other
/// than `*` or `localhost` back literally as the only allowed origin.
pub const CLOSED_CORS_ORIGIN: &str = "http://sard.invalid";

/// Flags every engine is started with, whatever the model.
pub const SECURITY_FLAGS: &[&str] = &[
    "--host",
    LOOPBACK,
    "--port",
    "0",
    "--no-webui",
    "--no-slots",
    "--no-cors-credentials",
    "--cors-origins",
    CLOSED_CORS_ORIGIN,
    "--no-agent",
    "--no-ui-mcp-proxy",
    "--offline",
    "-lv",
    "3",
];

/// The only inherited variables the engine receives (compared without regard to case, as Windows does).
/// Everything else — `LLAMA_*` and `GGML_*` (each server option has such a twin), `OMP_*`/`KMP_*` (thread
/// behaviour), `VK_*` (the Vulkan loader can be pointed at extra layers), proxies, and `PATH` itself — is
/// dropped. `PATH` is replaced with the system directories.
pub const PASSED_ENV: &[&str] = &[
    "SystemRoot",
    "windir",
    "SystemDrive",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
];

/// The Visual C++ runtime the engine imports and Sard itself does not.
///
/// All but one of the engine's binaries import from these three, and from nothing else that is not part of
/// Windows (read from their import tables). They are not in the engine's archive, and Sard does not install
/// them: it never downloads or installs the runtime, and never falls back to anything else.
///
/// What happens without a suitable runtime is settled before anything is launched — no process is created, so
/// neither Windows nor the engine has any occasion to fail in a way of its own:
/// * **A file missing from the system directory:** `EngineError::MissingVcRuntime`, naming it. (A runtime from
///   2015 or 2017 has no `VCRUNTIME140_1.dll`, so it is reported this way.)
/// * **Present, but older than the engine spec's minimum:** `EngineError::VcRuntimeTooOld`, naming the file, the
///   version found and the version needed. Being present is not enough: Windows would load the engine with an
///   old runtime, and by Microsoft's account the engine may then fail inside it. The engine spec sets out what
///   is documented, what was read from the build, and what is assumed.
/// * **Present, but its version cannot be read:** treated as too old. Nothing is assumed about a runtime that
///   cannot be identified.
///
/// The version is read from the files themselves, in the system directory. That is the only place the engine
/// can take them from — its own directory holds exactly its pinned files, and its `PATH` is the system
/// directories only — so the files read are the files that would be loaded.
///
/// `EngineError::recovery` says what to install. Sard reports; the user installs.
pub const VC_RUNTIME: &[&str] = &["MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"];

/// What the user is told to install when the runtime is missing or too old, and where Microsoft publishes its
/// latest supported version. Sard never fetches this itself.
pub const VC_RUNTIME_PRODUCT: &str = "Microsoft Visual C++ Redistributable (x64)";
pub const VC_RUNTIME_SOURCE: &str = "https://aka.ms/vc14/vc_redist.x64.exe";

const LOG_LINES: usize = 200;
const LOG_LINE_MAX: usize = 2000;
pub(crate) const LOG_READ_MAX: u64 = 64 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Where inference runs. GPU names the device explicitly, so a missing GPU is an error, never a silent switch
/// to the processor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Execution {
    Gpu { device: String },
    Cpu { threads: u16 },
}

/// Why an engine exited before it was ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCause {
    PortConflict,
    DeviceUnavailable,
    ModelLoadFailed,
    MissingSystemLibrary,
    Other,
}

/// Every way a start or a stop can fail. No variant carries the session key; log tails are redacted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    Unsupported,
    /// Another engine is running, or the engine is being installed.
    AlreadyActive,
    EngineNotInstalled(String),
    ModelNotInstalled,
    /// The model could not be held for the session — another program has it open for writing, or it is not a
    /// plain file with one name where the store keeps it — so nothing was started.
    ModelNotHeld(String),
    NoLaunchProfile,
    InvalidExecution(String),
    MissingVcRuntime(Vec<String>),
    /// A runtime file is older than the engine needs. `found` is `None` when its version could not be read.
    VcRuntimeTooOld { file: String, found: Option<String>, needed: String },
    SpawnFailed(String),
    /// The process could not be tied to Sard's lifetime; it was stopped before it ran.
    JobFailed(String),
    EarlyExit { code: Option<i32>, cause: ExitCause, log_tail: Vec<String> },
    StartupTimeout { phase: StartPhase, log_tail: Vec<String> },
    UnexpectedHealth { status: u16 },
    /// The engine's listening sockets could not be read, so it cannot be shown to listen on loopback only.
    ListenersUnknown(String),
    NotLoopbackOnly(String),
    AuthNotEnforced { status: u16 },
    CorsNotClosed(String),
    UiExposed { status: u16 },
    SlotsExposed { status: u16 },
    ToolsExposed { status: u16 },
    ProxyExposed { status: u16 },
    /// The engine did not answer one of the security checks.
    CheckFailed(String),
    /// Something appeared in the engine's directory between verifying it and using the engine.
    EngineChanged(String),
    ProbeFailed(String),
    ProbeTimeout,
    Cancelled,
    ShutdownFailed(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => write!(f, "translation is not available on this platform"),
            Self::AlreadyActive => write!(f, "the translation engine is already in use"),
            Self::EngineNotInstalled(why) => write!(f, "the translation engine is not installed correctly: {why}"),
            Self::ModelNotInstalled => write!(f, "the model is not installed"),
            Self::ModelNotHeld(why) => write!(f, "the model could not be protected from changes while it is used: {why}"),
            Self::NoLaunchProfile => write!(f, "this file is not a model that can be started"),
            Self::InvalidExecution(why) => write!(f, "invalid execution settings: {why}"),
            Self::MissingVcRuntime(files) => write!(f, "the Microsoft Visual C++ runtime is missing ({})", files.join(", ")),
            Self::VcRuntimeTooOld { file, found: Some(found), needed } => {
                write!(f, "the Microsoft Visual C++ runtime is too old: {file} is version {found}, and {needed} or later is needed")
            }
            Self::VcRuntimeTooOld { file, found: None, needed } => {
                write!(f, "the Microsoft Visual C++ runtime cannot be identified: the version of {file} could not be read, and {needed} or later is needed")
            }
            Self::SpawnFailed(why) => write!(f, "the engine could not be started: {why}"),
            Self::JobFailed(why) => write!(f, "the engine could not be tied to Sard's lifetime: {why}"),
            Self::EarlyExit { code, cause, .. } => write!(f, "the engine stopped while starting ({cause:?}, exit code {code:?})"),
            Self::StartupTimeout { phase, .. } => write!(f, "the engine did not finish starting in time ({})", phase.describe()),
            Self::UnexpectedHealth { status } => write!(f, "the engine answered its health check with {status}"),
            Self::ListenersUnknown(why) => write!(f, "the engine's network sockets could not be checked: {why}"),
            Self::NotLoopbackOnly(addr) => write!(f, "the engine listens beyond this computer ({addr})"),
            Self::AuthNotEnforced { status } => write!(f, "the engine accepted a request without its key ({status})"),
            Self::CorsNotClosed(origin) => write!(f, "the engine allows a browser origin ({origin})"),
            Self::UiExposed { status } => write!(f, "the engine serves a web page ({status})"),
            Self::SlotsExposed { status } => write!(f, "the engine exposes its status endpoint ({status})"),
            Self::ToolsExposed { status } => write!(f, "the engine has tools switched on ({status})"),
            Self::ProxyExposed { status } => write!(f, "the engine has its proxy switched on ({status})"),
            Self::CheckFailed(why) => write!(f, "the engine did not answer a security check: {why}"),
            Self::EngineChanged(why) => write!(f, "the engine's directory changed while it was starting: {why}"),
            Self::ProbeFailed(why) => write!(f, "the engine's test request failed: {why}"),
            Self::ProbeTimeout => write!(f, "the engine's test request timed out"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::ShutdownFailed(why) => write!(f, "the engine did not stop: {why}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl EngineError {
    /// What the user can do about this failure, where there is something they can do. Sard only says it:
    /// nothing is downloaded or installed on their behalf.
    pub fn recovery(&self) -> Option<String> {
        match self {
            Self::MissingVcRuntime(_) => Some(format!("Install the latest {VC_RUNTIME_PRODUCT} from Microsoft ({VC_RUNTIME_SOURCE}), then try again.")),
            Self::VcRuntimeTooOld { needed, .. } => Some(format!(
                "Install the latest {VC_RUNTIME_PRODUCT} from Microsoft ({VC_RUNTIME_SOURCE}) — version {needed} or later — then try again."
            )),
            _ => None,
        }
    }
}

/// Timeouts, all bounded.
///
/// The start timeout runs from the moment the engine process exists until its model is loaded and it has
/// passed its checks. It covers the slowest first launch measured — 58 s, a one-time reputation check of newly
/// written executables, against 0.2–0.5 s afterwards — plus a cold model load. Verifying the engine's files
/// comes before that and is not counted: it is a fixed amount of local work. The readiness probe has its own.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub startup_timeout: Duration,
    pub probe_timeout: Duration,
    pub stop_timeout: Duration,
    #[cfg(test)]
    pub(crate) hooks: TestHooks,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            startup_timeout: Duration::from_secs(150),
            probe_timeout: Duration::from_secs(60),
            stop_timeout: Duration::from_secs(10),
            #[cfg(test)]
            hooks: TestHooks::default(),
        }
    }
}

/// Test-only controls: how the fake engine is invoked, and failure injection for the stop path.
#[cfg(test)]
#[derive(Debug, Clone, Default)]
pub(crate) struct TestHooks {
    /// Arguments placed before the engine's own (the test harness needs them to run the fake engine).
    pub prefix_args: Vec<String>,
    /// Variables added after the environment is cleared (the fake engine's behaviour switches).
    pub extra_env: Vec<(String, String)>,
    /// Skip the Job Object (only together with `fail_kill`, to produce a process that will not stop).
    pub no_job: bool,
    pub fail_kill: bool,
    /// Where to look for the Visual C++ runtime instead of the system directory.
    pub system_dir: Option<std::path::PathBuf>,
    /// The version to take the runtime's files to have, instead of reading it from them.
    pub runtime_version: Option<[u16; 4]>,
    /// A file to create the instant the engine's files have been verified — what a program racing the launch
    /// would do.
    pub plant_after_verify: Option<std::path::PathBuf>,
    /// A pause between putting the process in its job and the last check before it is resumed, so that a test
    /// can tell a suspended engine from a running one.
    pub hold_before_resume: Duration,
}

/// The session key. Its `Debug` never shows it.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionKey(String);

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKey([redacted])")
    }
}

impl SessionKey {
    pub(crate) fn generate() -> std::io::Result<SessionKey> {
        random_hex(32).map(SessionKey)
    }

    #[cfg(test)]
    pub(crate) fn for_tests(text: &str) -> SessionKey {
        SessionKey(text.to_string())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// How later stages reach a ready engine.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub key: SessionKey,
}

/// The steps of a start, in order. A start that fails or times out names the step it was in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum StartPhase {
    /// Verifying the files and creating the process.
    #[default]
    Launching,
    /// The process exists; waiting for its server socket.
    Listening,
    /// The server answers; the model is loading.
    LoadingModel,
    /// The model is loaded; checking the server is locked down.
    Checking,
    /// Running the readiness probe.
    Probing,
}

impl StartPhase {
    pub fn describe(self) -> &'static str {
        match self {
            StartPhase::Launching => "starting the engine process",
            StartPhase::Listening => "waiting for the engine's server",
            StartPhase::LoadingModel => "loading the model",
            StartPhase::Checking => "checking the engine's security settings",
            StartPhase::Probing => "running the readiness test",
        }
    }
}

/// When each step of a start finished, in milliseconds from the start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PhaseTimes {
    pub created_ms: u128,
    pub listening_ms: u128,
    pub loaded_ms: u128,
    pub ready_ms: u128,
    /// How long the readiness probe itself took.
    pub probe_ms: u128,
}

/// A ready engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineInfo {
    pub pid: u32,
    pub port: u16,
    pub model_id: String,
    pub execution: Execution,
    pub phases: PhaseTimes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineStatus {
    Idle,
    Starting(StartPhase),
    Ready(EngineInfo),
    /// The engine exited without being asked to. Resources have been released.
    Exited { code: Option<i32> },
}

/// The last lines the engine printed, with the session key removed.
struct LogBuffer {
    lines: Mutex<VecDeque<String>>,
    secret: String,
}

impl LogBuffer {
    fn push(&self, raw: &str) {
        let mut line = raw.replace(&self.secret, "[redacted]");
        if line.len() > LOG_LINE_MAX {
            let mut cut = LOG_LINE_MAX;
            while !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
        }
        let mut lines = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        if lines.len() == LOG_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    fn tail(&self, n: usize) -> Vec<String> {
        let lines = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        lines.iter().skip(lines.len().saturating_sub(n)).cloned().collect()
    }
}

enum Signal {
    Port(u16),
    BindFailed,
    DeviceFailed,
    LoadFailed,
    StreamClosed,
}

struct Session {
    child: Arc<Mutex<Child>>,
    #[cfg(windows)]
    job: Option<win::Job>,
    pid: u32,
    info: EngineInfo,
    key: SessionKey,
    exit: Arc<Mutex<Option<Option<i32>>>>,
    stop_monitor: Arc<AtomicBool>,
    monitor: Option<JoinHandle<()>>,
    readers: Vec<JoinHandle<()>>,
    log: Arc<LogBuffer>,
    /// The engine's verified files, held open for as long as the session exists. A stop that could not end
    /// the process lets go of them with the session; what remains then is the slot, which stays taken.
    _files: VerifiedEngine,
    /// The model, held from before the engine existed for as long as the session exists. A stop that could not
    /// end the process does NOT let go of it: that engine may still be reading it, so it stays held, like the
    /// slot, for the rest of this run of Sard (`KEPT_MODELS`).
    model: std::fs::File,
    slot: SlotGuard,
}

/// The models of engines that a stop could not end. They stay held until Sard itself ends — and with it, by its
/// Job Object, any engine still alive.
static KEPT_MODELS: Mutex<Vec<std::fs::File>> = Mutex::new(Vec::new());

/// Let go of the models kept by stops that failed: only a test, after ending the engine it made unstoppable itself.
#[cfg(all(test, windows))]
pub(crate) fn release_kept_models_for_tests() {
    KEPT_MODELS.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// Shared between a start in progress and `stop`, so a stop can end a starting engine at once rather than
/// wait for the step the start is in (a model load or the probe can take a minute).
#[derive(Default)]
struct StartControl {
    cancel: AtomicBool,
    child: Mutex<Option<Arc<Mutex<Child>>>>,
    phase: Mutex<StartPhase>,
}

impl StartControl {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn set_phase(&self, phase: StartPhase) {
        *self.phase.lock().unwrap_or_else(|p| p.into_inner()) = phase;
    }

    fn phase(&self) -> StartPhase {
        *self.phase.lock().unwrap_or_else(|p| p.into_inner())
    }
}

enum ManagerState {
    Idle,
    Starting(Arc<StartControl>),
    Running(Box<Session>),
}

/// Starts, watches and stops the engine. Dropping it stops the engine.
pub struct EngineManager {
    config: EngineConfig,
    state: Mutex<ManagerState>,
    last_exit: Mutex<Option<Option<i32>>>,
}

impl EngineManager {
    pub fn new(config: EngineConfig) -> EngineManager {
        EngineManager { config, state: Mutex::new(ManagerState::Idle), last_exit: Mutex::new(None) }
    }

    /// Start the engine with `model` and wait until it is ready. Fails with a typed error and leaves nothing
    /// running if any step fails.
    ///
    /// This blocks for as long as the start takes — a model load can take a minute — so it belongs on a
    /// worker thread, never on the one that draws the interface. `stop` from another thread ends it at once.
    pub fn start(&self, store: &Store, spec: &EngineSpec, model: &Artifact, execution: Execution) -> Result<EngineInfo, EngineError> {
        if !cfg!(windows) {
            return Err(EngineError::Unsupported);
        }
        let control = Arc::new(StartControl::default());
        let slot_guard = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if !matches!(*state, ManagerState::Idle) {
                return Err(EngineError::AlreadyActive);
            }
            let guard = slot::claim(Holder::Engine).map_err(|_| EngineError::AlreadyActive)?;
            *state = ManagerState::Starting(control.clone());
            guard
        };
        let result = launch(&self.config, store, spec, model, execution, &control, slot_guard);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *state = ManagerState::Idle;
        match result {
            Ok(session) if !control.cancelled() => {
                let info = session.info.clone();
                *state = ManagerState::Running(session);
                *self.last_exit.lock().unwrap_or_else(|p| p.into_inner()) = None;
                Ok(info)
            }
            Ok(session) => {
                drop(state);
                Err(stop_after_failed_start(&self.config, *session, EngineError::Cancelled))
            }
            // An engine that could not be stopped is reported as that, whatever else happened.
            Err(e @ EngineError::ShutdownFailed(_)) => Err(e),
            // A stop during the start ends the process, which surfaces as whatever step it interrupted.
            Err(_) if control.cancelled() => Err(EngineError::Cancelled),
            Err(e) => Err(e),
        }
    }

    /// Stop a running engine, or cancel one that is starting. Idempotent and bounded: it returns within the
    /// stop timeout (plus the job's own grace period) whatever state the engine is in.
    pub fn stop(&self) -> Result<(), EngineError> {
        let session = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            match std::mem::replace(&mut *state, ManagerState::Idle) {
                ManagerState::Idle => return Ok(()),
                ManagerState::Starting(control) => {
                    control.cancel.store(true, Ordering::Relaxed);
                    let child = control.child.lock().unwrap_or_else(|p| p.into_inner()).clone();
                    // The starting thread still owns the session; it sees the flag, closes the job and returns
                    // the slot. Ending the process here makes that immediate.
                    *state = ManagerState::Starting(control);
                    drop(state);
                    return match child {
                        None => Ok(()),
                        Some(child) => {
                            #[cfg(test)]
                            let kill = !self.config.hooks.fail_kill;
                            #[cfg(not(test))]
                            let kill = true;
                            if kill {
                                let _ = child.lock().unwrap_or_else(|p| p.into_inner()).kill();
                            }
                            if wait_for_exit(&child, self.config.stop_timeout) {
                                Ok(())
                            } else {
                                Err(EngineError::ShutdownFailed("the starting engine did not stop".into()))
                            }
                        }
                    };
                }
                ManagerState::Running(session) => session,
            }
        };
        teardown(&self.config, *session)
    }

    /// The engine's state. An engine that exited on its own is reported as `Exited` (until the next start),
    /// and everything it held is released the first time that is seen.
    pub fn status(&self) -> EngineStatus {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let exited = match &*state {
            ManagerState::Idle => {
                return match *self.last_exit.lock().unwrap_or_else(|p| p.into_inner()) {
                    Some(code) => EngineStatus::Exited { code },
                    None => EngineStatus::Idle,
                }
            }
            ManagerState::Starting(control) => return EngineStatus::Starting(control.phase()),
            ManagerState::Running(session) => *session.exit.lock().unwrap_or_else(|p| p.into_inner()),
        };
        match exited {
            None => match &*state {
                ManagerState::Running(session) => EngineStatus::Ready(session.info.clone()),
                _ => EngineStatus::Idle,
            },
            Some(code) => {
                if let ManagerState::Running(session) = std::mem::replace(&mut *state, ManagerState::Idle) {
                    drop(state);
                    let _ = teardown(&self.config, *session);
                }
                *self.last_exit.lock().unwrap_or_else(|p| p.into_inner()) = Some(code);
                EngineStatus::Exited { code }
            }
        }
    }

    /// Where a ready engine listens, and its key.
    pub fn endpoint(&self) -> Option<Endpoint> {
        match &*self.state.lock().unwrap_or_else(|p| p.into_inner()) {
            ManagerState::Running(s) => Some(Endpoint { port: s.info.port, key: s.key.clone() }),
            _ => None,
        }
    }

    /// The last lines the engine printed (redacted), for diagnostics.
    pub fn log_tail(&self, n: usize) -> Vec<String> {
        match &*self.state.lock().unwrap_or_else(|p| p.into_inner()) {
            ManagerState::Running(s) => s.log.tail(n),
            _ => Vec::new(),
        }
    }
}

impl Drop for EngineManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// The command-line arguments for an engine: the model's frozen profile, the device, and the security flags.
/// The key is never among them.
pub(crate) fn engine_args(model_path: &Path, profile: LaunchProfile, execution: &Execution) -> Result<Vec<OsString>, EngineError> {
    let mut args: Vec<OsString> = vec!["-m".into(), model_path.as_os_str().to_owned()];
    match execution {
        Execution::Gpu { device } => {
            let plain = !device.is_empty() && device.len() <= 32 && device.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !plain || device.eq_ignore_ascii_case("none") {
                return Err(EngineError::InvalidExecution(format!("not a device name: {device:?}")));
            }
            args.extend(profile.gpu.iter().map(OsString::from));
            args.extend(["-dev".into(), OsString::from(device)]);
        }
        Execution::Cpu { threads } => {
            if !(1..=256).contains(threads) {
                return Err(EngineError::InvalidExecution(format!("thread count {threads}")));
            }
            args.extend(profile.cpu.iter().map(OsString::from));
            let t = threads.to_string();
            args.extend(["-t".into(), OsString::from(&t), "-tb".into(), OsString::from(&t), "-dev".into(), "none".into()]);
        }
    }
    args.extend(SECURITY_FLAGS.iter().map(OsString::from));
    Ok(args)
}

/// The engine's environment: the allowed inherited variables, a fixed `PATH`, and the key.
pub(crate) fn engine_env(
    parent: impl Iterator<Item = (OsString, OsString)>,
    system_dir: &Path,
    key: &SessionKey,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = parent
        .filter(|(k, _)| {
            let k = k.to_string_lossy();
            PASSED_ENV.iter().any(|p| p.eq_ignore_ascii_case(&k))
        })
        .collect();
    let windows_dir = system_dir.parent().unwrap_or(system_dir);
    let mut path = system_dir.as_os_str().to_owned();
    path.push(";");
    path.push(windows_dir.as_os_str());
    env.push(("PATH".into(), path));
    env.push(("LLAMA_API_KEY".into(), key.as_str().into()));
    env
}

/// A path without Windows' `\\?\` prefix, when it is an ordinary drive path that does not need one.
///
/// The store resolves its root, which adds that prefix. The engine was only ever evaluated from ordinary
/// paths, so that is the form it is given. Long paths, network paths and names that are not valid Unicode
/// are left exactly as they are.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    if let Some(rest) = path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        let b = rest.as_bytes();
        if cfg!(windows) && rest.len() < 240 && b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// The Visual C++ runtime files missing from `system_dir`.
pub(crate) fn missing_vc_runtime(system_dir: &Path) -> Vec<String> {
    VC_RUNTIME.iter().filter(|f| !system_dir.join(f).is_file()).map(|f| f.to_string()).collect()
}

/// What stands between the engine and the Visual C++ runtime it needs, if anything: a file that is missing, or
/// one that is older than `minimum` (major, minor). A file whose version cannot be read counts as too old —
/// nothing is assumed about a runtime that cannot be identified.
pub(crate) fn vc_runtime_problem(
    system_dir: &Path,
    minimum: (u16, u16),
    version_of: impl Fn(&Path) -> Option<[u16; 4]>,
) -> Option<EngineError> {
    let missing = missing_vc_runtime(system_dir);
    if !missing.is_empty() {
        return Some(EngineError::MissingVcRuntime(missing));
    }
    for file in VC_RUNTIME {
        let found = version_of(&system_dir.join(file));
        if found.is_none_or(|v| (v[0], v[1]) < minimum) {
            return Some(EngineError::VcRuntimeTooOld {
                file: file.to_string(),
                found: found.map(|v| format!("{}.{}.{}.{}", v[0], v[1], v[2], v[3])),
                needed: format!("{}.{}", minimum.0, minimum.1),
            });
        }
    }
    None
}

/// The file version recorded in a Windows program file — the four numbers of its version resource — read from
/// the file's own bytes. Nothing is loaded and nothing is run; a file that is not what it should be gives `None`.
pub(crate) fn file_version(bytes: &[u8]) -> Option<[u16; 4]> {
    // Positions are kept as u64, so that no sum of numbers read from the file can overflow, and every read is
    // checked against the length of the file.
    let get = |at: u64, len: u64| bytes.get(usize::try_from(at).ok()?..usize::try_from(at.checked_add(len)?).ok()?);
    let u16_at = |at: u64| get(at, 2).map(|s| u64::from(u16::from_le_bytes([s[0], s[1]])));
    let u32_at = |at: u64| get(at, 4).map(|s| u64::from(u32::from_le_bytes([s[0], s[1], s[2], s[3]])));
    let pe = u32_at(0x3C)?;
    if get(pe, 4)? != b"PE\0\0" {
        return None;
    }
    let (coff, optional) = (pe + 4, pe + 24);
    let (sections, optional_size) = (u16_at(coff + 2)?, u16_at(coff + 16)?);
    let directories = optional
        + match u16_at(optional)? {
            0x20B => 112,
            0x10B => 96,
            _ => return None,
        };
    // Where a position in the loaded image is in the file.
    let in_file = |rva: u64| -> Option<u64> {
        (0..sections).find_map(|i| {
            let s = optional + optional_size + i * 40;
            let (size, start, raw) = (u32_at(s + 8)?.max(u32_at(s + 16)?), u32_at(s + 12)?, u32_at(s + 20)?);
            Some(rva.checked_sub(start).filter(|within| *within < size)? + raw)
        })
    };
    // The resource directory is three levels deep: type, name, language. An entry is an id and where it leads.
    let resources = in_file(u32_at(directories + 8 * 2).filter(|rva| *rva != 0)?)?;
    let first = |table: u64, wanted: Option<u64>| -> Option<u64> {
        let entries = u16_at(table + 12)? + u16_at(table + 14)?;
        (0..entries).find_map(|i| {
            let e = table + 16 + i * 8;
            let (id, leads_to) = (u32_at(e)?, u32_at(e + 4)?);
            (wanted.is_none() || wanted == Some(id)).then_some(leads_to)
        })
    };
    const TABLE: u64 = 0x8000_0000;
    const VERSION_TYPE: u64 = 16;
    let by_type = first(resources, Some(VERSION_TYPE)).filter(|t| t & TABLE != 0)? & !TABLE;
    let by_name = first(resources + by_type, None).filter(|t| t & TABLE != 0)? & !TABLE;
    let data = first(resources + by_name, None).filter(|t| t & TABLE == 0)?;
    let block = in_file(u32_at(resources + data)?)?;
    // The block starts with a 6-byte header and the key "VS_VERSION_INFO"; the fixed part follows at 40.
    let fixed = block + 40;
    if u32_at(fixed)? != 0xFEEF_04BD {
        return None;
    }
    let (high, low) = (u32_at(fixed + 8)?, u32_at(fixed + 12)?);
    Some([(high >> 16) as u16, high as u16, (low >> 16) as u16, low as u16])
}

/// The port from the engine's "listening on" line, if this is that line.
pub(crate) fn listening_port(line: &str) -> Option<u16> {
    let marker = "listening on http://127.0.0.1:";
    let rest = &line[line.find(marker)? + marker.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|p| *p != 0)
}

fn classify_line(line: &str) -> Option<Signal> {
    if let Some(port) = listening_port(line) {
        return Some(Signal::Port(port));
    }
    let l = line.to_ascii_lowercase();
    if l.contains("couldn't bind http server socket") || l.contains("couldn't start http listener") {
        Some(Signal::BindFailed)
    } else if l.contains("invalid device") {
        Some(Signal::DeviceFailed)
    } else if l.contains("failed to load model") || l.contains("exiting due to model loading error") || l.contains("failed to create context") || l.contains("failed to create_context") {
        Some(Signal::LoadFailed)
    } else {
        None
    }
}

fn launch(
    config: &EngineConfig,
    store: &Store,
    spec: &EngineSpec,
    model: &Artifact,
    execution: Execution,
    control: &StartControl,
    slot_guard: SlotGuard,
) -> Result<Box<Session>, EngineError> {
    #[cfg(not(windows))]
    {
        let _ = (config, store, spec, model, execution, control, slot_guard);
        Err(EngineError::Unsupported)
    }
    #[cfg(windows)]
    {
        launch_windows(config, store, spec, model, execution, control, slot_guard)
    }
}

/// Open the model at `path` to hold it, and prove from that handle that it is the store's own: a plain file — not
/// a link, which is opened as itself and refused — with no other name, exactly at `path`, and of the model's size.
///
/// A model that some handle already has open for writing cannot be opened this way at all: that is `ModelNotHeld`,
/// and so is a file the handle shows to be anything but the store's own. A plain file of another size is not the
/// model that was installed (`ModelNotInstalled`). Nothing here writes, moves or deletes anything.
///
/// The size is checked here, on the handle, although the store has just checked it by the path: until this
/// handle is open nothing stops another program replacing the file at that path, and the store's check was of
/// what was there a moment before. This check is the only one made of the file that is actually held.
#[cfg(windows)]
pub(crate) fn hold_model(path: &Path, model: &Artifact) -> Result<std::fs::File, EngineError> {
    let file = install::open_held(path).map_err(|e| EngineError::ModelNotHeld(e.to_string()))?;
    let len = super::download::prove_own(&file, path, "the model's folder").map_err(EngineError::ModelNotHeld)?;
    if len != model.size {
        return Err(EngineError::ModelNotInstalled);
    }
    Ok(file)
}

#[cfg(windows)]
fn launch_windows(
    config: &EngineConfig,
    store: &Store,
    spec: &EngineSpec,
    model: &Artifact,
    execution: Execution,
    control: &StartControl,
    slot_guard: SlotGuard,
) -> Result<Box<Session>, EngineError> {
    use std::os::windows::process::CommandExt;

    let t0 = Instant::now();
    control.set_phase(StartPhase::Launching);
    // Every file is hashed and then HELD: from here until the engine has exited, nothing can change them.
    let verified = install::verify(store, spec).map_err(|e| EngineError::EngineNotInstalled(e.to_string()))?;
    let (dir, executable) = (plain_path(&verified.dir), plain_path(&verified.executable));
    #[cfg(test)]
    if let Some(planted) = &config.hooks.plant_after_verify {
        let _ = std::fs::write(planted, b"planted after verification");
    }
    let profile = launch_profile(model).ok_or(EngineError::NoLaunchProfile)?;
    if store.state(model).map_err(|e| EngineError::SpawnFailed(e.to_string()))? != ArtifactState::Installed {
        return Err(EngineError::ModelNotInstalled);
    }
    let model_path = store.installed_path(model);
    store.guard_existing(&model_path).map_err(|_| EngineError::ModelNotInstalled)?;
    // Held from here: until the session ends — or, if the engine cannot be ended, until Sard does — no other
    // handle can write the model, delete it, or rename it or the folders above it. Every return before the
    // session exists lets go of it again.
    let held_model = hold_model(&model_path, model)?;
    let args = engine_args(&plain_path(&model_path), profile, &execution)?;

    #[cfg(test)]
    let system_dir = config.hooks.system_dir.clone().or_else(win::system_dir);
    #[cfg(not(test))]
    let system_dir = win::system_dir();
    let system_dir = system_dir.ok_or_else(|| EngineError::SpawnFailed("the system directory is unknown".into()))?;
    let version_on_disk = |file: &Path| std::fs::read(file).ok().and_then(|bytes| file_version(&bytes));
    #[cfg(test)]
    let version_of = |file: &Path| config.hooks.runtime_version.or_else(|| version_on_disk(file));
    #[cfg(not(test))]
    let version_of = version_on_disk;
    if let Some(problem) = vc_runtime_problem(&system_dir, spec.min_vc_runtime, version_of) {
        return Err(problem);
    }

    let key = SessionKey::generate().map_err(|e| EngineError::SpawnFailed(e.to_string()))?;
    let mut cmd = Command::new(&executable);
    #[cfg(test)]
    cmd.args(&config.hooks.prefix_args);
    cmd.args(&args)
        .current_dir(&dir)
        .env_clear()
        .envs(engine_env(std::env::vars_os(), &system_dir, &key))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(win::CREATION_FLAGS);
    #[cfg(test)]
    cmd.envs(config.hooks.extra_env.iter().cloned());

    let job = win::Job::kill_on_close().map_err(EngineError::JobFailed)?;
    // A stop that arrived while the files were being verified: nothing is started at all.
    if control.cancelled() {
        return Err(EngineError::Cancelled);
    }
    let mut child = cmd.spawn().map_err(|e| EngineError::SpawnFailed(e.to_string()))?;
    let spawned = Instant::now();
    let pid = child.id();
    #[cfg(test)]
    let use_job = !config.hooks.no_job;
    #[cfg(not(test))]
    let use_job = true;
    if use_job {
        if let Err(e) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(EngineError::JobFailed(e));
        }
    }
    #[cfg(test)]
    std::thread::sleep(config.hooks.hold_before_resume);
    // The last moment before the engine runs a single instruction. Its files are held, so their contents are
    // what was hashed; what could still have happened is a file ADDED beside them, which the engine would
    // load as a backend. The process exists but is suspended, so it has loaded nothing yet.
    if let Err(e) = install::check_unchanged(store, spec) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(EngineError::EngineChanged(e.to_string()));
    }
    if let Err(e) = win::resume_threads(pid) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(EngineError::SpawnFailed(e));
    }

    let log = Arc::new(LogBuffer { lines: Mutex::new(VecDeque::new()), secret: key.as_str().to_string() });
    let (tx, rx) = mpsc::channel();
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(spawn_reader(out, log.clone(), tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(spawn_reader(err, log.clone(), tx.clone()));
    }
    drop(tx);

    let child = Arc::new(Mutex::new(child));
    *control.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child.clone());
    let mut session = Box::new(Session {
        child,
        job: if use_job { Some(job) } else { None },
        pid,
        info: EngineInfo { pid, port: 0, model_id: model.id.to_string(), execution, phases: PhaseTimes::default() },
        key,
        exit: Arc::new(Mutex::new(None)),
        stop_monitor: Arc::new(AtomicBool::new(false)),
        monitor: None,
        readers,
        log,
        _files: verified,
        model: held_model,
        slot: slot_guard,
    });
    session.info.phases.created_ms = t0.elapsed().as_millis();

    match bring_up(config, store, spec, &mut session, &rx, control, t0, spawned) {
        Ok(()) => {
            let (child, exit, stop) = (session.child.clone(), session.exit.clone(), session.stop_monitor.clone());
            session.monitor = Some(std::thread::spawn(move || monitor(child, exit, stop)));
            Ok(session)
        }
        Err(e) => Err(stop_after_failed_start(config, *session, e)),
    }
}

/// A start that did not succeed must still leave nothing running. If the engine cannot be stopped either,
/// that is the more serious failure, and it is the one reported — with the reason the start failed kept in
/// its text. (The slot stays taken in that case: see `teardown`.)
fn stop_after_failed_start(config: &EngineConfig, session: Session, failure: EngineError) -> EngineError {
    match teardown(config, session) {
        Ok(()) => failure,
        Err(EngineError::ShutdownFailed(why)) => EngineError::ShutdownFailed(format!("{why}, after the start had already failed ({failure})")),
        Err(other) => other,
    }
}

fn spawn_reader(stream: impl Read + Send + 'static, log: Arc<LogBuffer>, tx: mpsc::Sender<Signal>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for_each_line(stream, |raw| {
            let line = String::from_utf8_lossy(raw);
            let line = line.trim_end();
            if let Some(signal) = classify_line(line) {
                let _ = tx.send(signal);
            }
            log.push(line);
        });
        let _ = tx.send(Signal::StreamClosed);
    })
}

/// Hand `stream` to `on_line` a line at a time, never holding more than `LOG_READ_MAX` bytes of it: a longer
/// line arrives in pieces. The engine prints progress without ending the line, and nothing here may grow
/// with what it prints.
pub(crate) fn for_each_line(stream: impl Read, mut on_line: impl FnMut(&[u8])) {
    let mut reader = BufReader::new(stream);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match (&mut reader).take(LOG_READ_MAX).read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => on_line(&raw),
        }
    }
}

/// What the engine's log has reported so far.
#[derive(Default)]
struct Seen {
    port: Option<u16>,
    bind_failed: bool,
    device_failed: bool,
    load_failed: bool,
    closed: usize,
}

impl Seen {
    fn take(&mut self, signal: Signal) {
        match signal {
            Signal::Port(p) => {
                self.port.get_or_insert(p);
            }
            Signal::BindFailed => self.bind_failed = true,
            Signal::DeviceFailed => self.device_failed = true,
            Signal::LoadFailed => self.load_failed = true,
            Signal::StreamClosed => self.closed += 1,
        }
    }
}

/// Between every step of a start: has it been cancelled, has the engine exited, is time up?
#[cfg(windows)]
fn checkpoint(session: &Session, rx: &mpsc::Receiver<Signal>, seen: &mut Seen, control: &StartControl, deadline: Instant) -> Result<(), EngineError> {
    while let Ok(signal) = rx.try_recv() {
        seen.take(signal);
    }
    if control.cancelled() {
        return Err(EngineError::Cancelled);
    }
    if let Some(code) = exited(session) {
        return Err(early_exit(session, rx, seen, code));
    }
    if Instant::now() > deadline {
        return Err(EngineError::StartupTimeout { phase: control.phase(), log_tail: session.log.tail(20) });
    }
    Ok(())
}

/// Everything between "the process exists" and "the engine is ready".
///
/// The port comes from the operating system's table of the engine process's own listening sockets — not
/// from its log. The engine binds before it loads the model but prints its address only after the load, so
/// the table is the only way to see the server come up, and it is authoritative where a log line is not.
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn bring_up(
    config: &EngineConfig,
    store: &Store,
    spec: &EngineSpec,
    session: &mut Session,
    rx: &mpsc::Receiver<Signal>,
    control: &StartControl,
    t0: Instant,
    spawned: Instant,
) -> Result<(), EngineError> {
    let deadline = spawned + config.startup_timeout;
    let mut seen = Seen::default();

    // 1. The server comes up: the engine process holds a listening socket, and only on loopback.
    control.set_phase(StartPhase::Listening);
    let port = loop {
        checkpoint(session, rx, &mut seen, control, deadline)?;
        let listeners = win::tcp_listeners(session.pid).map_err(EngineError::ListenersUnknown)?;
        if let Some(wide) = listeners.iter().find(|a| !is_loopback_v4(a)) {
            return Err(EngineError::NotLoopbackOnly(wide.to_string()));
        }
        match listeners.as_slice() {
            [only] => break only.port(),
            [] => {}
            // More than one socket: only the one the engine names as its address is the server.
            several => {
                if let Some(p) = seen.port.filter(|p| several.iter().any(|a| a.port() == *p)) {
                    break p;
                }
            }
        }
        if let Ok(signal) = rx.recv_timeout(Duration::from_millis(50)) {
            seen.take(signal);
        }
    };
    session.info.port = port;
    session.info.phases.listening_ms = t0.elapsed().as_millis();

    // 2. Health: 503 while the model loads, 200 {"status":"ok"} once it has. Anything else is refused.
    control.set_phase(StartPhase::LoadingModel);
    loop {
        checkpoint(session, rx, &mut seen, control, deadline)?;
        match http(port, "GET", "/health", None, None, Duration::from_secs(2)) {
            Ok(r) if r.status == 200 => {
                let ok = serde_json::from_str::<serde_json::Value>(&r.body).ok().and_then(|v| v.get("status")?.as_str().map(|s| s == "ok"));
                if ok == Some(true) {
                    break;
                }
                return Err(EngineError::UnexpectedHealth { status: 200 });
            }
            Ok(r) if r.status == 503 => {}
            Ok(r) => return Err(EngineError::UnexpectedHealth { status: r.status }),
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    session.info.phases.loaded_ms = t0.elapsed().as_millis();

    // 3. Self-checks: the engine is refused unless it is locked down as configured.
    control.set_phase(StartPhase::Checking);
    self_check(session.pid, port, &session.key)?;
    // And its directory, now that it has loaded everything it is going to load: a file that appeared while it
    // was starting may have been loaded with the rest, so this engine is not used.
    install::check_unchanged(store, spec).map_err(|e| EngineError::EngineChanged(e.to_string()))?;
    checkpoint(session, rx, &mut seen, control, deadline)?;

    // 4. Readiness: one short, deterministic completion, bounded by its own timeout.
    control.set_phase(StartPhase::Probing);
    let p0 = Instant::now();
    let body = r#"{"prompt":"Hello","n_predict":4,"temperature":0,"cache_prompt":false}"#;
    match http(port, "POST", "/completion", Some(&session.key), Some(body), config.probe_timeout) {
        Ok(r) if r.status == 200 => {
            let content = serde_json::from_str::<serde_json::Value>(&r.body).ok().and_then(|v| v.get("content").map(|c| c.is_string()));
            if content != Some(true) {
                return Err(EngineError::ProbeFailed("the answer has no text".into()));
            }
        }
        Ok(r) => return Err(EngineError::ProbeFailed(format!("status {}", r.status))),
        Err(HttpError::Timeout) => return Err(EngineError::ProbeTimeout),
        Err(HttpError::Other(why)) => return Err(EngineError::ProbeFailed(why)),
    }
    // The probe has its own timeout, so the start deadline is not applied to it; cancellation and exit are.
    checkpoint(session, rx, &mut seen, control, Instant::now() + Duration::from_secs(1))?;
    session.info.phases.probe_ms = p0.elapsed().as_millis();
    session.info.phases.ready_ms = t0.elapsed().as_millis();
    Ok(())
}

/// Only an IPv4 loopback address counts: the engine is told to bind 127.0.0.1 and nothing else.
pub(crate) fn is_loopback_v4(addr: &std::net::SocketAddr) -> bool {
    matches!(addr.ip(), std::net::IpAddr::V4(ip) if ip.is_loopback())
}

/// Refuse an engine that is not locked down: listeners beyond loopback, a request without the key accepted,
/// an open CORS origin, a web UI, the slots endpoint, tools, or the proxy.
///
/// The flags and the cleared environment are what switch these off. This is the proof that they did — so an
/// engine that some other route switched on (an inherited `LLAMA_ARG_TOOLS`, a changed default) is not used.
#[cfg(windows)]
fn self_check(pid: u32, port: u16, key: &SessionKey) -> Result<(), EngineError> {
    // Again now the model has loaded: a socket opened during the load counts as much as one opened before it.
    let listeners = win::tcp_listeners(pid).map_err(EngineError::ListenersUnknown)?;
    if !listeners.iter().any(|a| a.port() == port) {
        return Err(EngineError::ListenersUnknown(format!("the engine no longer listens on port {port}")));
    }
    if let Some(wide) = listeners.iter().find(|a| !is_loopback_v4(a)) {
        return Err(EngineError::NotLoopbackOnly(wide.to_string()));
    }

    let ask = |path: &str, key: Option<&SessionKey>| http(port, "GET", path, key, None, CHECK_TIMEOUT).map_err(|e| EngineError::CheckFailed(e.to_string()));
    let unauth = ask("/v1/models", None)?;
    if unauth.status != 401 {
        return Err(EngineError::AuthNotEnforced { status: unauth.status });
    }
    match unauth.allow_origin.as_deref() {
        Some(CLOSED_CORS_ORIGIN) => {}
        other => return Err(EngineError::CorsNotClosed(other.unwrap_or("no header").to_string())),
    }
    let ui = ask("/", None)?;
    if ui.status != 404 {
        return Err(EngineError::UiExposed { status: ui.status });
    }
    // With the key, each switched-off feature says so itself: 501 for slots, 403 for tools and the proxy.
    let slots = ask("/slots", Some(key))?;
    if slots.status != 501 {
        return Err(EngineError::SlotsExposed { status: slots.status });
    }
    let tools = ask("/tools", Some(key))?;
    if tools.status != 403 {
        return Err(EngineError::ToolsExposed { status: tools.status });
    }
    let proxy = ask("/cors-proxy", Some(key))?;
    if proxy.status != 403 {
        return Err(EngineError::ProxyExposed { status: proxy.status });
    }
    Ok(())
}

fn exited(session: &Session) -> Option<Option<i32>> {
    let mut child = session.child.lock().unwrap_or_else(|p| p.into_inner());
    match child.try_wait() {
        Ok(Some(status)) => Some(status.code()),
        _ => None,
    }
}

fn early_exit(session: &Session, rx: &mpsc::Receiver<Signal>, seen: &mut Seen, code: Option<i32>) -> EngineError {
    // The streams close when the process ends; read what is left so the cause is not lost.
    let until = Instant::now() + Duration::from_secs(1);
    while seen.closed < session.readers.len() && Instant::now() < until {
        if let Ok(signal) = rx.recv_timeout(Duration::from_millis(50)) {
            seen.take(signal);
        }
    }
    let (bind, device, load) = (seen.bind_failed, seen.device_failed, seen.load_failed);
    // STATUS_DLL_NOT_FOUND, STATUS_ENTRYPOINT_NOT_FOUND, STATUS_INVALID_IMAGE_FORMAT.
    let missing_library = matches!(code.map(|c| c as u32), Some(0xC000_0135 | 0xC000_0139 | 0xC000_007B));
    let cause = if missing_library {
        ExitCause::MissingSystemLibrary
    } else if bind {
        ExitCause::PortConflict
    } else if device {
        ExitCause::DeviceUnavailable
    } else if load {
        ExitCause::ModelLoadFailed
    } else {
        ExitCause::Other
    };
    EngineError::EarlyExit { code, cause, log_tail: session.log.tail(20) }
}

fn monitor(child: Arc<Mutex<Child>>, exit: Arc<Mutex<Option<Option<i32>>>>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        let status = child.lock().unwrap_or_else(|p| p.into_inner()).try_wait();
        if let Ok(Some(status)) = status {
            *exit.lock().unwrap_or_else(|p| p.into_inner()) = Some(status.code());
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Stop the process, wait a bounded time, and close the job, which ends anything left in it.
///
/// The slot is released only once the process is known to be gone. If it is still running after all of that,
/// this reports `ShutdownFailed` and the slot stays taken for the rest of this run of Sard: no second engine
/// may start beside one that may still be alive.
fn teardown(config: &EngineConfig, mut session: Session) -> Result<(), EngineError> {
    session.stop_monitor.store(true, Ordering::Relaxed);
    #[cfg(test)]
    let kill = !config.hooks.fail_kill;
    #[cfg(not(test))]
    let kill = true;
    if kill {
        let _ = session.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
    }
    let mut gone = wait_for_exit(&session.child, config.stop_timeout);
    #[cfg(windows)]
    {
        drop(session.job.take());
        if !gone {
            gone = wait_for_exit(&session.child, Duration::from_secs(2));
        }
    }
    if let Some(m) = session.monitor.take() {
        let _ = m.join();
    }
    // Readers end when the pipes close; they are not joined if a pipe is still held open elsewhere.
    for r in std::mem::take(&mut session.readers) {
        if r.is_finished() {
            let _ = r.join();
        }
    }
    if gone {
        Ok(())
    } else {
        std::mem::forget(session.slot);
        KEPT_MODELS.lock().unwrap_or_else(|p| p.into_inner()).push(session.model);
        Err(EngineError::ShutdownFailed(format!("process {} is still running", session.pid)))
    }
}

fn wait_for_exit(child: &Arc<Mutex<Child>>, limit: Duration) -> bool {
    let until = Instant::now() + limit;
    loop {
        if let Ok(Some(_)) = child.lock().unwrap_or_else(|p| p.into_inner()).try_wait() {
            return true;
        }
        if Instant::now() > until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct HttpReply {
    status: u16,
    allow_origin: Option<String>,
    body: String,
}

#[derive(Debug)]
enum HttpError {
    Timeout,
    Other(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Timeout => write!(f, "timed out"),
            HttpError::Other(why) => write!(f, "{why}"),
        }
    }
}

/// One request to the engine on loopback. No proxy is ever used (`ureq` would otherwise take one from the
/// environment and send the key to it), redirects are not followed, and errors never include the key.
fn http(port: u16, method: &str, path: &str, key: Option<&SessionKey>, body: Option<&str>, timeout: Duration) -> Result<HttpReply, HttpError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("Sard")
        .timeout_global(Some(timeout))
        .build()
        .into();
    let url = format!("http://{LOOPBACK}:{port}{path}");
    let auth = key.map(|k| format!("Bearer {}", k.as_str()));
    let result = match (method, body) {
        ("POST", Some(b)) => {
            let mut req = agent.post(&url).header("Content-Type", "application/json");
            if let Some(a) = &auth {
                req = req.header("Authorization", a);
            }
            req.send(b)
        }
        _ => {
            let mut req = agent.get(&url);
            if let Some(a) = &auth {
                req = req.header("Authorization", a);
            }
            req.call()
        }
    };
    match result {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let allow_origin = resp.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = resp.body_mut().read_to_string().unwrap_or_default();
            Ok(HttpReply { status, allow_origin, body })
        }
        Err(ureq::Error::Timeout(_)) => Err(HttpError::Timeout),
        Err(e) => Err(HttpError::Other(e.to_string())),
    }
}

#[cfg(windows)]
pub(crate) mod win {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME};

    pub const CREATION_FLAGS: u32 = CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0;

    /// A Job Object whose processes all end when its last handle closes — including when this process ends,
    /// however it ends, because the kernel then closes the handle.
    #[derive(Debug)]
    pub struct Job(HANDLE);

    // SAFETY: the handle is an owned kernel object used only through `&self`/`Drop`; it is not tied to a thread.
    unsafe impl Send for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle was returned by CreateJobObjectW and is closed exactly once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    impl Job {
        pub fn kill_on_close() -> Result<Job, String> {
            // SAFETY: plain Win32 calls on a handle this function owns; the info struct outlives the call.
            unsafe {
                let job = Job(CreateJobObjectW(None, PCWSTR::null()).map_err(|e| e.to_string())?);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|e| e.to_string())?;
                Ok(job)
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
            // SAFETY: both handles are valid for the duration of the call.
            unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle() as _)).map_err(|e| e.to_string()) }
        }
    }

    /// Resume the threads of a process started suspended.
    pub fn resume_threads(pid: u32) -> Result<usize, String> {
        // SAFETY: the snapshot and thread handles are opened and closed here; the entry struct is sized.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| e.to_string())?;
            let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
            let mut resumed = 0;
            let mut more = Thread32First(snap, &mut entry).is_ok();
            while more {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        let _ = CloseHandle(thread);
                    }
                }
                more = Thread32Next(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
            if resumed == 0 {
                Err("no thread of the engine process could be resumed".into())
            } else {
                Ok(resumed)
            }
        }
    }

    pub fn system_dir() -> Option<PathBuf> {
        let mut buf = [0u16; 520];
        // SAFETY: the buffer is valid and its length is passed through the slice.
        let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
        if n == 0 || n >= buf.len() {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..n])))
    }

    /// The TCP listening addresses owned by `pid`, IPv4 and IPv6. A table that cannot be read whole is an
    /// error, never a shorter list: a row skipped here could be the listener the caller is looking for.
    pub fn tcp_listeners(pid: u32) -> Result<Vec<SocketAddr>, String> {
        const AF_INET: u32 = 2;
        const AF_INET6: u32 = 23;
        const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
        let mut out = Vec::new();
        for af in [AF_INET, AF_INET6] {
            let mut buf = vec![0u8; 16 * 1024];
            let mut attempts = 0;
            let size = loop {
                let mut size = buf.len() as u32;
                // SAFETY: the buffer is as large as `size` says; the call writes at most `size` bytes.
                let rc = unsafe { GetExtendedTcpTable(Some(buf.as_mut_ptr() as *mut _), &mut size, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0) };
                match rc {
                    0 => break size as usize,
                    ERROR_INSUFFICIENT_BUFFER if attempts < 4 => {
                        attempts += 1;
                        buf = vec![0u8; size as usize + 16 * 1024];
                    }
                    _ => return Err(format!("the listener table could not be read ({rc})")),
                }
            };
            // Both tables are a u32 count followed by the rows; the rows are read field by field from bytes.
            let buf = &buf[..size.min(buf.len())];
            if buf.len() < 4 {
                return Err("the listener table is truncated".into());
            }
            let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            let row = if af == AF_INET { std::mem::size_of::<MIB_TCPROW_OWNER_PID>() } else { std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>() };
            if count.checked_mul(row).and_then(|n| n.checked_add(4)).is_none_or(|end| end > buf.len()) {
                return Err("the listener table is truncated".into());
            }
            let u32_at = |o: usize| u32::from_ne_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]);
            for i in 0..count {
                let o = 4 + i * row;
                if af == AF_INET {
                    if u32_at(o + 20) == pid {
                        let ip = Ipv4Addr::new(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
                        let port = u16::from_be_bytes([buf[o + 8], buf[o + 9]]);
                        out.push(SocketAddr::new(IpAddr::V4(ip), port));
                    }
                } else if u32_at(o + 52) == pid {
                    let mut addr = [0u8; 16];
                    addr.copy_from_slice(&buf[o..o + 16]);
                    let port = u16::from_be_bytes([buf[o + 20], buf[o + 21]]);
                    out.push(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(addr)), port));
                }
            }
        }
        Ok(out)
    }
}
