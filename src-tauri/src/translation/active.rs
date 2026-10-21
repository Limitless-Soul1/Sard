//! The catalog the models section works with, and the download policy that goes with it.
//!
//! **A release build has one: the built-in catalog, under the production policy.** Nothing here reads the
//! environment in a release build; the test catalog below does not exist there at all.
//!
//! **A development build may name a test catalog instead**, with `SARD_TRANSLATION_TEST_CATALOG` — a JSON file that
//! points every download at a server on 127.0.0.1, so the section can be exercised without fetching anything real:
//!
//! * **No fallback.** Once the variable is set, the test catalog is used or nothing is: a file that cannot be read,
//!   or that names anything but 127.0.0.1, is refused, and the built-in catalog is NOT used in its place.
//! * **127.0.0.1 only, twice over.** Every URL in the file must be plain HTTP to 127.0.0.1, and the policy that
//!   comes with it allows no other host — so even a redirect elsewhere is refused before it is followed.
//! * **The licence and the needs stay the catalog's.** A test model takes the id of a built-in model, and with it
//!   that model's licence and requirements: a test catalog cannot make a model's terms disappear.
//! * **Only beside moved data.** The models section uses a test catalog only when the data directory has been moved
//!   too (`SARD_DATA_DIR`), so test files never land in a real translation directory.
//! * **No engine is run.** The test runtime's engine files are not a program. A test catalog's preparation uses a
//!   stand-in (`test::StandIn`) that starts nothing and answers the test sentence after a short wait — or fails, as
//!   `SARD_TRANSLATION_TEST_PREPARE` says (`memory` or `test`).

use super::catalog::{self, Artifact, EngineSpec, Kind, ENGINE_WINDOWS_X64};
use super::download::Policy;

/// The catalog in use.
pub struct Active {
    pub spec: &'static EngineSpec,
    pub models: Vec<&'static Artifact>,
    pub policy: Policy,
    /// A development build's test catalog, not the built-in one.
    pub test: bool,
}

impl Active {
    pub fn model(&self, id: &str) -> Option<&'static Artifact> {
        self.models.iter().copied().find(|a| a.id == id)
    }
}

/// The built-in catalog under the production policy: the only one a release build has.
pub fn builtin() -> Active {
    Active {
        spec: &ENGINE_WINDOWS_X64,
        models: catalog::ALL.iter().filter(|a| a.kind == Kind::Model).collect(),
        policy: Policy::production(),
        test: false,
    }
}

/// The catalog in use. In a release build, always the built-in one.
pub fn active() -> Result<Active, String> {
    #[cfg(debug_assertions)]
    {
        test::from_variable(std::env::var_os(test::VARIABLE))
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(builtin())
    }
}

#[cfg(debug_assertions)]
pub(crate) mod test {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde::Deserialize;

    use super::super::catalog::{self, Artifact, EngineFile, EngineSpec, Kind, Licence, Source};
    use super::super::download::Policy;
    use super::super::engine::{EngineError, EngineInfo, Execution, PhaseTimes};
    use super::super::execution::NotStarted;
    use super::super::hardware::Fit;
    use super::super::pipeline::{self, Raw, Request};
    use super::super::prepare;
    use super::{builtin, Active};

    pub(crate) const VARIABLE: &str = "SARD_TRANSLATION_TEST_CATALOG";

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct File {
        runtime: Download,
        engine: Engine,
        models: Vec<Model>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Download {
        url: String,
        file_name: String,
        size: u64,
        sha256: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Engine {
        executable: String,
        files: Vec<EngineFileEntry>,
        notices_name: String,
        notices: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EngineFileEntry {
        name: String,
        size: u64,
        sha256: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Model {
        /// The built-in model this stands for: its licence and requirements are taken from there.
        id: String,
        #[serde(flatten)]
        download: Download,
    }

    fn leak(s: String) -> &'static str {
        Box::leak(s.into_boxed_str())
    }

    /// Plain HTTP to 127.0.0.1, on an explicit port, with no user information. Anything else is refused.
    fn loopback(url: &str) -> Result<(), String> {
        let rest = url.strip_prefix("http://127.0.0.1:").ok_or_else(|| format!("not a 127.0.0.1 address: {url}"))?;
        let port: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if port.is_empty() || !rest[port.len()..].starts_with('/') || port.parse::<u16>().is_err() {
            return Err(format!("not a 127.0.0.1 address: {url}"));
        }
        Ok(())
    }

    fn artifact(id: &'static str, kind: Kind, licence: Licence, d: Download) -> Result<&'static Artifact, String> {
        loopback(&d.url)?;
        if d.sha256.len() != 64 || !d.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Err(format!("{id}: the checksum is not 64 lowercase hex digits"));
        }
        let sources: &'static [Source] = Box::leak(vec![Source { url: leak(d.url) }].into_boxed_slice());
        Ok(Box::leak(Box::new(Artifact { id, kind, file_name: leak(d.file_name), size: d.size, sha256: leak(d.sha256), sources, licence })))
    }

    /// The catalog for the variable's value: the built-in one if it is unset or empty; the test catalog it names
    /// otherwise — or an error, never the built-in catalog in its place.
    pub(crate) fn from_variable(value: Option<OsString>) -> Result<Active, String> {
        let Some(path) = value.filter(|v| !v.is_empty()) else {
            return Ok(builtin());
        };
        let text = std::fs::read_to_string(&path).map_err(|e| format!("the test catalog {} cannot be read: {e}", path.to_string_lossy()))?;
        let file: File = serde_json::from_str(&text).map_err(|e| format!("the test catalog is not valid: {e}"))?;
        from_file(file)
    }

    pub(crate) fn from_file(file: File) -> Result<Active, String> {
        let runtime = artifact("test-runtime", Kind::Runtime, Licence::LlamaCppRuntime, file.runtime)?;
        let files: Vec<EngineFile> = file.engine.files.into_iter().map(|f| EngineFile { name: leak(f.name), size: f.size, sha256: leak(f.sha256) }).collect();
        if !files.iter().any(|f| f.name == file.engine.executable) {
            return Err("the engine's executable is not one of its files".into());
        }
        let spec: &'static EngineSpec = Box::leak(Box::new(EngineSpec {
            archive: runtime,
            files: Box::leak(files.into_boxed_slice()),
            unused: &[],
            executable: leak(file.engine.executable),
            min_vc_runtime: (14, 0),
            notices_name: leak(file.engine.notices_name),
            notices: leak(file.engine.notices),
        }));
        let mut models = Vec::new();
        for m in file.models {
            let built_in = catalog::by_id(&m.id).filter(|a| a.kind == Kind::Model).ok_or_else(|| format!("{}: not a model in the catalog", m.id))?;
            models.push(artifact(built_in.id, Kind::Model, built_in.licence, m.download)?);
        }
        Ok(Active { spec, models, policy: Policy::loopback_for_development(), test: true })
    }

    // ---- The stand-in engine of a test catalog's preparation ------------------------------------------------------

    pub(crate) const PREPARE_VARIABLE: &str = "SARD_TRANSLATION_TEST_PREPARE";

    /// How long the stand-in takes to start, so that Preparing can be seen.
    const START: Duration = Duration::from_secs(4);

    /// A working model's translation of `prepare::TEST_SENTENCE`.
    const ARABIC: &str = "تفتح المكتبة الصغيرة عند الزاوية أبوابها باكرًا كل صباح.";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Behaviour {
        Pass,
        /// The hardware check refuses the GPU for too little memory.
        Memory,
        /// The test translation comes back in English, and is not accepted.
        Test,
    }

    /// What a test catalog's preparation runs in place of an engine: nothing. It waits, then answers the test sentence as
    /// a working model would — or fails as `PREPARE_VARIABLE` says.
    pub(crate) struct StandIn {
        model: &'static str,
        cancel: Arc<AtomicBool>,
        behaviour: Behaviour,
    }

    impl StandIn {
        pub(crate) fn new(model: &'static str, cancel: Arc<AtomicBool>, behaviour: Behaviour) -> StandIn {
            StandIn { model, cancel, behaviour }
        }

        pub(crate) fn from_environment(model: &'static str, cancel: Arc<AtomicBool>) -> StandIn {
            let behaviour = match std::env::var(PREPARE_VARIABLE).as_deref() {
                Ok("memory") => Behaviour::Memory,
                Ok("test") => Behaviour::Test,
                _ => Behaviour::Pass,
            };
            StandIn::new(model, cancel, behaviour)
        }
    }

    impl prepare::Engine for StandIn {
        type Source = StandInSource;

        fn start(&self) -> Result<EngineInfo, NotStarted> {
            let until = Instant::now() + START;
            while Instant::now() < until {
                if self.cancel.load(Ordering::SeqCst) {
                    return Err(NotStarted::Engine(EngineError::Cancelled));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if self.behaviour == Behaviour::Memory {
                return Err(NotStarted::Refused { why: Fit::InsufficientRam { needed: 4 * 1024 * 1024 * 1024, available: 2 * 1024 * 1024 * 1024 }, alternative: None });
            }
            let execution = Execution::Gpu { device: "Test GPU (stand-in)".into() };
            Ok(EngineInfo { pid: 0, port: 0, model_id: self.model.into(), execution, phases: PhaseTimes::default() })
        }

        fn source(&self, cancel: Arc<AtomicBool>) -> Result<StandInSource, String> {
            Ok(StandInSource { cancel, english: self.behaviour == Behaviour::Test })
        }

        fn stop(&self) -> Result<(), String> {
            Ok(())
        }
    }

    pub(crate) struct StandInSource {
        cancel: Arc<AtomicBool>,
        english: bool,
    }

    impl pipeline::Source for StandInSource {
        type Error = String;

        fn answer(&mut self, r: &Request) -> Result<Raw, String> {
            if self.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let out = if self.english { r.text.clone() } else { ARABIC.to_string() };
            Ok(Raw { out, tokens: Some(14), stop: "eos".into() })
        }
    }
}
