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
import { SynthScheduler } from "./ttsScheduler";

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
async function synthInvoke(i: number): Promise<ArrayBuffer> {
  try {
    return await invoke<ArrayBuffer>("tts_synthesize", { engine: curEngine, id: curVoice, text: sentences[i] });
  } catch (e) {
    if (curEngine !== "edge") throw e;
    if (String(e).includes("timed out")) throw new Error(TTS_EDGE_DOWN); // a stall — surface it, don't retry
    try {
      return await invoke<ArrayBuffer>("tts_synthesize", { engine: "edge", id: curVoice, text: sentences[i] });
    } catch {
      throw new Error(TTS_EDGE_DOWN);
    }
  }
}

// RAWY-231: the scheduler's dispatch — invoke (bounded so a stalled socket frees the single-flight slot) →
// parse the framed word timings → decode to an AudioBuffer. Engine-agnostic (WebAudio decodes Piper WAV +
// Edge MP3 alike). This is the ONLY thing the scheduler runs; ordering/priority/eviction are the scheduler's.
async function synthDispatch(i: number): Promise<Synthesized> {
  const raw = await withTimeout(synthInvoke(i), SYNTH_TIMEOUT_MS);
  const { words, audio } = parseFramed(raw);
  return { buffer: await audioCtx().decodeAudioData(audio), words };
}

// The one serialized, priority-ordered, drop-on-move synth scheduler (invariants B + C live here).
const scheduler = new SynthScheduler<Synthesized>(synthDispatch, {
  behind: CACHE_KEEP_BEHIND,
  ahead: PREFETCH_AHEAD,
  onAbandon: () => useTts.setState({ abandoned: scheduler.abandoned }),
});
// The promise playback awaits for sentence `i` (registers the want + kicks the scheduler's pump).
const synth = (i: number): Promise<Synthesized> => scheduler.request(i);

// RAWY-231 (E): mirror the recurrence counters into the store (for the pill's debug readout) and, when the
// owner has opted in via `localStorage.sardTtsDebug`, log each stall so he can SEE them, not only feel them.
const logStall = (kind: string, idx: number): void => {
  useTts.setState({ underruns: ttsUnderruns, abandoned: scheduler.abandoned });
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("sardTtsDebug")) {
      // eslint-disable-next-line no-console
      console.debug(`[sard/tts] ${kind} @${idx} · underruns=${ttsUnderruns} abandoned=${scheduler.abandoned} inFlight=${scheduler.inFlight}`);
    }
  } catch { /* localStorage may be unavailable */ }
};
// A dev/debug surface reachable from DevTools without shipping any UI (invariant E).
if (typeof window !== "undefined") {
  (window as unknown as { __sardTtsStats?: () => unknown }).__sardTtsStats = () => ({
    underruns: ttsUnderruns,
    abandoned: scheduler.abandoned,
    inFlight: scheduler.inFlight,
    cached: scheduler.size,
    priority: scheduler.priority,
  });
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
// their place (accessibility). Wire on a pill container's `onClickCapture` so it fires even for buttons that
// stopPropagation (the kashida). Only <button>s are released — the volume <input range> keeps its arrow keys.
export function releaseButtonFocusAfterPointerClick(e: { detail: number; target: EventTarget | null }): void {
  // `Element`, not `HTMLElement`: a click usually lands on the button's inner <svg>/<path> icon, which is an
  // SVGElement — an `instanceof HTMLElement` guard silently skipped the blur (caught live, RAWY-194 STEP 3).
  if (e.detail > 0 && e.target instanceof Element) e.target.closest("button")?.blur();
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
  try {
    // RAWY-172 (AUD-2): bound the synth so a stalled socket can't freeze the queue. RAWY-193: on Edge a
    // failure/stall is NOT skipped — the catch routes it to the explicit "Edge unavailable" pause (isEdgeDown);
    // a non-Edge (Piper) failure still skips per RAWY-159.
    synthd = await withTimeout(current, SYNTH_TIMEOUT_MS);
  } catch (e) {
    if (myGen !== gen) return; // superseded — the scheduler already dropped the rejected index
    // RAWY-193: an Edge-SERVICE failure (the bounded retry failed) or an Edge stall must NOT silently skip
    // or swap the voice — PAUSE and surface the explicit "Edge unavailable" choice (Retry / Switch to Piper),
    // visible in EVERY pill state (the player force-expands out of the kashida on this status). A non-Edge
    // failure (unspeakable "…"/"..." that yields empty audio, a Piper exit with no WAV) keeps RAWY-159 skip.
    if (curEngine === "edge" && isEdgeDown(e)) {
      stopSource();
      set({ status: "edge-error" });
      return;
    }
    skipSegment(String(e));
    return;
  }
  if (myGen !== gen) return; // superseded by stop/skip
  // RAWY-231 (invariant D): empty/zero-length audio. On EDGE this is the throttled-TRUNCATION symptom
  // (§ open defect) — a REAL failure, so surface the explicit "Edge unavailable" pause rather than skipping
  // it silently. On Piper an empty buffer is legitimate punctuation-only text, so keep the RAWY-159 skip.
  if (!synthd.buffer || synthd.buffer.length === 0 || synthd.buffer.duration === 0) {
    if (curEngine === "edge") { stopSource(); logStall("empty-edge", idx); set({ status: "edge-error" }); return; }
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
  if (myGen === gen) set({ status: "playing" });

  const c = audioCtx();
  if (c.state === "suspended") await c.resume();
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
    sentences = sen.map((s) => s.trim()).filter(Boolean);
    const saved = Number(await settingsGet("tts_speed").catch(() => null));
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? saved : get().speed;
    // RAWY-180: restore the saved volume (0..1). An UNSET key must not read as 0 (muted), so treat only
    // an in-range stored value as valid; otherwise keep the current (default full) level.
    const volStr = await settingsGet("tts_volume").catch(() => null);
    const volNum = volStr == null ? NaN : Number(volStr);
    const volume = volNum >= 0 && volNum <= 1 ? volNum : get().volume;
    curVolume = volume;
    if (gainNode) gainNode.gain.value = volume;
    set({ active: true, status: "preparing", endDismissed: false, lang, speed, volume, index: startIndex, total: sentences.length, progress: 0, chapterLabel, error: null, words: [], wordIndex: -1 });
    if (sentences.length === 0) {
      set({ status: "error", error: TTS_EMPTY });
      return;
    }
    // Resolve the saved engine+voice for this language (default = Piper) inside the gesture chain.
    const { engine, id } = await resolveVoicePref(lang);
    if (myGen !== gen) return;
    curEngine = engine;
    curVoice = id;
    set({ engine, voice: id });
    void ensureAndPlay(engine, id, Math.min(startIndex, sentences.length - 1), myGen);
  },

  toggle: () => {
    const st = get();
    if (!st.active) return;
    if (st.status === "playing") {
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
    if (!st.active || st.status === "preparing") return;
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
    ttsUnderruns = 0;
    sentences = [];
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, progress: 0, error: null, words: [], wordIndex: -1, underruns: 0, abandoned: 0 });
  },
}));
