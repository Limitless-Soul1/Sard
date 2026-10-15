//! Engine process tests.
//!
//! The "engine" is this test program itself, started again in a mode that imitates the real server
//! (`process::fake_engine_entry`). So every lifecycle path runs for real — a real process, real sockets, a real
//! Job Object — without the real engine, without a model, and without putting any load on the machine.
//!
//! What the imitation is faithful to was read from the server's source at the pinned release:
//! * it binds before it loads the model, and prints its address only afterwards;
//! * every route answers 503 while the model loads;
//! * `/health` and `/` need no key, everything else answers 401 without it;
//! * the configured CORS origin is sent on every answer;
//! * `/slots` answers 501 when it is switched off, and `/tools` and `/cors-proxy` answer 403.
//!
//! Whether the REAL engine behaves as its source says is not something these tests can show.

use std::ffi::OsString;
use std::path::Path;

use super::catalog::{launch_profile, MODEL_A, MODEL_B};
use super::engine::*;

fn args_of(model: &super::catalog::Artifact, execution: &Execution) -> Vec<String> {
    let profile = launch_profile(model).unwrap();
    engine_args(Path::new("model.gguf"), profile, execution).unwrap().iter().map(|a| a.to_string_lossy().into_owned()).collect()
}

fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
    args.windows(2).any(|w| w[0] == flag && w[1] == value)
}

#[test]
fn every_engine_gets_the_security_flags_and_an_explicit_device() {
    let gpu = Execution::Gpu { device: "Vulkan0".into() };
    let cpu = Execution::Cpu { threads: 4 };
    for model in [&MODEL_A, &MODEL_B] {
        for execution in [&gpu, &cpu] {
            let args = args_of(model, execution);
            assert_eq!(&args[..2], ["-m", "model.gguf"]);
            assert_eq!(&args[args.len() - SECURITY_FLAGS.len()..], SECURITY_FLAGS, "the security flags come last, so nothing overrides them");
            assert!(has_pair(&args, "--host", "127.0.0.1"));
            assert!(has_pair(&args, "--port", "0"));
            assert!(has_pair(&args, "--cors-origins", CLOSED_CORS_ORIGIN));
            assert!(has_pair(&args, "-lv", "3"));
            for flag in ["--no-webui", "--no-slots", "--no-cors-credentials", "--no-agent", "--no-ui-mcp-proxy", "--offline"] {
                assert!(args.iter().any(|a| a == flag), "{flag}");
            }
            for opening in ["--api-key", "--api-key-file", "--webui", "--ui", "--slots", "--metrics", "--props", "--tools", "--agent", "--ssl-key-file"] {
                assert!(!args.iter().any(|a| a == opening), "{opening}");
            }
            assert_eq!(args.iter().filter(|a| *a == "-dev").count(), 1, "exactly one device, always named");
        }
        let args = args_of(model, &gpu);
        assert!(has_pair(&args, "-dev", "Vulkan0") && has_pair(&args, "-ngl", "99"));
        let args = args_of(model, &cpu);
        assert!(has_pair(&args, "-dev", "none") && has_pair(&args, "-ngl", "0"));
        assert!(has_pair(&args, "-t", "4") && has_pair(&args, "-tb", "4"));
    }
}

#[test]
fn device_names_and_thread_counts_are_validated() {
    let profile = launch_profile(&MODEL_B).unwrap();
    let long = "x".repeat(33);
    for device in ["", "none", "NONE", "Vulkan0 --api-key x", "a,b", "../x", "--help", long.as_str()] {
        let result = engine_args(Path::new("m"), profile, &Execution::Gpu { device: device.into() });
        assert!(matches!(result, Err(EngineError::InvalidExecution(_))), "{device:?}");
    }
    for threads in [0, 257] {
        let result = engine_args(Path::new("m"), profile, &Execution::Cpu { threads });
        assert!(matches!(result, Err(EngineError::InvalidExecution(_))), "{threads}");
    }
    assert!(launch_profile(&super::catalog::RUNTIME_WINDOWS_X64).is_none(), "only a model can be started");
}

#[test]
fn the_environment_is_an_allowlist_plus_a_fixed_path_and_the_key() {
    let key = SessionKey::for_tests(&"5a".repeat(32));
    let system = Path::new("windows").join("System32");
    let parent = [
        ("SystemRoot", "root"),
        ("WINDIR", "root"),
        ("TEMP", "temp"),
        ("Path", "somewhere-else"),
        ("LLAMA_ARG_TOOLS", "all"),
        ("LLAMA_ARG_HOST", "0.0.0.0"),
        ("llama_arg_port", "8080"),
        ("LLAMA_API_KEY", "chosen-by-someone-else"),
        ("GGML_VK_VISIBLE_DEVICES", "1"),
        ("OMP_NUM_THREADS", "64"),
        ("KMP_AFFINITY", "x"),
        ("VK_ADD_LAYER_PATH", "x"),
        ("VK_ICD_FILENAMES", "x"),
        ("HTTP_PROXY", "http://proxy.example"),
        ("HF_TOKEN", "x"),
        ("UNRELATED", "x"),
    ];
    let env = engine_env(parent.iter().map(|(k, v)| (OsString::from(*k), OsString::from(*v))), &system, &key);
    let get = |name: &str| -> Vec<String> {
        env.iter().filter(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v.to_string_lossy().into_owned()).collect()
    };

    assert_eq!(get("LLAMA_API_KEY"), [key.as_str()], "only this session's key, never an inherited one");
    let expected_path = format!("{};{}", system.display(), Path::new("windows").display());
    assert_eq!(get("PATH"), [expected_path], "the search path is the system directories only");
    assert_eq!(get("SystemRoot"), ["root"]);
    assert_eq!(get("windir"), ["root"], "names are matched as Windows matches them, without regard to case");
    assert_eq!(get("TEMP"), ["temp"]);
    for (name, _) in env.iter() {
        let name = name.to_string_lossy();
        let allowed = PASSED_ENV.iter().any(|p| p.eq_ignore_ascii_case(&name)) || name == "PATH" || name == "LLAMA_API_KEY";
        assert!(allowed, "{name} reached the engine");
    }
}

#[test]
fn the_port_is_read_only_from_a_loopback_listening_line() {
    assert_eq!(listening_port("srv          main: listening on http://127.0.0.1:49152"), Some(49152));
    for line in [
        "main: listening on http://0.0.0.0:8080",
        "main: listening on http://[::1]:8080",
        "main: listening on http://127.0.0.1:0",
        "main: listening on http://127.0.0.1:99999",
        "main: listening on http://127.0.0.1:",
        "main: listening on unix://engine.sock",
        "http://127.0.0.1:8080",
    ] {
        assert_eq!(listening_port(line), None, "{line}");
    }
}

#[test]
fn only_ipv4_loopback_counts_as_local() {
    for local in ["127.0.0.1:8080", "127.0.0.2:1"] {
        assert!(is_loopback_v4(&local.parse().unwrap()), "{local}");
    }
    for wide in ["0.0.0.0:8080", "192.168.1.5:8080", "10.0.0.1:1", "[::]:8080", "[::1]:8080", "[::ffff:127.0.0.1]:8080"] {
        assert!(!is_loopback_v4(&wide.parse().unwrap()), "{wide}");
    }
}

#[test]
fn the_missing_runtime_files_are_named() {
    let tmp = super::install_tests::TempDir::new("vc-runtime");
    assert_eq!(missing_vc_runtime(&tmp.0), VC_RUNTIME);
    std::fs::write(tmp.0.join("MSVCP140.dll"), b"").unwrap();
    assert_eq!(missing_vc_runtime(&tmp.0), ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll"]);
    for name in VC_RUNTIME {
        std::fs::write(tmp.0.join(name), b"").unwrap();
    }
    assert!(missing_vc_runtime(&tmp.0).is_empty());
}

#[test]
fn the_engine_is_given_ordinary_paths_where_one_exists() {
    let verbatim = Path::new(r"\\?\C:\data\translation\model.gguf");
    if cfg!(windows) {
        assert_eq!(plain_path(verbatim), Path::new(r"C:\data\translation\model.gguf"));
    } else {
        assert_eq!(plain_path(verbatim), verbatim);
    }
    let long = format!(r"\\?\C:\{}", "x".repeat(300));
    for unchanged in [r"\\?\UNC\server\share\model.gguf", r"C:\data\model.gguf", "relative/model.gguf", r"\\?\pipe\x", long.as_str()] {
        assert_eq!(plain_path(Path::new(unchanged)), Path::new(unchanged), "{unchanged}");
    }
}

#[test]
fn a_runtime_that_is_missing_too_old_or_unidentifiable_is_refused_with_what_to_do() {
    let tmp = super::install_tests::TempDir::new("vc-version");
    let claims = |version: Option<[u16; 4]>| move |_: &Path| version;
    const NEEDED: (u16, u16) = (14, 51);

    // Missing comes first: with no files there is no version to speak of.
    assert_eq!(
        vc_runtime_problem(&tmp.0, NEEDED, claims(Some([14, 51, 36247, 0]))),
        Some(EngineError::MissingVcRuntime(VC_RUNTIME.iter().map(|s| s.to_string()).collect()))
    );
    for name in VC_RUNTIME {
        std::fs::write(tmp.0.join(name), b"").unwrap();
    }

    // Recent enough: exactly the minimum, a later minor, a later major.
    for recent in [[14, 51, 36247, 0], [14, 51, 0, 0], [14, 52, 0, 0], [15, 0, 0, 0]] {
        assert_eq!(vc_runtime_problem(&tmp.0, NEEDED, claims(Some(recent))), None, "{recent:?}");
    }
    // Too old — the newest that is still too old among them. Being installed is not enough.
    for old in [[14, 50, 35731, 0], [14, 44, 35215, 0], [14, 36, 32532, 0], [13, 99, 0, 0]] {
        match vc_runtime_problem(&tmp.0, NEEDED, claims(Some(old))) {
            Some(EngineError::VcRuntimeTooOld { file, found, needed }) => {
                assert_eq!(file, "MSVCP140.dll");
                assert_eq!(found, Some(format!("{}.{}.{}.{}", old[0], old[1], old[2], old[3])));
                assert_eq!(needed, "14.51");
            }
            other => panic!("{old:?}: {other:?}"),
        }
    }
    // One old file among recent ones is enough, and it is the one that is named.
    let mixed = |file: &Path| Some(if file.ends_with("VCRUNTIME140_1.dll") { [14, 29, 30139, 0] } else { [14, 51, 36247, 0] });
    assert!(matches!(vc_runtime_problem(&tmp.0, NEEDED, mixed), Some(EngineError::VcRuntimeTooOld { ref file, .. }) if file == "VCRUNTIME140_1.dll"));
    // A version that cannot be read is not given the benefit of the doubt.
    let unknown = vc_runtime_problem(&tmp.0, NEEDED, claims(None)).unwrap();
    assert!(matches!(unknown, EngineError::VcRuntimeTooOld { found: None, .. }), "{unknown:?}");

    // What the user is told: the prerequisite by name and version, and where Microsoft publishes it.
    let old = vc_runtime_problem(&tmp.0, NEEDED, claims(Some([14, 36, 32532, 0]))).unwrap();
    let said = old.to_string();
    assert!(said.contains("MSVCP140.dll") && said.contains("14.36.32532.0") && said.contains("14.51"), "{said}");
    for error in [&old, &unknown, &EngineError::MissingVcRuntime(vec!["MSVCP140.dll".into()])] {
        let advice = error.recovery().expect("there is something the user can do");
        assert!(advice.contains(VC_RUNTIME_PRODUCT) && advice.contains(VC_RUNTIME_SOURCE), "{advice}");
    }
    assert!(old.recovery().unwrap().contains("14.51"));
    assert_eq!(EngineError::Cancelled.recovery(), None);
}

#[test]
fn a_file_version_is_read_from_the_file_and_never_guessed() {
    let text = b"not a program at all, only text, long enough to be indexed into without running off its end".repeat(8);
    let mut headed = vec![0u8; 4096];
    headed[..2].copy_from_slice(b"MZ");
    headed[0x3C] = 0x80;
    headed[0x80..0x84].copy_from_slice(b"PE\0\0");
    let junk: [&[u8]; 6] = [b"", b"MZ", &[0u8; 64], &[0xFFu8; 4096], &text, &headed];
    for bytes in junk {
        assert_eq!(file_version(bytes), None);
    }

    // Real files with a real version: on Windows, the system's own copies of the runtime.
    #[cfg(windows)]
    {
        let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        for name in VC_RUNTIME {
            let bytes = std::fs::read(system.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            let version = file_version(&bytes).unwrap_or_else(|| panic!("{name} has a version"));
            assert_eq!(version[0], 14, "{name}: {version:?}");
            let [major, minor, build, revision] = version;
            super::install_tests::note(&format!("MEASURED: this machine's {name} is version {major}.{minor}.{build}.{revision}"));
            // A damaged copy gives no version rather than a wrong one, and never a panic.
            for cut in [bytes.len() / 2, bytes.len() / 8, 1024] {
                let _ = file_version(&bytes[..cut.min(bytes.len())]);
            }
            let mut scrambled = bytes.clone();
            scrambled.iter_mut().skip(0x200).step_by(7).for_each(|b| *b = !*b);
            let _ = file_version(&scrambled);
        }
    }
}

#[test]
fn a_line_longer_than_the_read_limit_arrives_in_pieces() {
    // 300,000 bytes with no line end, then two ordinary lines: what an engine printing progress looks like.
    let mut printed = vec![b'.'; 300_000];
    printed.extend_from_slice(b"\nfirst\nsecond\n");
    let mut pieces: Vec<Vec<u8>> = Vec::new();
    for_each_line(&printed[..], |piece| pieces.push(piece.to_vec()));

    let longest = pieces.iter().map(Vec::len).max().unwrap();
    assert!(longest as u64 <= LOG_READ_MAX, "a piece of {longest} bytes was held at once");
    assert_eq!(pieces.concat(), printed, "nothing is lost or reordered");
    assert_eq!(&pieces[pieces.len() - 2..], [b"first\n".to_vec(), b"second\n".to_vec()]);
}

#[test]
fn a_session_key_is_random_and_never_printed() {
    let (a, b) = (SessionKey::generate().unwrap(), SessionKey::generate().unwrap());
    assert_ne!(a.as_str(), b.as_str());
    for key in [&a, &b] {
        assert!(key.as_str().len() == 64 && key.as_str().bytes().all(|c| c.is_ascii_hexdigit()));
        assert!(!format!("{key:?}").contains(key.as_str()));
    }
    let endpoint = Endpoint { port: 1, key: a.clone() };
    assert!(!format!("{endpoint:?}").contains(a.as_str()));
}

#[cfg(not(windows))]
#[test]
fn starting_an_engine_is_unsupported_off_windows() {
    let _serial = super::slot::serial_for_tests();
    let tmp = super::install_tests::TempDir::new("unsupported");
    let store = super::store::Store::open(tmp.0.join("translation")).unwrap();
    let manager = EngineManager::new(EngineConfig::default());
    let result = manager.start(&store, &super::catalog::ENGINE_WINDOWS_X64, &MODEL_B, Execution::Cpu { threads: 4 });
    assert_eq!(result, Err(EngineError::Unsupported));
    assert_eq!(manager.status(), EngineStatus::Idle);
    assert!(super::slot::claim(super::slot::Holder::Engine).is_ok(), "nothing was left holding the slot");
}

#[cfg(windows)]
mod process {
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Barrier, OnceLock};
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0};
    use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

    use super::super::catalog::{Artifact, Kind, MODEL_B};
    use super::super::engine::*;
    use super::super::install::{self, InstallError};
    use super::super::install_tests::{build_zip, entries, fixture_in, never, put_verified, sha, try_link_file, Files, Fixture, TempDir};
    use super::super::slot::{self, serial_for_tests, Holder};

    const FAKE_ENTRY: &str = "translation::engine_tests::process::fake_engine_entry";
    const HOST_ENTRY: &str = "translation::engine_tests::process::engine_host_entry";
    const HARNESS: [&str; 3] = ["--exact", "--nocapture", "--test-threads=1"];
    const MODE: &str = "SARD_FAKE_ENGINE_MODE";
    const LOAD_MS: &str = "SARD_FAKE_ENGINE_LOAD_MS";
    const KEY_FILE: &str = "SARD_FAKE_ENGINE_KEY_FILE";
    /// Handle values from the host, separated by commas: the fake reports what each is in its own process.
    const HANDLES: &str = "SARD_FAKE_ENGINE_HANDLES";
    /// A file the fake writes its process id (and its child's, if it has one) to, for a test that must check they
    /// end.
    const PID_FILE: &str = "SARD_FAKE_ENGINE_PID_FILE";
    const HOST: &str = "SARD_ENGINE_HOST";
    const HOST_DIR: &str = "SARD_ENGINE_HOST_DIR";
    /// `CREATE_NO_WINDOW`: no helper process ever opens a console window on the screen.
    const NO_WINDOW: u32 = 0x0800_0000;
    /// No fake engine or host outlives this, whatever happens to the test that started it.
    const MAX_LIFE: Duration = Duration::from_secs(120);

    // ---- The fake engine ----

    /// Not a test of anything: the entry point of the fake engine. In an ordinary test run it does nothing.
    #[test]
    fn fake_engine_entry() {
        if let Ok(mode) = std::env::var(MODE) {
            fake::run(&mode);
        }
    }

    mod fake {
        use super::*;

        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut core::ffi::c_void;
            fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
        }

        struct Server {
            mode: String,
            key: String,
            cors: String,
            loaded: AtomicBool,
        }

        pub fn run(mode: &str) -> ! {
            std::thread::spawn(|| {
                std::thread::sleep(MAX_LIFE);
                std::process::exit(99);
            });
            if mode == "sleeper" {
                idle();
            }
            // The test harness has just printed "test <name> ... " without ending the line.
            println!();
            let args: Vec<String> = std::env::args().skip_while(|a| a != "--").skip(1).collect();
            let key = std::env::var("LLAMA_API_KEY").unwrap_or_default();
            for (name, _) in std::env::vars_os() {
                println!("FAKE env {}", name.to_string_lossy());
            }
            if args.first().map(String::as_str) == Some("--list-devices") {
                devices(mode);
            }
            if let Ok(path) = std::env::var(KEY_FILE) {
                let _ = fs::write(path, &key);
            }

            // What every launch must look like from the inside. A violation ends the fake at once, so every
            // test that reaches "ready" has also passed these.
            let mut violations = Vec::new();
            if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
                violations.push("the key is not 32 random bytes in hex".to_string());
            } else if std::env::args().any(|a| a.contains(&key)) {
                violations.push("the key is on the command line".to_string());
            }
            for (name, _) in std::env::vars_os() {
                let upper = name.to_string_lossy().to_ascii_uppercase();
                if (upper.starts_with("LLAMA_") && upper != "LLAMA_API_KEY") || upper.starts_with("GGML_") {
                    violations.push(format!("the variable {upper} reached the engine"));
                }
            }
            if args.len() < SECURITY_FLAGS.len() || args[args.len() - SECURITY_FLAGS.len()..] != *SECURITY_FLAGS {
                violations.push("the security flags are not the last arguments".to_string());
            }
            violations.extend(placement());
            if !violations.is_empty() {
                for v in violations {
                    println!("FAKE violation: {v}");
                }
                std::process::exit(3);
            }
            if let Ok(handles) = std::env::var(HANDLES) {
                for value in handles.split(',') {
                    let here = value.parse::<usize>().ok().and_then(|v| file_identity(HANDLE(v as *mut core::ffi::c_void)));
                    println!("FAKE handle {value} {}", here.unwrap_or_else(|| "is not a file here".into()));
                }
            }

            match mode {
                "early_exit" => {
                    println!("error: the engine could not start");
                    std::process::exit(1);
                }
                "port_conflict" => {
                    println!("srv         start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 0");
                    println!("srv          main: exiting due to HTTP server error");
                    std::process::exit(1);
                }
                "bad_device" => {
                    println!("error: invalid device: Vulkan7");
                    std::process::exit(1);
                }
                "missing_library" => std::process::exit(0xC000_0135u32 as i32),
                // What Windows ends a process with when a library is there but lacks what the process needs.
                "missing_entry_point" => std::process::exit(0xC000_0139u32 as i32),
                "leak_then_exit" => {
                    println!("srv          init: api_keys: {key}");
                    std::process::exit(1);
                }
                "silent" => idle(),
                _ => {}
            }

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let cors = args.windows(2).find(|w| w[0] == "--cors-origins").map(|w| w[1].clone()).unwrap_or_default();
            let server = Arc::new(Server { mode: mode.to_string(), key: key.clone(), cors, loaded: AtomicBool::new(false) });
            let mut extra_listeners = Vec::new();
            if mode == "wide_bind" {
                extra_listeners.push(bind_ipv6_loopback());
            }
            if mode == "two_listeners" {
                extra_listeners.push(TcpListener::bind("127.0.0.1:0").unwrap());
            }
            if mode == "spawn_child" {
                // Left running on purpose: the test checks that stopping the engine ends this too.
                #[allow(clippy::zombie_processes)]
                let child = Command::new(std::env::current_exe().unwrap())
                    .arg(FAKE_ENTRY)
                    .args(HARNESS)
                    .env(MODE, "sleeper")
                    .creation_flags(NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                println!("FAKE child {}", child.id());
            }
            {
                let server = server.clone();
                std::thread::spawn(move || {
                    for stream in listener.incoming().flatten() {
                        let server = server.clone();
                        std::thread::spawn(move || handle(stream, &server));
                    }
                });
            }

            println!("srv    load_model: loading model 'model.gguf'");
            if mode == "noisy" {
                // Progress printed without ending the line, then far more lines than are kept.
                println!("{}", ".".repeat(300_000));
                for i in 0..1000 {
                    println!("line {i} {}", "x".repeat(3000));
                }
            }
            if mode == "load_fail" {
                std::thread::sleep(Duration::from_millis(300));
                println!("srv    load_model: failed to load model, 'model.gguf'");
                println!("srv          main: exiting due to model loading error");
                std::process::exit(1);
            }
            if mode == "never_ready" {
                idle();
            }
            let load_ms = std::env::var(LOAD_MS).ok().and_then(|v| v.parse().ok()).unwrap_or(300);
            std::thread::sleep(Duration::from_millis(load_ms));
            if mode == "plant_late" {
                // A file that appears beside the engine while it is starting — in its own directory, which is
                // its working directory.
                fs::write("ggml-late.dll", b"appeared while the engine was starting").unwrap();
            }
            if mode == "wide_late" {
                extra_listeners.push(bind_ipv6_loopback());
            }
            server.loaded.store(true, Ordering::SeqCst);
            // As the real server does: the address is printed only now, after the load.
            println!("srv          main: model loaded");
            println!("srv          main: listening on http://127.0.0.1:{port}");
            if mode == "leak" {
                println!("srv          init: api_keys: {key}");
                println!("request: Authorization: Bearer {key} (end)");
            }
            idle();
        }

        fn idle() -> ! {
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }

        /// Where and how every engine process must run: in its own directory, and with a console of its own that
        /// has no window.
        fn placement() -> Vec<String> {
            let mut violations = Vec::new();
            let here = std::env::current_dir().ok().and_then(|d| fs::canonicalize(d).ok());
            let beside = std::env::current_exe().ok().and_then(|e| fs::canonicalize(e.parent()?).ok());
            if here.is_none() || here != beside {
                violations.push("the working directory is not the engine's own directory".to_string());
            }
            // Started windowless, a process has a console of its own with no window. Without that it either
            // gets a new console WITH a window (a parent without a console, as Sard is) or shares its parent's
            // (a parent with one, as the test runner is). Only the second can be produced here without
            // putting a window on the screen, so both are checked.
            let mut sharing = [0u32; 64];
            // SAFETY: the first takes no arguments; the second writes at most `len` ids into the buffer.
            let (window, count) = unsafe { (GetConsoleWindow(), GetConsoleProcessList(sharing.as_mut_ptr(), sharing.len() as u32) as usize) };
            let shared = count > sharing.len() || sharing[..count].iter().any(|pid| *pid != std::process::id());
            if !window.is_null() || shared {
                violations.push("the engine has a console window, or shares its parent's console".to_string());
            }
            violations
        }

        /// The fake's `--list-devices`. A violation of how the listing must be run ends it at once with exit code 3,
        /// so every listing a test sees succeed has passed these checks.
        fn devices(mode: &str) -> ! {
            let mut violations = placement();
            // Only the allowed variables, the fixed PATH and the test's own switches — no session key, nothing
            // else of the test runner's environment.
            for (name, _) in std::env::vars_os() {
                let name = name.to_string_lossy();
                let allowed = PASSED_ENV.iter().chain(&["PATH", MODE, PID_FILE, KEY_FILE]).any(|p| p.eq_ignore_ascii_case(&name));
                if !allowed {
                    violations.push(format!("the variable {name} reached the engine"));
                }
            }
            if !violations.is_empty() {
                for v in violations {
                    println!("FAKE violation: {v}");
                }
                std::process::exit(3);
            }
            // That it ran at all (a mode with a child adds the child's id below).
            if let Ok(path) = std::env::var(PID_FILE) {
                let _ = fs::write(path, std::process::id().to_string());
            }
            let header = "Available devices:";
            match mode {
                "devices_one" => println!("{header}\n  Vulkan0: Test GPU (8192 MiB, 8000 MiB free)"),
                "devices_none" => println!("{header}"),
                "devices_two" => println!("{header}\n  Vulkan0: Test GPU (8192 MiB, 8000 MiB free)\n  Vulkan1: Other GPU (4096 MiB, 4000 MiB free)"),
                "devices_garbage" => println!("error: something went wrong"),
                "devices_malformed" => println!("{header}\n  Vulkan0 Test GPU"),
                "devices_duplicate" => println!("{header}\n  Vulkan0: Test GPU (8192 MiB, 8000 MiB free)\n  Vulkan0: Other GPU (4096 MiB, 4000 MiB free)"),
                // Well formed, and far longer than any real list: only the size limit refuses it.
                "devices_flood" => {
                    println!("{header}");
                    for i in 0..3000 {
                        println!("  Vulkan{i}: Test GPU (8192 MiB, 8000 MiB free)");
                    }
                }
                "devices_exit" => {
                    println!("{header}\n  Vulkan0: Test GPU (8192 MiB, 8000 MiB free)");
                    std::process::exit(1);
                }
                // What Windows ends a process with when it reads memory it must not.
                "devices_crash" => std::process::exit(0xC000_0005u32 as i32),
                "devices_hang" => {
                    // Left running on purpose: the test checks that giving up on the listing ends this too.
                    #[allow(clippy::zombie_processes)]
                    let child = Command::new(std::env::current_exe().unwrap())
                        .arg(FAKE_ENTRY)
                        .args(HARNESS)
                        .env(MODE, "sleeper")
                        .creation_flags(NO_WINDOW)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap();
                    if let Ok(path) = std::env::var(PID_FILE) {
                        let _ = fs::write(path, format!("{} {}", std::process::id(), child.id()));
                    }
                    idle();
                }
                _ => std::process::exit(5),
            }
            std::process::exit(0);
        }

        fn bind_ipv6_loopback() -> TcpListener {
            TcpListener::bind("[::1]:0").unwrap_or_else(|_| {
                println!("FAKE no-ipv6");
                std::process::exit(4);
            })
        }

        fn handle(mut stream: TcpStream, server: &Server) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let head_end = loop {
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
                match stream.read(&mut chunk) {
                    Ok(n) if n > 0 && buf.len() < 65_536 => buf.extend_from_slice(&chunk[..n]),
                    _ => return,
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
            let mut lines = head.split("\r\n");
            let mut request = lines.next().unwrap_or("").split(' ');
            let (method, path) = (request.next().unwrap_or(""), request.next().unwrap_or(""));
            let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
            let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
            let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
            while buf.len() < head_end + length {
                match stream.read(&mut chunk) {
                    Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                    _ => return,
                }
            }

            let (status, body) = respond(server, method, path, header("authorization"));
            let origin = match server.mode.as_str() {
                "cors_open" => "Access-Control-Allow-Origin: *\r\n".to_string(),
                "cors_missing" => String::new(),
                _ => format!("Access-Control-Allow-Origin: {}\r\n", server.cors),
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Answer\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{origin}\r\n{body}",
                body.len()
            );
        }

        fn respond(server: &Server, method: &str, path: &str, authorization: Option<&str>) -> (u16, &'static str) {
            let mode = server.mode.as_str();
            // The real order: "still loading" first, then the key.
            if !server.loaded.load(Ordering::SeqCst) && path != "/" {
                return (503, r#"{"error":{"message":"Loading model","type":"unavailable_error","code":503}}"#);
            }
            let public = matches!(path, "/health" | "/v1/health" | "/");
            let authorised = authorization == Some(format!("Bearer {}", server.key).as_str());
            if !public && !authorised && mode != "auth_off" {
                return (401, r#"{"error":{"message":"Invalid API Key","type":"authentication_error","code":401}}"#);
            }
            match (method, path) {
                ("GET", "/health") => match mode {
                    "malformed_health" => (200, r#"{"status":"loading"}"#),
                    "health_error" => (500, "{}"),
                    _ => (200, r#"{"status":"ok"}"#),
                },
                ("GET", "/") if mode == "web_ui" => (200, "<!doctype html>"),
                ("GET", "/slots") if mode == "slots_open" => (200, "[]"),
                ("GET", "/slots") => (501, r#"{"error":{"message":"This server does not support slots endpoint.","code":501}}"#),
                ("GET", "/tools") if mode == "tools_open" => (200, "[]"),
                ("GET", "/cors-proxy") if mode == "proxy_open" => (200, "{}"),
                ("GET", "/tools" | "/cors-proxy") => (403, r#"{"error":{"message":"this feature is disabled","type":"feature_disabled"}}"#),
                ("GET", "/v1/models") => (200, r#"{"data":[]}"#),
                ("POST", "/completion") => match mode {
                    "probe_hang" => {
                        std::thread::sleep(MAX_LIFE);
                        (500, "{}")
                    }
                    "probe_error" => (500, r#"{"error":{"message":"failed","code":500}}"#),
                    "probe_empty" => (200, "{}"),
                    _ => {
                        if mode == "crash_after_ready" {
                            std::thread::spawn(|| {
                                std::thread::sleep(Duration::from_millis(700));
                                std::process::exit(7);
                            });
                        }
                        (200, r#"{"content":" there"}"#)
                    }
                },
                _ => (404, r#"{"error":{"message":"File Not Found","type":"not_found_error","code":404}}"#),
            }
        }
    }

    // ---- Fixtures and helpers ----

    /// The fake engine's files and their archive, built once: the executable is this test program.
    fn fake_engine_archive() -> &'static (Files, Vec<u8>) {
        static ARCHIVE: OnceLock<(Files, Vec<u8>)> = OnceLock::new();
        ARCHIVE.get_or_init(|| {
            let exe = fs::read(std::env::current_exe().unwrap()).unwrap();
            let files: Files = vec![("llama-server.exe".into(), exe), ("LICENSE-LLVM-OpenMP".into(), b"test licence".to_vec())];
            let archive = build_zip(&entries(&files));
            (files, archive)
        })
    }

    struct EngineFixture {
        fx: Fixture,
        model: &'static Artifact,
    }

    /// An installed fake engine and an installed "model" (a few bytes under model B's id, so that it has a
    /// launch profile), in the directory `tmp`.
    fn engine_fixture_at(tmp: TempDir, tag: &str) -> EngineFixture {
        let (files, archive) = fake_engine_archive();
        let fx = fixture_in(tmp, tag, files, archive);
        install::install(&fx.store, fx.spec, &never()).unwrap();
        let bytes = b"not a real model";
        let model: &'static Artifact = Box::leak(Box::new(Artifact {
            id: MODEL_B.id,
            kind: Kind::Model,
            file_name: "model.gguf",
            size: bytes.len() as u64,
            sha256: Box::leak(sha(bytes).into_boxed_str()),
            sources: &[],
            licence: MODEL_B.licence,
        }));
        put_verified(&fx.store, model, bytes);
        EngineFixture { fx, model }
    }

    fn engine_fixture(tag: &str) -> EngineFixture {
        engine_fixture_at(TempDir::new(tag), tag)
    }

    fn config(mode: &str) -> EngineConfig {
        let mut config = EngineConfig {
            startup_timeout: Duration::from_secs(60),
            probe_timeout: Duration::from_secs(20),
            stop_timeout: Duration::from_secs(5),
            hooks: TestHooks::default(),
        };
        config.hooks.prefix_args = std::iter::once(FAKE_ENTRY).chain(HARNESS).chain(["--"]).map(String::from).collect();
        config.hooks.extra_env = vec![(MODE.into(), mode.into())];
        config
    }

    fn start(f: &EngineFixture, manager: &EngineManager) -> Result<EngineInfo, EngineError> {
        manager.start(&f.fx.store, f.fx.spec, f.model, Execution::Cpu { threads: 2 })
    }

    /// Start a fake engine in `mode` and return why the start failed.
    fn failure(f: &EngineFixture, config: EngineConfig) -> EngineError {
        let manager = EngineManager::new(config);
        let error = start(f, &manager).expect_err("this start must fail");
        assert_eq!(manager.status(), EngineStatus::Idle);
        assert!(manager.endpoint().is_none());
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("a failed start gives the slot back"));
        error
    }

    /// A process, held by handle, so that waiting for its end cannot be fooled by its id being reused.
    struct Watched(HANDLE);

    impl Watched {
        fn open(pid: u32) -> Option<Watched> {
            // SAFETY: a plain call; the handle is closed in Drop.
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, pid).ok().map(Watched) }
        }

        fn gone_within(&self, limit: Duration) -> bool {
            // SAFETY: the handle is open for the lifetime of `self`.
            unsafe { WaitForSingleObject(self.0, limit.as_millis() as u32) == WAIT_OBJECT_0 }
        }

        fn kill(&self) {
            // SAFETY: as above.
            unsafe {
                let _ = TerminateProcess(self.0, 1);
            }
        }
    }

    impl Drop for Watched {
        fn drop(&mut self) {
            // SAFETY: closed exactly once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// The fake engines this test process has started that are still running.
    fn engine_children() -> Vec<u32> {
        let me = std::process::id();
        let mut found = Vec::new();
        // SAFETY: the snapshot handle is closed below; the entry is sized as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap();
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
            while more {
                let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if entry.th32ParentProcessID == me && name.eq_ignore_ascii_case("llama-server.exe") {
                    // A process that has ended can stay listed while a handle to it is open.
                    if Watched::open(entry.th32ProcessID).is_some_and(|w| !w.gone_within(Duration::ZERO)) {
                        found.push(entry.th32ProcessID);
                    }
                }
                more = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        found
    }

    fn assert_no_engine_left() {
        let until = Instant::now() + Duration::from_secs(3);
        while !engine_children().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(engine_children(), Vec::<u32>::new(), "an engine process was left running");
    }

    /// One request to a fake engine, without the manager; returns the status.
    fn request(port: u16, path: &str, key: Option<&str>) -> u16 {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let auth = key.map(|k| format!("Authorization: Bearer {k}\r\n")).unwrap_or_default();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Connection: close\r\n\r\n").unwrap();
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer);
        answer.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    /// A line that must be seen even when the test passes — a case that could not be run, or a measurement.
    /// The test harness hides what a passing test prints, so this goes to the error stream directly.
    fn note(line: &str) {
        let _ = writeln!(std::io::stderr(), "{line}");
    }

    /// Which file a handle is open on — its volume and its number there — or `None` if the value is not a
    /// handle on a file in this process. Two handles on one file give the same answer in any process.
    fn file_identity(handle: HANDLE) -> Option<String> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: the call writes one structure of this type; a value that is not a file handle is refused.
        unsafe { GetFileInformationByHandle(handle, &mut info).ok()? };
        Some(format!("{:08x}-{:08x}{:08x}", info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
    }

    /// The files under `dir`, at any depth, whose bytes include `needle`.
    fn files_holding(dir: &Path, needle: &[u8]) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files_holding(&path, needle));
            } else if fs::read(&path).unwrap().windows(needle.len()).any(|w| w == needle) {
                found.push(path);
            }
        }
        found
    }

    fn wait_for(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
        let until = Instant::now() + limit;
        while !done() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // ---- The lifecycle ----

    #[test]
    fn a_start_passes_every_phase_to_ready_and_a_stop_ends_the_engine() {
        let _serial = serial_for_tests();
        let f = engine_fixture("ready");
        let mut slow_load = config("normal");
        slow_load.hooks.extra_env.push((LOAD_MS.into(), "1500".into()));
        let manager = EngineManager::new(slow_load);
        assert_eq!(manager.status(), EngineStatus::Idle);

        let info = start(&f, &manager).unwrap();
        assert_eq!(manager.status(), EngineStatus::Ready(info.clone()));
        assert_eq!(info.model_id, MODEL_B.id);
        assert_eq!(engine_children(), [info.pid]);
        let p = info.phases;
        assert!(p.created_ms <= p.listening_ms && p.listening_ms <= p.loaded_ms && p.loaded_ms <= p.ready_ms, "{p:?}");
        // The server was seen up while the model was still loading — before the engine printed its address.
        assert!(p.loaded_ms - p.listening_ms >= 500, "{p:?}");

        let endpoint = manager.endpoint().unwrap();
        assert_eq!(endpoint.port, info.port);
        assert_eq!(request(info.port, "/v1/models", Some(endpoint.key.as_str())), 200);
        assert_eq!(request(info.port, "/v1/models", None), 401);
        assert_eq!(request(info.port, "/v1/models", Some(&"0".repeat(64))), 401);

        let engine = Watched::open(info.pid).unwrap();
        manager.stop().unwrap();
        assert!(engine.gone_within(Duration::ZERO), "stop returns only once the engine has ended");
        assert_eq!(manager.status(), EngineStatus::Idle);
        assert!(manager.endpoint().is_none());
        manager.stop().unwrap();
        manager.stop().unwrap();

        // The slot is free again, the next session has a new key, and dropping the manager stops the engine.
        let again = start(&f, &manager).unwrap();
        assert_ne!(manager.endpoint().unwrap().key.as_str(), endpoint.key.as_str());
        let engine = Watched::open(again.pid).unwrap();
        drop(manager);
        assert!(engine.gone_within(Duration::ZERO));
        assert_no_engine_left();
    }

    #[test]
    fn startup_failures_are_typed_and_leave_nothing_running() {
        let _serial = serial_for_tests();
        let f = engine_fixture("startup-failures");

        let exit = |mode: &str| match failure(&f, config(mode)) {
            EngineError::EarlyExit { code, cause, log_tail } => (code, cause, log_tail.join("\n")),
            other => panic!("{mode}: {other:?}"),
        };
        let (code, cause, log) = exit("early_exit");
        assert_eq!((code, cause), (Some(1), ExitCause::Other));
        assert!(log.contains("the engine could not start"), "the engine's own words are kept: {log}");
        assert_eq!(exit("port_conflict").1, ExitCause::PortConflict);
        assert_eq!(exit("bad_device").1, ExitCause::DeviceUnavailable);
        assert_eq!(exit("load_fail").1, ExitCause::ModelLoadFailed);
        let (code, cause, _) = exit("missing_library");
        assert_eq!((code, cause), (Some(0xC000_0135u32 as i32), ExitCause::MissingSystemLibrary));
        assert_eq!(exit("missing_entry_point").1, ExitCause::MissingSystemLibrary, "a runtime too old for the engine");

        assert_eq!(failure(&f, config("malformed_health")), EngineError::UnexpectedHealth { status: 200 });
        assert_eq!(failure(&f, config("health_error")), EngineError::UnexpectedHealth { status: 500 });

        // By now the fake has run several times, so the timeouts below measure the engine, not a first launch.
        let short = |mode: &str, seconds: u64| EngineConfig { startup_timeout: Duration::from_secs(seconds), ..config(mode) };
        let t0 = Instant::now();
        assert!(matches!(failure(&f, short("silent", 3)), EngineError::StartupTimeout { phase: StartPhase::Listening, .. }));
        assert!(matches!(failure(&f, short("never_ready", 8)), EngineError::StartupTimeout { phase: StartPhase::LoadingModel, .. }));
        assert!(t0.elapsed() < Duration::from_secs(60), "timeouts are bounded");
    }

    #[test]
    fn nothing_starts_without_a_verified_engine_a_model_and_the_runtime() {
        let _serial = serial_for_tests();
        let f = engine_fixture("preconditions");
        let run = |model: &Artifact, execution: Execution, config: EngineConfig| {
            let manager = EngineManager::new(config);
            let error = manager.start(&f.fx.store, f.fx.spec, model, execution).unwrap_err();
            assert_no_engine_left();
            error
        };
        let cpu = || Execution::Cpu { threads: 2 };

        assert_eq!(run(f.fx.spec.archive, cpu(), config("normal")), EngineError::NoLaunchProfile);
        assert!(matches!(run(f.model, Execution::Gpu { device: "two words".into() }, config("normal")), EngineError::InvalidExecution(_)));

        let empty = f.fx.tmp.0.join("no-runtime-here");
        fs::create_dir(&empty).unwrap();
        let mut without_runtime = config("normal");
        without_runtime.hooks.system_dir = Some(empty);
        assert_eq!(run(f.model, cpu(), without_runtime.clone()), EngineError::MissingVcRuntime(VC_RUNTIME.iter().map(|s| s.to_string()).collect()));
        // Files with the right names that are not the runtime: there, but not identifiable — so not accepted.
        for name in VC_RUNTIME {
            fs::write(f.fx.tmp.0.join("no-runtime-here").join(name), b"not a library").unwrap();
        }
        assert!(matches!(run(f.model, cpu(), without_runtime), EngineError::VcRuntimeTooOld { found: None, .. }));

        // A backend library planted beside the engine would be loaded by it: the engine is not launched.
        let planted = f.fx.dir().join("ggml-rpc.dll");
        fs::write(&planted, b"planted").unwrap();
        assert!(matches!(run(f.model, cpu(), config("normal")), EngineError::EngineNotInstalled(_)));
        fs::remove_file(&planted).unwrap();

        let licence = f.fx.dir().join("LICENSE-LLVM-OpenMP");
        fs::write(&licence, b"test licencE").unwrap();
        assert!(matches!(run(f.model, cpu(), config("normal")), EngineError::EngineNotInstalled(_)));
        fs::write(&licence, b"test licence").unwrap();

        fs::remove_file(f.fx.store.record_path(f.model)).unwrap();
        assert_eq!(run(f.model, cpu(), config("normal")), EngineError::ModelNotInstalled);
        put_verified(&f.fx.store, f.model, b"not a real model");

        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).expect("with everything restored the engine starts");
    }

    #[test]
    fn an_engine_that_is_not_locked_down_is_refused() {
        let _serial = serial_for_tests();
        let f = engine_fixture("lockdown");

        assert_eq!(failure(&f, config("auth_off")), EngineError::AuthNotEnforced { status: 200 });
        assert_eq!(failure(&f, config("cors_open")), EngineError::CorsNotClosed("*".into()));
        assert_eq!(failure(&f, config("cors_missing")), EngineError::CorsNotClosed("no header".into()));
        assert_eq!(failure(&f, config("web_ui")), EngineError::UiExposed { status: 200 });
        assert_eq!(failure(&f, config("slots_open")), EngineError::SlotsExposed { status: 200 });
        // What an inherited `LLAMA_ARG_TOOLS=all` would switch on, had it reached the engine.
        assert_eq!(failure(&f, config("tools_open")), EngineError::ToolsExposed { status: 200 });
        assert_eq!(failure(&f, config("proxy_open")), EngineError::ProxyExposed { status: 200 });

        // A listener that is not on 127.0.0.1 — opened before the model loads, or after.
        for mode in ["wide_bind", "wide_late"] {
            match failure(&f, config(mode)) {
                EngineError::NotLoopbackOnly(address) => assert!(address.starts_with("[::1]:"), "{mode}: {address}"),
                EngineError::EarlyExit { log_tail, .. } if log_tail.iter().any(|l| l.contains("FAKE no-ipv6")) => {
                    note(&format!("NOT TESTED ({mode}): this machine has no IPv6 loopback to open the extra listener on"));
                }
                other => panic!("{mode}: {other:?}"),
            }
        }

        // Two loopback sockets are not a breach; the server is the one the engine names as its address.
        let manager = EngineManager::new(config("two_listeners"));
        let info = start(&f, &manager).unwrap();
        assert_eq!(request(info.port, "/health", None), 200);
    }

    #[test]
    fn a_failed_readiness_probe_is_typed_and_bounded() {
        let _serial = serial_for_tests();
        let f = engine_fixture("probe");
        assert!(matches!(failure(&f, config("probe_error")), EngineError::ProbeFailed(_)));
        assert!(matches!(failure(&f, config("probe_empty")), EngineError::ProbeFailed(_)));

        let t0 = Instant::now();
        let hang = EngineConfig { probe_timeout: Duration::from_secs(2), ..config("probe_hang") };
        assert_eq!(failure(&f, hang), EngineError::ProbeTimeout);
        assert!(t0.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_crash_after_ready_is_reported_and_releases_everything() {
        let _serial = serial_for_tests();
        let f = engine_fixture("crash");
        let manager = EngineManager::new(config("crash_after_ready"));
        let info = start(&f, &manager).unwrap();
        assert_eq!(manager.status(), EngineStatus::Ready(info));

        wait_for("the crash to be noticed", Duration::from_secs(10), || manager.status() == EngineStatus::Exited { code: Some(7) });
        assert_eq!(manager.status(), EngineStatus::Exited { code: Some(7) }, "it stays reported");
        assert!(manager.endpoint().is_none());
        assert_no_engine_left();
        manager.stop().unwrap();

        start(&f, &manager).expect("the slot was released, so the engine can be started again");
        assert!(matches!(manager.status(), EngineStatus::Ready(_)));
    }

    #[test]
    fn stopping_ends_every_process_the_engine_started() {
        let _serial = serial_for_tests();
        let f = engine_fixture("tree");
        let manager = EngineManager::new(config("spawn_child"));
        start(&f, &manager).unwrap();
        let log = manager.log_tail(200);
        let child: u32 = log.iter().find_map(|l| l.strip_prefix("FAKE child ")).expect("the fake reports its child").trim().parse().unwrap();
        let child = Watched::open(child).expect("the engine's child is running");
        assert!(!child.gone_within(Duration::ZERO));

        manager.stop().unwrap();
        assert!(child.gone_within(Duration::from_secs(3)), "the job ends the engine's descendants too");
    }

    #[test]
    fn the_job_ends_an_engine_that_a_stop_could_not_and_a_failed_stop_is_reported() {
        let _serial = serial_for_tests();
        let f = engine_fixture("stop-failure");

        // The ordinary stop is made to do nothing: closing the job still ends the engine.
        let mut unkillable = EngineConfig { stop_timeout: Duration::from_secs(1), ..config("normal") };
        unkillable.hooks.fail_kill = true;
        let manager = EngineManager::new(unkillable.clone());
        let info = start(&f, &manager).unwrap();
        let engine = Watched::open(info.pid).unwrap();
        manager.stop().unwrap();
        assert!(engine.gone_within(Duration::ZERO));

        // With no job either, nothing can end it: the stop says so, within its bound, and keeps the slot.
        unkillable.hooks.no_job = true;
        let manager = EngineManager::new(unkillable);
        let info = start(&f, &manager).unwrap();
        let engine = Watched::open(info.pid).unwrap();
        let t0 = Instant::now();
        assert!(matches!(manager.stop(), Err(EngineError::ShutdownFailed(_))));
        assert!(t0.elapsed() < Duration::from_secs(10), "a failing stop is still bounded");
        assert!(!engine.gone_within(Duration::ZERO));
        assert_eq!(slot::claim(Holder::Engine).unwrap_err(), Holder::Engine, "no second engine beside one that may be alive");
        manager.stop().unwrap();

        engine.kill();
        assert!(engine.gone_within(Duration::from_secs(3)));
        slot::release_for_tests();
    }

    #[test]
    fn a_failed_start_whose_engine_cannot_be_stopped_says_so_and_keeps_the_slot() {
        let _serial = serial_for_tests();
        let f = engine_fixture("start-and-stop-fail");

        // An engine that is refused (it answers without its key) and then cannot be ended either: the ordinary
        // stop is made to do nothing, and there is no job.
        let stuck = |mode: &str| {
            let mut stuck = EngineConfig { stop_timeout: Duration::from_secs(1), startup_timeout: Duration::from_secs(90), ..config(mode) };
            stuck.hooks.fail_kill = true;
            stuck.hooks.no_job = true;
            stuck
        };
        // What must hold of an engine left running. (Then the test itself ends it, and frees the slot.)
        let left_running_and_alone = |manager: &EngineManager| {
            let running = engine_children();
            assert_eq!(running.len(), 1, "the engine this test made unstoppable is the one left");
            let engine = Watched::open(running[0]).unwrap();
            // It is not offered for use...
            assert_eq!(manager.status(), EngineStatus::Idle);
            assert!(manager.endpoint().is_none());
            // ...and nothing may start beside it, or replace its files, from this manager or any other.
            assert_eq!(slot::claim(Holder::Engine).unwrap_err(), Holder::Engine);
            assert_eq!(start(&f, manager), Err(EngineError::AlreadyActive));
            assert_eq!(start(&f, &EngineManager::new(config("normal"))), Err(EngineError::AlreadyActive));
            assert_eq!(install::install(&f.fx.store, f.fx.spec, &never()), Err(InstallError::EngineBusy));
            assert_eq!(engine_children(), running);

            engine.kill();
            assert!(engine.gone_within(Duration::from_secs(3)));
            slot::release_for_tests();
        };

        // The start reports the engine it left behind, not only why it refused it.
        let manager = EngineManager::new(stuck("auth_off"));
        let error = start(&f, &manager).unwrap_err();
        let EngineError::ShutdownFailed(why) = &error else { panic!("{error:?}") };
        assert!(why.contains("is still running") && why.contains("without its key"), "{why}");
        left_running_and_alone(&manager);

        // The same for a start that was not refused but cancelled. The stop says the engine did not end, and
        // the start says so too, where it would otherwise have reported a plain cancellation.
        let manager = EngineManager::new(stuck("never_ready"));
        std::thread::scope(|scope| {
            let starting = scope.spawn(|| start(&f, &manager));
            wait_for("the start to reach the model load", Duration::from_secs(60), || manager.status() == EngineStatus::Starting(StartPhase::LoadingModel));
            assert!(matches!(manager.stop(), Err(EngineError::ShutdownFailed(_))));
            let error = starting.join().unwrap().unwrap_err();
            let EngineError::ShutdownFailed(why) = &error else { panic!("{error:?}") };
            assert!(why.contains("is still running") && why.contains("cancelled"), "{why}");
        });
        left_running_and_alone(&manager);
    }

    #[test]
    fn only_one_engine_starts_however_many_are_asked_for() {
        let _serial = serial_for_tests();
        let f = engine_fixture("one-at-a-time");
        let slow = || {
            let mut c = config("normal");
            c.hooks.extra_env.push((LOAD_MS.into(), "1500".into()));
            c
        };
        let shared = EngineManager::new(slow());
        let others: Vec<EngineManager> = (0..4).map(|_| EngineManager::new(slow())).collect();
        let barrier = Barrier::new(8);

        let results: Vec<Result<EngineInfo, EngineError>> = std::thread::scope(|scope| {
            let mut threads = Vec::new();
            for i in 0..8 {
                let manager = if i < 4 { &shared } else { &others[i - 4] };
                let (f, barrier) = (&f, &barrier);
                threads.push(scope.spawn(move || {
                    barrier.wait();
                    start(f, manager)
                }));
            }
            // While they race: the engine's files may not be replaced under it.
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(install::install(&f.fx.store, f.fx.spec, &never()), Err(InstallError::EngineBusy));
            threads.into_iter().map(|t| t.join().unwrap()).collect()
        });

        let started: Vec<&EngineInfo> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(started.len(), 1, "{results:?}");
        for r in &results {
            assert!(matches!(r, Ok(_) | Err(EngineError::AlreadyActive)), "{r:?}");
        }
        assert_eq!(engine_children(), [started[0].pid]);

        // A second engine is refused for as long as the first runs, from any manager.
        let late = EngineManager::new(config("normal"));
        assert_eq!(start(&f, &late), Err(EngineError::AlreadyActive));
        assert_eq!(engine_children().len(), 1);
    }

    #[test]
    fn a_stop_during_a_start_ends_it_at_once() {
        let _serial = serial_for_tests();
        let f = engine_fixture("cancel");
        let long = |mode: &str| EngineConfig { startup_timeout: Duration::from_secs(90), probe_timeout: Duration::from_secs(90), ..config(mode) };

        // While the files are still being verified: the start ends, and nothing is left running.
        let manager = EngineManager::new(long("normal"));
        std::thread::scope(|scope| {
            let starting = scope.spawn(|| start(&f, &manager));
            wait_for("the start to begin", Duration::from_secs(60), || manager.status() == EngineStatus::Starting(StartPhase::Launching));
            manager.stop().unwrap();
            assert_eq!(starting.join().unwrap(), Err(EngineError::Cancelled));
        });
        assert_eq!(manager.status(), EngineStatus::Idle);
        assert_no_engine_left();

        // While the model loads, and while the probe is outstanding: the stop does not wait for either.
        for (mode, phase) in [("never_ready", StartPhase::LoadingModel), ("probe_hang", StartPhase::Probing)] {
            let manager = EngineManager::new(long(mode));
            std::thread::scope(|scope| {
                let starting = scope.spawn(|| start(&f, &manager));
                wait_for("the start to reach its phase", Duration::from_secs(60), || manager.status() == EngineStatus::Starting(phase));
                let pids = engine_children();
                assert_eq!(pids.len(), 1);
                let engine = Watched::open(pids[0]).unwrap();

                let t0 = Instant::now();
                manager.stop().unwrap();
                assert!(engine.gone_within(Duration::ZERO), "{mode}: stop returns only once the engine has ended");
                assert_eq!(starting.join().unwrap(), Err(EngineError::Cancelled), "{mode}");
                assert!(t0.elapsed() < Duration::from_secs(5), "{mode}: {:?}", t0.elapsed());
            });
            assert_eq!(manager.status(), EngineStatus::Idle);
            drop(slot::claim(Holder::Engine).expect("the cancelled start gave the slot back"));
        }
    }

    #[test]
    fn the_captured_log_is_bounded_and_never_holds_the_key() {
        let _serial = serial_for_tests();
        let f = engine_fixture("key");

        // An engine that prints without end: what is kept is capped, and it is the newest lines.
        let manager = EngineManager::new(config("noisy"));
        start(&f, &manager).unwrap();
        wait_for("the engine's last line", Duration::from_secs(10), || manager.log_tail(1).iter().any(|l| l.contains("listening on")));
        let log = manager.log_tail(usize::MAX);
        assert_eq!(log.len(), 200);
        assert!(log.iter().all(|l| l.len() <= 2000));
        manager.stop().unwrap();

        // An engine that prints its key: the captured log has it removed.
        let manager = EngineManager::new(config("leak"));
        start(&f, &manager).unwrap();
        let key = manager.endpoint().unwrap().key;
        wait_for("the engine's last line", Duration::from_secs(10), || manager.log_tail(200).iter().any(|l| l.ends_with("(end)")));
        let log = manager.log_tail(200).join("\n");
        assert!(log.contains("api_keys: [redacted]") && log.contains("Bearer [redacted] (end)"), "{log}");
        assert!(!log.contains(key.as_str()));
        // Nor has it been written anywhere: not into the store, and not beside it. (The search does find what
        // is there: the model's checksum is in the model's record, and nowhere else.)
        let everything = fs::canonicalize(&f.fx.tmp.0).unwrap();
        assert_eq!(files_holding(&everything, f.model.sha256.as_bytes()), [f.fx.store.record_path(f.model)]);
        assert_eq!(files_holding(&everything, key.as_str().as_bytes()), Vec::<PathBuf>::new(), "the key is in a file");
        manager.stop().unwrap();

        // An engine that prints its key and dies: the error carries the log, without the key.
        let key_file = f.fx.tmp.0.join("key-seen-by-the-engine");
        let mut leaking = config("leak_then_exit");
        leaking.hooks.extra_env.push((KEY_FILE.into(), key_file.to_string_lossy().into_owned()));
        let error = failure(&f, leaking);
        let seen = fs::read_to_string(&key_file).unwrap();
        assert_eq!(seen.len(), 64);
        assert_ne!(seen, key.as_str(), "every session has its own key");
        let shown = format!("{error} {error:?}");
        assert!(shown.contains("[redacted]"), "{shown}");
        assert!(!shown.contains(&seen));
    }

    #[test]
    fn a_runtime_too_old_for_the_engine_stops_the_launch_before_anything_runs() {
        let _serial = serial_for_tests();
        let f = engine_fixture("old-runtime");
        // The fake writes this file the moment it starts: if it exists, the engine ran.
        let ran = f.fx.tmp.0.join("the-engine-ran");
        let mut outdated = config("normal");
        outdated.hooks.extra_env.push((KEY_FILE.into(), ran.to_string_lossy().into_owned()));
        // The stand-in's spec accepts any runtime of the 14 family. This one is taken to be older than that.
        outdated.hooks.runtime_version = Some([13, 0, 0, 0]);

        let error = failure(&f, outdated);
        assert_eq!(error, EngineError::VcRuntimeTooOld { file: "MSVCP140.dll".into(), found: Some("13.0.0.0".into()), needed: "14.0".into() });
        assert!(error.recovery().unwrap().contains(VC_RUNTIME_SOURCE));
        assert!(!ran.exists(), "an engine was started against a runtime known to be too old");

        // The same machine with a runtime that is recent enough: the engine starts.
        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).expect("the real runtime on this machine is of the 14 family");
    }

    // ---- Between hashing and launching ----

    #[test]
    fn a_file_planted_after_verification_stops_the_launch_before_the_engine_runs() {
        let _serial = serial_for_tests();
        let f = engine_fixture("planted-early");
        // The fake writes this file the moment it starts: if it exists, the engine ran.
        let ran = f.fx.tmp.0.join("the-engine-ran");
        let planted = f.fx.dir().join("ggml-planted.dll");
        let mut racing = config("normal");
        racing.hooks.extra_env.push((KEY_FILE.into(), ran.to_string_lossy().into_owned()));
        racing.hooks.plant_after_verify = Some(planted.clone());
        // Long enough for a process that was NOT suspended to get going.
        racing.hooks.hold_before_resume = Duration::from_millis(1500);

        assert!(matches!(failure(&f, racing), EngineError::EngineChanged(_)));
        assert!(!ran.exists(), "the engine ran before its directory had been checked");

        fs::remove_file(&planted).unwrap();
        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).expect("with the planted file gone the engine starts");
    }

    #[test]
    fn a_file_that_appears_while_the_engine_starts_stops_it_being_used() {
        let _serial = serial_for_tests();
        let f = engine_fixture("planted-late");
        assert!(matches!(failure(&f, config("plant_late")), EngineError::EngineChanged(_)));

        // It is still there, so the next launch is refused before anything runs. Removing it is the recovery.
        let late = f.fx.dir().join("ggml-late.dll");
        assert!(late.exists());
        assert!(matches!(failure(&f, config("normal")), EngineError::EngineNotInstalled(_)));
        fs::remove_file(&late).unwrap();
        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).expect("with the stray file gone the engine starts");
    }

    #[test]
    fn while_the_engine_runs_its_files_cannot_be_changed() {
        let _serial = serial_for_tests();
        let f = engine_fixture("held-running");
        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).unwrap();
        // Not the executable — Windows protects a running program's own file anyway — but a file the engine
        // merely sits beside.
        let file = f.fx.dir().join("LICENSE-LLVM-OpenMP");
        assert!(fs::OpenOptions::new().write(true).open(&file).is_err(), "opened for writing");
        assert!(fs::remove_file(&file).is_err(), "deleted");
        assert!(fs::rename(&file, f.fx.dir().join("moved")).is_err(), "renamed");
        assert!(fs::rename(f.fx.dir(), f.fx.tmp.0.join("engine-moved")).is_err(), "its folder renamed");

        manager.stop().unwrap();
        fs::OpenOptions::new().append(true).open(&file).expect("released once the engine has stopped");
    }

    // ---- What the launch takes on trust ----

    #[test]
    fn the_model_is_checked_at_launch_by_its_record_its_size_and_its_place() {
        let _serial = serial_for_tests();
        let f = engine_fixture("model-checks");
        let model = f.fx.store.installed_path(f.model);
        let original = fs::read(&model).unwrap();
        let refused = |what: &str| {
            let error = start(&f, &EngineManager::new(config("normal"))).expect_err(what);
            assert_no_engine_left();
            error
        };

        // A file of another size where the model was.
        fs::write(&model, b"not a real model, and longer").unwrap();
        assert_eq!(refused("a model of the wrong size was started"), EngineError::ModelNotInstalled);

        // A link where the model was, to a file of the right size outside the translation directory.
        let outside = f.fx.tmp.0.join("outside.gguf");
        fs::write(&outside, &original).unwrap();
        fs::remove_file(&model).unwrap();
        if try_link_file(&model, &outside) {
            assert_eq!(refused("a model outside the translation directory was started"), EngineError::ModelNotInstalled);
            fs::remove_file(&model).unwrap();
        } else {
            note("NOT TESTED (a link in place of the model): this account may not create a symbolic link to a file");
        }

        // What is NOT checked, stated here so that it is a fact and not an assumption: the model's contents.
        // They were hashed when the download was verified, and hashing gigabytes again at every launch is not
        // done. A file of the right size in the right place is started, whatever it holds...
        fs::write(&model, b"not a real modeL").unwrap();
        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).expect("the launch does not read the model's contents");
        // ...and nothing holds the model the way the engine's own files are held. (The real engine keeps it
        // open while it runs; what that prevents was not measured, because the real engine was not run.)
        fs::OpenOptions::new().write(true).open(&model).expect("the launch does not hold the model");
    }

    #[test]
    fn a_file_the_host_merely_has_open_is_not_open_in_the_engine() {
        let _serial = serial_for_tests();
        let f = engine_fixture("handles");
        // Two files the host has open, as Sard has its library open. A file opened the ordinary way is not
        // passed to a process the host starts. The second is then marked to be passed on, as a library inside
        // Sard could mark a handle of its own.
        let ordinary_file = fs::File::create(f.fx.tmp.0.join("open-in-the-host")).unwrap();
        let marked_file = fs::File::create(f.fx.tmp.0.join("open-and-marked")).unwrap();
        let (ordinary, marked) = (HANDLE(ordinary_file.as_raw_handle()), HANDLE(marked_file.as_raw_handle()));
        // SAFETY: a handle this test owns, open until the end of it.
        unsafe { SetHandleInformation(marked, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT).unwrap() };

        let mut told = config("normal");
        told.hooks.extra_env.push((HANDLES.into(), format!("{},{}", ordinary.0 as usize, marked.0 as usize)));
        let manager = EngineManager::new(told);
        start(&f, &manager).unwrap();
        let log = manager.log_tail(200);
        let in_the_engine = |handle: HANDLE| {
            let prefix = format!("FAKE handle {} ", handle.0 as usize);
            log.iter().find_map(|l| l.strip_prefix(prefix.as_str())).expect("the fake reports each value it was given").to_string()
        };

        assert_ne!(in_the_engine(ordinary), file_identity(ordinary).unwrap(), "the engine has the host's file open");
        // Nothing limits the engine to a list of handles — the standard library offers no stable way to — so
        // one that IS marked anywhere in the host goes to the engine with the rest. A limit, not a promise:
        // it is measured rather than required.
        let reaches = in_the_engine(marked) == file_identity(marked).unwrap();
        note(&format!("MEASURED: a handle the host marked to be inherited {} the engine", if reaches { "REACHES" } else { "does not reach" }));
    }

    // ---- A host process: what happens when Sard itself ends, and what Sard's environment can do ----

    /// Not a test of anything: a stand-in for Sard, run as a separate process by the tests below. In an
    /// ordinary test run it does nothing.
    #[test]
    fn engine_host_entry() {
        let Ok(mode) = std::env::var(HOST) else { return };
        std::thread::spawn(|| {
            std::thread::sleep(MAX_LIFE);
            std::process::exit(99);
        });
        // The test harness has just printed "test <name> ... " without ending the line.
        println!();
        let dir = PathBuf::from(std::env::var_os(HOST_DIR).unwrap());
        // The directory belongs to the test that started this process, which removes it afterwards.
        let f = std::mem::ManuallyDrop::new(engine_fixture_at(TempDir(dir), "host"));
        if mode == "list" {
            println!("HOST listed {:?}", EngineManager::new(config("devices_one")).list_devices(&f.fx.store, f.fx.spec));
            std::process::exit(0);
        }
        let mut config = config("normal");
        config.hooks.no_job = mode == "outlive";
        let manager = std::mem::ManuallyDrop::new(EngineManager::new(config));
        match start(&f, &manager) {
            Ok(info) => println!("HOST ready {}", info.pid),
            Err(error) => {
                println!("HOST failed {error:?}");
                std::process::exit(2);
            }
        }
        if mode == "report" {
            for line in manager.log_tail(200) {
                println!("HOST log {line}");
            }
            let stopped = manager.stop();
            println!("HOST done {stopped:?}");
            std::process::exit(0);
        }
        // "die" and "outlive": wait to be killed, as a crash would end Sard — no destructor, no cleanup.
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    struct HostProcess {
        child: Child,
        lines: mpsc::Receiver<String>,
        _dir: TempDir,
    }

    impl Drop for HostProcess {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn spawn_host(mode: &str, environment: &[(&str, &str)]) -> HostProcess {
        let dir = TempDir::new(&format!("host-{mode}"));
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.arg(HOST_ENTRY).args(HARNESS).env(HOST, mode).env(HOST_DIR, &dir.0).env_remove("NO_PROXY").env_remove("no_proxy");
        command.envs(environment.iter().copied()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        command.creation_flags(NO_WINDOW);
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        HostProcess { child, lines, _dir: dir }
    }

    impl HostProcess {
        /// The rest of the first line starting with `prefix`; every line read on the way is kept in `seen`.
        fn wait_line(&self, prefix: &str, seen: &mut Vec<String>) -> String {
            let until = Instant::now() + Duration::from_secs(90);
            loop {
                let left = until.saturating_duration_since(Instant::now());
                let line = self.lines.recv_timeout(left).unwrap_or_else(|_| panic!("the host never printed {prefix:?}; it printed {seen:#?}"));
                seen.push(line.clone());
                if let Some(rest) = line.strip_prefix(prefix) {
                    return rest.to_string();
                }
            }
        }
    }

    #[test]
    fn the_engine_ends_within_three_seconds_of_its_host_being_killed() {
        let _serial = serial_for_tests();
        let mut host = spawn_host("die", &[]);
        let pid: u32 = host.wait_line("HOST ready ", &mut Vec::new()).trim().parse().unwrap();
        let engine = Watched::open(pid).expect("the engine is running");
        assert!(!engine.gone_within(Duration::from_millis(300)), "it runs for as long as its host does");

        let t0 = Instant::now();
        host.child.kill().unwrap();
        assert!(engine.gone_within(Duration::from_secs(3)), "the engine outlived its host");
        note(&format!("MEASURED: the engine ended {:?} after its host was killed", t0.elapsed()));
    }

    /// The control for the test above: without the Job Object the same engine DOES outlive its host — so it is
    /// the job, and nothing incidental about how the test runs, that ends it.
    #[test]
    fn without_the_job_the_engine_outlives_its_host() {
        let _serial = serial_for_tests();
        let mut host = spawn_host("outlive", &[]);
        let pid: u32 = host.wait_line("HOST ready ", &mut Vec::new()).trim().parse().unwrap();
        let engine = Watched::open(pid).expect("the engine is running");

        host.child.kill().unwrap();
        let outlived = !engine.gone_within(Duration::from_secs(3));
        engine.kill();
        assert!(engine.gone_within(Duration::from_secs(3)));
        assert!(outlived, "the control did not behave as a control");
    }

    #[test]
    fn nothing_in_the_hosts_environment_reaches_or_redirects_the_engine() {
        let _serial = serial_for_tests();
        // Anything that connects here was sent to a proxy.
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        proxy.set_nonblocking(true).unwrap();
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        let hostile = [
            ("LLAMA_ARG_TOOLS", "all"),
            ("LLAMA_ARG_HOST", "0.0.0.0"),
            ("LLAMA_ARG_PORT", "8080"),
            ("LLAMA_ARG_UI", "1"),
            ("LLAMA_API_KEY", "chosen-by-someone-else"),
            ("GGML_VK_VISIBLE_DEVICES", "7"),
            ("OMP_NUM_THREADS", "64"),
            ("KMP_AFFINITY", "disabled"),
            ("VK_ADD_LAYER_PATH", "layers"),
            ("VK_ICD_FILENAMES", "icd.json"),
            ("HF_TOKEN", "x"),
            ("HTTP_PROXY", proxy_url.as_str()),
            ("HTTPS_PROXY", proxy_url.as_str()),
            ("ALL_PROXY", proxy_url.as_str()),
        ];
        let host = spawn_host("report", &hostile);
        let mut seen = Vec::new();
        host.wait_line("HOST ready ", &mut seen);
        let done = host.wait_line("HOST done ", &mut seen);
        assert_eq!(done, "Ok(())", "{seen:#?}");

        let names: Vec<String> = seen.iter().filter_map(|l| l.strip_prefix("HOST log FAKE env ")).map(|n| n.trim().to_string()).collect();
        assert!(names.iter().any(|n| n == "LLAMA_API_KEY") && names.iter().any(|n| n == "PATH"), "{names:?}");
        assert!(names.iter().any(|n| n.eq_ignore_ascii_case("SystemRoot")), "{names:?}");
        for name in &names {
            let allowed = PASSED_ENV.iter().any(|p| p.eq_ignore_ascii_case(name)) || ["PATH", "LLAMA_API_KEY", MODE].contains(&name.as_str());
            assert!(allowed, "{name} reached the engine");
        }
        // (That the key the engine received is not the inherited one is checked by the fake itself: it accepts
        // only 64 hex characters, and the start would have failed.)

        assert!(
            matches!(proxy.accept(), Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "a request to the engine — which carries its key — was sent to the proxy"
        );
    }

    // ---- The engine's list of GPUs ----

    use super::super::hardware::EngineDevice;

    fn gpu(name: &str, description: &str) -> EngineDevice {
        EngineDevice { name: name.into(), description: description.into() }
    }

    /// List the fake engine's GPUs with `config`, and check that nothing was left running and the slot is free.
    fn listing(f: &EngineFixture, config: EngineConfig) -> Result<Vec<EngineDevice>, EngineError> {
        let result = EngineManager::new(config).list_devices(&f.fx.store, f.fx.spec);
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("a listing gives the slot back"));
        result
    }

    #[test]
    fn the_engine_lists_its_gpus() {
        let _serial = serial_for_tests();
        let f = engine_fixture("list_ok");
        assert_eq!(listing(&f, config("devices_one")), Ok(vec![gpu("Vulkan0", "Test GPU")]));
        assert_eq!(listing(&f, config("devices_none")), Ok(vec![]));
        assert_eq!(listing(&f, config("devices_two")), Ok(vec![gpu("Vulkan0", "Test GPU"), gpu("Vulkan1", "Other GPU")]));
    }

    #[test]
    fn a_device_list_that_is_not_had_in_full_is_refused() {
        let _serial = serial_for_tests();
        let f = engine_fixture("list_bad");
        for mode in ["devices_garbage", "devices_malformed", "devices_duplicate", "devices_flood", "devices_exit", "devices_crash"] {
            let result = listing(&f, config(mode));
            assert!(matches!(result, Err(EngineError::DeviceListFailed(_))), "{mode}: {result:?}");
        }
    }

    #[test]
    fn a_listing_that_never_answers_is_given_up_and_leaves_nothing_running() {
        let _serial = serial_for_tests();
        let f = engine_fixture("list_hang");
        let pids = f.fx.tmp.0.join("pids.txt");
        let mut c = config("devices_hang");
        c.startup_timeout = Duration::from_secs(5);
        c.hooks.extra_env.push((PID_FILE.into(), pids.to_string_lossy().into_owned()));
        let t0 = Instant::now();
        let result = EngineManager::new(c).list_devices(&f.fx.store, f.fx.spec);
        let took = t0.elapsed();
        assert!(matches!(result, Err(EngineError::DeviceListFailed(ref why)) if why.contains("no answer")), "{result:?}");
        assert!(took >= Duration::from_secs(5) && took < Duration::from_secs(20), "{took:?}");
        // The fake and the child it started, both inside the listing's job.
        let ids = fs::read_to_string(&pids).expect("the fake wrote its process ids");
        let ids: Vec<u32> = ids.split_whitespace().map(|id| id.parse().unwrap()).collect();
        assert_eq!(ids.len(), 2, "{ids:?}");
        for id in ids {
            assert!(Watched::open(id).is_none_or(|w| w.gone_within(Duration::from_secs(3))), "process {id} outlived the listing");
        }
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("a listing that was given up gives the slot back"));
    }

    #[test]
    fn only_the_verified_engine_is_ever_listed() {
        let _serial = serial_for_tests();
        // Not installed.
        let gone = engine_fixture("list_removed");
        install::remove(&gone.fx.store, gone.fx.spec).unwrap();
        assert!(matches!(listing(&gone, config("devices_one")), Err(EngineError::EngineNotInstalled(_))));
        // One of its files changed after it was installed.
        let changed = engine_fixture("list_changed");
        fs::write(install::engine_dir(&changed.fx.store, changed.fx.spec).join("LICENSE-LLVM-OpenMP"), b"changed").unwrap();
        assert!(matches!(listing(&changed, config("devices_one")), Err(EngineError::EngineNotInstalled(_))));
        // A file added beside it, which ggml would load as a backend.
        let added = engine_fixture("list_added");
        fs::write(install::engine_dir(&added.fx.store, added.fx.spec).join("ggml-extra.dll"), b"not part of the engine").unwrap();
        assert!(matches!(listing(&added, config("devices_one")), Err(EngineError::EngineNotInstalled(_))));
    }

    #[test]
    fn a_listing_needs_the_slot_and_the_runtime_a_start_needs() {
        let _serial = serial_for_tests();
        let f = engine_fixture("list_slot");
        {
            let _installing = slot::claim(Holder::Install).unwrap();
            assert_eq!(EngineManager::new(config("devices_one")).list_devices(&f.fx.store, f.fx.spec), Err(EngineError::AlreadyActive));
        }
        // While this manager's own engine runs.
        let manager = EngineManager::new(config("normal"));
        start(&f, &manager).unwrap();
        assert_eq!(manager.list_devices(&f.fx.store, f.fx.spec), Err(EngineError::AlreadyActive));
        manager.stop().unwrap();
        // A Visual C++ runtime too old for the engine: nothing is run, as with a start. (The stand-in's spec accepts
        // any runtime of the 14 family; this one is taken to be older than that.)
        let ran = f.fx.tmp.0.join("ran.txt");
        let mut old = config("devices_one");
        old.hooks.runtime_version = Some([13, 0, 0, 0]);
        old.hooks.extra_env.push((PID_FILE.into(), ran.to_string_lossy().into_owned()));
        assert_eq!(
            listing(&f, old),
            Err(EngineError::VcRuntimeTooOld { file: "MSVCP140.dll".into(), found: Some("13.0.0.0".into()), needed: "14.0".into() })
        );
        assert!(!ran.exists(), "the engine was run against a runtime known to be too old");
        // The control: with a suitable runtime the same listing runs, and says so.
        let mut fine = config("devices_one");
        fine.hooks.extra_env.push((PID_FILE.into(), ran.to_string_lossy().into_owned()));
        assert!(listing(&f, fine).is_ok());
        assert!(ran.exists(), "the control did not run");
    }

    #[test]
    fn a_listing_gets_no_key_and_nothing_else_of_the_environment() {
        let _serial = serial_for_tests();
        // The fake refuses — exit code 3 — any variable but the allowed ones, a working directory that is not its
        // own, and a console window: a listing that succeeds was run as it must be.
        let f = engine_fixture("list_env");
        assert!(listing(&f, config("devices_one")).is_ok());
        // The control: a variable that does reach it is refused.
        let mut leaky = config("devices_one");
        leaky.hooks.extra_env.push(("LLAMA_ARG_TOOLS".into(), "all".into()));
        let result = listing(&f, leaky);
        assert!(matches!(result, Err(EngineError::DeviceListFailed(ref why)) if why.contains("exit code Some(3)")), "{result:?}");
    }

    #[test]
    fn nothing_in_the_hosts_environment_reaches_a_listing() {
        let _serial = serial_for_tests();
        let hostile = [
            ("LLAMA_ARG_TOOLS", "all"),
            ("LLAMA_API_KEY", "chosen-by-someone-else"),
            ("GGML_VK_VISIBLE_DEVICES", "7"),
            ("VK_ICD_FILENAMES", "icd.json"),
            ("VK_ADD_LAYER_PATH", "layers"),
            ("OMP_NUM_THREADS", "64"),
            ("HTTP_PROXY", "http://127.0.0.1:9"),
        ];
        let host = spawn_host("list", &hostile);
        let mut seen = Vec::new();
        let listed = host.wait_line("HOST listed ", &mut seen);
        assert_eq!(listed, r#"Ok([EngineDevice { name: "Vulkan0", description: "Test GPU" }])"#, "{seen:#?}");
    }

    // ---- A start that lists the GPUs first, and the stops that may come during it ----

    type Listing = Result<Vec<EngineDevice>, EngineError>;

    /// A start that lists the engine's GPUs and then starts on the CPU; `chose` records what the listing gave the
    /// decision, if the start got that far.
    fn start_listing(f: &EngineFixture, manager: &EngineManager, chose: &std::sync::Mutex<Option<Listing>>) -> Result<EngineInfo, NotLaunched<()>> {
        manager.start_after_listing(&f.fx.store, f.fx.spec, f.model, |listing| {
            *chose.lock().unwrap() = Some(listing);
            Ok(Execution::Cpu { threads: 2 })
        })
    }

    /// The process ids a hanging listing wrote (its own and its child's), once it has written both.
    fn listing_ids(pids: &Path) -> Option<Vec<u32>> {
        let ids: Vec<u32> = fs::read_to_string(pids).ok()?.split_whitespace().filter_map(|id| id.parse().ok()).collect();
        (ids.len() == 2).then_some(ids)
    }

    #[test]
    fn a_stop_while_the_gpus_are_listed_ends_the_listing_and_the_start() {
        let _serial = serial_for_tests();
        let f = engine_fixture("listing-stopped");
        let (pids, ran) = (f.fx.tmp.0.join("pids.txt"), f.fx.tmp.0.join("ran.txt"));
        // A listing that never answers — given far longer than this test may take, so only the stop can end it.
        let mut c = EngineConfig { startup_timeout: Duration::from_secs(300), ..config("devices_hang") };
        c.hooks.extra_env.push((PID_FILE.into(), pids.to_string_lossy().into_owned()));
        c.hooks.extra_env.push((KEY_FILE.into(), ran.to_string_lossy().into_owned()));
        let manager = EngineManager::new(c);
        let chose = std::sync::Mutex::new(None);
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| done_tx.send(start_listing(&f, &manager, &chose)).unwrap());
            wait_for("the listing to be running", Duration::from_secs(60), || listing_ids(&pids).is_some());
            // Nothing is asserted until the stop has been made: a failed check here would otherwise wait out the
            // listing's 300 seconds before the test could end.
            let status = manager.status();
            let stopped = manager.stop();
            let ended = done_rx.recv_timeout(Duration::from_secs(30)).expect("the stop did not end the listing");
            assert_eq!(status, EngineStatus::Starting(StartPhase::ListingDevices));
            assert_eq!(stopped, Ok(()));
            assert_eq!(ended, Err(NotLaunched::Engine(EngineError::Cancelled)));
        });
        assert!(chose.lock().unwrap().is_none(), "the start went on to decide after the stop");
        assert!(!ran.exists(), "an engine was started after the stop");
        for id in listing_ids(&pids).unwrap() {
            assert!(Watched::open(id).is_none_or(|w| w.gone_within(Duration::from_secs(3))), "process {id} outlived the stop");
        }
        assert_eq!(manager.status(), EngineStatus::Idle);
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("the slot is free again"));
    }

    #[test]
    fn a_stop_that_comes_as_the_listing_ends_or_as_the_start_is_decided_starts_nothing() {
        let _serial = serial_for_tests();
        let f = engine_fixture("listing-then-stop");
        let ran = f.fx.tmp.0.join("ran.txt");

        // The listing ends, with its GPU found; the start is held there while a stop comes; then it goes on — let go
        // when the test drops its end of the `go` channel.
        let (listed_tx, listed_rx) = mpsc::channel::<()>();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let go_rx = std::sync::Mutex::new(go_rx);
        let mut c = config("devices_one");
        c.hooks.extra_env.push((KEY_FILE.into(), ran.to_string_lossy().into_owned()));
        c.hooks.after_listing = Some(Hook(Arc::new(move || {
            listed_tx.send(()).unwrap();
            let _ = go_rx.lock().unwrap().recv();
        })));
        let manager = EngineManager::new(c);
        let chose = std::sync::Mutex::new(None);
        std::thread::scope(|scope| {
            let starting = scope.spawn(|| start_listing(&f, &manager, &chose));
            // Nothing is asserted until the start has been let go: a failed check while it is held would leave it
            // waiting for that word forever, and the test with it.
            let listed = listed_rx.recv_timeout(Duration::from_secs(60));
            let status = manager.status();
            let stopped = manager.stop();
            drop(go_tx);
            let started = starting.join();
            assert_eq!(listed, Ok(()), "the listing ended");
            assert_eq!(status, EngineStatus::Starting(StartPhase::ListingDevices));
            assert_eq!(stopped, Ok(()));
            assert_eq!(started.unwrap(), Err(NotLaunched::Engine(EngineError::Cancelled)));
        });
        assert!(chose.lock().unwrap().is_none(), "the start went on to decide after the stop");
        assert!(!ran.exists(), "an engine was started after the stop");
        assert_eq!(manager.status(), EngineStatus::Idle);

        // The stop comes while the start is being decided: the decision is made, and still nothing is started — the
        // launch is not even begun, so its engine files are not verified again (the planted file marks that step).
        let verified = f.fx.tmp.0.join("verified.txt");
        let mut c = config("devices_one");
        c.hooks.extra_env.push((KEY_FILE.into(), ran.to_string_lossy().into_owned()));
        c.hooks.plant_after_verify = Some(verified.clone());
        let manager = EngineManager::new(c);
        let decided = manager.start_after_listing(&f.fx.store, f.fx.spec, f.model, |listing| {
            assert_eq!(listing, Ok(vec![gpu("Vulkan0", "Test GPU")]));
            assert_eq!(manager.stop(), Ok(()));
            Ok::<_, ()>(Execution::Cpu { threads: 2 })
        });
        assert_eq!(decided, Err(NotLaunched::Engine(EngineError::Cancelled)));
        assert!(!verified.exists(), "the launch was begun after the stop");
        assert!(!ran.exists(), "an engine was started after the stop");
        assert_eq!(manager.status(), EngineStatus::Idle);
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("the slot is free again"));
    }

    #[test]
    fn a_start_after_listing_lists_decides_and_starts() {
        let _serial = serial_for_tests();
        let f = engine_fixture("listing-start");
        let manager = EngineManager::new(config("devices_one"));
        let chose = std::sync::Mutex::new(None);
        let info = start_listing(&f, &manager, &chose).unwrap();
        assert_eq!(*chose.lock().unwrap(), Some(Ok(vec![gpu("Vulkan0", "Test GPU")])));
        assert_eq!(info.execution, Execution::Cpu { threads: 2 });
        assert!(matches!(manager.status(), EngineStatus::Ready(_)));
        manager.stop().unwrap();
        assert_eq!(manager.status(), EngineStatus::Idle);

        // A decision not to start: nothing is started, the manager is idle and the slot is free.
        let declined = manager.start_after_listing(&f.fx.store, f.fx.spec, f.model, |_| Err::<Execution, &str>("not now"));
        assert_eq!(declined, Err(NotLaunched::Declined("not now")));
        assert_eq!(manager.status(), EngineStatus::Idle);
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("the slot is free again"));
    }

    #[test]
    fn starts_that_list_first_and_stops_follow_each_other_cleanly() {
        let _serial = serial_for_tests();
        let f = engine_fixture("listing-rounds");
        let pids = f.fx.tmp.0.join("pids.txt");
        for round in 0..3 {
            // A start stopped while it lists. Meanwhile nothing else starts, from this manager or another.
            let _ = fs::remove_file(&pids);
            let mut hang = EngineConfig { startup_timeout: Duration::from_secs(300), ..config("devices_hang") };
            hang.hooks.extra_env.push((PID_FILE.into(), pids.to_string_lossy().into_owned()));
            let manager = EngineManager::new(hang);
            let chose = std::sync::Mutex::new(None);
            std::thread::scope(|scope| {
                let starting = scope.spawn(|| start_listing(&f, &manager, &chose));
                wait_for("the listing to be running", Duration::from_secs(60), || listing_ids(&pids).is_some());
                // Nothing is asserted until the stop has been made, so that a failed check cannot wait out the listing.
                let same = start(&f, &manager);
                let other = start(&f, &EngineManager::new(config("normal")));
                let status = manager.status();
                let stopped = manager.stop();
                let started = starting.join();
                assert_eq!(same, Err(EngineError::AlreadyActive), "round {round}");
                assert_eq!(other, Err(EngineError::AlreadyActive), "round {round}");
                assert_eq!(status, EngineStatus::Starting(StartPhase::ListingDevices), "round {round}");
                assert_eq!(stopped, Ok(()));
                assert_eq!(started.unwrap(), Err(NotLaunched::Engine(EngineError::Cancelled)), "round {round}");
            });
            assert_eq!(manager.status(), EngineStatus::Idle, "round {round}");
            assert_eq!(manager.stop(), Ok(()), "a second stop is harmless");
            // Then a whole start, from the same manager's kind, and its stop.
            let manager = EngineManager::new(config("devices_one"));
            let chose = std::sync::Mutex::new(None);
            start_listing(&f, &manager, &chose).unwrap();
            assert!(matches!(manager.status(), EngineStatus::Ready(_)), "round {round}");
            manager.stop().unwrap();
            assert_eq!(manager.status(), EngineStatus::Idle, "round {round}");
        }
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("the slot is free again"));
    }

    // ---- What a start makes of the listing's errors ----

    use super::super::execution::{start_using, Assessment, NotStarted, Path as RunPath, Preference};
    use super::super::hardware::{Adapter, Fit, HardwareReport, Memory, Undetermined, VideoMemory};

    /// A reading of a computer on which model B fits, in full, on a GPU called "Test GPU" — the stand-in's.
    fn fits_test_gpu(devices: Option<&[EngineDevice]>) -> Assessment {
        const GIB: u64 = 1024 * 1024 * 1024;
        let card = Adapter {
            description: "Test GPU".into(),
            vendor_id: 0x10DE,
            device_id: 1,
            luid: 1,
            dedicated: 8 * GIB,
            software: false,
            video: Some(VideoMemory { budget: 8 * GIB, usage: 0 }),
            in_use: Some(0),
        };
        let found = HardwareReport { memory: Some(Memory { total: 16 * GIB, available: 12 * GIB }), disk_free: Some(100 * GIB), adapters: Some(vec![card]) };
        Assessment::of(MODEL_B.id, &super::super::catalog::needs(&MODEL_B).unwrap(), 0, &found, devices)
    }

    /// `start_using` on the fake engine, recording what the assessment was given — `None` if it was never asked.
    fn start_on(f: &EngineFixture, manager: &EngineManager, preference: Preference) -> (Result<(RunPath, EngineInfo), NotStarted>, Option<Option<Vec<EngineDevice>>>) {
        let seen = std::cell::RefCell::new(None);
        let result = start_using(manager, &f.fx.store, f.fx.spec, f.model, preference, None, |devices| {
            *seen.borrow_mut() = Some(devices.map(<[EngineDevice]>::to_vec));
            Ok(fits_test_gpu(devices))
        });
        (result, seen.into_inner())
    }

    #[test]
    fn a_device_list_that_cannot_be_read_leaves_the_gpu_undetermined_and_nothing_else() {
        let _serial = serial_for_tests();
        let f = engine_fixture("listing-unreadable");
        let ran = f.fx.tmp.0.join("ran.txt");
        let mut c = config("devices_garbage");
        c.hooks.extra_env.push((KEY_FILE.into(), ran.to_string_lossy().into_owned()));
        let manager = EngineManager::new(c);
        let undetermined = Fit::NotDetermined { why: Undetermined::DeviceListUnknown, cpu_offered: true };

        // Automatic: assessed with no GPUs known, and the CPU asked about — never started without consent.
        let (result, seen) = start_on(&f, &manager, Preference::Auto);
        assert_eq!(seen, Some(None), "the assessment was not told the GPUs are unknown");
        assert!(matches!(&result, Err(NotStarted::NeedsConsent(request)) if request.gpu_verdict == undetermined), "{result:?}");
        // The GPU chosen: refused, the CPU offered.
        let (result, _) = start_on(&f, &manager, Preference::Gpu);
        assert_eq!(result, Err(NotStarted::Refused { why: undetermined, alternative: Some(RunPath::Cpu) }));
        assert!(!ran.exists(), "an engine was started");
        assert_eq!(manager.status(), EngineStatus::Idle);
        // The CPU chosen: started, as the user asked.
        let (result, _) = start_on(&f, &manager, Preference::Cpu);
        let (path, info) = result.unwrap();
        assert_eq!((path, info.execution), (RunPath::Cpu, Execution::Cpu { threads: super::super::execution::CPU_THREADS }));
        manager.stop().unwrap();
        assert_no_engine_left();
    }

    #[test]
    fn a_start_that_cannot_be_made_says_why_at_once_and_asks_nothing() {
        let _serial = serial_for_tests();
        let refused_at_once = |f: &EngineFixture, manager: &EngineManager, what: &str| -> EngineError {
            for preference in [Preference::Auto, Preference::Gpu, Preference::Cpu] {
                let (result, seen) = start_on(f, manager, preference);
                assert_eq!(seen, None, "{what} / {preference:?}: the computer was assessed for a start that cannot be made");
                let Err(NotStarted::Engine(error)) = result else { panic!("{what} / {preference:?}: {result:?}") };
                if preference == Preference::Cpu {
                    return error;
                }
            }
            unreachable!()
        };

        // No engine installed.
        let gone = engine_fixture("listing-no-engine");
        install::remove(&gone.fx.store, gone.fx.spec).unwrap();
        let error = refused_at_once(&gone, &EngineManager::new(config("devices_one")), "no engine");
        assert!(matches!(error, EngineError::EngineNotInstalled(_)), "{error:?}");
        // A runtime too old for the engine.
        let f = engine_fixture("listing-fatal");
        let mut old = config("devices_one");
        old.hooks.runtime_version = Some([13, 0, 0, 0]);
        let error = refused_at_once(&f, &EngineManager::new(old), "an old runtime");
        assert!(matches!(error, EngineError::VcRuntimeTooOld { .. }), "{error:?}");
        // Another engine already running.
        let running = EngineManager::new(config("normal"));
        start(&f, &running).unwrap();
        let error = refused_at_once(&f, &EngineManager::new(config("devices_one")), "another engine running");
        assert_eq!(error, EngineError::AlreadyActive);
        running.stop().unwrap();
        assert_no_engine_left();
        drop(slot::claim(Holder::Engine).expect("the slot is free again"));
    }

    #[test]
    fn a_device_list_that_names_the_gpu_lets_the_assessment_start_it_there() {
        let _serial = serial_for_tests();
        let f = engine_fixture("listing-gpu");
        let manager = EngineManager::new(config("devices_one"));
        let (result, seen) = start_on(&f, &manager, Preference::Auto);
        assert_eq!(seen, Some(Some(vec![gpu("Vulkan0", "Test GPU")])));
        let (path, info) = result.unwrap();
        assert_eq!(path, RunPath::Gpu { device: "Vulkan0".into() });
        assert_eq!(info.execution, Execution::Gpu { device: "Vulkan0".into() });
        manager.stop().unwrap();
        assert_no_engine_left();
    }
}
