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
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use msedge_tts::tts::client::{connect, MSEdgeTTSClient, SynthesizedAudio};
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::{get_voices_list, Voice};
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

/// Managed state: the persistent Piper process + the warm Edge WebSocket + the cached Edge voices.
#[derive(Default)]
pub struct TtsEngine {
    inner: Mutex<Option<Running>>,          // Piper (engine #1) — one warm process per voice
    edge: Mutex<Option<EdgeRunning>>,       // Edge (engine #2) — one warm WS client per voice
    edge_voices: Mutex<Option<Vec<Voice>>>, // cached get_voices_list() (fetched once, for the picker)
}

/// Edge (engine #2, RAWY-111): a warm WebSocket client bound to one voice's SpeechConfig, reused
/// across sentences and reconnected on drop. `MSEdgeTTSClient<TcpStream>` is Send (rustls StreamOwned).
struct EdgeRunning {
    voice_id: String,
    config: SpeechConfig,
    client: MSEdgeTTSClient<TcpStream>,
}

/// A UI-facing Edge voice — the picker groups these by language and labels them by engine.
#[derive(serde::Serialize)]
pub struct EdgeVoiceInfo {
    pub id: String,     // short_name, e.g. "ar-EG-SalmaNeural"
    pub lang: String,   // locale, e.g. "ar-EG"
    pub gender: String, // "Female" / "Male"
    pub label: String,  // friendly display name, e.g. "Salma"
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

    // RAWY-111: ureq 3 API (bumped from 2 to dedupe with msedge-tts). `timeout_connect` +
    // `timeout_recv_response` turn an unreachable host into a fast visible error (RAWY-106 intent);
    // the body itself is left untimed so a slow-but-progressing 60 MB download isn't falsely aborted.
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(std::time::Duration::from_secs(20)))
            .timeout_recv_response(Some(std::time::Duration::from_secs(45)))
            .build(),
    );

    on_progress.send(0.0).ok();
    // Config first (tiny, instant), then the model (~60 MB) — the model drives the visible bar.
    for ext in ["onnx.json", "onnx"] {
        let dest = dir.join(format!("{}.{ext}", v.file));
        if dest.exists() && std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) > 1000 {
            continue;
        }
        let url = format!("{HF_BASE}/{}/{}.{ext}", v.url_dir, v.file);
        let resp = agent.get(&url).call().map_err(|e| format!("fetch {ext}: {e}"))?;
        let total: u64 = resp.body().content_length().unwrap_or(0);
        let big = ext == "onnx";
        let tmp = dir.join(format!("{}.{ext}.part", v.file));
        let mut reader = resp.into_body().into_reader();
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

/// RAWY-127 (word karaoke): per-word timing for one synthesized sentence. `offset`/`duration` are
/// Azure's 100-nanosecond ticks relative to the START of THIS sentence's audio (each sentence is its
/// own synth call, so offsets reset per sentence — clean to schedule against the played buffer).
/// EDGE emits these (`wordBoundary`); Piper emits none (an empty list → the frontend stays sentence-level).
#[derive(serde::Serialize)]
struct WordTiming {
    text: String,
    offset: u64,
    duration: u64,
}

/// RAWY-127: pack `{words, audio}` into ONE response body so the audio stays RAW bytes (no base64
/// bloat) yet carries its word timing. Framing: `[u32 BE json_len][json words][audio bytes]`. The
/// frontend reads the header, parses the words, and decodes the rest as audio. Piper passes `&[]`.
fn framed(audio: Vec<u8>, words: &[WordTiming]) -> Result<tauri::ipc::Response, String> {
    let json = serde_json::to_vec(words).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + json.len() + audio.len());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&audio);
    Ok(tauri::ipc::Response::new(out))
}

/// Synthesize ONE sentence → framed `[words][audio]` bytes the frontend decodes + plays via WebAudio.
///
/// RAWY-110: the engine-abstraction boundary. A voice is `{engine, id}`; this dispatches by engine.
/// `piper` (engine #1) is the persistent-process path returning WAV; `edge` (engine #2) returns MP3
/// from the free Edge Read-Aloud API. Everything downstream (the WebAudio queue, play/pause/skip/speed)
/// is engine-agnostic — WebAudio decodes both. RAWY-127: the response is now `framed` so it also carries
/// Edge's per-word timing (Piper's is empty).
// RAWY-183: this is `async` on PURPOSE. A synthesis is BLOCKING (Piper's first call spawns the sidecar
// + loads the ~60 MB model — measured ~3.3 s; Edge does a WebSocket round-trip). A SYNC Tauri command
// runs on the MAIN thread, so that block froze the WHOLE window — input couldn't reach the WebView, so
// the pill/shrink button was unresponsive for the synth's duration (the RAWY-181/182 "first-play block"
// that the loading-order + chunked walk didn't explain: measurement showed the ~3.3 s was HERE and the
// JS thread was idle). An async command is dispatched to the runtime's worker pool, so the blocking
// synth runs OFF the main thread and the UI stays responsive throughout. The body has no `.await` (the
// engine work is synchronous under its mutex), so nothing non-Send crosses an await point.
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    state: State<'_, AppState>,
    engines: State<'_, TtsEngine>,
    engine: String,
    id: String,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    match engine.as_str() {
        "piper" => piper_synthesize(&app, &state, &engines, id, text),
        "edge" => edge_synthesize(&engines, id, text),
        other => Err(format!("unknown TTS engine: {other}")),
    }
}

// ---- Edge (engine #2, RAWY-111): the FREE, keyless Edge Read-Aloud neural voices ----

/// "ar-EG-SalmaNeural" → "Salma" (drop the `<lang>-` prefix + a `Neural` suffix); fall back to the
/// friendly name or the raw short_name.
fn edge_label(short_name: &str, v: &Voice) -> String {
    let tail = short_name.rsplit('-').next().unwrap_or(short_name); // "SalmaNeural"
    let name = tail.strip_suffix("Neural").unwrap_or(tail); // "Salma"
    if name.is_empty() {
        v.friendly_name.clone().unwrap_or_else(|| short_name.to_string())
    } else {
        name.to_string()
    }
}

// RAWY-179: Sard is Arabic-first, but Microsoft's read-aloud voice-list endpoint (a fixed global URL)
// is served region-varied by their CDN — some users get a set that OMITS ar-* voices (the tester saw
// English but NO Arabic; the owner, in an Arabic region, sees all 32). The list being region-filtered
// does NOT stop the SYNTHESIS endpoint from speaking a valid Arabic voice by name, so we ALWAYS include
// the full ar-* set: `merge_arabic_fallback` appends any missing Arabic voice to the fetched list
// (deduped by short_name). Because both the picker (`tts_edge_voices`) and synthesis (`edge_synthesize`)
// read the SAME `engines.edge_voices` cache, this makes Arabic BOTH offered AND playable, for everyone —
// and it's a no-op where the fetch already returned Arabic (the owner's list is unchanged).
//
// (`Name` mirrors the endpoint's exact format so `SpeechConfig::from` builds the right SSML voice name;
// all are GA + 24 kHz MP3. Piper's bundled Kareem remains the offline anchor when the fetch fails.)
const AR_FALLBACK: &[(&str, &str, &str)] = &[
    ("ar-AE", "FatimaNeural", "Female"), ("ar-AE", "HamdanNeural", "Male"),
    ("ar-BH", "AliNeural", "Male"),      ("ar-BH", "LailaNeural", "Female"),
    ("ar-DZ", "AminaNeural", "Female"),  ("ar-DZ", "IsmaelNeural", "Male"),
    ("ar-EG", "SalmaNeural", "Female"),  ("ar-EG", "ShakirNeural", "Male"),
    ("ar-IQ", "BasselNeural", "Male"),   ("ar-IQ", "RanaNeural", "Female"),
    ("ar-JO", "SanaNeural", "Female"),   ("ar-JO", "TaimNeural", "Male"),
    ("ar-KW", "FahedNeural", "Male"),    ("ar-KW", "NouraNeural", "Female"),
    ("ar-LB", "LaylaNeural", "Female"),  ("ar-LB", "RamiNeural", "Male"),
    ("ar-LY", "ImanNeural", "Female"),   ("ar-LY", "OmarNeural", "Male"),
    ("ar-MA", "JamalNeural", "Male"),    ("ar-MA", "MounaNeural", "Female"),
    ("ar-OM", "AbdullahNeural", "Male"), ("ar-OM", "AyshaNeural", "Female"),
    ("ar-QA", "AmalNeural", "Female"),   ("ar-QA", "MoazNeural", "Male"),
    ("ar-SA", "HamedNeural", "Male"),    ("ar-SA", "ZariyahNeural", "Female"),
    ("ar-SY", "AmanyNeural", "Female"),  ("ar-SY", "LaithNeural", "Male"),
    ("ar-TN", "HediNeural", "Male"),     ("ar-TN", "ReemNeural", "Female"),
    ("ar-YE", "MaryamNeural", "Female"), ("ar-YE", "SalehNeural", "Male"),
];

fn arabic_fallback_voices() -> Vec<Voice> {
    AR_FALLBACK
        .iter()
        .map(|(locale, suffix, gender)| Voice {
            name: format!("Microsoft Server Speech Text to Speech Voice ({locale}, {suffix})"),
            short_name: Some(format!("{locale}-{suffix}")),
            gender: Some((*gender).to_string()),
            locale: Some((*locale).to_string()),
            suggested_codec: Some("audio-24khz-48kbitrate-mono-mp3".to_string()),
            friendly_name: None,
            status: Some("GA".to_string()),
            voice_tag: None,
        })
        .collect()
}

/// Append any ar-* fallback voice not already present (by short_name) to the fetched list.
fn merge_arabic_fallback(mut fetched: Vec<Voice>) -> Vec<Voice> {
    let have: std::collections::HashSet<String> =
        fetched.iter().filter_map(|v| v.short_name.clone()).collect();
    for fb in arabic_fallback_voices() {
        let present = fb.short_name.as_deref().map(|sn| have.contains(sn)).unwrap_or(true);
        if !present {
            fetched.push(fb);
        }
    }
    fetched
}

/// Fetch the Edge voice list and guarantee the Arabic set is present (RAWY-179). Fails only when the
/// fetch itself fails (offline) — the frontend then shows the RAWY-177 "no voices" state; the fallback
/// is merged ONLY on a successful (online) fetch, so we never offer an Edge voice that can't synthesize.
fn load_edge_voices() -> Result<Vec<Voice>, String> {
    let fetched = get_voices_list().map_err(|e| format!("edge voices: {e:?}"))?;
    Ok(merge_arabic_fallback(fetched))
}

/// List the Edge voices for the picker — EVERY voice Microsoft returns, cached after the first
/// fetch. RAWY-197 removed the old `ar-`/`en-` filter (tts.rs:378-383): it silently made Sard an
/// Arabic/English-only reader for read-aloud, contradicting D44 (a GENERAL reader for everyone).
/// Arabic stays guaranteed by `merge_arabic_fallback` upstream in `load_edge_voices`. A voice with
/// no short_name is skipped (no stable id to select); a voice with no locale still passes through
/// with an empty locale string — grouping never drops a selectable voice.
#[tauri::command]
pub fn tts_edge_voices(engines: State<'_, TtsEngine>) -> Result<Vec<EdgeVoiceInfo>, String> {
    let mut cache = engines.edge_voices.lock().map_err(|e| e.to_string())?;
    if cache.is_none() {
        *cache = Some(load_edge_voices()?);
    }
    let out = cache
        .as_ref()
        .unwrap()
        .iter()
        .filter_map(|v| {
            v.short_name.as_ref().map(|sn| EdgeVoiceInfo {
                id: sn.clone(),
                lang: v.locale.clone().unwrap_or_default(),
                gender: v.gender.clone().unwrap_or_default(),
                label: edge_label(sn, v),
            })
        })
        .collect();
    Ok(out)
}

/// RAWY-172 (AUD-2): a single Edge synth may block at most this long before we treat the socket as stalled,
/// drop it, and free this mutex so the next sentence can be synthesized (the frontend surfaces the explicit
/// "Edge unavailable" pause). RAWY-231 (invariant D): lowered 20 s → 8 s so a genuine stall surfaces a CHOICE
/// in ~8 s instead of ~20 s of silence. BASIS: the worst live synth measured to date is ~2.7 s (a cold WS
/// connect, RAWY-191); a normal synth ~0.6 s; a 236-char sentence in 632 ms — so 8 s keeps ~3x margin over
/// the worst measured and never false-trips a slow-but-live link. Kept just BELOW the frontend
/// SYNTH_TIMEOUT_MS (9 s) so the specific Rust reason ("edge synth timed out") reaches the user, not the
/// generic JS timeout. PROVISIONAL — if the owner's Phase-0 slow-synth capture shows synths above ~5 s on his
/// real network, raise both (a false timeout is a visible, actionable edge-error, not silence).
const EDGE_SYNTH_TIMEOUT_SECS: u64 = 8;

/// The outcome of one bounded Edge synth (RAWY-172). `Ok`/`Failed` hand the warm client BACK (for reuse,
/// or its config to reconnect); `Stalled` means the worker is still blocked and OWNS the client — it
/// drops when the OS finally times the socket out — so the caller must reconnect next time.
enum EdgeSynth {
    Ok(SynthesizedAudio, EdgeRunning),
    Failed(EdgeRunning, String),
    Stalled,
}

/// Run ONE blocking Edge synth on a worker thread, bounded by `EDGE_SYNTH_TIMEOUT_SECS`, so a stalled
/// socket can't block the caller's mutex forever. msedge-tts 0.4 exposes no socket-timeout hook (the
/// client's inner WebSocket is `pub(crate)` and `connect()` builds the `TcpStream` internally), so a
/// worker + `recv_timeout` is the way to put a ceiling on it. The warm client is moved to the worker and
/// returned with the result; on timeout the worker is abandoned — its client drops when synthesize finally
/// returns, closing the socket. `MSEdgeTTSClient<TcpStream>` + `SpeechConfig` are Send, so the move is sound.
fn edge_synth_once(mut running: EdgeRunning, text: &str) -> EdgeSynth {
    let (tx, rx) = std::sync::mpsc::channel();
    let text = text.to_string();
    std::thread::spawn(move || {
        let res = running.client.synthesize(&text, &running.config);
        let _ = tx.send((running, res)); // if we already timed out, this send fails and drops the client
    });
    match rx.recv_timeout(std::time::Duration::from_secs(EDGE_SYNTH_TIMEOUT_SECS)) {
        Ok((running, Ok(audio))) => EdgeSynth::Ok(audio, running),
        Ok((running, Err(e))) => EdgeSynth::Failed(running, format!("{e:?}")),
        Err(_) => EdgeSynth::Stalled,
    }
}

/// Synthesize one sentence → MP3 bytes over the free Edge Read-Aloud WebSocket. Reuses a warm client
/// per voice; a dropped socket reconnects once. Online-required — an unreachable endpoint surfaces a
/// clear error, and the frontend then falls back to Piper.
fn edge_synthesize(engines: &TtsEngine, id: String, text: String) -> Result<tauri::ipc::Response, String> {
    let mut guard = engines.edge.lock().map_err(|e| e.to_string())?;
    let need_new = guard.as_ref().map(|r| r.voice_id != id).unwrap_or(true);
    if need_new {
        // build the voice's config from the (cached) voice list, then open a warm connection
        let mut vcache = engines.edge_voices.lock().map_err(|e| e.to_string())?;
        if vcache.is_none() {
            // RAWY-179: same merged list as the picker, so a fallback Arabic voice is synthesizable.
            *vcache = Some(load_edge_voices()?);
        }
        let voice = vcache
            .as_ref()
            .unwrap()
            .iter()
            .find(|v| v.short_name.as_deref() == Some(id.as_str()))
            .ok_or_else(|| format!("unknown edge voice: {id}"))?;
        let mut config = SpeechConfig::from(voice);
        config.audio_format = "audio-24khz-48kbitrate-mono-mp3".to_string(); // force MP3 for WebAudio
        drop(vcache);
        let client = connect().map_err(|e| format!("edge connect: {e:?}"))?;
        *guard = Some(EdgeRunning { voice_id: id.clone(), config, client });
    }
    // RAWY-172 (AUD-2): bound the blocking synth with a timeout so a stalled socket can't hold this mutex
    // forever. We run synthesize on a worker thread and wait with a ceiling — still HOLDING the guard
    // across the wait, so callers serialize exactly as before (no second connection): the warm client is
    // moved out and put back. On a stall we surface an error and leave the slot empty (the abandoned client
    // drops when its synthesize finally returns), so the next call reconnects; the frontend's own timeout
    // (RAWY-172) has already advanced playback by then.
    let running = guard.take().unwrap();
    let audio = match edge_synth_once(running, &text) {
        EdgeSynth::Ok(audio, running) => {
            *guard = Some(running);
            audio
        }
        EdgeSynth::Failed(running, _) => {
            // the socket dropped cleanly (idle / a brief blip) — reconnect once and retry (RAWY-113)
            let config = running.config.clone();
            let client = connect().map_err(|e| format!("edge reconnect: {e:?}"))?;
            match edge_synth_once(EdgeRunning { voice_id: id.clone(), config, client }, &text) {
                EdgeSynth::Ok(audio, running) => {
                    *guard = Some(running);
                    audio
                }
                EdgeSynth::Failed(_, e) => return Err(format!("edge synth: {e}")),
                EdgeSynth::Stalled => return Err("edge synth timed out".into()),
            }
        }
        EdgeSynth::Stalled => return Err("edge synth timed out".into()),
    };
    // RAWY-127: keep the per-word timing Edge already sends (it was discarded before). The crate
    // requests `wordBoundaryEnabled` and parses each `audio.metadata` into `AudioMetadata`; take only
    // the WORD boundaries (skip any sentence/punctuation boundary) with real word text.
    let words: Vec<WordTiming> = audio
        .audio_metadata
        .iter()
        .filter(|m| m.boundary_type.as_deref() == Some("WordBoundary"))
        .filter_map(|m| {
            m.text.as_ref().map(|t| WordTiming {
                text: t.clone(),
                offset: m.offset,
                duration: m.duration,
            })
        })
        .collect();
    framed(audio.audio_bytes, &words)
}

/// Piper (engine #1): reuse the persistent warm process; respawn only if the voice changed or died.
fn piper_synthesize(
    app: &AppHandle,
    state: &AppState,
    engines: &TtsEngine,
    id: String,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    let v = voice_def(&id).ok_or("unknown voice")?;
    let mut guard = engines.inner.lock().map_err(|e| e.to_string())?;

    let reuse = if let Some(r) = guard.as_mut() {
        r.voice_id == id && r.child.try_wait().map(|s| s.is_none()).unwrap_or(false)
    } else {
        false
    };
    if !reuse {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
        *guard = Some(spawn_piper(app, state, v)?);
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
    // RAWY-127: Piper exposes no word timing — frame with an EMPTY word list, so the frontend keeps
    // this sentence at the Phase-1 sentence level (no pill). Same wire shape as Edge (audio still raw).
    framed(bytes, &[])
}

/// Kill the warm Piper child + drop the Edge socket. Shared by the `tts_stop` command (the user closes
/// the player) and the app-exit handler (RAWY-173, AUD-10) so closing the window never orphans piper.exe.
pub fn shutdown(engine: &TtsEngine) {
    if let Ok(mut guard) = engine.inner.lock() {
        if let Some(mut r) = guard.take() {
            let _ = r.child.kill(); // Piper process
        }
    }
    if let Ok(mut guard) = engine.edge.lock() {
        *guard = None; // Edge WebSocket (dropped → closed)
    }
}

/// Stop + drop both engines' warm connections (called when the user closes the player).
///
/// RAWY-188: this is `async` on PURPOSE (the RAWY-183 lesson). `shutdown` must lock `engine.inner` /
/// `engine.edge` to take the Piper child + Edge socket, but a synth in flight HOLDS that mutex for its
/// full duration (a cold Piper spawn or an Edge round-trip — measured ~6 s of contention). A SYNC command
/// runs on the app's MAIN thread, so that mutex wait froze the whole window (input couldn't reach the
/// WebView; the taskbar icon reverted to the default while Windows judged the app unresponsive). An async
/// command is dispatched to the runtime worker pool, so the (still-serialized) teardown runs OFF the main
/// thread and the UI stays responsive. The body has no `.await` (the lock + kill are synchronous), so
/// nothing non-Send crosses an await point.
#[tauri::command]
pub async fn tts_stop(engine: State<'_, TtsEngine>) -> Result<(), String> {
    shutdown(&engine);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{arabic_fallback_voices, merge_arabic_fallback, Voice};

    fn mk(short: &str, locale: &str) -> Voice {
        Voice {
            name: format!("Microsoft Server Speech Text to Speech Voice ({short})"),
            short_name: Some(short.to_string()),
            gender: Some("Female".to_string()),
            locale: Some(locale.to_string()),
            suggested_codec: None,
            friendly_name: None,
            status: Some("GA".to_string()),
            voice_tag: None,
        }
    }

    // RAWY-179: the tester's region returns English voices but NO Arabic. The merge must restore the
    // full ar-* set (so Arabic is offered + playable), preserve the English voices, and NOT duplicate
    // an Arabic voice the fetch DID include.
    #[test]
    fn arabic_fallback_restores_missing_voices() {
        // simulate the region-filtered fetch: 2 English + 1 Arabic that happened to be present.
        let fetched = vec![
            mk("en-US-AriaNeural", "en-US"),
            mk("en-GB-SoniaNeural", "en-GB"),
            mk("ar-EG-SalmaNeural", "ar-EG"),
        ];
        let merged = merge_arabic_fallback(fetched);
        let shorts: Vec<&str> = merged.iter().filter_map(|v| v.short_name.as_deref()).collect();

        // English preserved
        assert!(shorts.contains(&"en-US-AriaNeural"));
        assert!(shorts.contains(&"en-GB-SoniaNeural"));
        // every fallback Arabic voice is now present (spot-check the key ones + the full count)
        for want in ["ar-SA-HamedNeural", "ar-SA-ZariyahNeural", "ar-EG-ShakirNeural", "ar-AE-FatimaNeural", "ar-MA-MounaNeural"] {
            assert!(shorts.contains(&want), "missing Arabic voice {want}");
        }
        assert_eq!(arabic_fallback_voices().len(), 32, "the full ar-* set");
        // the already-present Arabic voice is NOT duplicated
        assert_eq!(shorts.iter().filter(|s| **s == "ar-EG-SalmaNeural").count(), 1);
        // 2 English + 32 Arabic (Salma dedup'd) = 34
        assert_eq!(merged.len(), 2 + 32);
        // the fallback carries a valid full Name (SpeechConfig::from uses it for the SSML voice name)
        let salma = merged.iter().find(|v| v.short_name.as_deref() == Some("ar-SA-HamedNeural")).unwrap();
        assert_eq!(salma.name, "Microsoft Server Speech Text to Speech Voice (ar-SA, HamedNeural)");
    }
}
