//! TTS engine — synthesis over the free Edge Read-Aloud neural voices. A warm WebSocket client is
//! kept per voice and reused across sentences; each synth returns MP3 bytes plus Edge's per-word
//! timing, which the frontend decodes and plays through WebAudio.

use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use msedge_tts::tts::stream::{msedge_tts_split, Receiver, Sender, SynthesizedResponse};
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::{get_voices_list, Voice};
use tauri::State;

/// RAWY-FINAL: lock, RECOVERING from poisoning rather than failing (or, worse, silently skipping)
/// forever. Same reasoning as `AppState::conn` — a `std::sync::Mutex` poisons permanently on the
/// first panic under it, and the release profile unwinds. Before this, `edge` / `edge_voices`
/// mapped the poison to an error string, so ONE panic under either of them ended read-aloud for the
/// rest of the process with a message no user could act on.
/// The guarded values are a WebSocket client and a voice list; neither has an invariant a panic
/// could half-update in a way that recovery makes worse, and every consumer re-establishes its own
/// state (`need_new` reconnects).
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Managed state: the warm Edge WebSocket, the cached Edge voices, the cancel flag of the call in
/// flight, and the recent first-audio latencies the progress bound is derived from.
#[derive(Default)]
pub struct TtsEngine {
    edge: Mutex<Option<EdgeRunning>>,       // one warm WS client per voice
    edge_voices: Mutex<Option<Vec<Voice>>>, // cached get_voices_list() (fetched once, for the picker)
    /// The cancel flag of the synthesis currently holding `edge`. `tts_cancel_synth` and `tts_stop`
    /// raise it without taking `edge`, so a cancel can reach a call that is mid-stream.
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Milliseconds from request to the first audio chunk, for the last successful calls. The
    /// first-audio window adapts to these, so a slow-but-alive service is not mistaken for a dead one
    /// and a dead socket is not given the benefit of a doubt for longer than the service warrants.
    first_audio_ms: Mutex<std::collections::VecDeque<u64>>,
    /// Whether the synthesis currently holding `edge` has produced its first audio chunk. Read by
    /// `tts_synth_streaming` so the scheduler can tell a call that is SILENT from one that is slow but
    /// streaming: the first may be asked to yield for a fresh attempt, the second is left to finish.
    streaming: AtomicBool,
}

/// Edge (engine #2, RAWY-111): a warm WebSocket client bound to one voice's SpeechConfig, reused
/// across sentences and reconnected on drop. The crate's split client: `Sender` writes the request,
/// `Receiver` yields the response one message at a time, which is what lets a synthesis be bounded on
/// PROGRESS (first audio, then activity) instead of on a single total.
struct EdgeRunning {
    voice_id: String,
    config: SpeechConfig,
    tx: Sender<TcpStream>,
    rx: Receiver<TcpStream>,
    /// When this client last finished a synthesis — the input to the idle rule below.
    last_used: Instant,
}

/// HOW LONG A WARM CLIENT MAY SIT IDLE BEFORE IT IS REPLACED RATHER THAN USED.
///
/// THE DEFECT THIS EXISTS FOR. The service closes a read-aloud socket it considers idle, and the close
/// is only discovered when the next request is WRITTEN: the call fails immediately with a connection
/// reset (10054) and the scheduler pays a wasted attempt before reconnecting. MEASURED against the live
/// service, one request per idle interval: every request up to 32.4 s idle succeeded, and every request
/// from 33.0 s onwards failed in 3 ms and succeeded on the immediate retry (35 s, 45 s, 60 s — both
/// trials). In a real day of listening this was 17 of 22 resets, and it is why a chapter start after a
/// pause so often began with a failure: the tail of a chapter leaves the engine idle for 10–27 s and the
/// listener's own reaction adds the rest.
///
/// THE RULE. Past this ceiling the client is dropped and a fresh one opened BEFORE the request is
/// written, so the first request after a pause connects instead of failing. 20 s is the validated value
/// and leaves 13 s of margin under the measured cliff; the reconnect it costs was measured at 1.0–2.7 s,
/// which is what the failure path was already paying for its retry — with the policy on, 22 of 22
/// requests succeeded across 0–120 s of idle, with no reset at any interval.
///
/// ACTIVE PLAYBACK IS UNAFFECTED: a chapter in flight dispatches far inside this window (the longest gap
/// between two successful requests in the real record was 29.3 s, and only 5 of 1,669 fell in the 20–33 s
/// band at all). The ceiling is tunable through `SARD_EDGE_IDLE_MAX_MS`, and 0 disables the rule, so the
/// threshold can be re-measured on another network without a rebuild.
const EDGE_IDLE_MAX_MS: u64 = 20_000;

fn edge_idle_max() -> Option<Duration> {
    let ms = std::env::var("SARD_EDGE_IDLE_MAX_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(EDGE_IDLE_MAX_MS);
    (ms > 0).then(|| Duration::from_millis(ms))
}

/// Is a warm client too old to be trusted with the next request? Separated from the socket so the rule
/// itself is testable without one.
fn edge_client_is_stale(idle: Duration, max: Option<Duration>) -> bool {
    max.is_some_and(|m| idle > m)
}
/// A UI-facing Edge voice — the picker groups these by language and labels them by engine.
#[derive(serde::Serialize)]
pub struct EdgeVoiceInfo {
    pub id: String,     // short_name, e.g. "ar-EG-SalmaNeural"
    pub lang: String,   // locale, e.g. "ar-EG"
    pub gender: String, // "Female" / "Male"
    pub label: String,  // friendly display name, e.g. "Salma"
}

/// RAWY-127 (word karaoke): per-word timing for one synthesized sentence. `offset`/`duration` are
/// Azure's 100-nanosecond ticks relative to the START of THIS sentence's audio (each sentence is its
/// own synth call, so offsets reset per sentence — clean to schedule against the played buffer).
/// EDGE emits these (`wordBoundary`).
#[derive(serde::Serialize)]
struct WordTiming {
    text: String,
    offset: u64,
    duration: u64,
}

/// RAWY-127: pack `{words, audio}` into ONE response body so the audio stays RAW bytes (no base64
/// bloat) yet carries its word timing. Framing: `[u32 BE json_len][json words][audio bytes]`. The
/// frontend reads the header, parses the words, and decodes the rest as audio.
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
/// `edge` returns MP3 from the free Edge Read-Aloud API. Everything downstream (the WebAudio queue,
/// play/pause/skip/speed) is engine-agnostic. RAWY-127: the response is `framed` so it also carries
/// Edge's per-word timing.
// RAWY-183: this is `async` on PURPOSE. A synthesis is BLOCKING (Edge does a WebSocket round-trip).
// A SYNC Tauri command runs on the MAIN thread, so that block froze the WHOLE window — input couldn't
// reach the WebView, so the pill/shrink button was unresponsive for the synth's duration (the
// RAWY-181/182 "first-play block" that the loading-order + chunked walk didn't explain: measurement
// showed the block was HERE and the JS thread was idle). An async command is dispatched to the
// runtime's worker pool, so the blocking synth runs OFF the main thread and the UI stays responsive
// throughout. The body has no `.await` (the engine work is synchronous under its mutex), so nothing
// non-Send crosses an await point.
// `budget_ms` is the frontend's user-facing recovery budget for THIS call (the listener is waiting on
// it): every bound below is clamped to what is left of it, so the command returns inside the budget
// whatever the service does. Absent, the call is background work and is bounded on progress instead.
// `first_audio_ms` is a further cap on how long this call may go WITHOUT A FIRST AUDIO BYTE — connect,
// voice list and the first frame together. The scheduler sets it on the first attempt of a recovery round
// so that a connection which opens and then falls silent cannot spend the listener's whole budget by
// itself; see `bounds_for`. It never shortens a call that is producing audio.
#[tauri::command]
pub async fn tts_synthesize(
    engines: State<'_, TtsEngine>,
    engine: String,
    id: String,
    text: String,
    budget_ms: Option<u64>,
    first_audio_ms: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    match engine.as_str() {
        "edge" => edge_synthesize(&engines, id, text, budget_ms, first_audio_ms),
        other => Err(format!("unknown TTS engine: {other}")),
    }
}

/// Raise the cancel flag of the synthesis in flight, if any. It returns at once; the call itself
/// returns `edge synth cancelled` within one wait slice, and its worker drops the socket at the next
/// message from the service. Used when the listener navigates away from the unit being produced,
/// when the session changes, and by `tts_stop`. Not an error to call with nothing in flight.
#[tauri::command]
pub async fn tts_cancel_synth(engines: State<'_, TtsEngine>) -> Result<bool, String> {
    Ok(cancel_current(&engines))
}

/// Has the synthesis in flight produced any audio yet? False with nothing in flight. The scheduler asks
/// this before yielding a call it adopted into a recovery round (RULE 2a): a stalled call is dropped so a
/// fresh connection gets the rest of the budget; a call that is already streaming is left alone, because
/// restarting it could only lose the audio it has.
#[tauri::command]
pub async fn tts_synth_streaming(engines: State<'_, TtsEngine>) -> Result<bool, String> {
    Ok(engines.streaming.load(Ordering::SeqCst))
}

/// This call's cancel flag, installed for the duration of the call and retired on EVERY exit path.
///
/// THE DEFECT THIS CLOSES (found by the live cancellation tests, intermittently): the flag used to be
/// retired at one point in the middle of `edge_synthesize`, after the synthesis returned — so every
/// early return of the SETUP phase (a voice-list fetch or a connect that ran out of budget, an unknown
/// voice, a missing warm client) left a stale flag in the slot. A cancel raised in that window was then
/// written to a flag nobody would ever read: `tts_cancel_synth` answered `true` with nothing in flight,
/// and the Stop it belonged to did nothing at this layer. `Drop` cannot be forgotten by a later edit.
///
/// It retires only its OWN flag (pointer identity), so a flag installed by a later call is never
/// cleared by an earlier one retiring late.
struct CancelSlot<'a> {
    engine: &'a TtsEngine,
    flag: Arc<AtomicBool>,
}

impl<'a> CancelSlot<'a> {
    /// Install before the engine lock is taken, so a cancel can reach a call still queued behind another.
    fn install(engine: &'a TtsEngine) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        *lock_recover(&engine.cancel) = Some(flag.clone());
        Self { engine, flag }
    }
}

impl Drop for CancelSlot<'_> {
    fn drop(&mut self) {
        let mut slot = lock_recover(&self.engine.cancel);
        if slot.as_ref().map(|f| Arc::ptr_eq(f, &self.flag)).unwrap_or(false) {
            *slot = None;
        }
    }
}

fn cancel_current(engines: &TtsEngine) -> bool {
    match lock_recover(&engines.cancel).as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
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

// RAWY-179: Sard must be able to read Arabic aloud, but Microsoft's voice-list endpoint (a fixed global URL)
// is served region-varied by their CDN — some users get a set that OMITS ar-* voices (the tester saw
// English but NO Arabic; the owner, in an Arabic region, sees all 32). The list being region-filtered
// does NOT stop the SYNTHESIS endpoint from speaking a valid Arabic voice by name, so we ALWAYS include
// the full ar-* set: `merge_arabic_fallback` appends any missing Arabic voice to the fetched list
// (deduped by short_name). Because both the picker (`tts_edge_voices`) and synthesis (`edge_synthesize`)
// read the SAME `engines.edge_voices` cache, this makes Arabic BOTH offered AND playable, for everyone —
// and it's a no-op where the fetch already returned Arabic (the owner's list is unchanged).
//
// (`Name` mirrors the endpoint's exact format so `SpeechConfig::from` builds the right SSML voice name;
// all are GA + 24 kHz MP3.)
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
/// The voice list, fetched once (bounded, OUTSIDE the lock) and cached. A concurrent second fetch is
/// harmless: the same list is stored twice.
fn cached_voices(engines: &TtsEngine, budget: Duration, cancel: &AtomicBool) -> Result<Arc<Vec<Voice>>, String> {
    if let Some(v) = lock_recover(&engines.edge_voices).as_ref() {
        return Ok(Arc::new(v.clone()));
    }
    let fetched = load_edge_voices_bounded(budget, cancel)?;
    let mut cache = lock_recover(&engines.edge_voices);
    if cache.is_none() {
        *cache = Some(fetched);
    }
    Ok(Arc::new(cache.as_ref().cloned().unwrap_or_default()))
}

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
// `async` for the same reason `tts_synthesize` is (RAWY-183): a sync command runs on the MAIN thread,
// and this one used to make an UNBOUNDED HTTP fetch there while holding `edge_voices` — which the
// synthesis path also takes — so an outage could freeze the window and pin the engine at once. The
// fetch is now bounded and made without the lock; the lock is taken only to read or store the list.
#[tauri::command]
pub async fn tts_edge_voices(engines: State<'_, TtsEngine>) -> Result<Vec<EdgeVoiceInfo>, String> {
    let voices = cached_voices(&engines, Duration::from_secs(EDGE_SYNTH_TIMEOUT_SECS), &AtomicBool::new(false))?;
    let out = voices
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
/// RAWY-257 package 2A (C1): this is now the **TOTAL** budget for ONE `tts_synthesize` call — every step
/// (voice fetch, connect, synth, reconnect, retry) draws from it — NOT a per-attempt ceiling.
///
/// WHY IT CHANGED MEANING. The doc above claims this is kept "just BELOW the frontend SYNTH_TIMEOUT_MS (9 s)
/// so the specific Rust reason reaches the user". That was only ever true of a SINGLE attempt. `edge_synthesize`
/// can run TWO bounded synths in series, and `connect()` / `get_voices_list()` had NO bound at all (msedge-tts
/// 0.4 exposes no socket-timeout hook — see `edge_synth_once`), so the real worst case was ~16 s PLUS unbounded
/// network I/O — roughly 2x the JS ceiling, and unbounded in the bad cases. The frontend therefore gave up
/// while this call was still working, the worker kept HOLDING the engine mutex, and the next sentence queued
/// behind it and timed out too: a CASCADE of false failures on a healthy link.
///
/// Making it a TOTAL deadline makes the documented invariant TRUE for the first time: the Rust command now
/// returns within ~8 s, the JS ceiling sits 1 s above it, and the specific Rust reason wins the race.
///
/// RAWY-266 (stage 2): 8 -> 12. D70/S3 said this value must be re-derived from a measured distribution and
/// not guessed; RAWY-265 finally ran that capture, with an ISOLATED probe on the same crate and voice and
/// NO deadline at all, over 105 requests of real sentences from the owner's own book:
///
///   * 105/105 completed. ZERO hung. The premise that a timeout means a dead socket is not what happens.
///   * synthesis time tracks output audio almost linearly (~0.37-0.45x the audio duration), so it is
///     SENTENCE LENGTH that decides whether 8 s is enough: a 236-char sentence (19 s of audio) exceeded 8 s
///     in 59% of samples, while the book's median sentence (56 chars) synthesises in ~2 s.
///   * at 8 s, 22.0% of warm requests fail; at 12 s, 1.1%. Of everything that passes 8 s, 95% is finished
///     by 12 s.
///
/// 12 is therefore where the recovery curve flattens, not a round number. The JS ceiling moves with it
/// (SYNTH_TIMEOUT_MS 9 -> 13 s): leaving it at 9 would fire FIRST and this budget would never be reachable.
const EDGE_SYNTH_TIMEOUT_SECS: u64 = 12;

/// Time left before `deadline`, or the timeout error once it has passed. Every bounded step below goes
/// through this, so no combination of steps can exceed the total budget.
///
/// RAWY-266 (stage 1): the error now names the PHASE that ran out. Before this, all three call sites and
/// `EdgeSynth::Stalled` returned the single string "edge synth timed out", so four different conditions were
/// indistinguishable in the failure record — and the frontend's `isStallFailure` suppressed retries for all
/// of them alike. That is precisely the case RAWY-257's C1 fix was meant to end for connection faults: it
/// narrowed the JS predicate to whole phrases, but the Rust side still emitted the synth phrase when the
/// budget expired during CONNECT, so a connection fault was still being read as a stalled synthesis.
fn remaining(deadline: std::time::Instant, phase: &str) -> Result<std::time::Duration, String> {
    match deadline.checked_duration_since(std::time::Instant::now()) {
        Some(d) if !d.is_zero() => Ok(d),
        _ => Err(format!("edge {phase} timed out")),
    }
}

/// RAWY-257 (C8-lite): the connection opened on a worker thread and bounded. It opens a TCP + TLS +
/// WebSocket connection with NO timeout of its own, and it is made while `engines.edge` is HELD — so on
/// a black-holed route it could pin the engine mutex for the OS connect timeout (tens of seconds), far
/// past any ceiling the app believed it had. An abandoned worker finishes on its own and drops its
/// socket. The split client (`Sender` + `Receiver` over the one socket) replaces the whole-response
/// client so the synthesis can be read one message at a time — see `edge_synth_once`.
///
/// The wait is made in slices against the call's cancel flag: a Stop or a session change raised while
/// the connection is still being opened returns at once instead of after the connect (measured 1.9 s
/// on a cold engine, up to the whole budget on a slow route), so a Listen started right after a Stop
/// never queues behind a connection nobody wants. The abandoned connect finishes on its own; its
/// socket is dropped with the result nobody receives.
fn connect_bounded(budget: Duration, cancel: &AtomicBool) -> Result<(Sender<TcpStream>, Receiver<TcpStream>), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(msedge_tts_split().map_err(|e| format!("edge connect: {e:?}")));
    });
    wait_bounded(rx, budget, cancel, "edge connect timed out")
}

/// Wait for a bounded worker's result in short slices, so a cancel raised meanwhile is honoured
/// within one slice. The worker is abandoned on either exit; its result is dropped unread.
fn wait_bounded<T>(rx: std::sync::mpsc::Receiver<Result<T, String>>, budget: Duration, cancel: &AtomicBool, timed_out: &str) -> Result<T, String> {
    const SLICE: Duration = Duration::from_millis(100);
    let deadline = Instant::now() + budget;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("edge synth cancelled".into());
        }
        let left = match deadline.checked_duration_since(Instant::now()) {
            Some(d) if !d.is_zero() => d,
            _ => return Err(timed_out.into()),
        };
        match rx.recv_timeout(left.min(SLICE)) {
            Ok(r) => return r,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(timed_out.into()),
        }
    }
}

/// RAWY-257 (C8-lite): the voice-list fetch, bounded the same way. It is a blocking HTTP call made INSIDE the
/// engine mutex on the voice-change path, and it was equally unbounded.
fn load_edge_voices_bounded(budget: std::time::Duration, cancel: &AtomicBool) -> Result<Vec<Voice>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(load_edge_voices());
    });
    wait_bounded(rx, budget, cancel, "edge voices fetch timed out")
}

/// The outcome of one bounded Edge synth. `Ok`/`Failed` hand the warm client BACK (for reuse, or its
/// config to reconnect); `Stalled` means the worker still OWNS the client — it drops the socket at the
/// next message from the service, or when the OS finally times the socket out — so the caller must
/// reconnect next time. `Cancelled` is the same shape, raised by the frontend rather than a bound.
enum EdgeSynth {
    Ok(StreamedAudio, EdgeRunning),
    /// The service answered with an error; the worker has dropped the client.
    Failed(String),
    Stalled(String),
    Cancelled,
}

/// One synthesis, assembled from the stream: the MP3 bytes, Edge's per-word metadata, and how long
/// the first audio took to arrive (the sample the adaptive first-audio window is derived from).
struct StreamedAudio {
    audio_bytes: Vec<u8>,
    audio_metadata: Vec<msedge_tts::tts::AudioMetadata>,
    first_audio_ms: u64,
}

/// One message from the streaming worker to the waiting caller.
enum Chunk {
    Audio(Vec<u8>),
    Meta(Vec<msedge_tts::tts::AudioMetadata>),
    Done(EdgeRunning),
    Err(String),
}

/// The bounds one synthesis is held to, all measured from the moment the request is written.
///
/// A synthesis is bounded on PROGRESS, not on a single total: the service was measured (2026-09-17,
/// uncached text) taking 6–22 s to the first audio chunk and up to 69 s for a long unit, with pauses of
/// up to 19 s between chunks, and completing every one of those — while a dead socket produces nothing
/// at all. A single 12 s total cannot tell those apart; these three bounds can.
struct Bounds {
    /// No audio at all by then → the socket is treated as dead.
    first_audio: Duration,
    /// Audio had started but nothing arrived for this long → the stream is treated as dead.
    idle: Duration,
    /// Hard ceiling on the whole synthesis, scaled to the text length.
    total: Duration,
}

/// Fallback first-audio window with too few samples to adapt: the bound every call had before.
const FIRST_AUDIO_DEFAULT_MS: u64 = 12_000;
/// The window only ever WIDENS from that bound: a floor below it would fail calls the previous
/// implementation completed (measured in the app: a healthy-looking service delivered first audio at
/// 9 s right after three sub-2 s calls, and an 8 s floor killed it).
const FIRST_AUDIO_MIN_MS: u64 = FIRST_AUDIO_DEFAULT_MS;
const FIRST_AUDIO_MAX_MS: u64 = 30_000;
/// The least a recovery attempt may be given to produce its first byte, whatever the frontend asks: below
/// this a fresh connection has no realistic chance and the cap would only manufacture failures.
const FIRST_AUDIO_CAP_FLOOR_MS: u64 = 1_000;
/// Between chunks: the longest pause measured on a completing stream was 19 s.
const STREAM_IDLE_MS: u64 = 30_000;
/// Total: a base plus per-character allowance (the longest measured unit, 1,336 chars, took 43 s),
/// capped so a runaway stream cannot hold the engine indefinitely.
const TOTAL_BASE_MS: u64 = 12_000;
const TOTAL_PER_CHAR_MS: u64 = 60;
const TOTAL_MAX_MS: u64 = 120_000;
const FIRST_AUDIO_SAMPLES: usize = 20;

/// clamp(1.5 × p90 of the recent first-audio latencies, 8 s, 30 s); the default until three samples
/// exist. Pure, so it is unit-tested against measured distributions.
fn adaptive_first_audio_ms(samples: &[u64]) -> u64 {
    if samples.len() < 3 {
        return FIRST_AUDIO_DEFAULT_MS;
    }
    let mut v = samples.to_vec();
    v.sort_unstable();
    let p90 = v[((v.len() - 1) * 9) / 10];
    (p90 + p90 / 2).clamp(FIRST_AUDIO_MIN_MS, FIRST_AUDIO_MAX_MS)
}

/// The bounds for one call: background work is bounded on progress; a call the listener is waiting on
/// (`budget`) has every bound clamped to what is left of that budget, so it returns inside it.
///
/// THE FIRST-AUDIO CAP (`first_audio_cap`). The adaptive first-audio window floors at 12 s — the whole
/// recovery budget — so until this existed a recovery attempt whose connection opened and then sent
/// nothing was only declared stalled when the budget itself ran out. Measured in real listening on a poor
/// link: "recovery failed (budget) after 1 attempt(s)", a 12,002 ms gap, and the listener pressing Retry
/// — the round's second and third attempts never had a chance. The cap bounds only the wait for the FIRST
/// byte, so a call that is streaming, however slowly, keeps its full budget; it is clamped below to the
/// second the frontend may not go under, and it is always at most the budget.
fn bounds_for(chars: usize, adaptive_first_audio: u64, budget: Option<Duration>, first_audio_cap: Option<Duration>) -> Bounds {
    let total_ms = (TOTAL_BASE_MS + chars as u64 * TOTAL_PER_CHAR_MS).min(TOTAL_MAX_MS);
    let mut b = Bounds {
        first_audio: Duration::from_millis(adaptive_first_audio),
        idle: Duration::from_millis(STREAM_IDLE_MS),
        total: Duration::from_millis(total_ms),
    };
    if let Some(budget) = budget {
        b.first_audio = b.first_audio.min(budget);
        b.idle = b.idle.min(budget);
        b.total = budget;
    }
    if let Some(cap) = first_audio_cap {
        b.first_audio = b.first_audio.min(cap.max(Duration::from_millis(FIRST_AUDIO_CAP_FLOOR_MS)));
    }
    b
}

/// XML-escape book text on its way into the Edge SSML payload.
///
/// THE DEFECT THIS CLOSES. `msedge-tts` builds the request by interpolating the text straight into
/// XML character data (0.4.0, `src/tts/mod.rs:150`):
///
/// ```text
/// format!("<speak ...><voice name='{}'><prosody ...>{}</prosody></voice></speak>", .., text)
/// ```
///
/// so a sentence carrying `<`, `>` or `&` produces a malformed document. The reported case is the
/// guillemet pair `<<`, which .txt-to-EPUB conversions use for quotation marks throughout a book:
/// the endpoint accepts the request and answers with audio that never plays, and read-aloud
/// eventually reports that the voice cannot read this book.
///
/// WHY HERE. This is the last line Sard owns before the crate sees the text, and there is exactly one
/// of them: `tts_synthesize` dispatches on the engine name, `edge_synthesize` is the only arm, and it
/// reaches the crate through this one call. Escaping in the frontend instead would push an XML concern
/// into the IPC contract and pre-escape text for any future engine that does not speak XML; escaping
/// inside the crate would mean patching a vendored dependency for a problem Sard can solve at its own
/// boundary.
///
/// WHY IT CHANGES NOTHING AUDIBLE. This is a transport encoding, and the receiver undoes it: the
/// endpoint's XML parser decodes `&lt;` back to `<` before synthesis, so the spoken text — and the word
/// boundaries Edge reports against it, which drive the karaoke cursor — are exactly what they were.
///
/// ONE PASS, so double-escaping is impossible BY CONSTRUCTION rather than by ordering care. Each source
/// character is examined once and its replacement is written to the output, which is never re-read — so
/// the `&` of an `&lt;` this function itself produced can never be escaped again. The result is
/// identical to escaping `&` first and then the angle brackets: `&<>` becomes `&amp;&lt;&gt;`, and the
/// reported `<<` becomes `&lt;&lt;`, never `&amp;lt;&amp;lt;`.
///
/// Book text is SOURCE TEXT, not markup: a book that literally prints `&lt;` is four characters the
/// reader can see, so its `&` is escaped like any other and the endpoint decodes `&amp;lt;` back to the
/// four characters the page shows.
///
/// Quotes are deliberately NOT escaped. The text lands in character data, between `<prosody>` and its
/// closing tag, never inside an attribute value, so `"` and `'` carry no meaning there.
fn escape_ssml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

fn edge_synth_once(mut running: EdgeRunning, text: &str, bounds: Bounds, cancel: Arc<AtomicBool>, streaming: &AtomicBool) -> EdgeSynth {
    // The worker owns the client for the duration of the call. It writes the request, then forwards
    // every message the service sends, and hands the client back with `Done` when the turn ends. It
    // checks the cancel flag BEFORE each read: a cancelled or abandoned call drops the client — and
    // with it the socket — at the next message, which the live probe confirmed closes the connection
    // at once, so a cancelled call never keeps streaming beside its successor. A socket that never
    // sends another message keeps the worker blocked until the OS reaps it, exactly as before.
    let (tx, rx) = std::sync::mpsc::channel::<Chunk>();
    let text = escape_ssml_text(text); // the crate interpolates this straight into SSML
    let worker_cancel = cancel.clone();
    std::thread::spawn(move || {
        if let Err(e) = running.tx.send(&text, &running.config) {
            let _ = tx.send(Chunk::Err(format!("edge synth: {e:?}")));
            return;
        }
        loop {
            if worker_cancel.load(Ordering::SeqCst) {
                return; // drops `running` → the socket closes
            }
            // `Receiver::read` blocks forever when no turn is pending, so the turn's end is checked
            // AFTER every read and before the next one.
            let msg = match running.rx.read() {
                Ok(Some(SynthesizedResponse::AudioBytes(b))) => Some(Chunk::Audio(b)),
                Ok(Some(SynthesizedResponse::AudioMetadata(m))) => Some(Chunk::Meta(m)),
                Ok(None) => None,
                Err(e) => {
                    let _ = tx.send(Chunk::Err(format!("edge synth: {e:?}")));
                    return;
                }
            };
            if let Some(m) = msg {
                if tx.send(m).is_err() {
                    return; // the caller stopped waiting → drop the client
                }
            }
            if !running.rx.can_read() {
                let _ = tx.send(Chunk::Done(running));
                return;
            }
        }
    });

    // The caller waits in short slices so a cancel raised from another command is seen promptly,
    // and applies the three progress bounds. On any bound or a cancel the worker is abandoned with
    // the flag raised; it drops the socket at its next message.
    const SLICE: Duration = Duration::from_millis(100);
    let start = Instant::now();
    let mut audio: Vec<u8> = Vec::new();
    let mut metadata = Vec::new();
    let mut first_audio: Option<Instant> = None;
    let mut last_activity = start;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return EdgeSynth::Cancelled;
        }
        let now = Instant::now();
        let since_start = now.duration_since(start);
        let stalled = match first_audio {
            None if since_start >= bounds.first_audio => Some("edge synth stalled: no audio"),
            Some(_) if now.duration_since(last_activity) >= bounds.idle => Some("edge synth stalled: stream idle"),
            _ if since_start >= bounds.total => Some("edge synth stalled: over budget"),
            _ => None,
        };
        if let Some(why) = stalled {
            cancel.store(true, Ordering::SeqCst);
            return EdgeSynth::Stalled(why.into());
        }
        match rx.recv_timeout(SLICE) {
            Ok(Chunk::Audio(b)) => {
                if first_audio.is_none() {
                    first_audio = Some(Instant::now());
                    streaming.store(true, Ordering::SeqCst);
                }
                last_activity = Instant::now();
                audio.extend_from_slice(&b);
            }
            Ok(Chunk::Meta(m)) => {
                last_activity = Instant::now();
                metadata.extend(m);
            }
            Ok(Chunk::Done(running)) => {
                let first_audio_ms = first_audio.map(|t| t.duration_since(start).as_millis() as u64).unwrap_or(0);
                return EdgeSynth::Ok(StreamedAudio { audio_bytes: audio, audio_metadata: metadata, first_audio_ms }, running);
            }
            Ok(Chunk::Err(e)) => return EdgeSynth::Failed(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // The worker saw the cancel flag first and left (a race inside one wait slice, measured in
                // the app as "worker ended" on a voice change): that is a cancel, not a failure to count.
                if cancel.load(Ordering::SeqCst) {
                    return EdgeSynth::Cancelled;
                }
                return EdgeSynth::Failed("edge synth: worker ended".into());
            }
        }
    }
}

/// Record one first-audio latency; the adaptive window is read back through `first_audio_window`.
fn note_first_audio(engines: &TtsEngine, ms: u64) {
    let mut q = lock_recover(&engines.first_audio_ms);
    q.push_back(ms);
    while q.len() > FIRST_AUDIO_SAMPLES {
        q.pop_front();
    }
}

fn first_audio_window(engines: &TtsEngine) -> u64 {
    let mut q = lock_recover(&engines.first_audio_ms);
    adaptive_first_audio_ms(q.make_contiguous())
}

/// Synthesize one sentence → MP3 bytes over the free Edge Read-Aloud WebSocket. Reuses a warm client
/// per voice; a dropped socket reconnects on the next call. Online-required — an unreachable endpoint
/// surfaces a clear error, which the frontend surfaces as the explicit Edge-unavailable pause.
fn edge_synthesize(engines: &TtsEngine, id: String, text: String, budget_ms: Option<u64>, first_audio_ms: Option<u64>) -> Result<tauri::ipc::Response, String> {
    // A call the listener is waiting on carries its budget (clamped to the range the JS side may ask
    // for); the connect and voice-list phases draw from it too, so the whole command returns inside it.
    let budget = budget_ms.map(|b| Duration::from_millis(b.clamp(1_000, EDGE_SYNTH_TIMEOUT_SECS * 1_000)));
    // The first-audio cap counts from the call's start and covers the setup phases as well: a connect that
    // hangs is the same silence to the listener as a stream that never begins.
    let first_audio_cap = first_audio_ms.map(|c| Duration::from_millis(c.max(FIRST_AUDIO_CAP_FLOOR_MS)));
    let setup_budget = budget.unwrap_or(Duration::from_secs(EDGE_SYNTH_TIMEOUT_SECS));
    let setup_budget = first_audio_cap.map_or(setup_budget, |c| setup_budget.min(c));
    let started = Instant::now();
    let deadline = started + setup_budget;

    // The cancel flag is installed before the engine lock is taken, so a cancel can reach a call that
    // is still queued behind the previous one, and it is retired on every exit path (see `CancelSlot`).
    // Calls are serialized by the frontend, so "the current call" is unambiguous.
    let slot = CancelSlot::install(engines);
    let cancel = slot.flag.clone();

    let mut guard = lock_recover(&engines.edge);
    if cancel.load(Ordering::SeqCst) {
        return Err("edge synth cancelled".into());
    }
    // A client the service has probably closed already (see `EDGE_IDLE_MAX_MS`) is replaced here, before
    // the request is written, rather than discovered as a failure by the caller.
    let idle = guard.as_ref().map(|r| r.last_used.elapsed()).unwrap_or_default();
    let stale = guard.is_some() && edge_client_is_stale(idle, edge_idle_max());
    let need_new = guard.as_ref().map(|r| r.voice_id != id).unwrap_or(true) || stale;
    if need_new {
        if stale {
            // Dropped on this thread, while the engine lock is held, so no other call can take it up.
            *guard = None;
        }
        // build the voice's config from the (cached) voice list, then open a warm connection
        let voices = cached_voices(engines, remaining(deadline, "voices")?, &cancel)?;
        let voice = voices
            .iter()
            .find(|v| v.short_name.as_deref() == Some(id.as_str()))
            .ok_or_else(|| format!("unknown edge voice: {id}"))?;
        let mut config = SpeechConfig::from(voice);
        config.audio_format = "audio-24khz-48kbitrate-mono-mp3".to_string(); // force MP3 for WebAudio
        let (tx, rx) = connect_bounded(remaining(deadline, "connect")?, &cancel)?;
        *guard = Some(EdgeRunning { voice_id: id.clone(), config, tx, rx, last_used: Instant::now() });
    }
    // RAWY-FINAL: `let Some(..) else` rather than `.unwrap()`. The `need_new` branch above makes this
    // provably `Some` today, but this line runs while `engines.edge` is HELD — the one place a panic
    // would poison the read-aloud engine mutex permanently.
    let Some(running) = guard.take() else {
        return Err("edge connect: no warm client".into());
    };
    let budget_left = budget.map(|b| b.saturating_sub(started.elapsed()));
    let cap_left = first_audio_cap.map(|c| c.saturating_sub(started.elapsed()));
    let bounds = bounds_for(text.chars().count(), first_audio_window(engines), budget_left, cap_left);
    // RAWY-172 (AUD-2) / RAWY-257: the synth is bounded while HOLDING the guard, so callers serialize
    // exactly as before (no second connection): the warm client is moved to the worker and put back.
    // On a stall or a cancel the slot is left empty, so the next call reconnects.
    engines.streaming.store(false, Ordering::SeqCst);
    let outcome = edge_synth_once(running, &text, bounds, cancel.clone(), &engines.streaming);
    engines.streaming.store(false, Ordering::SeqCst);
    let streamed = match outcome {
        EdgeSynth::Ok(audio, mut running) => {
            // The idle clock starts when the client is handed back, not when the request began.
            running.last_used = Instant::now();
            *guard = Some(running);
            audio
        }
        EdgeSynth::Failed(e) => return Err(e),
        // RAWY-257 package 2B (C1 completion): there is exactly ONE retry authority in the system — the
        // frontend's scheduler. A stall here is reported, never retried in place.
        EdgeSynth::Stalled(why) => return Err(why),
        EdgeSynth::Cancelled => return Err("edge synth cancelled".into()),
    };
    if streamed.first_audio_ms > 0 {
        note_first_audio(engines, streamed.first_audio_ms);
    }
    // RAWY-127: keep the per-word timing Edge already sends. The crate requests `wordBoundaryEnabled`
    // and parses each `audio.metadata` into `AudioMetadata`; take only the WORD boundaries (skip any
    // sentence/punctuation boundary) with real word text.
    let words: Vec<WordTiming> = streamed
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
    framed(streamed.audio_bytes, &words)
}

/// Drop the warm Edge socket. Shared by the `tts_stop` command (the user closes the player) and the
/// app-exit handler (RAWY-173, AUD-10) so closing the window always releases the connection.
pub fn shutdown(engine: &TtsEngine) {
    // RAWY-FINAL: `lock_recover`, not `if let Ok(..)`. A poisoned mutex used to make this a NO-OP,
    // leaving the socket open for the rest of the process.
    *lock_recover(&engine.edge) = None; // Edge WebSocket (dropped → closed)
}

/// Stop + drop both engines' warm connections (called when the user closes the player).
///
/// RAWY-188: this is `async` on PURPOSE (the RAWY-183 lesson). `shutdown` must lock `engine.inner` /
/// `engine.edge` to take the Edge socket, but a synth in flight HOLDS that mutex for its full
/// duration (an Edge round-trip — measured ~6 s of contention). A SYNC command
/// runs on the app's MAIN thread, so that mutex wait froze the whole window (input couldn't reach the
/// WebView; the taskbar icon reverted to the default while Windows judged the app unresponsive). An async
/// command is dispatched to the runtime worker pool, so the (still-serialized) teardown runs OFF the main
/// thread and the UI stays responsive. The body has no `.await` (the lock + kill are synchronous), so
/// nothing non-Send crosses an await point.
#[tauri::command]
pub async fn tts_stop(engine: State<'_, TtsEngine>) -> Result<(), String> {
    // A call in flight would otherwise hold `edge` for the rest of its bounds; cancelling first frees
    // it within one wait slice, so Stop never waits behind synthesis.
    cancel_current(&engine);
    shutdown(&engine);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        adaptive_first_audio_ms, arabic_fallback_voices, bounds_for, escape_ssml_text, merge_arabic_fallback, Voice,
        FIRST_AUDIO_DEFAULT_MS, FIRST_AUDIO_CAP_FLOOR_MS, FIRST_AUDIO_MAX_MS, FIRST_AUDIO_MIN_MS, STREAM_IDLE_MS, TOTAL_MAX_MS,
    };
    use std::time::Duration;

    // ---- the progress bounds (measured 2026-09-17 on the live service) ----

    #[test]
    fn first_audio_window_defaults_until_three_samples_exist() {
        assert_eq!(adaptive_first_audio_ms(&[]), FIRST_AUDIO_DEFAULT_MS);
        assert_eq!(adaptive_first_audio_ms(&[400, 25_000]), FIRST_AUDIO_DEFAULT_MS);
    }

    #[test]
    fn first_audio_window_never_drops_below_the_previous_bound() {
        // typical healthy first-audio latencies: a few hundred ms → the floor, which IS the old 12 s bound
        assert_eq!(adaptive_first_audio_ms(&[300, 450, 500, 380, 420]), FIRST_AUDIO_MIN_MS);
        assert_eq!(FIRST_AUDIO_MIN_MS, FIRST_AUDIO_DEFAULT_MS);
    }

    #[test]
    fn first_audio_window_widens_for_a_slow_service_and_is_capped() {
        // the measured William distribution: 6.8–22.2 s to first audio
        let w = adaptive_first_audio_ms(&[6_848, 10_710, 22_242, 12_148, 8_597, 7_137]);
        assert!(w > FIRST_AUDIO_DEFAULT_MS, "a slow-but-alive service must get more than the default: {w}");
        assert!(w <= FIRST_AUDIO_MAX_MS);
        assert_eq!(adaptive_first_audio_ms(&[40_000, 50_000, 60_000]), FIRST_AUDIO_MAX_MS);
    }

    #[test]
    fn first_audio_window_stays_inside_its_bounds_for_any_history() {
        // pathological histories: empty, one sample, extremes, zeros, huge outliers, alternating
        let cases: Vec<Vec<u64>> = vec![
            vec![],
            vec![1],
            vec![u64::MAX / 4; 5],
            vec![0, 0, 0, 0],
            vec![300, 25_000, 300, 25_000, 300, 25_000, 300],
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100_000],
            (0..20).map(|i| i * 1_000).collect(),
            vec![11_999, 12_000, 12_001],
            vec![19_999, 20_000, 20_001],
            vec![1_000_000; 20],
        ];
        for h in &cases {
            let w = adaptive_first_audio_ms(h);
            assert!((FIRST_AUDIO_MIN_MS..=FIRST_AUDIO_MAX_MS).contains(&w), "{h:?} -> {w}");
        }
        // pseudo-random histories
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..5_000 {
            let n = (x % 25) as usize;
            let mut h = Vec::with_capacity(n);
            for _ in 0..n {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                h.push(x % 120_000);
            }
            let w = adaptive_first_audio_ms(&h);
            assert!((FIRST_AUDIO_MIN_MS..=FIRST_AUDIO_MAX_MS).contains(&w), "{h:?} -> {w}");
        }
    }

    #[test]
    fn a_single_outlier_cannot_poison_the_window() {
        // 19 healthy samples and one 60 s outlier: p90 is still healthy -> the floor
        let mut h = vec![400u64; 19];
        h.push(60_000);
        assert_eq!(adaptive_first_audio_ms(&h), FIRST_AUDIO_MIN_MS);
        // and the history is bounded to FIRST_AUDIO_SAMPLES by note_first_audio
        let e = super::TtsEngine::default();
        for i in 0..100 {
            super::note_first_audio(&e, i);
        }
        assert_eq!(super::lock_recover(&e.first_audio_ms).len(), super::FIRST_AUDIO_SAMPLES);
    }

    #[test]
    fn background_bounds_scale_with_text_length_and_are_capped() {
        let short = bounds_for(60, 12_000, None, None);
        let long = bounds_for(1_336, 12_000, None, None);
        assert_eq!(short.first_audio, Duration::from_millis(12_000));
        assert_eq!(short.idle, Duration::from_millis(STREAM_IDLE_MS));
        assert!(long.total > short.total);
        assert_eq!(bounds_for(100_000, 12_000, None, None).total, Duration::from_millis(TOTAL_MAX_MS));
    }

    #[test]
    fn a_waited_on_call_never_outlives_its_budget() {
        // every bound is clamped to what is left of the listener's budget
        let b = bounds_for(1_336, 30_000, Some(Duration::from_millis(4_500)), None);
        assert_eq!(b.first_audio, Duration::from_millis(4_500));
        assert_eq!(b.idle, Duration::from_millis(4_500));
        assert_eq!(b.total, Duration::from_millis(4_500));
        let c = bounds_for(10, 8_000, Some(Duration::from_millis(12_000)), None);
        assert_eq!(c.first_audio, Duration::from_millis(8_000));
        assert_eq!(c.total, Duration::from_millis(12_000));
    }

    #[test]
    fn a_stalled_first_attempt_cannot_consume_the_whole_round() {
        // The failure as it was measured: a 12 s budget, the adaptive window at its 12 s floor, and a
        // connection that never sends a byte. Without the cap the call was allowed the whole budget.
        let uncapped = bounds_for(77, 12_000, Some(Duration::from_millis(12_000)), None);
        assert_eq!(uncapped.first_audio, Duration::from_millis(12_000));
        // With the first attempt's cap (half the round), silence is declared at 6 s and the round's second
        // attempt still has the other half. The TOTAL is untouched: a stream that has begun keeps its budget.
        let capped = bounds_for(77, 12_000, Some(Duration::from_millis(12_000)), Some(Duration::from_millis(6_000)));
        assert_eq!(capped.first_audio, Duration::from_millis(6_000));
        assert_eq!(capped.total, Duration::from_millis(12_000));
        assert_eq!(capped.idle, Duration::from_millis(12_000));
        // The cap can only shorten: a cap above the budget leaves the budget's own clamp in force.
        let wide = bounds_for(77, 12_000, Some(Duration::from_millis(5_000)), Some(Duration::from_millis(9_000)));
        assert_eq!(wide.first_audio, Duration::from_millis(5_000));
        // ...and never below the floor, whatever the frontend sends.
        let tiny = bounds_for(77, 12_000, Some(Duration::from_millis(12_000)), Some(Duration::from_millis(10)));
        assert_eq!(tiny.first_audio, Duration::from_millis(FIRST_AUDIO_CAP_FLOOR_MS));
        // A background call (no budget) is not a recovery attempt and the cap is simply not sent for it.
        let bg = bounds_for(77, 12_000, None, None);
        assert_eq!(bg.first_audio, Duration::from_millis(12_000));
    }

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
    // ---- SSML escaping (the `<<` defect) ------------------------------------------------------
    //
    // `msedge-tts` interpolates the text straight into XML character data, so anything Sard hands it
    // is markup unless it was escaped first. These fix that contract in place.

    /// The reported case, and the one that must NOT come out double-escaped.
    #[test]
    fn escapes_the_guillemet_pair() {
        assert_eq!(escape_ssml_text("<<"), "&lt;&lt;");
        assert_ne!(escape_ssml_text("<<"), "&amp;lt;&amp;lt;");
    }

    #[test]
    fn escapes_each_sensitive_character() {
        assert_eq!(escape_ssml_text("<"), "&lt;");
        assert_eq!(escape_ssml_text(">"), "&gt;");
        assert_eq!(escape_ssml_text("&"), "&amp;");
        assert_eq!(escape_ssml_text(">>"), "&gt;&gt;");
    }

    /// The ordering property: the ampersand is escaped as a SOURCE character, and the ampersands this
    /// function writes are never re-read. Escaping `<` first and `&` second would give `&amp;lt;` here.
    #[test]
    fn the_ampersand_is_escaped_before_the_angle_brackets() {
        assert_eq!(escape_ssml_text("&<>"), "&amp;&lt;&gt;");
        assert_eq!(escape_ssml_text("<&>"), "&lt;&amp;&gt;");
        assert!(!escape_ssml_text("<").contains("&amp;lt;"));
    }

    /// A book that literally prints `&lt;` shows the reader four characters. They are source text, so
    /// the ampersand is escaped exactly once and the endpoint decodes them back to what the page shows.
    #[test]
    fn an_entity_looking_sequence_is_treated_as_source_text() {
        assert_eq!(escape_ssml_text("&lt;"), "&amp;lt;");
        assert_eq!(escape_ssml_text("&amp;"), "&amp;amp;");
    }

    #[test]
    fn mixed_text_carrying_all_three() {
        assert_eq!(escape_ssml_text("a < b & c > d"), "a &lt; b &amp; c &gt; d");
    }

    #[test]
    fn ordinary_text_is_returned_unchanged() {
        // Arabic prose, with the punctuation and the Arabic-Indic digits read-aloud relies on.
        let arabic = "كان الفصل ٤٦، وهو جميل؟";
        assert_eq!(escape_ssml_text(arabic), arabic);
        let latin = "The quick brown fox; it jumped (twice) - 42% of the time!";
        assert_eq!(escape_ssml_text(latin), latin);
        assert_eq!(escape_ssml_text(""), "");
    }

    // ---- the SSML payload itself ---------------------------------------------------------------
    //
    // A helper can be correct and still not be REACHED, so this asserts the property at the shape the
    // crate actually sends. The template mirrors `msedge-tts` 0.4.0 `src/tts/mod.rs:150` verbatim; if
    // that crate is re-pinned, re-derive this copy from the new source.
    fn ssml_payload(escaped_text: &str) -> String {
        format!(
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
<voice name='ar-EG-SalmaNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{escaped_text}\
</prosody></voice></speak>"
        )
    }

    /// Parse the payload with a real XML reader and read the character data back out.
    fn parse_text_of(payload: &str) -> Result<String, String> {
        let mut reader = quick_xml::Reader::from_str(payload);
        let mut found = String::new();
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Text(e)) => {
                    found.push_str(&e.unescape().map_err(|err| format!("unescape: {err}"))?);
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Ok(_) => {}
                Err(e) => return Err(format!("parse: {e}")),
            }
        }
        Ok(found)
    }

    /// THE REGRESSION. Hostile book text, escaped by the function production uses, put into the shape
    /// the crate sends: the document must parse, and the text the endpoint would synthesize must be
    /// character-for-character the sentence from the book.
    #[test]
    fn the_payload_is_well_formed_and_says_what_the_book_says() {
        for original in [
            "<<",
            "قال: <<أهلاً>> & مضى",
            "a < b & c > d",
            "&lt;",
            "plain sentence",
        ] {
            let payload = ssml_payload(&escape_ssml_text(original));
            let spoken = parse_text_of(&payload)
                .unwrap_or_else(|e| panic!("payload for {original:?} did not parse: {e}"));
            assert_eq!(spoken, original, "the endpoint would speak the wrong text for {original:?}");
        }
    }

    /// The test above must be able to FAIL, or it proves nothing. Unescaped, the same text is not a
    /// well-formed document — which is precisely the defect.
    #[test]
    fn the_unescaped_payload_is_what_breaks() {
        let payload = ssml_payload("<<");
        assert!(
            parse_text_of(&payload).is_err(),
            "raw `<<` must not parse — if it does, the escaping test above is vacuous"
        );
    }
}

/// Live-service tests. They need the network and the real Edge endpoint, so they are `#[ignore]` and
/// run explicitly: `cargo test --locked live_edge -- --ignored --test-threads=1`.
#[cfg(test)]
mod live_edge {
    use super::*;
    use std::time::Instant;

    const VOICE: &str = "en-AU-WilliamMultilingualNeural";
    fn nonce(text: &str) -> String {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        format!("{text} {}", t % 1_000_000_007)
    }
    fn established() -> usize {
        let out = std::process::Command::new("netstat").args(["-ano", "-p", "TCP"]).output().unwrap();
        let pid = std::process::id().to_string();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| l.contains(":443") && l.contains("ESTABLISHED") && l.trim_end().ends_with(&pid))
            .count()
    }
    /// `established` counts the WHOLE process's sockets, and a test that finished may still be closing
    /// one, so every socket assertion starts from a measured-quiet process instead of an assumed one.
    /// Returns how long the wait took; panics if the process never goes quiet (that is itself a leak).
    fn wait_quiet() -> Duration {
        let t0 = Instant::now();
        while established() > 0 {
            assert!(t0.elapsed() < Duration::from_secs(30), "the process never released its sockets: {} open", established());
            std::thread::sleep(Duration::from_millis(100));
        }
        t0.elapsed()
    }
    /// One request that the case needs to SUCCEED, with the live service's transients absorbed: MEASURED
    /// over repeated runs, roughly one request in thirty is refused or stalled by the service (that is the
    /// very behaviour the resilience work exists for — in the app the scheduler retries it). A transient
    /// there is not a defect in the behaviour under test, so it is retried up to three times and the
    /// attempt count is printed; three refusals in a row fail the test as a service outage.
    fn synth_ok(e: &TtsEngine, text: &str, budget: Option<u64>, what: &str) -> usize {
        let mut last = String::new();
        for attempt in 1..=3 {
            match synth(e, text, budget) {
                Ok(n) if n > 1_000 => {
                    if attempt > 1 {
                        eprintln!("{what}: succeeded on attempt {attempt} (service transient: {last})");
                    }
                    return n;
                }
                Ok(n) => last = format!("{n} bytes"),
                Err(e) => last = e,
            }
            std::thread::sleep(Duration::from_millis(700));
        }
        panic!("{what}: the live service refused three requests in a row ({last}) — service unavailable, not a code failure");
    }

    /// Open a warm connection before the case under test. The live service occasionally refuses or
    /// stalls a request (measured once in these runs), and a transient failure of the SETUP must not be
    /// reported as a failure of the behaviour being tested — so it is retried, and only a service that
    /// refuses three times in a row fails the test, with a message that says so.
    fn warm(e: &TtsEngine) {
        synth_ok(e, &nonce("warm up"), None, "warm-up");
    }
    #[test]
    fn the_idle_rule_replaces_only_a_client_past_the_ceiling() {
        let max = Some(Duration::from_millis(20_000));
        assert!(!edge_client_is_stale(Duration::from_millis(0), max), "a client just used is kept");
        assert!(!edge_client_is_stale(Duration::from_millis(19_999), max), "just inside the ceiling is kept");
        assert!(!edge_client_is_stale(Duration::from_millis(20_000), max), "exactly at the ceiling is kept");
        assert!(edge_client_is_stale(Duration::from_millis(20_001), max), "past the ceiling is replaced");
        assert!(edge_client_is_stale(Duration::from_secs(120), max), "long past it, certainly");
        // The measured band: every request up to 32.4 s idle succeeded, every one from 33.0 s failed. The
        // ceiling must sit below that cliff, or the rule would let the failing case through.
        assert!(EDGE_IDLE_MAX_MS < 33_000, "the ceiling must stay under the measured reset cliff");
    }

    #[test]
    fn the_idle_rule_can_be_switched_off_and_retuned() {
        assert!(!edge_client_is_stale(Duration::from_secs(600), None), "no ceiling: a client is never replaced for age");
        // The default, and what an override would have to look like, without touching the process env in a
        // test that runs beside others.
        assert_eq!(EDGE_IDLE_MAX_MS, 20_000);
        let ceiling = |ms: u64| (ms > 0).then(|| Duration::from_millis(ms));
        assert_eq!(Some(Duration::from_millis(25_000)), ceiling(25_000), "an override retunes the rule");
        assert_eq!(None, ceiling(0), "zero switches it off");
    }

    fn synth(e: &TtsEngine, text: &str, budget: Option<u64>) -> Result<usize, String> {
        use tauri::ipc::IpcResponse;
        // the app installs the provider at startup (lib.rs); the test binary has to do the same
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        edge_synthesize(e, VOICE.into(), text.into(), budget, None).map(|r| match r.body() {
            Ok(tauri::ipc::InvokeResponseBody::Raw(b)) => b.len(),
            _ => 0,
        })
    }

    #[test]
    #[ignore]
    fn completes_a_short_and_a_long_sentence_and_reuses_the_connection() {
        wait_quiet();
        let e = TtsEngine::default();
        let a = synth_ok(&e, &nonce("Nothing arrives until the request is written."), None, "the short sentence");
        let long = "The scheduler now keeps one request in flight and bounds it on progress rather than on a single total, so a slow but living stream is allowed to finish while a dead one is still reported within the window. ".repeat(4);
        let b = synth_ok(&e, &nonce(&long), None, "the long sentence");
        assert!(b > a, "the long sentence yields more audio than the short one");
        assert_eq!(established(), 1, "one warm connection");
        assert!(lock_recover(&e.first_audio_ms).len() >= 2);
    }

    #[test]
    #[ignore]
    fn a_cancel_before_first_audio_returns_within_a_slice_and_closes_the_socket() {
        wait_quiet();
        let e = TtsEngine::default();
        warm(&e);
        let e = std::sync::Arc::new(e);
        let e2 = e.clone();
        let long = nonce(&"A long sentence that takes the service a while to begin. ".repeat(30));
        let t0 = Instant::now();
        let h = std::thread::spawn(move || synth(&e2, &long, None));
        std::thread::sleep(Duration::from_millis(400)); // the request is written, audio not yet flowing
        assert!(cancel_current(&e), "a call was in flight");
        let r = h.join().unwrap();
        let took = t0.elapsed();
        assert_eq!(r.unwrap_err(), "edge synth cancelled");
        assert!(took < Duration::from_millis(1_500), "returned in {took:?}");
        // The worker drops the socket at the service's NEXT message, not at the cancel itself (the
        // crate gives no handle to close the socket from outside), so the close is bounded by the
        // service's first-message latency. Measure it rather than assume it.
        let t1 = Instant::now();
        while established() > 0 && t1.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("socket closed {:?} after the cancel", t1.elapsed());
        assert_eq!(established(), 0, "the cancelled call's socket is closed once the service answers");
        // the engine is idle: the next call reconnects and works
        synth_ok(&e, &nonce("after a cancel"), None, "the call after a cancel");
    }

    /// A cancel storm: every call is cancelled before its first audio, as rapid navigation on a slow
    /// service would do. Each abandoned worker keeps its socket until the service answers it, so the
    /// count of open sockets is the measure of what a storm can accumulate.
    #[test]
    #[ignore]
    fn a_cancel_storm_does_not_accumulate_sockets_without_bound() {
        wait_quiet();
        let e = std::sync::Arc::new(TtsEngine::default());
        let mut peak = 0;
        let t0 = Instant::now();
        for i in 0..12 {
            let e2 = e.clone();
            let long = nonce(&format!("Storm {i}. {}", "A sentence long enough to take a moment. ".repeat(20)));
            let h = std::thread::spawn(move || synth(&e2, &long, None));
            std::thread::sleep(Duration::from_millis(250));
            cancel_current(&e);
            let r = h.join().unwrap();
            assert!(r.is_err(), "call {i} was cancelled");
            peak = peak.max(established());
        }
        eprintln!("peak open sockets during the storm: {peak} ({} cancels in {:?})", 12, t0.elapsed());
        let t1 = Instant::now();
        while established() > 0 && t1.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(200));
        }
        eprintln!("all sockets closed {:?} after the storm", t1.elapsed());
        assert_eq!(established(), 0);
        // The engine must not be left broken. MEASURED: the service sometimes refuses the first request
        // after a storm of cancels (1 run in 4), which in the app is an ordinary failure the scheduler
        // retries — so what is asserted here is RECOVERY within a few attempts, and the count is printed.
        // The engine must not be left broken. MEASURED: the service sometimes refuses the first request
        // after a storm of cancels, which in the app is an ordinary failure the scheduler retries — so what
        // is asserted is RECOVERY within a few attempts.
        let n = synth_ok(&e, &nonce("after the storm"), None, "the call after the storm");
        eprintln!("the engine recovered after the storm ({n} bytes)");
    }

    #[test]
    #[ignore]
    fn a_cancel_after_audio_started_drops_the_socket_at_the_next_message() {
        wait_quiet();
        let e = std::sync::Arc::new(TtsEngine::default());
        let e2 = e.clone();
        let long = nonce(&"Audio is already flowing when the listener moves on. ".repeat(40));
        let h = std::thread::spawn(move || synth(&e2, &long, None));
        let t0 = Instant::now();
        while established() == 0 && t0.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(established(), 1, "exactly this call's socket is open");
        std::thread::sleep(Duration::from_millis(2_500));
        assert!(cancel_current(&e));
        let r = h.join().unwrap();
        assert_eq!(r.unwrap_err(), "edge synth cancelled");
        eprintln!("socket closed {:?} after the cancel", wait_quiet());
    }

    #[test]
    #[ignore]
    fn a_cancel_with_nothing_in_flight_is_a_no_op_and_the_next_call_is_not_affected() {
        let e = TtsEngine::default();
        assert!(!cancel_current(&e));
        synth_ok(&e, &nonce("untouched"), None, "the call after a no-op cancel");
        assert!(!cancel_current(&e), "a finished call retires its flag");
        synth_ok(&e, &nonce("still untouched"), None, "the second call after a no-op cancel");
    }

    #[test]
    #[ignore]
    fn stop_returns_promptly_while_a_call_is_in_flight() {
        wait_quiet();
        let e = std::sync::Arc::new(TtsEngine::default());
        let e2 = e.clone();
        let long = nonce(&"Stop must never wait behind synthesis. ".repeat(40));
        let h = std::thread::spawn(move || synth(&e2, &long, None));
        std::thread::sleep(Duration::from_millis(600));
        let t0 = Instant::now();
        cancel_current(&e);
        shutdown(&e);
        assert!(t0.elapsed() < Duration::from_millis(1_500), "stop took {:?}", t0.elapsed());
        assert!(h.join().unwrap().is_err());
        eprintln!("socket closed {:?} after Stop", wait_quiet());
    }

    #[test]
    #[ignore]
    fn a_waited_on_call_returns_inside_its_budget_even_when_the_service_is_slow() {
        let e = TtsEngine::default();
        let long = nonce(&"A recovery attempt carries the listener's remaining budget and returns inside it. ".repeat(40));
        let t0 = Instant::now();
        let r = synth(&e, &long, Some(3_000));
        let took = t0.elapsed();
        assert!(took <= Duration::from_millis(3_400), "took {took:?} for a 3 s budget: {r:?}");
    }

    #[test]
    #[ignore]
    fn a_first_audio_cap_bounds_the_silence_but_not_the_stream() {
        // A real recovery attempt as the scheduler now dispatches it: the remaining budget, and a cap on
        // the wait for the first byte. Whatever the service does, the two bounds must stay distinct: a
        // failure BY THE CAP is "no audio" at about the cap; a failure BY THE BUDGET is "over budget" at
        // about the budget — the cap never shortens a stream that has begun.
        use tauri::ipc::IpcResponse;
        let e = TtsEngine::default();
        warm(&e);
        let text = nonce(&"The cap bounds silence; a stream that has begun keeps its whole budget. ".repeat(6));
        let t0 = Instant::now();
        let r = edge_synthesize(&e, VOICE.into(), text.clone(), Some(12_000), Some(3_000));
        let took = t0.elapsed();
        match r {
            Ok(resp) => {
                let n = match resp.body() { Ok(tauri::ipc::InvokeResponseBody::Raw(b)) => b.len(), _ => 0 };
                assert!(n > 5_000, "audio for {} chars came back as {n} bytes", text.chars().count());
            }
            Err(err) if err.contains("stalled: no audio") => {
                assert!(took <= Duration::from_millis(3_600), "the cap declared silence after {took:?}, not at the cap");
            }
            Err(err) if err.contains("over budget") => {
                assert!(took >= Duration::from_millis(11_000), "'over budget' after only {took:?}: the cap cut a running stream");
            }
            Err(err) => panic!("unexpected failure: {err}"),
        }
        // and the cap never outlives the budget: a 12 s cap on a 3 s budget is a 3 s call
        let t1 = Instant::now();
        let _ = edge_synthesize(&e, VOICE.into(), nonce(&"x ".repeat(2_000)), Some(3_000), Some(12_000));
        assert!(t1.elapsed() <= Duration::from_millis(3_400), "took {:?} for a 3 s budget", t1.elapsed());
    }

    #[test]
    #[ignore]
    fn the_streaming_flag_rises_with_the_first_chunk_and_falls_when_the_call_ends() {
        // What `tts_synth_streaming` answers the scheduler: false before and after a call, true from the
        // first audio chunk until the call returns.
        use std::sync::atomic::Ordering;
        let e = std::sync::Arc::new(TtsEngine::default());
        warm(&e);
        assert!(!e.streaming.load(Ordering::SeqCst), "idle: not streaming");
        let long = nonce(&"A stream that has begun is left to finish; the flag says so while it runs. ".repeat(6));
        let e2 = e.clone();
        let worker = std::thread::spawn(move || edge_synthesize(&e2, VOICE.into(), long, None, None).is_ok());
        let t0 = Instant::now();
        let mut seen = false;
        while t0.elapsed() < Duration::from_secs(20) && !worker.is_finished() {
            if e.streaming.load(Ordering::SeqCst) { seen = true; }
            std::thread::sleep(Duration::from_millis(20));
        }
        let ok = worker.join().unwrap();
        assert!(ok, "the call itself failed");
        assert!(seen, "the flag never rose during a successful call");
        assert!(!e.streaming.load(Ordering::SeqCst), "the flag stayed up after the call returned");
    }

    #[test]
    #[ignore]
    fn an_empty_text_does_not_hang() {
        let e = TtsEngine::default();
        let t0 = Instant::now();
        let r = synth(&e, " ", Some(6_000));
        assert!(t0.elapsed() <= Duration::from_millis(6_500), "{r:?}");
    }

    #[test]
    #[ignore]
    fn the_cancel_flag_is_retired_after_every_outcome() {
        let e = TtsEngine::default();
        // a COLD engine with a 2 s budget: the voice-list fetch and the connect draw from it, so this is
        // the setup-phase early return that used to leave a stale flag behind
        let cold = synth(&e, &nonce("one"), Some(2_000));
        assert!(lock_recover(&e.cancel).is_none(), "retired after {cold:?}");
        // a warm engine, a long sentence, 1 s: the synthesis itself runs out of budget
        let short = synth(&e, &nonce(&"two ".repeat(200)), Some(1_000));
        assert!(lock_recover(&e.cancel).is_none(), "retired after {short:?}");
        // an unknown voice: the earliest early return there is
        let unknown = edge_synthesize(&e, "no-such-voice".into(), "text".into(), None, None);
        assert!(unknown.is_err());
        assert!(lock_recover(&e.cancel).is_none(), "retired after an unknown voice");
        // and a success
        warm(&e);
        assert!(lock_recover(&e.cancel).is_none(), "retired after a success");
    }
}
