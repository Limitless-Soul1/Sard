//! TTS engine (RAWY-105, Phase 1) — drives the BUNDLED prebuilt piper engine as a persistent
//! sidecar process. The engine (piper.exe + its DLLs + espeak-ng-data + libtashkeel_model.ort for
//! Arabic auto-diacritization) ships in the installer under `resources/piper` and is resolved via
//! `resource_dir()`. VOICE models are NOT bundled — they download on demand into app-data.
//!
//! Persistence model (measured warm RTF ~0.05 in RAWY-102): piper is spawned ONCE per voice with
//! `--json-input`, keeping the ONNX model loaded. Each synth writes one `{"text":...}` line to its
//! stdin; piper writes a WAV to a temp dir and prints that path on stdout. We read the path, read
//! the WAV bytes, and return them raw to the frontend (WebAudio decodes + plays them).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};

use crate::db::AppState;

/// A known voice. Stage 1 ships a minimal registry; Stage 2 (RAWY-106) grows this into a full
/// language→voice manifest with the download UI. `arabic` routes synthesis through libtashkeel.
struct VoiceDef {
    id: &'static str,
    file: &'static str,   // base filename of the .onnx / .onnx.json
    url_dir: &'static str, // path under the piper-voices HF repo
    arabic: bool,
}

const VOICES: &[VoiceDef] = &[
    VoiceDef { id: "ar_JO-kareem-medium", file: "ar_JO-kareem-medium", url_dir: "ar/ar_JO/kareem/medium", arabic: true },
    VoiceDef { id: "en_US-lessac-medium", file: "en_US-lessac-medium", url_dir: "en/en_US/lessac/medium", arabic: false },
];

const HF_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

fn voice_def(id: &str) -> Option<&'static VoiceDef> {
    VOICES.iter().find(|v| v.id == id)
}

/// Managed state: the single persistent piper process (or none).
#[derive(Default)]
pub struct TtsEngine {
    inner: Mutex<Option<Running>>,
}

struct Running {
    voice_id: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    // piper's stderr, drained by a background thread into this buffer (RAWY-108) so a real engine
    // error is surfaced verbatim instead of a bare path — and so an undrained pipe can't ever block
    // piper mid-session.
    errlog: Arc<Mutex<String>>,
}

fn engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))
        .map(|d| d.join("piper"))
}

fn voices_dir(state: &AppState) -> PathBuf {
    state.app_data_dir.join("voices")
}

/// Is the voice's model present on disk (both .onnx + .onnx.json)?
#[tauri::command]
pub fn tts_voice_present(state: State<'_, AppState>, id: String) -> bool {
    let Some(v) = voice_def(&id) else { return false };
    let dir = voices_dir(&state);
    ["onnx", "onnx.json"]
        .iter()
        .all(|ext| dir.join(format!("{}.{ext}", v.file)).exists())
}

/// Download a voice's model files (.onnx.json config + the ~60 MB .onnx model) into app-data if
/// missing, streaming the big model in chunks and reporting a 0.0–1.0 fraction over `on_progress`
/// (RAWY-106) so the player shows a real "downloading voice…" bar instead of a silent, swallowed
/// hang — the exact failure the owner hit on a fresh install. Written to a `.part` then renamed so a
/// partial download never looks complete; connect/read timeouts turn a stalled link into a visible
/// error rather than an endless "preparing".
#[tauri::command]
pub fn tts_download_voice(
    state: State<'_, AppState>,
    id: String,
    on_progress: tauri::ipc::Channel<f64>,
) -> Result<(), String> {
    let v = voice_def(&id).ok_or("unknown voice")?;
    let dir = voices_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout_read(std::time::Duration::from_secs(45))
        .build();

    on_progress.send(0.0).ok();
    // Config first (tiny, instant), then the model (~60 MB) — the model drives the visible bar.
    for ext in ["onnx.json", "onnx"] {
        let dest = dir.join(format!("{}.{ext}", v.file));
        if dest.exists() && std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) > 1000 {
            continue;
        }
        let url = format!("{HF_BASE}/{}/{}.{ext}", v.url_dir, v.file);
        let resp = agent.get(&url).call().map_err(|e| format!("fetch {ext}: {e}"))?;
        let total: u64 = resp.header("Content-Length").and_then(|h| h.parse().ok()).unwrap_or(0);
        let big = ext == "onnx";
        let tmp = dir.join(format!("{}.{ext}.part", v.file));
        let mut reader = resp.into_reader();
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut got: u64 = 0;
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("read {ext}: {e}"))?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            if big && total > 0 {
                on_progress.send((got as f64 / total as f64).min(0.999)).ok();
            }
        }
        f.sync_all().ok();
        drop(f);
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    }
    on_progress.send(1.0).ok();
    Ok(())
}

/// Build the piper Command EXACTLY as the app spawns it. Pure — takes resolved paths (no Tauri
/// AppHandle), so the real spawn path can be exercised from a test against the actual test-build /
/// installer engine layout (RAWY-108) instead of a hand-run of piper.exe. `current_dir(eng)` is what
/// lets Windows load piper's sibling DLLs (onnxruntime, espeak-ng, piper_phonemize); those DLLs +
/// espeak-ng-data + the tashkeel model must all sit in `eng`.
pub fn piper_command(eng: &Path, model: &Path, arabic: bool, out_dir: &Path) -> Command {
    let mut cmd = Command::new(eng.join("piper.exe"));
    cmd.arg("-m").arg(model)
        .arg("--espeak_data").arg(eng.join("espeak-ng-data"))
        .arg("--json-input")
        .arg("--output_dir").arg(out_dir)
        .arg("-q")
        .current_dir(eng)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if arabic {
        cmd.arg("--tashkeel_model").arg(eng.join("libtashkeel_model.ort"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
    }
    cmd
}

fn spawn_piper(app: &AppHandle, state: &AppState, v: &VoiceDef) -> Result<Running, String> {
    let eng = engine_dir(app)?;
    let piper = eng.join("piper.exe");
    if !piper.exists() {
        // RAWY-108: the engine (piper.exe + its DLLs + espeak-ng-data + tashkeel model) ships beside
        // the app as bundled resources; if the whole `piper/` folder is missing next to the exe, the
        // app wasn't laid out with its resources (the test-build gap this task fixed).
        return Err(format!("piper engine not found at {} — the app is missing its bundled engine folder", piper.display()));
    }
    let model = voices_dir(state).join(format!("{}.onnx", v.file));
    if !model.exists() {
        return Err(format!("voice model missing: {}", model.display()));
    }
    let out_dir = std::env::temp_dir().join("sard-tts");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut cmd = piper_command(&eng, &model, v.arabic, &out_dir);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't start piper ({}): {e}", piper.display()))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

    // Drain stderr on a background thread → errlog. Piper is `-q` (near-silent) in normal use, but on
    // an error it writes here; draining continuously means the pipe never fills (which would stall
    // piper) and the real message is available to surface if synthesis fails.
    let errlog = Arc::new(Mutex::new(String::new()));
    if let Some(err) = child.stderr.take() {
        let sink = errlog.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(err);
            let mut line = String::new();
            while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                if let Ok(mut g) = sink.lock() {
                    g.push_str(&line);
                }
                line.clear();
            }
        });
    }
    Ok(Running { voice_id: v.id.to_string(), child, stdin, stdout, errlog })
}

/// Synthesize ONE sentence with the given voice; returns the raw WAV bytes (frontend decodes +
/// plays via WebAudio). Reuses the persistent piper process (warm) — respawns only if the voice
/// changed or the process died.
#[tauri::command]
pub fn tts_synthesize(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: State<'_, TtsEngine>,
    id: String,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    let v = voice_def(&id).ok_or("unknown voice")?;
    let mut guard = engine.inner.lock().map_err(|e| e.to_string())?;

    let reuse = if let Some(r) = guard.as_mut() {
        r.voice_id == id && r.child.try_wait().map(|s| s.is_none()).unwrap_or(false)
    } else {
        false
    };
    if !reuse {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
        *guard = Some(spawn_piper(&app, &state, v)?);
    }
    let r = guard.as_mut().unwrap();

    // request: one JSON line on stdin
    let line = serde_json::json!({ "text": text }).to_string();
    r.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    r.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    r.stdin.flush().map_err(|e| e.to_string())?;

    // response: one line on stdout = the output WAV path
    let mut path_line = String::new();
    let n = r.stdout.read_line(&mut path_line).map_err(|e| e.to_string())?;
    if n == 0 {
        // Piper exited without emitting a WAV path — surface WHY (RAWY-108) so a failure is
        // diagnosable, not hidden behind a bare "closed unexpectedly". Piper is near-silent on stderr
        // even on a bad model (it just exits non-zero), so the EXIT CODE is the main signal; include
        // any stderr it did write. (A missing DLL fails earlier at spawn with the OS error; a missing
        // engine/voice is caught before spawn.)
        let errlog = r.errlog.clone();
        let code = r.child.wait().ok().and_then(|s| s.code());
        *guard = None; // drop it so the next call respawns
        std::thread::sleep(std::time::Duration::from_millis(30)); // let the drain thread flush
        let msg = errlog.lock().ok().map(|g| g.trim().to_string()).unwrap_or_default();
        return Err(match (msg.is_empty(), code) {
            (false, Some(c)) => format!("piper failed (exit {c}): {msg}"),
            (false, None) => format!("piper failed: {msg}"),
            (true, Some(c)) => format!("piper exited with code {c} without producing audio"),
            (true, None) => "piper exited without producing audio".into(),
        });
    }
    let wav_path = path_line.trim();
    let bytes = std::fs::read(wav_path).map_err(|e| format!("read wav {wav_path}: {e}"))?;
    let _ = std::fs::remove_file(wav_path);
    Ok(tauri::ipc::Response::new(bytes))
}

/// Stop + drop the persistent piper process (called when the user closes the player).
#[tauri::command]
pub fn tts_stop(engine: State<'_, TtsEngine>) {
    if let Ok(mut guard) = engine.inner.lock() {
        if let Some(mut r) = guard.take() {
            let _ = r.child.kill();
        }
    }
}
