// TTS playback (RAWY-105) — the frontend half of read-aloud. Rust synthesizes each sentence and
// returns raw audio bytes; here we decode them with WebAudio and play a QUEUE of sentences,
// synthesizing the NEXT while the current plays (hides synth latency). Controls: play/pause,
// skip ±sentence, speed.
//
// RAWY-110/111 (engine abstraction): a voice is {engine, id}; `synth` calls the dispatching
// `tts_synthesize(engine, id, text)`. Engine-agnostic — WebAudio decodes both Piper's WAV and Edge's
// MP3, so play/pause/skip/speed work the same. The chosen engine+voice persists PER LANGUAGE
// (`tts_voice:ar`/`tts_voice:en`), defaulting to EDGE (neural, design 6). Edge is online-required — RAWY-193:
// a synth failure is retried ONCE on Edge (a transient blip, invisible), then, if still failing, playback
// PAUSES in an explicit "Edge unavailable" state (Retry / Switch to Piper). The engine/voice NEVER changes on
// its own — the old silent per-sentence Edge→Piper fallback (D37/RAWY-113) was removed as a correctness bug.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { settingsGet, settingsSet, ttsDownloadVoice, ttsEdgeVoices, ttsStop, ttsVoicePresent } from "./ipc";
import { LatencySeries, newSeries, recordSeries, resetSeries, seriesSummary, SynthScheduler } from "./ttsScheduler";

export const TTS_MIN_SPEED = 0.75;
export const TTS_MAX_SPEED = 2.0;
export const TTS_SPEED_STEP = 0.25;
// Sentinel error the player localizes (RAWY-107) — distinct from a raw engine/download error, which
// the pill shows verbatim (RAWY-106). Set when a section genuinely has no readable text.
export const TTS_EMPTY = "empty-chapter";
// RAWY-193: sentinel meaning "Edge synthesis failed and the ONE bounded retry also failed." The player then
// enters the explicit "Edge unavailable" PAUSE state (Retry / Switch to Piper) — it NEVER silently swaps the
// voice to Piper (the deleted D37 anti-pattern). A synth stall (`tts.synthTimeout`) on Edge is treated the same.
export const TTS_EDGE_DOWN = "edge-unavailable";

// A voice is identified by its ENGINE + id (RAWY-110). "piper" = offline; "edge" = online neural.
export type TtsEngineKind = "piper" | "edge";
export interface TtsVoiceRef { engine: TtsEngineKind; id: string }
// The key a voice preference is stored under (`tts_voice:<lang>`). The TYPE is a string so it can carry
// any primary ISO code, but be clear about what actually happens today:
//
// RAWY-199 (correcting the RAWY-197 claim): Sard does NOT have per-language voice memory. Reader derives
// this value as `isRtlBook ? "ar" : "en"` (Reader.tsx), so there are exactly TWO slots — an RTL slot and
// an LTR slot — and nothing ever emits "fr"/"de"/"zh". Choosing a French voice for a French book saves it
// under `tts_voice:en` and it will then narrate EVERY LTR book. That is the honest behaviour; the picker
// still lists every language, so the choice itself is real.
//
// Real per-language memory would need a trustworthy language key, and `books.language` is NOT it: RAWY-189
// exists precisely because Arabic books routinely mis-declare themselves `en`, which is why direction (the
// corrected signal) is what Reader uses. Doing it properly means keying off the RAWY-189 script detection —
// a separate task (OPEN.md), not a type widening.
export type TtsLang = string;

// The bundled Piper voices — the OFFLINE anchor (the engine the user gets when they explicitly Switch
// to Piper from the Edge-unavailable state, RAWY-193). Only Arabic + English are bundled today, so
// Piper is offered only for those; for any other language there is no offline voice (Edge is the path).
export const PIPER_VOICE: Record<string, string> = {
  ar: "ar_JO-kareem-medium",
  en: "en_US-lessac-medium",
};
export const piperVoiceRef = (lang: TtsLang): TtsVoiceRef => ({ engine: "piper", id: PIPER_VOICE[lang] ?? PIPER_VOICE.en });

// RAWY-197: the PREFERRED unset-default Edge voice for every language. WilliamMultilingual speaks any
// language, so it is sane for every book. No badge, no label — it is simply pre-selected when nothing
// is saved, and an explicitly saved key always wins.
//
// RAWY-199: this is a PREFERENCE, not a guarantee. Microsoft's CDN serves region-varied voice lists
// (RAWY-179), so this id may be ABSENT for some users — and an absent id is not a harmless miss: the
// synth request fails, and RAWY-193 pauses read-aloud in the "Edge unavailable" state. That is a broken
// FIRST PLAY for a fresh install in such a region. RAWY-197 wrote `resolveEdgeDefault` to cover exactly
// this and then never called it (the constant was used directly), so the guard did not exist. Nothing
// may use this constant as a voice id without first checking it against the REAL list — go through
// `edgeUnsetDefault()` below.
export const EDGE_UNSET_DEFAULT = "en-AU-WilliamMultilingualNeural";

// Friendly display name for the player's VOICE CHIP (RAWY-112 — the design's labelled chip, not a
// bare icon). Piper: the two bundled names; Edge: the short_name's voice part ("ar-EG-SalmaNeural" → "Salma").
export function voiceLabel(engine: TtsEngineKind, id: string): string {
  if (engine === "piper") return id === PIPER_VOICE.ar ? "Kareem" : id === PIPER_VOICE.en ? "Lessac" : id;
  const tail = id.split("-").pop() ?? id; // "SalmaNeural"
  return tail.replace(/Neural$/, "") || id; // "Salma"
}

// A row in the voice picker (RAWY-111) — Piper (2, offline) + every Edge neural voice Microsoft returns.
// RAWY-197: `lang` is now the REAL primary ISO code parsed from the locale (was hard-cast to "ar"/"en"),
// and the Edge list is no longer filtered by the backend to ar-/en- — every language appears.
export interface PickerVoice { engine: TtsEngineKind; id: string; lang: TtsLang; locale: string; label: string; gender: string }
const PIPER_PICKER: PickerVoice[] = [
  { engine: "piper", id: PIPER_VOICE.ar, lang: "ar", locale: "ar", label: "Kareem", gender: "" },
  { engine: "piper", id: PIPER_VOICE.en, lang: "en", locale: "en", label: "Lessac", gender: "" },
];
let edgeVoicesCache: PickerVoice[] | null = null;
/** Piper (offline) + Edge (online neural) voices for the picker. Edge list is fetched once + cached;
 *  a failure (offline) yields Piper-only rather than throwing. RAWY-197: `lang` is the real primary code
 *  parsed from the locale (`fr-FR` → `fr`); a voice with no locale gets `lang=""` but is still listed. */
export async function loadPickerVoices(): Promise<PickerVoice[]> {
  if (!edgeVoicesCache) {
    try {
      const list = await ttsEdgeVoices();
      edgeVoicesCache = list.map((v) => {
        const loc = v.lang.toLowerCase();
        const primary = loc.includes("-") ? loc.split("-")[0] : loc; // "fr-fr" → "fr", "en" → "en"
        return {
          engine: "edge" as const,
          id: v.id,
          lang: primary,
          locale: v.lang,
          label: v.label,
          gender: v.gender,
        };
      });
    } catch {
      edgeVoicesCache = []; // offline / endpoint down → Piper-only picker
    }
  }
  return [...PIPER_PICKER, ...edgeVoicesCache];
}

// RAWY-197: the Edge voice to PRE-SELECT in the picker when no choice is saved — the unset default.
// Prefers the WilliamMultilingual id; if it is absent from THIS region's list (Microsoft's CDN varies
// by geography, RAWY-179), falls back to the first available Multilingual voice, else the first Edge
// voice. Returns null only when there is no Edge voice at all (offline → Piper-only picker).
export function resolveEdgeDefault(edgeVoices: PickerVoice[]): string | null {
  if (edgeVoices.length === 0) return null;
  const wm = edgeVoices.find((v) => v.id === EDGE_UNSET_DEFAULT);
  if (wm) return wm.id;
  const firstMulti = edgeVoices.find((v) => v.id.includes("Multilingual"));
  return (firstMulti ?? edgeVoices[0]).id;
}

/** RAWY-199: the Edge voice id to use when NOTHING is saved — resolved against the REAL, region-specific
 *  voice list, never the bare constant. This is the ONLY way an unset default may reach playback.
 *
 *  EMPTY LIST = OFFLINE. We then return the preferred id anyway and stay on Edge, so the synth fails and
 *  RAWY-193 raises the explicit "Edge unavailable" pause (Retry / Switch to Piper). We deliberately do NOT
 *  fall back to Piper here: an automatic engine change the user did not ask for is exactly the silent swap
 *  RAWY-193 removed. The only path to Piper is the user pressing it. */
export async function edgeUnsetDefault(): Promise<string> {
  const edge = (await loadPickerVoices()).filter((v) => v.engine === "edge");
  return resolveEdgeDefault(edge) ?? EDGE_UNSET_DEFAULT;
}

// Resolve the saved engine+voice for a language (persisted as "engine:id").
// A previously saved `tts_voice:<lang>` key is READ AND RESPECTED byte-identical — the value is parsed only
// by the `engine:id` shape, never reinterpreted by language. A saved key ALWAYS wins over the unset default.
//
// RAWY-199: the unset default now goes through `edgeUnsetDefault()`, which checks the id against the voices
// this region actually serves. Before, it returned the hard-coded id blind, so a fresh install in a region
// without WilliamMultilingual asked Edge for a voice that does not exist and read-aloud died on first Play.
//
// SCOPE (RAWY-199, honest): `lang` here is NOT a real book language — Reader passes `isRtlBook ? "ar" : "en"`,
// so there are exactly TWO slots. See the TtsLang note above.
async function resolveVoicePref(lang: TtsLang): Promise<TtsVoiceRef> {
  const saved = await settingsGet(`tts_voice:${lang}`).catch(() => null);
  if (saved) {
    const i = saved.indexOf(":");
    const engine = saved.slice(0, i);
    const id = saved.slice(i + 1);
    if ((engine === "piper" || engine === "edge") && id) return { engine, id };
  }
  return { engine: "edge", id: await edgeUnsetDefault() };
}

// RAWY-231 (invariant A/D): "buffering" is a VISIBLE mid-playback wait — playback moved to a sentence whose
// audio isn't ready yet (an underrun) or the chapter-start/seek "keep-one-ahead" lead is still synthesizing.
// It is transient (it resolves to "playing" the moment the audio is ready, or escalates to "edge-error" on a
// timeout), so it is never a silent gap. Distinct from "preparing" so skipping still works during a buffer.
type Status = "idle" | "preparing" | "downloading" | "playing" | "paused" | "error" | "chapter-end" | "edge-error" | "buffering";

// RAWY-231: `deferPrefetch` (RAWY-188) is REMOVED — it had no callers (the RAWY-227 resume-prompt removal
// left it dead), and the scheduler now prioritizes the current+lead sentence over look-ahead by construction,
// so the old "start only the first sentence" hack is obsolete.
interface StartOpts { sentences: string[]; lang: TtsLang; startIndex?: number; chapterLabel: string }

interface TtsState {
  active: boolean; // player pill visible
  status: Status;
  // RAWY-190: at "chapter-end" the pill/kashida offer a "next chapter" continue control. If the user
  // instead navigates the view off the finished chapter, that offer is stale — this hides it WITHOUT
  // stopping read-aloud, so the player (bead/transport) stays and a later Play reads the CURRENT chapter.
  endDismissed: boolean;
  engine: TtsEngineKind;
  voice: string; // voice id within the engine
  lang: TtsLang; // current book language (which voice pref applies)
  speed: number;
  volume: number; // RAWY-180: read-aloud output volume 0..1 (persisted as `tts_volume`)
  index: number; // current sentence
  total: number;
  words: TtsWord[]; // RAWY-127: the current sentence's Edge word timings ([] = sentence-level only)
  wordIndex: number; // RAWY-127: active word within `words` (-1 = none / no karaoke) — drives the pill
  progress: number; // voice-download fraction 0–1 (only meaningful while status === "downloading")
  chapterLabel: string;
  error: string | null;
  // RAWY-231 (invariant E, recurrence guard): LOCAL counters the owner can SEE (not just feel) — no
  // telemetry leaves the machine. `underruns` = times playback had to WAIT on synthesis (a stall);
  // `abandoned` = syntheses discarded because the cursor moved. Reset per session (on stop). Surfaced via
  // the pill's tiny debug readout when `localStorage.sardTtsDebug` is set, and via `window.__sardTtsStats()`.
  underruns: number;
  abandoned: number;
  // RAWY-247 (Part 3): a short human-readable summary of the LAST synth failure (unit length + classification
  // + non-audio bytes), so the owner's live Edge test surfaces WHY it failed. null = none this session.
  lastFailure: string | null;
  // RAWY-257 (Phase 1) / RAWY-255: is the read-aloud DIAGNOSTIC readout on? Mirrors `localStorage.sardTtsDebug`
  // so the pill re-renders the instant the setting is toggled. OPEN.md recorded the defect this closes: the
  // D62 instrument had NO in-app setter and DevTools is off in release, so the one tool built for this class
  // of bug could not be switched on by the owner at all — it was discovered at the worst possible moment,
  // during the first real read-aloud regression (RAWY-254). An instrument is part of the feature, not a note.
  debug: boolean;
  setDebug: (on: boolean) => void;
  // RAWY-257 2B (D68): which RETRY attempt is currently waiting/running (0 = not retrying). Playback is
  // already in `buffering` while it awaits the sentence; this turns that silence into visible progress, which
  // is the condition under which a longer wait is acceptable at all.
  retryAttempt: number;
  start: (o: StartOpts) => Promise<void>;
  toggle: () => void;
  dismissEnd: () => void; // RAWY-190: hide the stale chapter-end "next chapter" offer (keeps the player)
  skip: (delta: number) => void;
  setSpeed: (s: number) => void;
  setVolume: (v: number) => void; // RAWY-180 (Part A): read-aloud output volume 0..1 (persisted)
  setVoice: (engine: TtsEngineKind, id: string, lang: TtsLang) => void;
  setEngine: (engine: TtsEngineKind) => void;
  retry: () => void;
  resumeEdge: () => void; // RAWY-193: the "Edge unavailable" state's Retry — re-attempt Edge from the current sentence
  stop: () => void;
}

// RAWY-127 (word karaoke): per-word timing for one sentence. `offset`/`duration` are Azure's 100-ns
// ticks from the START of THIS sentence's audio (each sentence is its own buffer, so they're clean to
// schedule against playback). EDGE emits them; Piper emits an empty list → sentence-level only.
export interface TtsWord { text: string; offset: number; duration: number }
interface Synthesized { buffer: AudioBuffer; words: TtsWord[] }

// ---- imperative playback engine (WebAudio), kept outside the reactive store ----
let ctx: AudioContext | null = null;
let sentences: string[] = [];
let source: AudioBufferSourceNode | null = null;
// RAWY-180 (Part A): read-aloud VOLUME. Every sentence source connects through ONE shared GainNode
// before the destination, so the slider's 0..1 gain governs BOTH engines (Piper AND Edge) identically —
// they both play decoded buffers via the same `createBufferSource` path. Persisted as `tts_volume`.
let gainNode: GainNode | null = null;
let curVolume = 1; // 0..1, applied to the shared output gain (mirrors useTts.volume)
let volSaveTimer: ReturnType<typeof setTimeout> | null = null;
// RAWY-231: the per-sentence synth cache now lives INSIDE the SynthScheduler (see `scheduler` below), which
// serializes + prioritizes dispatch (current > next > look-ahead) and drops stale work on a cursor move.
let ttsUnderruns = 0; // RAWY-231 (E): times playback had to WAIT on synthesis this session (a stall)
let curEngine: TtsEngineKind = "piper";
let curVoice = "";
let gen = 0; // bumped by stop/skip/start to invalidate in-flight async work
let lastStart: StartOpts | null = null; // for retry() after a download/synth failure

// RAWY-185: DEBOUNCE synth during RAPID skipping. Each skip moves the index + sentence spotlight
// instantly (responsive), but the SYNTH for the landing sentence is deferred until skipping has been
// idle for `SKIP_SETTLE_MS`. Without this, every fly-by sentence kicked off a synth (+ its prefetch
// window) onto the serialized engine, so the LANDING sentence's synth only STARTED once that wasted
// backlog drained — a long wait to first audio after a fast skip (root: RAWY-183 made synth off-thread,
// so this is about WHEN the landing synth is queued, not a UI block). An ISOLATED (non-rapid) skip
// still synths IMMEDIATELY via the leading edge, so a single skip feels exactly as before.
const SKIP_SETTLE_MS = 220;
// RAWY-186 (Part B): two consecutive skips less than this apart are the SAME skipping session (one held
// arrow key, or fast repeated taps). This spans the OS key-REPEAT DELAY (~250–500 ms) between the first
// keydown and the auto-repeats — without it, that gap let the settle fire mid-hold, so each repeat burst
// re-fired the "leading" synth, piling wasted cold synths onto the serialized engine ahead of the
// landing. Now the leading synth fires ONCE per session; the rest only move the index until it settles.
const SKIP_CONTINUE_MS = 600;
let skipSettleTimer: ReturnType<typeof setTimeout> | null = null;
let skipLeadTarget = -1; // the index the leading (immediate) skip of the current session synthesized
let skipLastTarget = -1; // the most recent skip's target — moved ONLY by skip(), never by auto-advance
let lastSkipAt = 0; // performance.now() of the previous skip — detects a continuing skipping session
const clearSkipSettle = () => {
  if (skipSettleTimer) { clearTimeout(skipSettleTimer); skipSettleTimer = null; }
};

// RAWY-159 (crash-proof chain): the advance to the next sentence must never depend on a single
// segment behaving. A watchdog (polled on the AudioContext clock, so it FREEZES while paused) force-
// advances if a source's `onended` never fires; `failStreak` counts CONSECUTIVE unspeakable/failed
// segments so an isolated bad one is skipped silently while a genuine run of failures (e.g. offline +
// no Piper) still surfaces the retryable error.
let watchdog: ReturnType<typeof setInterval> | null = null;
let failStreak = 0;
const FAIL_LIMIT = 3; // consecutive failures that turn "skip the bad segment" into "surface a dead end"
// RAWY-172 (AUD-2): a synth that never resolves (a stalled Edge socket — Wi-Fi dropped without an RST, a
// captive portal, a sleeping router) must not freeze read-aloud. Every synth is raced against this ceiling;
// on timeout playback surfaces the explicit "Edge unavailable" pause (invariant D — fail loudly, never a
// silent gap). RAWY-231 lowered it 20 s → 9 s so a stall surfaces a CHOICE in ~8-9 s, not ~20 s of silence.
// BASIS: the worst live synth measured to date is ~2.7 s (a cold WS connect, RAWY-191); a normal synth is
// ~0.6 s; a 236-char sentence synthesised in 632 ms — so ~8-9 s keeps ~3× margin over the worst measured and
// never false-trips a slow-but-live link. PROVISIONAL: if the owner's Phase-0 slow-synth capture on his real
// network shows synths above ~5 s, RAISE this (a false timeout is a visible edge-error, not silence, so
// erring short is the safe direction). Coordinated with the Rust EDGE_SYNTH_TIMEOUT_SECS (8 s), which frees
// the engine mutex at its ceiling; this JS value is ~1 s longer so the specific Rust-reported reason wins.
const SYNTH_TIMEOUT_MS = 9000;
// RAWY-172 (AUD-1): how many already-played sentences to keep decoded (besides the current +
// prefetched-next), so a one-sentence skip-back stays instant while memory stays bounded.
const CACHE_KEEP_BEHIND = 1;
// RAWY-181 (BUG 3): how many UPCOMING sentences to synthesize ahead of need. RAWY-231: the GUARANTEE is a
// lead of exactly ONE sentence (invariant A); anything up to PREFETCH_AHEAD is OPTIONAL look-ahead the
// scheduler dispatches only after the current + lead, and drops on a cursor move. The scheduler's window
// keeps [idx-CACHE_KEEP_BEHIND … idx+PREFETCH_AHEAD] decoded (≈5 sentences) and evicts the rest, so memory
// stays bounded/O(1) regardless of chapter length (RAWY-172).
const PREFETCH_AHEAD = 3;
const clearWatchdog = () => {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
};

// RAWY-231: ONE tts_synthesize call for sentence `i` — the invoke plus the RAWY-193 single bounded retry for
// a stale/dropped warm Edge socket. A retry is only worth it for a FAST failure (a dropped socket errors in
// ~ms); a genuine STALL (the Rust side reported a timeout) is surfaced immediately rather than burning
// another synth window on it (that would only pile up silence — RAWY-191 lesson). The engine/voice is NEVER
// changed here (D37): a sustained failure rejects with TTS_EDGE_DOWN so playFrom raises the explicit
// "Edge unavailable" pause; a non-Edge (Piper) failure keeps its RAWY-159 skip behaviour.
// ---- RAWY-257 (Phase 1, item 4): the FAULT-INJECTION SEAM — DEV BUILDS ONLY ----
// LESSONS: "a concurrency/performance fix validated only on a FAST network is NOT validated", and (RAWY-205)
// "the harness must be proven to FAIL on the unfixed build before its pass means anything". Neither is
// possible while the only way to see a failure is to wait for the owner's network to misbehave. This seam
// makes each failure CLASS reproducible on demand.
//
// It sits at the `invoke` boundary ON PURPOSE, so BOTH the first attempt and RAWY-193's retry pass through
// it — that is what lets 2A/2B measure the C3 behaviour (~4 connect attempts inside ~200 ms) and later prove
// the backoff ladder actually waits.
//
// INERT unless explicitly armed, and `import.meta.env.DEV`-gated so a release build can never arm it.
// Phase 1 must not change playback behaviour: with no fault armed, `rawSynth` is exactly the old `invoke`.
// RAWY-257 2B: `permanent` is ADDED to the dev harness because G-2B requires proving that a permanent
// failure does NOT enter the backoff ladder, and no existing mode can produce one. Permitted under the
// freeze rule — it does not alter any behaviour G-P1 validated, and G-P1 is re-run to prove that.
type FaultMode = "off" | "fail-fast" | "stall" | "empty" | "truncated" | "permanent";
let fault: { mode: FaultMode; ms: number; times: number } = { mode: "off", ms: 0, times: 0 };
const faultArmed = (): boolean => import.meta.env.DEV && fault.mode !== "off" && fault.times > 0;

/** Build a framed `[u32 BE json_len][json][audio]` body (the RAWY-127 wire shape) with a chosen audio body,
 *  so an injected fault is indistinguishable downstream from a real Edge response of that shape. */
function framedFault(audio: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode("[]"); // no word timings, like Piper
  const out = new Uint8Array(4 + json.length + audio.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(audio, 4 + json.length);
  return out.buffer;
}

/** ONE `tts_synthesize` call, with the dev fault seam in front of it. Unarmed → a bare `invoke`. */
async function rawSynth(engine: TtsEngineKind, id: string, text: string): Promise<ArrayBuffer> {
  if (faultArmed()) {
    fault.times--;
    const mode = fault.mode;
    if (mode === "permanent") {
      // A 4xx — the class that cannot succeed on a later attempt (a retired voice, a rejected request).
      // `isPermanentFailure` matches the status code, so this must never enter the ladder.
      throw new Error("edge synth: HTTP 403 Forbidden (RAWY-257 fault)");
    }
    if (mode === "fail-fast") {
      // A REFUSED connection — returns in milliseconds. This is the C3 case: the RAWY-193 retry assumes the
      // reconnect is "itself the delay", which is false here, so both attempts burn inside one bad instant.
      throw new Error("edge connect: injected fail-fast (RAWY-257 fault)");
    }
    if (mode === "stall") {
      // ms <= 0 → never resolves (a hung socket). ms > 0 → SLOW BUT SUCCESSFUL: delay, then do the real call.
      // The graded form is what G-2A needs to show a timeout fires only above the ceiling.
      if (fault.ms <= 0) return await new Promise<ArrayBuffer>(() => {});
      await new Promise((r) => setTimeout(r, fault.ms));
    } else if (mode === "empty") {
      // An EMPTY audio payload (a framed response carrying zero audio bytes).
      // HONEST LIMIT — do not mis-cite this: this reaches the DECODE-FAILURE path (`decodeAudioData` rejects
      // on 0 bytes → D62 `decode/non-audio`), NOT the `synthd.buffer.length === 0` branch that RAWY-231
      // invariant D / C9 actually guards. That branch needs decode to SUCCEED and yield a 0-length buffer —
      // i.e. a valid MP3 container with no audio frames — which cannot be fabricated at this seam
      // (`createBuffer` rejects length 0, and injecting below decode would bypass the code under test).
      // Both paths feed the SAME policy decision in Phase 2B (provider junk ⇒ transient ⇒ ladder), so the
      // policy is exercised; the specific zero-length PREDICATE is not. If 2B's gate needs that predicate
      // covered, embed a real silent-MP3 fixture then — flagged now, not discovered at the gate.
      return framedFault(new Uint8Array(0));
    } else if (mode === "truncated") {
      // A short, non-decodable byte run beginning with a real MP3 sync word — what a throttled Edge endpoint
      // returns (OPEN.md: "SHORT / garbled audio with NO error"). Also reaches `decode/non-audio`, and D62
      // records the byte length + first-16-byte sniff for it, so the two modes are distinguishable in the
      // captured `lastFailure` string even though they share a branch.
      return framedFault(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]));
    }
  }
  return await invoke<ArrayBuffer>("tts_synthesize", { engine, id, text });
}

// RAWY-257 package 2B (C3): ONE attempt. The retry that used to live here is gone — it fired in the SAME
// TICK, and RAWY-193's commit states the premise verbatim: "NO backoff: the cold WS reconnect (~2.7 s,
// measured RAWY-191) is itself the delay." That premise is FALSE whenever the connection is REFUSED rather
// than slow: a refused connect returns in milliseconds, so this retry plus Rust's own internal one burned
// ~4 attempts inside ~50–200 ms against the same bad instant. Retry ownership now belongs solely to the
// ladder in `synthDispatch`.
async function synthInvoke(i: number): Promise<ArrayBuffer> {
  return await rawSynth(curEngine, curVoice, sentences[i]);
}

// RAWY-257 2B (C3/D68): the approved backoff ladder — one initial attempt, then a retry after each delay.
// THREE delays means FOUR dispatches at most; "3 attempts at 500/1500/4500" reads as three RETRY attempts,
// and it is the only reading under which all three delays are observable (a G-2B criterion measures them).
const RETRY_BACKOFF_MS = [500, 1500, 4500] as const;
/** How many RETRY attempts follow the initial one — the pill reads this so the indicator and the ladder can
 *  never disagree (the RAWY-206 "a dimension written twice desyncs" trap). */
export const TTS_MAX_RETRIES = RETRY_BACKOFF_MS.length;

// RAWY-257 2B (C3): a PERMANENT failure must never enter the ladder — retrying it only delays the dialog the
// user has to act on anyway. Deliberately NARROW: only failures that cannot succeed on a later attempt.
// A 5xx is NOT here (a server-side blip is exactly what the ladder is for).
const isPermanentFailure = (e: unknown): boolean => {
  const s = String(e);
  return s.includes("unknown edge voice") || /\b4\d\d\b/.test(s);
};

// RAWY-257 2B: a STALL is not retried either — RAWY-193 established that burning another synth window on a
// socket that already went quiet "would only pile up silence", and the ladder would turn one 9 s stall into
// ~40 s before the user is offered a choice. Preserving that invariant, not changing it.
const isStallFailure = (e: unknown): boolean => {
  const s = String(e);
  return s.includes("synthTimeout") || s.includes("timed out");
};

// RAWY-247: when `decodeAudioData` fails, this holds what we FAILED to decode (Defect C / §1.5), read by
// `noteFailure`. There is no per-message content-type on the Edge WebSocket, so the first bytes are the
// sniff: `3c` ("<") = HTML/XML error page, `7b` ("{") = JSON, `00 00` = empty/garbage, `49 44 33`/`ff fb` = MP3.
let pendingDecodeInfo: { bytes: number; head: string } | null = null;

// RAWY-231: the scheduler's dispatch — invoke (bounded so a stalled socket frees the single-flight slot) →
// parse the framed word timings → decode to an AudioBuffer. Engine-agnostic (WebAudio decodes Piper WAV +
// Edge MP3 alike). This is the ONLY thing the scheduler runs; ordering/priority/eviction are the scheduler's.
async function attemptSynth(i: number): Promise<Synthesized> {
  const raw = await withTimeout(synthInvoke(i), SYNTH_TIMEOUT_MS);
  const { words, audio } = parseFramed(raw);
  // RAWY-257 (Phase 1 — CONFIRMED DEFECT, found by the fault harness on its first real use):
  // `decodeAudioData` DETACHES the ArrayBuffer it is given. The RAWY-247 capture below used to read `audio`
  // INSIDE the catch — i.e. AFTER detachment — so it threw
  //   "TypeError: Cannot perform Construct on a detached ArrayBuffer"
  // and that TypeError REPLACED the real decode error. Consequences, all measured live:
  //   • D62 classified every decode failure as `other` instead of `decode/non-audio`;
  //   • the byte-length + first-16-byte sniff — the whole point of Part 3 — was NEVER captured;
  //   • the substituted TypeError does not match `isEdgeDown`, so the failure took the RAWY-159 skip path.
  // OPEN.md recorded this instrument as "UNVALIDATED in the field — the FIRST real synth failure is its
  // first real test." This was that test, and it failed. The fix is to sniff BEFORE decoding (a 16/24-byte
  // read per sentence — negligible, and far cheaper than copying the whole payload to keep it alive).
  const u8 = new Uint8Array(audio);
  const hex = [...u8.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = new TextDecoder("latin1").decode(u8.slice(0, 24)).replace(/[^\x20-\x7e]/g, ".");
  const sniff = { bytes: audio.byteLength, head: `${hex} "${ascii}"` };
  let buffer: AudioBuffer;
  try {
    buffer = await audioCtx().decodeAudioData(audio);
  } catch (e) {
    // RAWY-247 (Part 3): the byte length + first 16 bytes (hex + ASCII sniff) of the non-audio payload, so
    // the owner can read WHY a decode failed without devtools (Defect C / §1.5 / feeds RAWY-248).
    pendingDecodeInfo = sniff;
    throw e; // the ORIGINAL decode error now propagates, so `classifyFailure` sees the real thing
  }
  // RAWY-257 2B (C9 / D69): EMPTY or zero-length EDGE audio is raised HERE, inside the attempt, so the ladder
  // can retry it. RAWY-231 made it an immediate hard stop; `OPEN.md` documents that a throttled Edge endpoint
  // "returns SHORT / garbled audio with NO error", so that turned a RECURRING PROVIDER BEHAVIOUR into a
  // stopped chapter. Detection is KEPT — it is never silently skipped; it now reaches the same explicit pause
  // only after the ladder is exhausted.
  // PIPER IS UNTOUCHED: an empty Piper buffer is legitimate punctuation-only text, so it is returned as-is and
  // `playFrom` keeps its RAWY-159 skip for it.
  if (curEngine === "edge" && (!buffer || buffer.length === 0 || buffer.duration === 0)) {
    pendingDecodeInfo = sniff;
    throw new Error("empty-audio (0-length buffer)");
  }
  return { buffer, words };
}

// RAWY-257 2B (C3 + A1): THE ONE RETRY AUTHORITY. Rust's internal reconnect-and-retry is gone and
// `synthInvoke` no longer retries, so every retry decision is made exactly here.
//
// WHY THE LADDER LIVES INSIDE THE DISPATCH, not in `playFrom`: the scheduler is single-flight, and a ladder
// outside it would RELEASE the engine slot between attempts — other work would interleave and the retry
// would queue behind it. Keeping it here means the whole ladder is ONE logical dispatch, which also means
// this package does not touch the scheduler at all (that is package 2C's exclusive territory).
//
// A1: this ladder IS the Edge tolerance band the path never had. A RECOVERED fault never reaches a dialog;
// only EXHAUSTION does. `failStreak` (the Piper-side model) is left to `playFrom` exactly as it was.
async function synthDispatch(i: number): Promise<Synthesized> {
  pendingDecodeInfo = null; // don't let a recovered attempt's sniff be attributed to a later, different failure
  let lastErr: unknown = new Error("no attempt made");
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      // D68: the wait is VISIBLE. Playback is already showing `buffering` while it awaits this sentence;
      // the attempt number turns "the player is dead" into "the player is working". Without this the ladder
      // would just be a longer silence, which is the reason RAWY-231 shortened the timeout in the first place.
      useTts.setState({ retryAttempt: attempt });
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]));
    }
    try {
      const out = await attemptSynth(i);
      if (attempt > 0) useTts.setState({ retryAttempt: 0 });
      return out;
    } catch (e) {
      lastErr = e;
      if (curEngine !== "edge") break;      // Piper: unchanged, one attempt then RAWY-159 skip
      if (isPermanentFailure(e)) break;     // C3: a permanent failure must NOT enter the ladder
      if (isStallFailure(e)) break;         // RAWY-193 invariant: a stall is surfaced, never retried
    }
  }
  useTts.setState({ retryAttempt: 0 });
  // RAWY-193 unchanged: a sustained EDGE failure rejects with the sentinel so `playFrom` raises the explicit
  // "Edge unavailable" pause. The engine/voice is NEVER changed here (D37) — the only path to Piper remains
  // the user pressing it.
  if (curEngine === "edge") throw new Error(`${TTS_EDGE_DOWN}: ${lastErr}`);
  throw lastErr;
}

// The one serialized, priority-ordered, drop-on-move synth scheduler (invariants B + C live here).
const scheduler = new SynthScheduler<Synthesized>(synthDispatch, {
  behind: CACHE_KEEP_BEHIND,
  ahead: PREFETCH_AHEAD,
  onAbandon: () => useTts.setState({ abandoned: scheduler.abandoned }),
});

// RAWY-257 (Phase 1, item 3): AWAIT→SETTLE — how long PLAYBACK waited for a sentence. The scheduler owns the
// DISPATCH→SETTLE half; this is the other. `playFrom`'s SYNTH_TIMEOUT_MS is applied to THIS series, so
// (await − dispatch) is the queue wait that timeout wrongly charges to the network. That gap is C2, measured.
const awaitLatency: LatencySeries = newSeries();

// RAWY-257 (Phase 1, item 1 / RAWY-255): the diagnostic flag, mirrored in a module variable so the hot paths
// (`logStall`, `noteFailure`) never touch localStorage per event, and in the store so the pill re-renders the
// moment the setting is toggled. localStorage remains the SOURCE OF TRUTH (it survives a reload and is not a
// DB key — this is a diagnostic, not a reading preference, so it is deliberately NOT a `ReadingStyle` field).
let ttsDebugOn = false;
try {
  ttsDebugOn = typeof localStorage !== "undefined" && !!localStorage.getItem("sardTtsDebug");
} catch { /* localStorage may be unavailable */ }
// The promise playback awaits for sentence `i` (registers the want + kicks the scheduler's pump).
const synth = (i: number): Promise<Synthesized> => scheduler.request(i);

// RAWY-231 (E): mirror the recurrence counters into the store (for the pill's debug readout) and, when the
// owner has opted in via `localStorage.sardTtsDebug`, log each stall so he can SEE them, not only feel them.
const logStall = (kind: string, idx: number): void => {
  useTts.setState({ underruns: ttsUnderruns, abandoned: scheduler.abandoned });
  if (ttsDebugOn) {
    // eslint-disable-next-line no-console
    console.debug(`[sard/tts] ${kind} @${idx} · underruns=${ttsUnderruns} abandoned=${scheduler.abandoned}(${scheduler.abandonedEpoch} epoch) live=${scheduler.liveDispatches} queued=${scheduler.queueDepth} maxConc=${scheduler.maxConcurrent}`);
  }
};
// RAWY-247 (Part 3): the LAST synthesis failure, so the owner's live Edge test yields the measurement
// RAWY-235 could not capture. `kind` classifies WHICH failure; `len` is the failing unit's character count
// (a long unit → the RAWY-247 segmentation lead); decode failures also carry the payload's bytes/first-bytes.
let lastFail: { unit: number; len: number; kind: string; detail: string; bytes?: number; head?: string } | null = null;

// Classify an Edge/synth error into a readable failure kind (which timeout / WS / HTTP / non-audio / decode).
function classifyFailure(err: unknown): string {
  const s = String(err);
  if (s.includes("tts.synthTimeout")) return "timeout-js-9s";
  if (s.includes("timed out")) return "timeout-rust-8s";
  if (s.includes("EncodingError") || s.includes("decode")) return "decode/non-audio";
  if (s.includes("edge connect") || s.includes("edge reconnect")) return "ws-connect";
  if (/\b(4\d\d|5\d\d)\b/.test(s)) return "http-error";
  if (s.includes("edge synth")) return "ws-synth";
  if (s.includes(TTS_EDGE_DOWN)) return "edge-down";
  return "other";
}

// Record a synthesis failure into the debug surface (invariant E extended). Off by default; nothing leaves
// the device. The owner reads it from the pill's `sardTtsDebug` readout or `window.__sardTtsStats()`.
function noteFailure(unit: number, err: unknown): void {
  const kind = classifyFailure(err);
  const len = sentences[unit]?.length ?? -1;
  lastFail = { unit, len, kind, detail: String(err).slice(0, 140), ...(pendingDecodeInfo ?? {}) };
  pendingDecodeInfo = null;
  const summary = `len=${len} ${kind}${lastFail.bytes != null ? ` ${lastFail.bytes}B ${lastFail.head}` : ""}`;
  useTts.setState({ lastFailure: summary });
  if (ttsDebugOn) {
    // eslint-disable-next-line no-console
    console.debug(`[sard/tts] FAIL @${unit} ${summary} · ${lastFail.detail}`);
  }
}

// A dev/debug surface reachable from DevTools without shipping any UI (invariant E).
/** RAWY-257 (Phase 1): the single diagnostic snapshot. Exported so the PILL readout and the console surface
 *  (`window.__sardTtsStats`) read the SAME numbers — RAWY-197's scar was a guard that existed in prose but
 *  had no call site, so the instrument and the thing it describes must not be two separate implementations. */
export function ttsStats() {
  return {
    underruns: ttsUnderruns,
    abandoned: scheduler.abandoned,
    // RAWY-257 (C10): the epoch-abandoned SUBSET — non-zero is direct evidence of C4 (work dispatched, paid
    // for on the one serialized socket, then thrown away by clearCache).
    abandonedEpoch: scheduler.abandonedEpoch,
    inFlight: scheduler.inFlight,
    // RAWY-257 (Phase 1): D60 says single-flight, so `maxConcurrent` must never exceed 1. If it does, C4 is
    // confirmed in the field, not just by inspection.
    liveDispatches: scheduler.liveDispatches,
    maxConcurrent: scheduler.maxConcurrent,
    queueDepth: scheduler.queueDepth,
    cached: scheduler.size,
    priority: scheduler.priority,
    // RAWY-257 (Phase 1, item 3): the TWO series, kept apart. `dispatch` is the engine's real cost (the
    // distribution D70 needs before the 8 s/9 s ceiling stops being PROVISIONAL); `await` is what playback
    // waited, which is what SYNTH_TIMEOUT_MS is actually applied to. await.max ≫ dispatch.max = C2, measured.
    dispatchMs: seriesSummary(scheduler.dispatchLatency),
    awaitMs: seriesSummary(awaitLatency),
    lastFailure: lastFail,
    debug: ttsDebugOn,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __sardTtsStats?: () => unknown }).__sardTtsStats = ttsStats;
  // RAWY-257 (Phase 1, item 4): arm the fault seam — DEV ONLY, and only ever from a console.
  //   __sardTtsFault("fail-fast")            → next synth attempt fails instantly (the C3 case)
  //   __sardTtsFault("fail-fast", { times: 6 }) → six attempts fail (3 ladder rounds × first+retry)
  //   __sardTtsFault("stall", { ms: 6000 })  → slow BUT SUCCESSFUL: 6 s, then the real call (G-2A grading)
  //   __sardTtsFault("stall")                → never resolves (a hung socket)
  //   __sardTtsFault("empty") / ("truncated") → the C9 / decode-non-audio payloads
  //   __sardTtsFault("off")                  → disarm
  if (import.meta.env.DEV) {
    (window as unknown as { __sardTtsFault?: (m: FaultMode, o?: { ms?: number; times?: number }) => unknown }).__sardTtsFault = (m, o) => {
      fault = { mode: m, ms: o?.ms ?? 0, times: m === "off" ? 0 : (o?.times ?? 1) };
      return { ...fault };
    };
  }
}

const audioCtx = (): AudioContext => {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  return ctx;
};

// RAWY-180 (Part A): the shared output GainNode — every source connects HERE (not straight to the
// destination), so the volume applies to Piper + Edge alike. Recreated if the AudioContext was replaced.
const outputNode = (c: AudioContext): GainNode => {
  if (!gainNode || gainNode.context !== c) {
    gainNode = c.createGain();
    gainNode.gain.value = curVolume;
    gainNode.connect(c.destination);
  }
  return gainNode;
};

/** RAWY-180 (Part B): toggle read-aloud play/pause IF a session is active. Returns whether it acted, so
 *  the caller only swallows the key (preventDefault) when it actually toggled. */
export function toggleTtsPlayback(): boolean {
  const st = useTts.getState();
  if (st.active && (st.status === "playing" || st.status === "paused")) {
    st.toggle();
    return true;
  }
  return false;
}

/** RAWY-184 (Part C) / PART D: Right/Left arrow → skip to the next/previous SENTENCE (the ⏭/⏮ transport) IF
 *  a read-aloud session is active. The transport is a MEDIA control (it represents TIME, not reading
 *  direction), so it is NOT mirrored in RTL: Right = next / Left = previous in EVERY locale — matching the
 *  un-mirrored ⏭/⏮ buttons and the universal media convention (YouTube/Spotify seek). Returns whether it
 *  acted, so the caller preventDefault()s ONLY then; otherwise the arrows keep their normal reader behaviour
 *  (page-turn — which DOES mirror in RTL — / scroll) when TTS is off. */
export function skipSentenceForArrow(key: string): boolean {
  const st = useTts.getState();
  // RAWY-231: "buffering" is an active-playback state (a transient synth wait) — arrows must still skip out
  // of it, so it joins playing/paused here (skip() itself already permits it; only "preparing" blocks).
  if (!st.active || (st.status !== "playing" && st.status !== "paused" && st.status !== "buffering")) return false;
  const isRight = key === "ArrowRight";
  const isLeft = key === "ArrowLeft";
  if (!isRight && !isLeft) return false;
  st.skip(isRight ? 1 : -1); // Right = next (+1), Left = previous (-1) — media convention, NOT mirrored in RTL
  return true;
}

// RAWY-194 (A/B): a MOUSE click leaves the <button> focused, and a focused <button> then swallows Space (it
// activates ITSELF) and ignores arrow keys entirely — so a click silently CAPTURES the keyboard from the
// global transport handler until the user clicks the page. After a POINTER activation ONLY (`detail > 0`),
// release focus so the next Space/arrow reaches the transport handler on the FIRST press. A KEYBOARD
// activation (Enter/Space on a Tab-focused button → `detail === 0`) KEEPS focus, so Tab users never lose
// their place (accessibility). Wire on a container's `onClickCapture` so it fires even for buttons that
// stopPropagation (the kashida).
// RAWY-249: BROADENED from `closest("button")` to the full set of controls the global transport handler
// bails on — `button, [role="button"], a[href]` — because the leak recurred from THREE control kinds:
// RAWY-230 fixed `.rc-btns` <button>s only; the settings-drawer × button (also a <button>, but not under a
// covered container) and the search/annotation JUMP ROWS (which are `<span role="button" tabIndex=0>`, so
// `closest("button")` never matched them) both kept focus and killed SPACE/arrows. This helper is now wired
// ONCE at `.reader-root` (Reader.tsx), so every focusable "keys-swallower" in the reader is covered by one
// mechanism. Deliberately NOT released: INPUT/TEXTAREA/SELECT/[role="slider"]/[contenteditable] — the user
// needs their keys (typing, slider arrows), and the transport handler already skips those targets too.
export function releaseButtonFocusAfterPointerClick(e: { detail: number; target: EventTarget | null }): void {
  // `Element`, not `HTMLElement`: a click usually lands on the button's inner <svg>/<path> icon, which is an
  // SVGElement — an `instanceof HTMLElement` guard silently skipped the blur (caught live, RAWY-194 STEP 3).
  if (e.detail > 0 && e.target instanceof Element) {
    const el = e.target.closest("button, [role='button'], a[href]");
    if (el instanceof HTMLElement) el.blur();
  }
}

// RAWY-127: the Rust response is FRAMED — `[u32 BE json_len][json words][audio bytes]` — so the audio
// stays raw (no base64) while carrying its per-word timing. Split the header off; `words` is `[]` for
// Piper, which keeps that sentence at the Phase-1 sentence level.
function parseFramed(raw: ArrayBuffer): { words: TtsWord[]; audio: ArrayBuffer } {
  const dv = new DataView(raw);
  const jlen = dv.getUint32(0); // big-endian, matches Rust `to_be_bytes`
  const words: TtsWord[] = jlen ? JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, jlen))) : [];
  return { words, audio: raw.slice(4 + jlen) };
}

// RAWY-193: does this synth failure mean the Edge SERVICE is down (→ pause + prompt), vs a skippable bad
// segment? True for the bounded-retry sentinel, or a synth stall (the RAWY-172 timeout) — the caller gates
// this on `curEngine === "edge"`, so a Piper stall / an unspeakable Edge sentence still skips (RAWY-159).
const isEdgeDown = (e: unknown): boolean => {
  const s = String(e);
  return s.includes(TTS_EDGE_DOWN) || s.includes("synthTimeout");
};

// ---- RAWY-127: word-level karaoke scheduling (Edge only) ----
// A requestAnimationFrame loop maps the AudioContext clock → the active word so the solid pill tracks
// the spoken word. Pause is FREE (a suspended context freezes `currentTime`, so the loop just recomputes
// the same word); a speed change re-anchors so the mapped audio-time stays continuous; skip/stop cancels.
let karaokeRaf = 0;
let karaokeWords: TtsWord[] = [];
let karaokeLastIdx = -2;
// audio-time anchor: at wall-clock `wall` (ctx.currentTime) this sentence had played `audio` seconds at `rate`.
let karaokeAnchor = { wall: 0, audio: 0, rate: 1 };

function stopKaraoke() {
  if (karaokeRaf) { cancelAnimationFrame(karaokeRaf); karaokeRaf = 0; }
  karaokeWords = [];
  karaokeLastIdx = -2;
}

// Schedule (or clear) the pill for the sentence that just started playing at ctx time `t0`.
function startKaraoke(words: TtsWord[], t0: number, myGen: number) {
  stopKaraoke();
  useTts.setState({ words, wordIndex: -1 });
  if (!words.length) return; // Piper / no timing → sentence-level only (no pill)
  karaokeWords = words;
  karaokeAnchor = { wall: t0, audio: 0, rate: useTts.getState().speed };
  const c = audioCtx();
  const tick = () => {
    if (myGen !== gen || !useTts.getState().active) { karaokeRaf = 0; return; }
    const audioTime = karaokeAnchor.audio + (c.currentTime - karaokeAnchor.wall) * karaokeAnchor.rate;
    let k = -1;
    for (let j = 0; j < karaokeWords.length; j++) {
      if (karaokeWords[j].offset / 1e7 <= audioTime) k = j; // 100-ns ticks → seconds; offsets ascend
      else break;
    }
    if (k !== karaokeLastIdx) { karaokeLastIdx = k; useTts.setState({ wordIndex: k }); }
    karaokeRaf = requestAnimationFrame(tick);
  };
  karaokeRaf = requestAnimationFrame(tick);
}

// Re-anchor on a speed change: playbackRate scales wall-clock, so freeze the audio-time reached so far
// and continue at the new rate (otherwise the pill would jump).
function reanchorKaraoke(newRate: number) {
  if (!karaokeWords.length) return;
  const c = audioCtx();
  karaokeAnchor.audio += (c.currentTime - karaokeAnchor.wall) * karaokeAnchor.rate;
  karaokeAnchor.wall = c.currentTime;
  karaokeAnchor.rate = newRate;
}

const stopSource = () => {
  clearWatchdog(); // RAWY-159: a new/stopped source must not leave a stale advance timer running
  if (source) {
    try {
      source.onended = null;
      source.stop();
    } catch {
      /* already stopped */
    }
    source = null;
  }
};

// RAWY-172 (AUD-1) / RAWY-231: bounded memory is now the scheduler's job — `reprioritize(idx)` trims the
// decoded-audio cache to the window [idx-CACHE_KEEP_BEHIND … idx+PREFETCH_AHEAD] on every advance/seek
// (~5 buffers), so a decoded sentence's ~0.19 MB/s of PCM can't accumulate the ~650 MB/hour it once did. A
// skip-back below the window simply re-synthesizes (a cache miss re-requests), so nothing depends on
// retaining old buffers.

// RAWY-172 (AUD-2): resolve `p`, or reject after `ms` if it stalls — so a never-resolving synth can't
// hang the queue. Engine-agnostic (covers Piper + Edge). The scheduler drops a rejected index from its
// cache so a later revisit re-synthesizes cleanly.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("tts.synthTimeout")), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

// RAWY-231: optional LOOK-AHEAD beyond the one-sentence lead. The scheduler dispatches these only AFTER the
// current + lead sentence and drops them on a cursor move, so requesting the whole window is safe — nothing
// here can occupy the engine ahead of the sentence the user is waiting for (invariant B).
function prefetchFrom(idx: number): void {
  for (let k = 1; k <= PREFETCH_AHEAD; k++) {
    const j = idx + k;
    if (j >= 0 && j < sentences.length) void synth(j).catch(() => {});
  }
}

// RAWY-231: `establishLead` = this is an ENTRY into playback (a chapter start, a seek/skip LANDING, a
// voice/engine switch, an Edge retry) — do NOT begin until the current sentence AND its one-ahead lead are
// both ready (invariant A), so the second sentence never underruns. A NORMAL advance (onended → next) passes
// false: the lead was already maintained while the previous sentence played, so we don't re-wait — but if it
// underran anyway we show a visible buffering state and count it (invariant E), never a silent gap.
async function playFrom(i: number, myGen: number, establishLead = false) {
  const set = useTts.setState;
  if (i >= sentences.length) {
    // RAWY-184 (Part B): reached the LAST sentence — STOP and enter the "chapter-end" state (the owner
    // chose a "next chapter" button over auto-advance). The pill then offers Next chapter (if one exists)
    // or a gentle end-of-book state; playing/paused-gated shortcuts (Space, arrows) no-op here.
    set({ status: "chapter-end", endDismissed: false, index: Math.max(0, sentences.length - 1) });
    return;
  }
  const idx = Math.max(0, i);
  // RAWY-231: re-point the scheduler at this sentence NOW — it becomes top priority and stale look-ahead for
  // the old position is dropped (and the decoded-audio cache is trimmed to the window). So the CURRENT
  // sentence is the engine's next work, never stuck behind speculative look-ahead (invariants B + C).
  scheduler.reprioritize(idx);
  const current = synth(idx);                                       // top priority
  const lead = idx + 1 < sentences.length ? synth(idx + 1) : null;  // the one-ahead lead (invariant A)
  prefetchFrom(idx);                                                // optional deeper look-ahead (yields)

  // RAWY-231 (invariant A/E): if the current sentence isn't decoded yet, playback must WAIT. On a NORMAL
  // advance that is an UNDERRUN (the lead failed to keep up) — count it + log it. On an ENTRY it's the
  // expected initial synth, not an underrun. Either way, show a VISIBLE buffering state, never silence.
  const ready = scheduler.isReady(idx);
  set({ index: idx, status: ready ? "playing" : "buffering" });
  if (!ready && !establishLead) { ttsUnderruns++; logStall("underrun", idx); }

  // RAWY-159: skip the current sentence and continue — one bad segment must NEVER halt the queue. A
  // genuine dead end (a RUN of FAIL_LIMIT consecutive failures, e.g. offline + no Piper) still surfaces
  // the retryable error instead of silently racing to the end.
  const skipSegment = (deadEndError: string): void => {
    if (myGen !== gen) return;
    if (++failStreak >= FAIL_LIMIT) { set({ status: "error", error: deadEndError }); return; }
    void playFrom(idx + 1, myGen);
  };

  let synthd: Synthesized;
  // RAWY-257 (Phase 1, item 3): start the AWAIT clock HERE — the same instant `SYNTH_TIMEOUT_MS` below starts
  // counting. Because the scheduler is single-flight, `current` may not have been DISPATCHED yet, so this
  // interval can contain pure queue wait. Comparing it against the scheduler's dispatch series is the
  // measurement that decides C2. Phase 1 only MEASURES; it changes nothing about the timeout.
  const tAwait = performance.now();
  try {
    // RAWY-172 (AUD-2): bound the synth so a stalled socket can't freeze the queue. RAWY-193: on Edge a
    // failure/stall is NOT skipped — the catch routes it to the explicit "Edge unavailable" pause (isEdgeDown);
    // a non-Edge (Piper) failure still skips per RAWY-159.
    // RAWY-257 package 2A (C2 — THE FIX): this await is NO LONGER wrapped in a timeout.
    //
    // It used to be `withTimeout(current, SYNTH_TIMEOUT_MS)`, which timed the WRONG OPERATION. Because the
    // RAWY-231 scheduler is SINGLE-FLIGHT, a requested sentence can sit UNDISPATCHED behind another synth,
    // so this interval is QUEUE WAIT + synthesis — and the rejection it produced (`tts.synthTimeout`) is
    // matched by `isEdgeDown`, so pure queue congestion surfaced as "Edge unavailable" ON A HEALTHY NETWORK.
    // A timeout could therefore fire BEFORE generation had even started. Pre-RAWY-231 there was ONE 20 s
    // timer and NO queue, so it measured synthesis alone; the queue and the halved budget arrived in the same
    // commit and the semantic change went unnoticed.
    //
    // The network is still bounded — `synthDispatch` wraps the actual `invoke` in `withTimeout` starting at
    // DISPATCH, which is the only place that can measure the engine honestly. A genuinely hung socket still
    // rejects with `tts.synthTimeout` from there and still reaches the RAWY-193 pause below, so no failure
    // mode is lost; only the false ones are. If the entry is dropped from the scheduler's window while we
    // await it, this promise simply never settles — correct, because a NEWER `playFrom` owns playback by then
    // (and the unreferenced pending promise is collectible). Removing the orphan case entirely is A3 / 4A.
    synthd = await current;
    recordSeries(awaitLatency, performance.now() - tAwait);
  } catch (e) {
    recordSeries(awaitLatency, performance.now() - tAwait); // a failed wait is still a wait — measure it
    if (myGen !== gen) return; // superseded — the scheduler already dropped the rejected index
    // RAWY-193: an Edge-SERVICE failure (the bounded retry failed) or an Edge stall must NOT silently skip
    // or swap the voice — PAUSE and surface the explicit "Edge unavailable" choice (Retry / Switch to Piper),
    // visible in EVERY pill state (the player force-expands out of the kashida on this status). A non-Edge
    // failure (unspeakable "…"/"..." that yields empty audio, a Piper exit with no WAV) keeps RAWY-159 skip.
    if (curEngine === "edge" && isEdgeDown(e)) {
      noteFailure(idx, e); // RAWY-247: record the failing unit's length + classification for the owner
      stopSource();
      set({ status: "edge-error" });
      return;
    }
    noteFailure(idx, e); // RAWY-247: also capture a decode/non-audio failure (Defect C / §1.5) before skipping
    skipSegment(String(e));
    return;
  }
  if (myGen !== gen) return; // superseded by stop/skip
  // RAWY-231 (invariant D): empty/zero-length audio. On EDGE this is the throttled-TRUNCATION symptom
  // (§ open defect) — a REAL failure, so surface the explicit "Edge unavailable" pause rather than skipping
  // it silently. On Piper an empty buffer is legitimate punctuation-only text, so keep the RAWY-159 skip.
  if (!synthd.buffer || synthd.buffer.length === 0 || synthd.buffer.duration === 0) {
    if (curEngine === "edge") { noteFailure(idx, new Error("empty-audio (0-length buffer)")); stopSource(); logStall("empty-edge", idx); set({ status: "edge-error" }); return; }
    skipSegment(TTS_EMPTY);
    return;
  }
  failStreak = 0; // a real, speakable sentence played → reset the dead-end counter

  // RAWY-231 (invariant A, ENTRY): don't BEGIN until the one-ahead lead is also ready, so the very next
  // sentence can't underrun. Best-effort + bounded — a slow/failed lead must not hang the start (it surfaces
  // on its own turn); only entries wait (a normal advance already had the lead maintained).
  if (establishLead && lead && !scheduler.isReady(idx + 1)) {
    if (myGen === gen) set({ status: "buffering" });
    try { await withTimeout(lead, SYNTH_TIMEOUT_MS); } catch { /* surfaces when playback reaches it */ }
    if (myGen !== gen) return;
  }
  // RAWY-257 3B (C6 — blocker 2): the user may have PAUSED while this sentence was buffering. Two things
  // must then NOT happen here: the status must not be forced back to "playing", and the context must not be
  // resumed — either one silently cancels the pause that was just granted. This blocker is INVISIBLE before
  // the fix, because Reader's gate stopped the pause from ever registering; fixing only one of the two
  // produces an incomplete repair.
  //
  // The sentence is still armed below against the SUSPENDED context: `start()` schedules it at the frozen
  // `currentTime`, so it makes no sound until the user resumes — which is exactly how the pre-existing
  // pause/resume already behaves. Synthesis and the 2B retry ladder are untouched by any of this and keep
  // running while paused; only the START of audio is withheld.
  const pausedByUser = useTts.getState().status === "paused";
  if (myGen === gen && !pausedByUser) set({ status: "playing" });

  const c = audioCtx();
  if (pausedByUser) {
    // `toggle()` fires `suspend()` WITHOUT awaiting it, so the context can still be running for a moment
    // after the pause is granted. Awaiting it here guarantees the source armed below cannot be audible.
    if (c.state !== "suspended") await c.suspend();
  } else if (c.state === "suspended") {
    await c.resume();
  }
  if (myGen !== gen) return;
  stopSource();
  const s = c.createBufferSource();
  s.buffer = synthd.buffer;
  s.playbackRate.value = useTts.getState().speed;
  s.connect(outputNode(c)); // RAWY-180: through the shared volume gain (both engines)
  // RAWY-159: advance exactly ONCE, whether the source ends normally OR the watchdog fires. The
  // watchdog is the safety net for a source whose `onended` never arrives (an edge-case empty/stuck
  // buffer) — it advances only after the audio COULD have finished even at the slowest speed, and it
  // polls the AudioContext clock (which freezes while paused), so a long pause never trips it.
  let advanced = false;
  const advance = () => {
    if (advanced || myGen !== gen) return;
    advanced = true;
    clearWatchdog();
    void playFrom(idx + 1, myGen);
  };
  s.onended = advance;
  source = s;
  s.start();
  const startedAt = c.currentTime;
  const maxCtxSeconds = synthd.buffer.duration / TTS_MIN_SPEED + 2; // slowest-case play time + margin
  clearWatchdog();
  watchdog = setInterval(() => {
    if (myGen !== gen) { clearWatchdog(); return; }
    if (c.currentTime - startedAt > maxCtxSeconds) advance();
  }, 500);
  // RAWY-127: schedule the karaoke pill against this buffer's clock (empty words → sentence-level only).
  startKaraoke(synthd.words, c.currentTime, myGen);
}

// Ensure the chosen voice is usable, then play from `fromIndex`. Only PIPER voices fetch on demand
// (~60 MB) with a REAL progress bar (RAWY-106); Edge synthesizes over the network with no local
// model, so it skips straight to playback. Shared by start / setVoice / resumeEdge (RAWY-193).
async function ensureAndPlay(engine: TtsEngineKind, voice: string, fromIndex: number, myGen: number) {
  const set = useTts.setState;
  if (engine === "piper") {
    try {
      if (!(await ttsVoicePresent(voice))) {
        set({ status: "downloading", progress: 0 });
        await ttsDownloadVoice(voice, (frac) => {
          if (myGen === gen) set({ progress: frac });
        });
        if (myGen !== gen) return; // stopped mid-download
        set({ status: "preparing" });
      }
    } catch (e) {
      if (myGen === gen) set({ status: "error", error: `${e}` });
      return;
    }
  }
  if (myGen !== gen) return;
  // RAWY-231: an ENTRY into playback — establish the one-ahead lead before beginning (invariant A), so the
  // second sentence of a chapter/landing never underruns.
  void playFrom(fromIndex, myGen, true);
}

export const useTts = create<TtsState>((set, get) => ({
  active: false,
  status: "idle",
  endDismissed: false,
  engine: "piper",
  voice: "",
  lang: "en",
  speed: 1,
  volume: 1, // RAWY-180: full volume until the user lowers it (or a saved level loads on start)
  index: 0,
  total: 0,
  words: [],
  wordIndex: -1,
  progress: 0,
  chapterLabel: "",
  error: null,
  underruns: 0,
  abandoned: 0,
  lastFailure: null,
  debug: ttsDebugOn,
  retryAttempt: 0,

  // RAWY-257 (Phase 1) / RAWY-255: the in-app setter the D62 diagnostic never had. Writes localStorage (the
  // source of truth, survives a reload), the module mirror (so the hot paths don't re-read it per event), and
  // the store (so the pill readout appears/disappears immediately). Purely additive — it cannot affect playback.
  setDebug: (on) => {
    ttsDebugOn = on;
    try {
      if (typeof localStorage !== "undefined") {
        if (on) localStorage.setItem("sardTtsDebug", "1");
        else localStorage.removeItem("sardTtsDebug");
      }
    } catch { /* localStorage may be unavailable */ }
    set({ debug: on });
  },

  start: async (opts) => {
    lastStart = opts;
    const { sentences: sen, lang, startIndex = 0, chapterLabel } = opts;
    audioCtx(); // create within the user gesture so autoplay policy unlocks it
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127
    clearSkipSettle(); // RAWY-185: a fresh Listen cancels any pending rapid-skip landing synth
    skipLeadTarget = -1;
    skipLastTarget = -1;
    lastSkipAt = 0; // RAWY-186: the first skip of a new session must lead (not read as a continuation)
    scheduler.clearCache(); // RAWY-231: fresh chapter — drop cached audio (keeps the session's E counters)
    failStreak = 0; // RAWY-159: a fresh Listen starts the dead-end counter clean
    // RAWY-257 package 3A (C5): capture the units in a LOCAL. `sentences` is module state that `stop()`
    // empties, so reading it back after the awaits below is reading whatever the LAST caller left there —
    // which is how closing the player mid-preparation produced a false "empty chapter".
    const units = sen.map((s) => s.trim()).filter(Boolean);
    sentences = units;
    const saved = Number(await settingsGet("tts_speed").catch(() => null));
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? saved : get().speed;
    // RAWY-180: restore the saved volume (0..1). An UNSET key must not read as 0 (muted), so treat only
    // an in-range stored value as valid; otherwise keep the current (default full) level.
    const volStr = await settingsGet("tts_volume").catch(() => null);
    const volNum = volStr == null ? NaN : Number(volStr);
    const volume = volNum >= 0 && volNum <= 1 ? volNum : get().volume;
    curVolume = volume;
    if (gainNode) gainNode.gain.value = volume;
    // RAWY-257 3A (C5 — THE FIX): the FIRST generation check now precedes the first `set`. It used to sit
    // three awaits later, after this `set` had already run, so pressing ✕ during preparation was UNDONE by
    // the very call the user had just cancelled: `stop()` set `active: false` and emptied `sentences`, then
    // `start()` resumed, re-asserted `active: true`, read the emptied array and reported the chapter as
    // EMPTY. The pill the reader had just closed came back claiming a chapter full of text had none.
    // Reachable because the pill and its ✕ are rendered by the Reader BEFORE `start()` is called, so the
    // control is live for the whole (chunked, multi-second) chapter walk.
    if (myGen !== gen) return; // superseded by stop()/another start() — do not resurrect the player
    set({ active: true, status: "preparing", endDismissed: false, lang, speed, volume, index: startIndex, total: units.length, progress: 0, chapterLabel, error: null, words: [], wordIndex: -1 });
    if (units.length === 0) {
      set({ status: "error", error: TTS_EMPTY });
      return;
    }
    // Resolve the saved engine+voice for this language (default = Piper) inside the gesture chain.
    const { engine, id } = await resolveVoicePref(lang);
    if (myGen !== gen) return;
    curEngine = engine;
    curVoice = id;
    set({ engine, voice: id });
    void ensureAndPlay(engine, id, Math.min(startIndex, units.length - 1), myGen);
  },

  toggle: () => {
    const st = get();
    if (!st.active) return;
    // RAWY-257 3B (C6): `buffering` is pausable. It is an ACTIVE playback state — playback is waiting on a
    // synth (an underrun, an entry, or since 2B a retry backoff) — so refusing the pause left the user with
    // a live-looking transport that ignored them and then started speaking. Suspending the context here is
    // also what makes the suppression in `playFrom` safe: the pending sentence is armed against an already
    // suspended context and cannot make a sound until the user resumes.
    if (st.status === "playing" || st.status === "buffering") {
      void audioCtx().suspend();
      set({ status: "paused" });
    } else if (st.status === "paused") {
      void audioCtx().resume();
      set({ status: "playing" });
    }
  },

  // RAWY-190: the view moved off the finished chapter, so the "next chapter" offer is stale. Hide it but
  // KEEP the player active (status stays "chapter-end", so Play still reads the CURRENT chapter via
  // playOrRelisten) — a full stop() would remove the bead and leave no way to play from the kashida.
  dismissEnd: () => {
    if (get().status === "chapter-end" && !get().endDismissed) set({ endDismissed: true });
  },

  skip: (delta) => {
    const st = get();
    // RAWY-257 3A (SM1): `error` and `edge-error` are DEAD ENDS — they are exited by their own explicit
    // controls (Retry / Switch to Piper), never by a transport move. The guard used to block only
    // "preparing", so a skip from either state would have written `status: "playing"` and resurrected
    // playback from a state the user has not resolved.
    // HONEST NOTE (measured, not assumed): this is currently UNREACHABLE — the two ⏭/⏮ buttons are
    // `disabled={busy || errored}`, the transport is not rendered at all at `edge-error`, and both arrow-key
    // paths go through `skipSentenceForArrow`, which admits only playing/paused/buffering. Those three are
    // the complete set of callers. This closes the hole at the STORE, where the invariant belongs, so a
    // future control cannot reopen it — it is not fixing a live symptom.
    if (!st.active || st.status === "preparing" || st.status === "error" || st.status === "edge-error") return;
    const target = Math.max(0, Math.min(sentences.length - 1, st.index + delta));
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127: drop the old sentence's pill; playFrom restarts karaoke for the new one
    failStreak = 0; // RAWY-159: a user skip is a fresh attempt — don't count it toward a dead end
    // RAWY-231: re-point the scheduler at the landing IMMEDIATELY (invariants B + C). This drops stale
    // look-ahead for the old position and makes the landing the engine's next work, so a fast skip never
    // wastes synths on flown-past sentences and the landing waits behind at most the one in-flight synth.
    scheduler.reprioritize(target);
    // Move the index + sentence spotlight INSTANTLY (the RAWY-126/127 reader effects follow `index`), so
    // rapid skipping tracks on screen even though the landing sentence's audio is deferred below.
    set({ wordIndex: -1, index: target, status: "playing" });

    // RAWY-185/186: debounce the audio SOURCE. Only the FIRST skip of a skipping session plays immediately
    // (the leading edge → a single skip is instant); every skip within SKIP_CONTINUE_MS of the previous is
    // a CONTINUATION (a held arrow key or fast repeats — this spans the OS key-repeat DELAY, so a hold plays
    // the leading ONCE, not once per repeat burst) and only moves the index + priority. When skipping
    // settles, the LANDING plays once, establishing its one-ahead lead first (invariant A).
    skipLastTarget = target;
    const now = performance.now();
    const continuing = now - lastSkipAt < SKIP_CONTINUE_MS;
    lastSkipAt = now;
    if (!continuing) {
      skipLeadTarget = target;
      void playFrom(target, myGen, false); // leading: play it now (responsive); scheduler prioritizes it
    }
    // (Re)arm the settle. If skipping moved past the leading play, play the LANDING with its lead
    // established; otherwise it was a lone skip already playing — just warm the look-ahead window.
    clearSkipSettle();
    skipSettleTimer = setTimeout(() => {
      skipSettleTimer = null;
      if (!get().active) return; // stopped during the window (stop() also clears this timer)
      if (skipLastTarget !== skipLeadTarget) void playFrom(skipLastTarget, ++gen, true); // establishLead
      else prefetchFrom(skipLeadTarget);
    }, SKIP_SETTLE_MS);
  },

  setSpeed: (s) => {
    const sp = Math.max(TTS_MIN_SPEED, Math.min(TTS_MAX_SPEED, Math.round(s / TTS_SPEED_STEP) * TTS_SPEED_STEP));
    if (source) source.playbackRate.value = sp;
    reanchorKaraoke(sp); // RAWY-127: keep the karaoke audio-time continuous across the rate change
    set({ speed: sp });
    void settingsSet("tts_speed", String(sp)).catch(() => {});
  },

  // RAWY-180 (Part A): set the read-aloud volume (0..1) on the shared gain — live for both engines — and
  // persist it debounced (the slider fires many events per drag). Applies even before a source connects
  // (curVolume seeds the gain node when it's created).
  setVolume: (v) => {
    const vol = Math.max(0, Math.min(1, v));
    curVolume = vol;
    if (gainNode) gainNode.gain.value = vol;
    set({ volume: vol });
    if (volSaveTimer) clearTimeout(volSaveTimer);
    volSaveTimer = setTimeout(() => void settingsSet("tts_volume", String(vol)).catch(() => {}), 250);
  },

  // Pick an engine+voice for a language (RAWY-111). Always persists the choice; if it's for the
  // language being read RIGHT NOW, switch live from the current sentence so the owner hears it.
  setVoice: (engine, id, lang) => {
    void settingsSet(`tts_voice:${lang}`, `${engine}:${id}`).catch(() => {});
    const st = get();
    if (!st.active || st.lang !== lang) return; // saved; applies next time that language is read
    curEngine = engine;
    curVoice = id;
    scheduler.clearCache(); // RAWY-231: new voice → invalidate cached audio (keeps the session's E counters)
    failStreak = 0; // RAWY-159: a new engine/voice is a fresh attempt at the current sentence
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127: switching engine (e.g. Edge→Piper) drops any pill; playFrom re-decides
    clearSkipSettle(); // RAWY-185: a live voice/engine switch supersedes a pending rapid-skip landing synth
    set({ engine, voice: id, status: "preparing", error: null, wordIndex: -1 });
    void ensureAndPlay(engine, id, st.index, myGen);
  },

  // RAWY-113 (design 6): the Engine chip switches engine, keeping the current language. It picks that
  // engine's default voice for the language (the Voices chip then refines the specific voice). Piper's
  // default is the bundled voice for the language, else the English Lessac model (the offline anchor) —
  // only ar/en are bundled, so a non-ar/en book switching to Piper lands on Lessac.
  //
  // RAWY-199: Edge's default is resolved against the REAL voice list (`edgeUnsetDefault`), not the bare
  // constant — the same defect as the play path: "Switch to Edge" in a region without WilliamMultilingual
  // used to select a voice that does not exist, so the switch the user just asked for failed to speak.
  // The engine is set from the user's explicit action either way; only the ID is being resolved here, so
  // this is not an engine swap (RAWY-193).
  setEngine: (engine) => {
    const lang = get().lang;
    if (engine === "piper") {
      get().setVoice("piper", PIPER_VOICE[lang] ?? PIPER_VOICE.en, lang);
      return;
    }
    void edgeUnsetDefault().then((id) => get().setVoice("edge", id, lang));
  },

  // Re-run the last Listen after a download/synth failure (RAWY-106: a visible way to recover from a
  // flaky first-use download without leaving the reader).
  retry: () => {
    if (lastStart) void get().start(lastStart);
  },

  // RAWY-193: the "Edge unavailable" state's Retry — re-attempt the CURRENT sentence on the SAME engine
  // (still Edge; the voice was never changed). Clears the cache so a stale failed synth from the outage can't
  // instantly re-trip the error, and resumes from the current index. ("Switch to Piper" in the pill is the
  // normal `setEngine("piper")` — an explicit, persisted engine switch, NOT a hidden temporary Piper mode.)
  resumeEdge: () => {
    const st = get();
    if (!st.active) return;
    scheduler.clearCache(); // RAWY-231: drop the outage's stale rejected synths so Retry re-attempts cleanly
    failStreak = 0;
    const myGen = ++gen;
    stopSource();
    stopKaraoke();
    set({ status: "preparing", error: null });
    void ensureAndPlay(curEngine, curVoice, st.index, myGen);
  },

  stop: () => {
    gen++;
    stopSource();
    stopKaraoke(); // RAWY-127
    clearSkipSettle(); // RAWY-185: cancel any deferred rapid-skip landing synth
    skipLeadTarget = -1;
    skipLastTarget = -1;
    lastSkipAt = 0; // RAWY-186
    scheduler.reset(); // RAWY-231: session over — drop the cache AND zero the recurrence counters (E)
    resetSeries(awaitLatency); // RAWY-257: the latency series are per-SESSION, like the counters beside them
    ttsUnderruns = 0;
    lastFail = null; // RAWY-247: clear the last-failure diagnostic for the new session
    pendingDecodeInfo = null;
    sentences = [];
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, progress: 0, error: null, words: [], wordIndex: -1, underruns: 0, abandoned: 0, lastFailure: null, retryAttempt: 0 });
  },
}));
