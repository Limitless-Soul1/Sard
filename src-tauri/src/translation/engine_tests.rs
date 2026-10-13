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
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Barrier, OnceLock};
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

    use super::super::catalog::{Artifact, Kind, MODEL_B};
    use super::super::engine::*;
    use super::super::install::{self, InstallError};
    use super::super::install_tests::{build_zip, entries, fixture_in, never, put_verified, sha, Files, Fixture, TempDir};
    use super::super::slot::{self, serial_for_tests, Holder};

    const FAKE_ENTRY: &str = "translation::engine_tests::process::fake_engine_entry";
    const HOST_ENTRY: &str = "translation::engine_tests::process::engine_host_entry";
    const HARNESS: [&str; 3] = ["--exact", "--nocapture", "--test-threads=1"];
    const MODE: &str = "SARD_FAKE_ENGINE_MODE";
    const LOAD_MS: &str = "SARD_FAKE_ENGINE_LOAD_MS";
    const KEY_FILE: &str = "SARD_FAKE_ENGINE_KEY_FILE";
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
            if !violations.is_empty() {
                for v in violations {
                    println!("FAKE violation: {v}");
                }
                std::process::exit(3);
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
        assert_eq!(run(f.model, cpu(), without_runtime), EngineError::MissingVcRuntime(VC_RUNTIME.iter().map(|s| s.to_string()).collect()));

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
                    eprintln!("{mode}: NOT TESTED — this machine has no IPv6 loopback to open the extra listener on");
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
        eprintln!("engine ended {:?} after its host was killed", t0.elapsed());
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
}
