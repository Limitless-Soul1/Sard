//! TTS engine — synthesis over the free Edge Read-Aloud neural voices. A warm WebSocket client is
//! kept per voice and reused across sentences; each synth returns MP3 bytes plus Edge's per-word
//! timing, which the frontend decodes and plays through WebAudio.

use std::net::TcpStream;
use std::sync::Mutex;

use msedge_tts::tts::client::{connect, MSEdgeTTSClient, SynthesizedAudio};
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

/// Managed state: the warm Edge WebSocket + the cached Edge voices.
#[derive(Default)]
pub struct TtsEngine {
    edge: Mutex<Option<EdgeRunning>>,       // one warm WS client per voice
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
#[tauri::command]
pub async fn tts_synthesize(
    engines: State<'_, TtsEngine>,
    engine: String,
    id: String,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    match engine.as_str() {
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
    let mut cache = lock_recover(&engines.edge_voices);
    if cache.is_none() {
        *cache = Some(load_edge_voices()?);
    }
    // RAWY-FINAL: `as_deref().unwrap_or(&[])` rather than `unwrap()`. The branch above makes `Some`
    // provable today, but a panic HERE happens while `edge_voices` is held and would poison it.
    let out = cache
        .as_deref()
        .unwrap_or(&[])
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

/// RAWY-257 (C8-lite): `connect()` bounded on a worker thread. It opens a TCP + TLS + WebSocket connection
/// with NO timeout of its own, and it was called while `engines.edge` was HELD — so on a black-holed route it
/// could pin the engine mutex for the OS connect timeout (tens of seconds), far past any ceiling the app
/// believed it had. Same worker + `recv_timeout` shape as `edge_synth_once`; an abandoned worker finishes on
/// its own and drops its socket. The socket LIFECYCLE is untouched (ENGINE CAUTION) — only the wait is bounded.
fn connect_bounded(budget: std::time::Duration) -> Result<MSEdgeTTSClient<TcpStream>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(connect().map_err(|e| format!("edge connect: {e:?}")));
    });
    match rx.recv_timeout(budget) {
        Ok(r) => r,
        Err(_) => Err("edge connect timed out".into()),
    }
}

/// RAWY-257 (C8-lite): the voice-list fetch, bounded the same way. It is a blocking HTTP call made INSIDE the
/// engine mutex on the voice-change path, and it was equally unbounded.
fn load_edge_voices_bounded(budget: std::time::Duration) -> Result<Vec<Voice>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(load_edge_voices());
    });
    match rx.recv_timeout(budget) {
        Ok(r) => r,
        Err(_) => Err("edge voices fetch timed out".into()),
    }
}

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
/// RAWY-257 (C1): `budget` is what is LEFT of the call's total deadline, not a fresh per-attempt ceiling.
fn edge_synth_once(mut running: EdgeRunning, text: &str, budget: std::time::Duration) -> EdgeSynth {
    let (tx, rx) = std::sync::mpsc::channel();
    let text = text.to_string();
    std::thread::spawn(move || {
        let res = running.client.synthesize(&text, &running.config);
        let _ = tx.send((running, res)); // if we already timed out, this send fails and drops the client
    });
    match rx.recv_timeout(budget) {
        Ok((running, Ok(audio))) => EdgeSynth::Ok(audio, running),
        Ok((running, Err(e))) => EdgeSynth::Failed(running, format!("{e:?}")),
        Err(_) => EdgeSynth::Stalled,
    }
}

/// Synthesize one sentence → MP3 bytes over the free Edge Read-Aloud WebSocket. Reuses a warm client
/// per voice; a dropped socket reconnects once. Online-required — an unreachable endpoint surfaces a
/// clear error, which the frontend surfaces as the explicit Edge-unavailable pause.
fn edge_synthesize(engines: &TtsEngine, id: String, text: String) -> Result<tauri::ipc::Response, String> {
    // RAWY-257 (C1): ONE deadline for the WHOLE call. Every bounded step below draws from what is left, so
    // the command cannot outlive the budget the frontend was told to expect — however many steps it takes.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(EDGE_SYNTH_TIMEOUT_SECS);
    let mut guard = lock_recover(&engines.edge);
    let need_new = guard.as_ref().map(|r| r.voice_id != id).unwrap_or(true);
    if need_new {
        // build the voice's config from the (cached) voice list, then open a warm connection
        let mut vcache = lock_recover(&engines.edge_voices);
        if vcache.is_none() {
            // RAWY-179: same merged list as the picker, so a fallback Arabic voice is synthesizable.
            *vcache = Some(load_edge_voices_bounded(remaining(deadline, "voices")?)?);
        }
        // RAWY-FINAL: no `unwrap()` — a panic here runs while BOTH `edge` and `edge_voices` are held
        // and would poison both, killing read-aloud for the rest of the process. An empty list falls
        // through to the existing "unknown edge voice" error, which the frontend already handles.
        let voice = vcache
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .find(|v| v.short_name.as_deref() == Some(id.as_str()))
            .ok_or_else(|| format!("unknown edge voice: {id}"))?;
        let mut config = SpeechConfig::from(voice);
        config.audio_format = "audio-24khz-48kbitrate-mono-mp3".to_string(); // force MP3 for WebAudio
        drop(vcache);
        let client = connect_bounded(remaining(deadline, "connect")?)?;
        *guard = Some(EdgeRunning { voice_id: id.clone(), config, client });
    }
    // RAWY-172 (AUD-2): bound the blocking synth with a timeout so a stalled socket can't hold this mutex
    // forever. We run synthesize on a worker thread and wait with a ceiling — still HOLDING the guard
    // across the wait, so callers serialize exactly as before (no second connection): the warm client is
    // moved out and put back. On a stall we surface an error and leave the slot empty (the abandoned client
    // drops when its synthesize finally returns), so the next call reconnects; the frontend's own timeout
    // (RAWY-172) has already advanced playback by then.
    // RAWY-FINAL: `let Some(..) else` rather than `.unwrap()`. The `need_new` branch above makes this
    // provably `Some` today, but this line runs while `engines.edge` is HELD — the one place a panic
    // would poison the read-aloud engine mutex permanently. The fallback is the existing connect
    // error string, which `classifyFailure` already maps to `ws-connect` and the 2B ladder retries.
    let Some(running) = guard.take() else {
        return Err("edge connect: no warm client".into());
    };
    let audio = match edge_synth_once(running, &text, remaining(deadline, "synth")?) {
        EdgeSynth::Ok(audio, running) => {
            *guard = Some(running);
            audio
        }
        EdgeSynth::Failed(_running, e) => {
            // RAWY-257 package 2B (C1 completion — the G-2A pre-declared handoff): the reconnect-and-retry
            // that lived here is REMOVED, so there is exactly ONE retry authority in the system — the JS
            // backoff ladder in `synthDispatch`. Two independent retry layers were what turned a single
            // refused connection into ~4 attempts inside ~50–200 ms with no delay between any of them.
            //
            // `_running` is deliberately DROPPED rather than stored: the socket that just failed is dead, and
            // leaving the slot empty is what makes the NEXT ladder attempt take the `need_new` branch and
            // open a FRESH connection. That is how "each retry forces a fresh connection" is honoured without
            // touching the socket lifecycle ENGINE CAUTION protects.
            return Err(format!("edge synth: {e}"));
        }
                // RAWY-266 (stage 1): DISTINCT from "edge synth timed out". That phrase now means the budget was
        // already gone before synthesis could start (voices/connect consumed it); THIS means synthesis
        // actually ran and did not finish inside its slice. Only this one carries RAWY-193s premise that
        // "the socket went quiet" - and RAWY-265 measured 0 hangs in 105 unbounded requests, so a first
        // occurrence is treated as slow-but-alive and retried once on a fresh socket. A stall that RECURS
        // on that fresh socket is what now counts as a genuine stall.
        EdgeSynth::Stalled => return Err("edge synth stalled".into()),
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
