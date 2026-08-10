// TTS playback (RAWY-105) — the frontend half of read-aloud. Rust synthesizes each sentence and
// returns raw audio bytes; here we decode them with WebAudio and play a QUEUE of sentences,
// synthesizing the NEXT while the current plays (hides synth latency). Controls: play/pause,
// skip ±sentence, speed.
//
// RAWY-110/111 (engine abstraction): a voice is {engine, id}; `synth` calls the dispatching
// `tts_synthesize(engine, id, text)`. Engine-agnostic — the media element plays
// Edge's MP3, so play/pause/skip/speed work the same. The chosen engine+voice persists PER LANGUAGE
// (`tts_voice:ar`/`tts_voice:en`), defaulting to EDGE (neural, design 6). Edge is online-required — RAWY-193:
// a synth failure is retried ONCE on Edge (a transient blip, invisible), then, if still failing, playback
// PAUSES in an explicit "Edge unavailable" state whose only action is Retry. The voice NEVER changes on
// its own — the old silent per-sentence engine fallback (D37/RAWY-113) was removed as a correctness bug.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { type BookScript, voiceCompatibility, isImplausiblyShortAudio } from "./voiceCompat"; // WP-5
// DIAGNOSTIC BUILD ONLY. A release build aliases this specifier to src/lib/diagOff.ts, so these two
// calls compile to no-ops and the instrumentation leaves the bundle entirely. They used to write to
// `globalThis.__sardDiag*` inline, which the bundler cannot recognise as diagnostic — that is how
// instrumentation kept reaching release bundles that were meant to have none.
import { diagNote, diagPublishAudio } from "@diag";
import { settingsGet, settingsSet, ttsEdgeVoices, ttsStop } from "./ipc";
import { LatencySeries, newSeries, recordSeries, resetSeries, seriesSummary, SynthScheduler } from "./ttsScheduler";

/**
 * RAWY-281 — the selectable playback speeds, as an EXPLICIT ORDERED SET.
 *
 * This replaces a uniform grid (`MIN 0.75 / MAX 2.0 / STEP 0.25`) that produced the same six values
 * implicitly. The grid was not merely silent about 1.10 — `setSpeed` QUANTISED to it
 * (`Math.round(s / 0.25) * 0.25`), so 1.10 was actively snapped to 1.00 and was unreachable by any
 * path. A uniform step cannot express {0.75, 1.00, 1.10, 1.25, …}: 1.10 is off the 0.25 grid, and the
 * only steps containing it (0.05, 0.10) either bloat the cycle to 26 stops or drop 1.00 and 1.25.
 *
 * So the constraint is REMOVED rather than special-cased. The list states exactly what the grid was
 * always trying to express — a fixed, ordered set the chip cycles and stored values snap to — and it
 * can hold any value the product wants without arithmetic having to agree.
 *
 * **Every previously reachable speed is still here, unchanged and in the same order.** 1.10 is
 * inserted in sorted position, so cycling order is preserved and only gains one stop.
 * NOT an engine change: `mediaEl.playbackRate` is a float and time-stretches at 1.10 exactly as it
 * does at 1.25 (RAWY-264). Nothing in scheduling, buffering, retry or the Edge pipeline reads these.
 */
/**
 * RAWY-296 (owner, 2026-08-08): the list is now chosen from a MENU rather than cycled, so it can carry
 * fine steps without a long tap-cycle — the reason the set was kept to six stops before.
 *
 * ⚠ **0.75 IS REMOVED — the only sub-1x speed.** Two consequences, both deliberate:
 *   1. A reader who had set 0.75 does not keep it. On restore, `saved >= TTS_MIN_SPEED` is now false
 *      for 0.75, so it falls through to the default rather than being snapped — a one-time reset of
 *      that preference. RAWY-281's "lossless" property therefore no longer holds for 0.75; it still
 *      holds for every other previously storable value (1.00 / 1.10 / 1.25 / 1.50 / 1.75 / 2.00 are
 *      all still members and map to themselves).
 *   2. `TTS_MIN_SPEED` becomes 1.0, which tightens the playback watchdog's bound
 *      (`durationSec / TTS_MIN_SPEED + 2`). That stays CORRECT rather than becoming risky: the bound
 *      means "slowest-case play time", and the slowest selectable case really is 1.0 now. It cannot
 *      fire early, because no slower rate is reachable.
 * The maximum stays 2.0 — nothing above it.
 */
export const TTS_SPEEDS = [1.0, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5, 1.75, 2.0] as const;
/** Derived so they can never drift from the list. Both are consumed elsewhere — `TTS_MIN_SPEED`
 *  also bounds the decode-context lifetime (`durationSec / TTS_MIN_SPEED`), which is why it stays. */
export const TTS_MIN_SPEED = TTS_SPEEDS[0];
export const TTS_MAX_SPEED = TTS_SPEEDS[TTS_SPEEDS.length - 1];
/** Snap to the nearest SELECTABLE speed. Replaces the grid quantiser, and is deliberately the single
 *  point where an arbitrary number becomes a valid one — used by both `setSpeed` and the restore path,
 *  so "speed is always a member of TTS_SPEEDS" holds everywhere rather than at each call site. */
export const nearestSpeed = (s: number): number =>
  TTS_SPEEDS.reduce((best, v) => (Math.abs(v - s) < Math.abs(best - s) ? v : best), TTS_SPEEDS[0]);
// Sentinel error the player localizes (RAWY-107) — distinct from a raw engine/download error, which
// the pill shows verbatim (RAWY-106). Set when a section genuinely has no readable text.
export const TTS_EMPTY = "empty-chapter";
// RAWY-193: sentinel meaning "Edge synthesis failed and the ONE bounded retry also failed." The player then
// enters the explicit "Edge unavailable" PAUSE state, whose only action is Retry — it NEVER silently swaps
// the voice (the deleted D37 anti-pattern). A synth stall (`tts.synthTimeout`) is treated the same.
export const TTS_EDGE_DOWN = "edge-unavailable";

// A voice is identified by its ENGINE + id (RAWY-110). "edge" = the online neural voices.
export type TtsEngineKind = "edge";
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
// bare icon). The short_name's voice part ("ar-EG-SalmaNeural" → "Salma").
export function voiceLabel(_engine: TtsEngineKind, id: string): string {
  const tail = id.split("-").pop() ?? id; // "SalmaNeural"
  return tail.replace(/Neural$/, "") || id; // "Salma"
}

// A row in the voice picker (RAWY-111) — every Edge neural voice Microsoft returns.
// RAWY-197: `lang` is now the REAL primary ISO code parsed from the locale (was hard-cast to "ar"/"en"),
// and the Edge list is no longer filtered by the backend to ar-/en- — every language appears.
export interface PickerVoice { engine: TtsEngineKind; id: string; lang: TtsLang; locale: string; label: string; gender: string }
let edgeVoicesCache: PickerVoice[] | null = null;
/** The Edge (online neural) voices for the picker, fetched once + cached;
 *  a failure (offline) yields an empty list rather than throwing. RAWY-197: `lang` is the real primary code
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
      edgeVoicesCache = []; // offline / endpoint down → empty picker
    }
  }
  return [...edgeVoicesCache];
}

// RAWY-197: the Edge voice to PRE-SELECT in the picker when no choice is saved — the unset default.
// Prefers the WilliamMultilingual id; if it is absent from THIS region's list (Microsoft's CDN varies
// by geography, RAWY-179), falls back to the first available Multilingual voice, else the first Edge
// voice. Returns null only when there is no Edge voice at all (offline → empty picker).
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
 *  EMPTY LIST = OFFLINE. We then return the preferred id anyway, so the synth fails and RAWY-193 raises
 *  the explicit "Edge unavailable" pause, whose only action is Retry. */
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
    // A legacy `piper:<id>` key no longer matches, so it falls through to the Edge default below.
    if (engine === "edge" && id) return { engine, id };
  }
  return { engine: "edge", id: await edgeUnsetDefault() };
}

// RAWY-231 (invariant A/D): "buffering" is a VISIBLE mid-playback wait — playback moved to a sentence whose
// audio isn't ready yet (an underrun) or the chapter-start/seek "keep-one-ahead" lead is still synthesizing.
// It is transient (it resolves to "playing" the moment the audio is ready, or escalates to "edge-error" on a
// timeout), so it is never a silent gap. Distinct from "preparing" so skipping still works during a buffer.
// RESILIENCE-1 / WP-5: "voice-mismatch" is TERMINAL and never retried — the pre-flight refused before
// any dispatch, or the empty-audio net (WP-5B) proved the voice cannot render this script. It is
// deliberately NOT "edge-error": that state offers a retry, and retrying this can only fail again.
type Status = "idle" | "preparing" | "playing" | "paused" | "error" | "chapter-end" | "edge-error" | "buffering" | "voice-mismatch";

// RAWY-231: `deferPrefetch` (RAWY-188) is REMOVED — it had no callers (the RAWY-227 resume-prompt removal
// left it dead), and the scheduler now prioritizes the current+lead sentence over look-ahead by construction,
// so the old "start only the first sentence" hack is obsolete.
interface StartOpts { sentences: string[]; lang: TtsLang; startIndex?: number; chapterLabel: string;
  /** WP-5A: the script SNIFFED from the book (never its declared language). null = do not gate. */
  bookScript?: BookScript }

/** WP-5C: the settings prefix recording "I chose this voice anyway", for ONE voice id. Per-voice, so
 *  an override can never silently generalise to a different incompatible voice. */
export const VOICE_OK_PREFIX = "tts_voice_ok:";

/** WP-5: which voice the pre-flight refused, so the dialog can name it and offer the alternative. */
export interface VoiceMismatch { voiceId: string; engine: TtsEngineKind; bookScript: BookScript }

interface TtsState {
  active: boolean; // player pill visible
  status: Status;
  /** WP-5: set together with status "voice-mismatch"; null in every other state. */
  mismatch: VoiceMismatch | null;
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
  retry: () => void;
  resumeEdge: () => void; // RAWY-193: the "Edge unavailable" state's Retry — re-attempt Edge from the current sentence
  stop: () => void;
}

// RAWY-127 (word karaoke): per-word timing for one sentence. `offset`/`duration` are Azure's 100-ns
// ticks from the START of THIS sentence's audio (each sentence is its own buffer, so they're clean to
// schedule against playback). Edge emits them; an empty list keeps the sentence at sentence level.
export interface TtsWord { text: string; offset: number; duration: number }
// RAWY-264: a synthesized sentence is now its ENCODED bytes plus the duration decoding proved it has.
// The decoded PCM is deliberately NOT retained: it existed only to be played, and playback no longer uses
// it (see the media-element section below). Decoding still happens — it is what validates the payload
// (RAWY-247 decode classification, RAWY-257 2B/C9 zero-length) and where the duration comes from — but the
// AudioBuffer is released immediately afterwards. That turns ~1.67 MB per sentence into ~53 KB, a ~32x
// reduction in the cache RAWY-172 (AUD-1) was written to bound.
interface Synthesized { bytes: ArrayBuffer; durationSec: number; words: TtsWord[] }

// ---- imperative playback engine (WebAudio), kept outside the reactive store ----
let ctx: AudioContext | null = null;
let sentences: string[] = [];

// ---- RAWY-264: the playback substrate — HTMLMediaElement, not AudioBufferSourceNode -----------------
//
// WHY. Playback speed used to be produced by `AudioBufferSourceNode.playbackRate`, which RESAMPLES: pitch
// and duration move together, so the narrator became a different person (+3.86 semitones at 1.25x, a full
// octave at 2.00x — measured). Generating the audio at the listener's speed instead fixed the voice but made
// speed a property of the AUDIO, which meant every speed change invalidated buffered sentences and forced
// re-synthesis. A media element with `preservesPitch` TIME-STRETCHES in Chromium's own pipeline: measured
// spectral shift 0.00 semitones at every supported speed, so speed goes back to being a property of
// PLAYBACK. The cache is rate-independent again, a speed change costs one property assignment, and it works
// by the media element rather than the engine, so the voice is preserved.
//
// CSP. The element is fed a `blob:` URL built from the bytes already in memory, so `media-src blob:` is
// REQUIRED in tauri.conf.json (JSON takes no comments, which is why the rationale lives here). Without it
// Chromium refuses the load with `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check` and a
// `media-src` violation — measured, not assumed.
//
// It is deliberately `blob:` ALONE, not `'self' blob:`. This pool is the only media element in the app and
// it never loads anything but a blob, and no media assets are bundled, so `'self'` would grant reach nobody
// uses. The directive also does not widen script execution in any way: WebAssembly instantiation and
// blob:/data: AudioWorklet loading remain BLOCKED by the untouched `script-src` — re-verified by the final
// gate, precisely so this entry cannot be mistaken for the far broader `script-src 'wasm-unsafe-eval'` that
// a WASM time-stretcher would have required. The alternatives (a `data:` URL, or the asset protocol) need
// an equivalent relaxation and add a copy or a disk round-trip.
//
// LIFECYCLE. `createMediaElementSource` may be called ONCE per element and its node cannot be recreated, so
// the two elements are created once per AudioContext and REUSED, never recreated. Everything the pool owns
// is released deliberately: a slot's blob URL is revoked when that slot is reused, and `releaseMedia()`
// tears the whole pool down on session stop.
const MEDIA_POOL_SIZE = 2; // one sounding, one free to take the next sentence
let mediaEls: HTMLAudioElement[] = [];
let mediaNodes: MediaElementAudioSourceNode[] = [];
let mediaUrls: (string | null)[] = [];
let mediaCtx: AudioContext | null = null; // the context the pool's source nodes are bound to
let mediaSlot = 0;
let mediaEl: HTMLAudioElement | null = null; // the element currently sounding
let blobsCreated = 0;
let blobsRevoked = 0;
let playRejections = 0;

// AUDIO↔TEXT DRIFT (RAWY-264): the karaoke pill's DERIVED clock minus the media pipeline's OWN position.
// `el.currentTime` is ground truth — Edge's word offsets are expressed in exactly that timeline — so this is
// the real misalignment between the highlighted word and the spoken one, not a proxy for it. Kept because a
// CONSTANT offset and a GROWING one are different defects: regressing drift against position WITHIN the
// sentence separates them, and the slope is what proves synchronisation cannot degrade over a long sentence.
// Measured at adoption: mean +22 ms, max 40 ms, slope 0.02–0.13 ms per second of speech.
let driftN = 0, driftSum = 0, driftMin = 0, driftMax = 0;
let regX = 0, regY = 0, regXY = 0, regXX = 0;
const noteDrift = (ms: number, posSec: number) => {
  driftN++; driftSum += ms;
  if (driftN === 1 || ms < driftMin) driftMin = ms;
  if (driftN === 1 || ms > driftMax) driftMax = ms;
  regX += posSec; regY += ms; regXY += posSec * ms; regXX += posSec * posSec;
};
const driftSlope = (): number | null => {
  const d = driftN * regXX - regX * regX;
  return driftN > 50 && Math.abs(d) > 1e-9 ? (driftN * regXY - regX * regY) / d : null;
};
const resetDrift = () => {
  driftN = 0; driftSum = 0; driftMin = 0; driftMax = 0;
  regX = 0; regY = 0; regXY = 0; regXX = 0;
};

/** The pool, bound to `c`. Rebuilt only if the AudioContext was replaced (`audioCtx()` remakes a closed one). */
function mediaPool(c: AudioContext): HTMLAudioElement[] {
  if (mediaCtx === c && mediaEls.length === MEDIA_POOL_SIZE) return mediaEls;
  releaseMedia(); // a context swap orphans the old nodes — tear them down rather than leak them
  for (let k = 0; k < MEDIA_POOL_SIZE; k++) {
    const el = new Audio();
    el.preload = "auto";
    // The whole point of the substrate. Measured to survive later `src` and `playbackRate` assignment, so it
    // is set once here rather than re-asserted per sentence.
    el.preservesPitch = true;
    mediaEls.push(el);
    mediaUrls.push(null);
    // RAWY-180: through the SHARED volume gain, never straight to the destination, so the volume slider
    // governs read-aloud exactly as it did for the buffer path.
    const node = c.createMediaElementSource(el);
    node.connect(outputNode(c));
    mediaNodes.push(node);
  }
  mediaCtx = c;
  return mediaEls;
}

/** Release a slot's blob URL. Called when the slot is reused and when the pool is torn down. */
const revokeSlot = (slot: number) => {
  const u = mediaUrls[slot];
  if (u) { URL.revokeObjectURL(u); blobsRevoked++; mediaUrls[slot] = null; }
};

/** Full teardown: stop every element, drop its media, release every URL, disconnect every node. */
function releaseMedia() {
  for (let k = 0; k < mediaEls.length; k++) {
    const el = mediaEls[k];
    try {
      el.onended = null;
      el.pause();
      // Dropping the src is what makes the element let go of the decoded media; revoking the URL alone
      // would not, because the element still holds its own reference to the resource it loaded.
      el.removeAttribute("src");
      el.load();
    } catch { /* element already torn down */ }
    revokeSlot(k);
  }
  for (const n of mediaNodes) { try { n.disconnect(); } catch { /* already disconnected */ } }
  mediaEls = []; mediaNodes = []; mediaUrls = []; mediaCtx = null; mediaSlot = 0; mediaEl = null;
}
// RAWY-180 (Part A): read-aloud VOLUME. Every sentence source connects through ONE shared GainNode
// before the destination, so the slider's 0..1 gain governs playback —
// they both play through the same media-element pool (RAWY-264). Persisted as `tts_volume`.
let gainNode: GainNode | null = null;
let curVolume = 1; // 0..1, applied to the shared output gain (mirrors useTts.volume)
let volSaveTimer: ReturnType<typeof setTimeout> | null = null;
// RAWY-231: the per-sentence synth cache now lives INSIDE the SynthScheduler (see `scheduler` below), which
// serializes + prioritizes dispatch (current > next > look-ahead) and drops stale work on a cursor move.
let ttsUnderruns = 0; // RAWY-231 (E): times playback had to WAIT on synthesis this session (a stall)
let curEngine: TtsEngineKind = "edge";
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
// offline) still surfaces the retryable error.
let watchdog: ReturnType<typeof setInterval> | null = null;
let failStreak = 0;
const FAIL_LIMIT = 3; // consecutive failures that turn "skip the bad segment" into "surface a dead end"
// RAWY-172 (AUD-2): a synth that never resolves (a stalled Edge socket — Wi-Fi dropped without an RST, a
// captive portal, a sleeping router) must not freeze read-aloud. Every synth is raced against this ceiling;
// on timeout playback surfaces the explicit "Edge unavailable" pause (invariant D — fail loudly, never a
// silent gap). RAWY-231 lowered it 20 s → 9 s so a stall surfaces a CHOICE in ~8-9 s, not ~20 s of silence.
// RAWY-266 (stage 2): 9 s -> 13 s, moved TOGETHER with the Rust budget (8 -> 12). These two ceilings are
// COUPLED and must never be set independently: this one wraps every single attempt, so had it stayed at 9 s
// the Rust budget would have been unreachable — the JS wrapper would fire first, the extra 4 s would never
// be used, and the failure would merely be RELABELLED from a Rust reason to `tts.synthTimeout`.
// The 1 s margin over Rust is preserved (13 vs 12, as 9 vs 8) so the specific Rust-reported PHASE still wins.
//
// The old basis for 9 s ("a 236-char sentence synthesised in 632 ms") was a single cached-response sample.
// RAWY-265 re-measured it properly on unique text: the same length takes 6.9-11.8 s, and a repeat of
// identical text returns in ~490 ms because the service caches — which is exactly how 632 ms was obtained.
const SYNTH_TIMEOUT_MS = 13000;
// RAWY-266 (stage 3): the ladder's TOTAL wall-clock ceiling, so a listener is never left in silence
// indefinitely. Sized from the measured recovery curve to afford exactly TWO full attempts
// (13 000 + 500 backoff + 13 000 = 26 500):
//   * attempt 1 at 12 s already covers 98.9% of requests;
//   * the residual is service-side variance, not length (the same 235-char sentence ranged 8.8-13.4 s), so a
//     second attempt on a FRESH socket clears ~86% of what is left (cold >=12 s was 14%);
//   * expected residual after two ~0.15% of dispatches, i.e. ~0.2 per 133-unit chapter instead of ~1.5;
//   * a third attempt would move 0.15% -> 0.02% for another 13 s. The curve has flattened; stop at two.
// This bound only ever applies to the ~1.1% tail, it is VISIBLE (D68 `retryAttempt`), and it replaces a
// measured 49-103 s of dead time in which the listener had to notice the stall and press Retry themselves.
const MAX_DISPATCH_MS = 27000;
const STALL_RETRY_LIMIT = 1; // a stall that RECURS on a fresh socket is what counts as genuine
// RAWY-172 (AUD-1): how many already-played sentences to keep decoded (besides the current +
// prefetched-next), so a one-sentence skip-back stays instant while memory stays bounded.
const CACHE_KEEP_BEHIND = 1;
// RAWY-181 (BUG 3): how many UPCOMING sentences to synthesize ahead of need. RAWY-231: the GUARANTEE is a
// lead of exactly ONE sentence (invariant A); anything beyond that is OPTIONAL look-ahead the scheduler
// dispatches only after the current + lead, and drops on a cursor move.
//
// ---- RAWY-257 package 4B (A2 / D71, reduced) — THE LEAD IS NOW MEASURED IN SECONDS ----
// `PREFETCH_AHEAD = 3` was a UNIT count, and the 4B investigation measured what that is worth in TIME:
//   • Arabic (p50 unit 6.13 s): 3 units ≈ 16.5 s of decoded cover
//   • English (p50 unit 2.75 s): 3 units ≈  6.5 s of decoded cover
// The SAME window, a 2.5× spread, inside one library — that is A2, and it is why a unit count cannot be the
// policy. Worse, on English a p95 dispatch (2620 ms) already exceeds the wall playback one median unit
// provides (2200 ms at the owner's 1.25×), so the thin side of that spread is the side under load.
//
// SECONDS now govern; the unit number survives only as a HARD CAP that keeps the window O(1) if units are
// pathologically short. 15 s ÷ 12 = 1.25 s/unit, which is BELOW the shortest unit measured anywhere in the
// investigation (1.75 s over 93 units) — so on measured content the cap never binds and seconds decide,
// while on degenerate content the cap holds memory to ~15 s of audio (≈2.9 MB at 48 kHz float32 mono) and
// RAWY-172 survives absolutely.
//
// D60-A IS UNTOUCHED: `playFrom` still refuses to BEGIN until the current sentence and its one-ahead lead
// are both decoded. S4 (fast start) was closed as NOT REQUIRED and is not implemented in any form.
const PREFETCH_MAX_AHEAD = 12;
// D71: TARGET 15 s of decoded audio ahead of the cursor.
const LEAD_TARGET_SECONDS = 15;
// D71: LOW WATER 5 s. Carried as a REPORTED threshold only — see `wantedAhead()` in ttsScheduler.ts for why a
// hysteresis refill trigger would reduce cover under a sliding window on a single-flight engine.
const LEAD_LOW_WATER_SECONDS = 5;
const clearWatchdog = () => {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
};

// RAWY-231: ONE tts_synthesize call for sentence `i` — the invoke plus the RAWY-193 single bounded retry for
// a stale/dropped warm Edge socket. A retry is only worth it for a FAST failure (a dropped socket errors in
// ~ms); a genuine STALL (the Rust side reported a timeout) is surfaced immediately rather than burning
// another synth window on it (that would only pile up silence — RAWY-191 lesson). The engine/voice is NEVER
// changed here (D37): a sustained failure rejects with TTS_EDGE_DOWN so playFrom raises the explicit
// "Edge unavailable" pause.
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
// RAWY-257 (C1): `msg` lets a DEV harness inject the EXACT error text the Rust side produces, so the C1 fix
// can be proven on the real strings instead of on a paraphrase. Same justification 2B recorded when it added
// the `permanent` mode: a gate needs a failure class no existing mode can produce. Unset → the message is
// byte-identical to before, so no armed behaviour changes.
let fault: { mode: FaultMode; ms: number; times: number; msg?: string } = { mode: "off", ms: 0, times: 0 };
const faultArmed = (): boolean => import.meta.env.DEV && fault.mode !== "off" && fault.times > 0;

/** Build a framed `[u32 BE json_len][json][audio]` body (the RAWY-127 wire shape) with a chosen audio body,
 *  so an injected fault is indistinguishable downstream from a real Edge response of that shape. */
function framedFault(audio: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode("[]"); // no word timings
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
      // RAWY-257 (C1): `msg` substitutes the exact Rust wording under test; unset keeps the original string.
      throw new Error(fault.msg || "edge connect: injected fail-fast (RAWY-257 fault)");
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
  // RAWY-264: synthesis is ALWAYS at the voice's natural rate. Speed is applied at playback, so the same
  // bytes serve every speed and a speed change never invalidates them.
  return await invoke<ArrayBuffer>("tts_synthesize", { engine, id, text });
}

// RAWY-257 package 2B (C3): ONE attempt. The retry that used to live here is gone — it fired in the SAME
// TICK, and RAWY-193's commit states the premise verbatim: "NO backoff: the cold WS reconnect (~2.7 s,
// measured RAWY-191) is itself the delay." That premise is FALSE whenever the connection is REFUSED rather
// than slow: a refused connect returns in milliseconds, so this retry plus Rust's own internal one burned
// ~4 attempts inside ~50–200 ms against the same bad instant. Retry ownership now belongs solely to the
// ladder in `synthDispatch`.
/**
 * RESILIENCE-1 / WP-5B — THE SAFETY NET, matched to what Edge ACTUALLY does.
 *
 * The plan specified this as a wire-error class. MEASUREMENT M1 proved there is no wire error: a
 * mismatched pair returns HTTP **success** carrying a 6-byte MP3, against 28,676–41,356 bytes for
 * every working pair. So the only available signal is a success that contains no speech, and a class
 * matched on an error that never arrives would have been dead code dressed as protection.
 *
 * This is the net for whatever the WP-5A pre-flight does not catch — a book whose sniffed script is
 * absent, or a voice the rule believes is fine that this endpoint disagrees about. It throws a marker
 * error that `isPermanentFailure` recognises, so it leaves the retry ladder completely untouched
 * while never entering it: retrying a voice that cannot render this script can only fail again.
 */
export const VOICE_MISMATCH_MARKER = "voice-language-mismatch";

async function synthInvoke(i: number): Promise<ArrayBuffer> {
  const text = sentences[i];
  const buf = await rawSynth(curEngine, curVoice, text);
  if (isImplausiblyShortAudio(text, buf?.byteLength ?? 0)) {
    throw new Error(`${VOICE_MISMATCH_MARKER}: ${curVoice} returned ${buf?.byteLength ?? 0} bytes for ${text.length} chars`);
  }
  return buf;
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
  if (s.includes("unknown edge voice")) return true;
  // WP-5B: a voice that cannot render this script will not learn to on a later attempt. Sits here,
  // beside the existing permanent class, rather than anywhere inside the ladder — WP-5D's rule is
  // that the ladder, its constants and every other classifier stay untouched.
  if (s.includes(VOICE_MISMATCH_MARKER)) return true;
  // RAWY-257 (C1 — regression fix): 429 "Too Many Requests" is a RATE LIMIT, not a rejection. It is the one
  // 4xx that CAN succeed on a later attempt, and a spaced retry is the canonical response to it — so the
  // blanket 4xx rule was swallowing exactly the failure the D68 ladder exists to absorb. MEASURED: a
  // handshake carrying 429 classified `permanent`, skipped the ladder, and reached the user as a hard stop
  // with no retry indicator at all. Stripping the token before the test keeps every OTHER 4xx permanent,
  // including a string that carries both (e.g. a 403 alongside a 429 in the same debug text).
  return /\b4\d\d\b/.test(s.replace(/\b429\b/g, ""));
};

// RAWY-266 (stage 3): the retry decision, now made on the PHASE rather than on one ambiguous phrase.
//
// WHAT CHANGED AND WHY. RAWY-193 suppressed every retry after a timeout on the premise that the socket had
// gone quiet, so retrying would only pile up silence. RAWY-265 tested that premise directly with an isolated
// probe on the same crate, same voice, real sentences from the owner's own book, and NO deadline at all:
// 105 requests, 105 completed, ZERO hung. The requests Sard was abandoning were alive and still working.
// The premise does not hold for a budget timeout, so the suppression it justified is narrowed to the single
// case that can still mean a dead socket: a stall that RECURS on a fresh connection.

/** Budget ran out BEFORE this phase could do its work — no socket was even established for it, so there is
 *  nothing gone-quiet to burn a window on. Exactly the class RAWY-257 C1 identified as wrongly suppressed:
 *  C1 fixed the JS predicate, but Rust still emitted the SYNTH phrase when the budget expired during
 *  connect, so the hole stayed open until stage 1 separated the phases. Always retryable. */
const isTransientTimeout = (e: unknown): boolean => {
  const s = String(e);
  return s.includes("edge voices timed out") || s.includes("edge connect timed out") || s.includes("edge synth timed out");
};

/** Synthesis RAN and did not finish inside its slice — the shape of every failure the owner actually hit.
 *  Measured slow-but-alive, so it is retried ONCE, and that retry necessarily runs on a FRESH socket because
 *  a stall leaves Rust's warm-client slot empty. A second stall on the fresh socket is the operational
 *  definition of a genuine stall, and is surfaced. The JS ceiling sentinel is included: at 13 s over Rust's
 *  12 s it should never fire, and if it does the IPC itself is stuck, which a retry may still clear. */
const isSynthStall = (e: unknown): boolean => {
  const s = String(e);
  return s.includes("edge synth stalled") || s.includes("synthTimeout");
};


// RAWY-247: when `decodeAudioData` fails, this holds what we FAILED to decode (Defect C / §1.5), read by
// `noteFailure`. There is no per-message content-type on the Edge WebSocket, so the first bytes are the
// sniff: `3c` ("<") = HTML/XML error page, `7b` ("{") = JSON, `00 00` = empty/garbage, `49 44 33`/`ff fb` = MP3.
let pendingDecodeInfo: { bytes: number; head: string } | null = null;

// RAWY-231: the scheduler's dispatch — invoke (bounded so a stalled socket frees the single-flight slot) →
// parse the framed word timings → decode to an AudioBuffer. Engine-agnostic (WebAudio decodes
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
  // RAWY-264: playback needs the ENCODED bytes, and the decode below DETACHES them (the Phase 1 defect
  // above), so the copy must be taken first. This copy is what is cached and played; the AudioBuffer that
  // decoding produces is used only to validate the payload and read its duration, then released.
  ttrace("decode START", { bytes: audio.byteLength, ctxState: (ctx && ctx.state) || "no-ctx" });
  const bytes = audio.slice(0);
  let buffer: AudioBuffer;
  try {
    buffer = await audioCtx().decodeAudioData(audio);
    ttrace("decode OK", { seconds: +buffer.duration.toFixed(2), rate: buffer.sampleRate, channels: buffer.numberOfChannels });
  } catch (e) {
    // RAWY-247 (Part 3): the byte length + first 16 bytes (hex + ASCII sniff) of the non-audio payload, so
    // the owner can read WHY a decode failed without devtools (Defect C / §1.5 / feeds RAWY-248).
    ttrace("decode FAILED", { err: String(e).slice(0, 200), sniff });
    pendingDecodeInfo = sniff;
    throw e; // the ORIGINAL decode error now propagates, so `classifyFailure` sees the real thing
  }
  // RAWY-257 2B (C9 / D69): EMPTY or zero-length EDGE audio is raised HERE, inside the attempt, so the ladder
  // can retry it. RAWY-231 made it an immediate hard stop; `OPEN.md` documents that a throttled Edge endpoint
  // "returns SHORT / garbled audio with NO error", so that turned a RECURRING PROVIDER BEHAVIOUR into a
  // stopped chapter. Detection is KEPT — it is never silently skipped; it now reaches the same explicit pause
  // only after the ladder is exhausted.
  // A punctuation-only unit legitimately decodes to an empty buffer, so it is returned as-is and
  // `playFrom` keeps its RAWY-159 skip for it.
  if (curEngine === "edge" && (!buffer || buffer.length === 0 || buffer.duration === 0)) {
    ttrace("decode EMPTY (decoded, but zero-length audio)", { sniff });
    pendingDecodeInfo = sniff;
    throw new Error("empty-audio (0-length buffer)");
  }
  // RAWY-264: the decoded PCM has now done its two jobs — proving the payload is real audio and yielding
  // its duration — and playback does not use it. Keeping only `durationSec` is what drops the cached cost
  // of a sentence from ~1.67 MB to ~53 KB; `buffer` goes out of scope here and is collectable.
  return { bytes, durationSec: buffer.duration, words };
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
// only EXHAUSTION does. `failStreak` is left to `playFrom` exactly as it was.
/** RAWY-266 (stage 3): is index `i` still inside the window the scheduler would keep it in? This MIRRORS
 *  the scheduler's own [priority − behind, priority + ahead] bound instead of reaching into it, so the ladder
 *  still reads and mutates no scheduler state — the property that keeps retry policy out of the scheduler's
 *  territory. A `function` (not a `const`) so it hoists above `synthDispatch`, which the scheduler below is
 *  constructed with. */
function stillWanted(i: number): boolean {
  const p = scheduler.priority;
  return i >= p - CACHE_KEEP_BEHIND && i <= p + PREFETCH_MAX_AHEAD;
}

async function synthDispatch(i: number): Promise<Synthesized> {
  pendingDecodeInfo = null; // don't let a recovered attempt's sniff be attributed to a later, different failure
  const t0 = performance.now();
  const startGen = gen; // RAWY-266: the chapter/voice this ladder belongs to
  let stallRetries = 0;
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
      if (isPermanentFailure(e)) break;     // C3: a permanent failure must NOT enter the ladder
      // RAWY-266 (stage 3): the policy, stated at the point of decision.
      //   stall     — synthesis ran and did not finish. Retried ONCE, necessarily on a fresh socket (the
      //               stall empties Rust's warm slot). A recurrence there is the genuine stall RAWY-193 was
      //               written for, and is surfaced.
      //   transient — the budget expired before voices/connect/synth could even begin. No socket existed to
      //               have gone quiet, so it takes the full backoff ladder. This is the behaviour C1
      //               intended and could not reach until stage 1 stopped Rust labelling it as a synth stall.
      //   other     — decode faults and the like: unchanged, they keep the ladder they already had.
      const retryClass = isSynthStall(e) ? "stall" : isTransientTimeout(e) ? "transient" : "other";
      if (retryClass === "stall") {
        if (stallRetries >= STALL_RETRY_LIMIT) break;
        stallRetries++;
      }
      if (ttsDebugOn) logStall(`retry:${retryClass}:${classifyFailure(e)}`, i);

      // ---- RAWY-266 (stage 3): three guards, all BEFORE committing to another attempt ----
      // 1. SUPERSEDED. A chapter change, voice change or stop bumps `gen`. Without this the ladder would go
      //    on occupying the single-flight engine for work whose result is already guaranteed to be discarded.
      if (gen !== startGen) break;
      // 2. ABANDONED. The listener skipped away, so this index is outside the window the scheduler is still
      //    willing to keep. Checked against the scheduler's own cursor rather than by reaching into it, so
      //    the ladder still touches no scheduler state (the property that keeps this out of 2C's territory).
      if (!stillWanted(i)) break;
      // 3. TOTAL CEILING. Only start another attempt if a WHOLE one can finish inside the ladder's budget;
      //    testing elapsed alone would let a final attempt overrun to ~40 s. With 27 000 / 13 000 this
      //    permits exactly two attempts, which is where the measured recovery curve flattens.
      if (performance.now() - t0 + SYNTH_TIMEOUT_MS > MAX_DISPATCH_MS) break;
    }
  }
  useTts.setState({ retryAttempt: 0 });
  // RAWY-193 unchanged: a sustained EDGE failure rejects with the sentinel so `playFrom` raises the explicit
  // "Edge unavailable" pause. The voice is NEVER changed here (D37) — recovery remains
  // the user pressing it.
  if (curEngine === "edge") throw new Error(`${TTS_EDGE_DOWN}: ${lastErr}`);
  throw lastErr;
}

// The one serialized, priority-ordered, drop-on-move synth scheduler (invariants B + C live here).
const scheduler = new SynthScheduler<Synthesized>(synthDispatch, {
  behind: CACHE_KEEP_BEHIND,
  ahead: PREFETCH_MAX_AHEAD,
  // RAWY-257 4B (A2): seconds govern the window; `ahead` above is only the O(1) safety cap.
  targetSeconds: LEAD_TARGET_SECONDS,
  lowWaterSeconds: LEAD_LOW_WATER_SECONDS,
  // The scheduler must stay PURE, so it is told HOW to read a duration rather than learning what an
  // AudioBuffer is. A punctuation-only unit legitimately decodes to 0 s — that contributes nothing to
  // the lead, which is correct: it is no cover.
  durationOf: (s) => s.durationSec, // RAWY-264: the duration decoding measured, kept without the PCM
  // RAWY-257 4B (A2): a synth landed, so the decoded lead changed and ONE more index may now be justified.
  // The scheduler cannot request it itself — only this module knows how long the chapter is.
  onSettled: () => { if (useTts.getState().active) prefetchFrom(scheduler.priority); },
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
  // RAWY-266 (stage 1): ONE KIND PER PHASE. These four used to be a single indistinguishable
  // `timeout-rust-8s`, which is why RAWY-265 could say only "three identical timeouts" and could not say
  // whether the budget went on fetching voices, opening a socket, or synthesising. Checked before the
  // looser `edge connect` / `edge synth` matches below, which stay for non-timeout faults.
  if (s.includes("tts.synthTimeout")) return "timeout-js";
  if (s.includes("edge voices timed out")) return "timeout-voices";
  if (s.includes("edge connect timed out")) return "timeout-connect";
  if (s.includes("edge synth stalled")) return "stall-synth";
  if (s.includes("edge synth timed out")) return "timeout-synth";
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
    // RAWY-267: indices retained after a rejected dispatch instead of being deleted and re-dispatched.
    failedRetained: scheduler.failedCount,
    priority: scheduler.priority,
    // RAWY-257 4B (A2): the quantity the fixed-unit window could not express — CONTIGUOUS decoded seconds
    // ahead of the cursor. This is what G-4B measures on both content profiles; `lowWater` is the reported
    // threshold it is measured against, NOT a refill gate.
    bufferedSeconds: Math.round(scheduler.bufferedSecondsAhead() * 100) / 100,
    wantedAhead: scheduler.wantedAhead(),
    leadTarget: LEAD_TARGET_SECONDS,
    leadLowWater: LEAD_LOW_WATER_SECONDS,
    // RAWY-257 (Phase 1, item 3): the TWO series, kept apart. `dispatch` is the engine's real cost (the
    // distribution D70 needs before the 8 s/9 s ceiling stops being PROVISIONAL); `await` is what playback
    // waited, which is what SYNTH_TIMEOUT_MS is actually applied to. await.max ≫ dispatch.max = C2, measured.
    dispatchMs: seriesSummary(scheduler.dispatchLatency),
    awaitMs: seriesSummary(awaitLatency),
    lastFailure: lastFail,
    debug: ttsDebugOn,
    // ---- RAWY-264: playback-substrate health ----
    // AUDIO↔TEXT drift in ms: the pill's derived clock minus the media pipeline's own position.
    // Positive = the pill runs AHEAD of the voice. `slopeMsPerSec` is the one that matters — a fixed offset
    // is imperceptible, a growing one would desynchronise a long sentence.
    drift: driftN
      ? {
          n: driftN,
          meanMs: +(driftSum / driftN).toFixed(2),
          minMs: +driftMin.toFixed(2),
          maxMs: +driftMax.toFixed(2),
          slopeMsPerSec: driftSlope() === null ? null : +(driftSlope() as number).toFixed(3),
        }
      : null,
    // Blob-URL accounting. `live` is bounded by the pool size by construction; if it ever exceeds it, a slot
    // was reused without being revoked. The pool elements are NOT in the DOM (`new Audio()`), so this is the
    // only way to observe the live element — a `querySelectorAll('audio')` probe silently matches nothing.
    blobs: { created: blobsCreated, revoked: blobsRevoked, live: mediaUrls.filter(Boolean).length },
    playRejections,
    media: mediaEl
      ? {
          rate: mediaEl.playbackRate,
          preservesPitch: mediaEl.preservesPitch,
          currentTime: +mediaEl.currentTime.toFixed(3),
          paused: mediaEl.paused,
          isBlob: String(mediaEl.currentSrc || mediaEl.src).startsWith("blob:"),
          poolSize: mediaEls.length,
          readyState: mediaEl.readyState,
        }
      : null,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __sardTtsStats?: () => unknown }).__sardTtsStats = ttsStats;
  // WP-5: a dev/debug surface, same convention as __sardTtsStats — lets the M1 harness verify the
  // SHIPPING compatibility rule rather than a copy of it. No UI, no behaviour.
  (window as unknown as { __sardVoiceCompat?: unknown }).__sardVoiceCompat = { voiceCompatibility, isImplausiblyShortAudio };
  // RAWY-257 (Phase 1, item 4): arm the fault seam — DEV ONLY, and only ever from a console.
  //   __sardTtsFault("fail-fast")            → next synth attempt fails instantly (the C3 case)
  //   __sardTtsFault("fail-fast", { times: 6 }) → six attempts fail (3 ladder rounds × first+retry)
  //   __sardTtsFault("stall", { ms: 6000 })  → slow BUT SUCCESSFUL: 6 s, then the real call (G-2A grading)
  //   __sardTtsFault("stall")                → never resolves (a hung socket)
  //   __sardTtsFault("empty") / ("truncated") → the C9 / decode-non-audio payloads
  //   __sardTtsFault("off")                  → disarm
  if (import.meta.env.DEV) {
    (window as unknown as { __sardTtsFault?: (m: FaultMode, o?: { ms?: number; times?: number; msg?: string }) => unknown }).__sardTtsFault = (m, o) => {
      fault = { mode: m, ms: o?.ms ?? 0, times: m === "off" ? 0 : (o?.times ?? 1), msg: o?.msg };
      return { ...fault };
    };
  }
}

const audioCtx = (): AudioContext => {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
    ttrace("AudioContext created", { state: ctx.state, rate: ctx.sampleRate });
  }
  // DIAGNOSTIC BUILD: publish the context so the collector can watch `state` and `currentTime`. The
  // karaoke clock is derived from currentTime, which does NOT advance while a context is suspended.
  try {
    diagPublishAudio(ctx);
  } catch {
    /* ignore */
  }
  return ctx;
};

// RAWY-180 (Part A): the shared output GainNode — every source connects HERE (not straight to the
// destination), so the volume applies to playback. Recreated if the AudioContext was replaced.
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
// no timing, which keeps that sentence at the Phase-1 sentence level.
function parseFramed(raw: ArrayBuffer): { words: TtsWord[]; audio: ArrayBuffer } {
  const dv = new DataView(raw);
  const jlen = dv.getUint32(0); // big-endian, matches Rust `to_be_bytes`
  const words: TtsWord[] = jlen ? JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, jlen))) : [];
  // DIAGNOSTIC BUILD: `jlen` is the whole word-level story. jlen === 0 means Edge returned audio with
  // NO timing metadata, so the karaoke loop takes its early return and the word cursor never moves —
  // while the audio plays perfectly. Recorded at the source so it can never be confused with a
  // rendering fault further down.
  try {
    diagNote("tts.synth", "MEASURED", "word-timing frame received", {
        jsonLengthBytes: jlen,
        wordCount: words.length,
        audioBytes: raw.byteLength - 4 - jlen,
        note: jlen === 0
          ? "NO word timings returned — word karaoke will be skipped by its own early return"
          : "timings present",
      });
  } catch {
    /* never let instrumentation affect playback */
  }
  return { words, audio: raw.slice(4 + jlen) };
}

// RAWY-193: does this synth failure mean the Edge SERVICE is down (→ pause + prompt), vs a skippable bad
// segment? True for the bounded-retry sentinel, or a synth stall (the RAWY-172 timeout) — the caller gates
// this on `curEngine === "edge"`, so an unspeakable sentence still skips (RAWY-159).
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
// RAWY-FINAL: the live tick, kept so a PARKED loop (see below) can be restarted without rebuilding the
// anchor. null whenever no sentence has karaoke scheduled.
let karaokeTick: (() => void) | null = null;

// RAWY-FINAL: the loop runs only while sound is being produced or awaited.
//
// THE DEFECT. `tick` re-requested a frame unless `gen` moved or the session went inactive — neither of
// which happens on a PAUSE or at CHAPTER-END. So:
//   • paused — the context is suspended, `ctx.currentTime` is frozen, `k` never changes and no state is
//     published: a pure ~60 Hz spin for as long as the listener stays paused;
//   • chapter-end — `playFrom`'s `i >= sentences.length` branch returns after `set({status:"chapter-end"})`
//     without calling `stopSource()` or `stopKaraoke()` and without bumping `gen`, so the LAST sentence's
//     loop kept requesting frames INDEFINITELY;
//   • error / edge-error — same shape (`stopSource()` runs, `stopKaraoke()` does not).
// A continuously scheduled rAF keeps the compositor from idling, which is a battery cost in exactly the
// states a reader sits in longest. Driven by Edge word timings, and `startKaraoke`
// returns before scheduling anything.
//
// PARKING, NOT STOPPING. The loop releases its frame but `karaokeWords` / `karaokeAnchor` / the STORE's
// `words`+`wordIndex` are left untouched, so the pill stays exactly where it was — RAWY-230 §2a (the pill
// survives a pause) holds by construction, and the Reader's `ttsStatus`-dependent effect still redraws it.
// The anchor stays valid across a pause because a SUSPENDED AudioContext does not advance `currentTime`.
const karaokeShouldRun = (s: Status): boolean => s === "playing" || s === "buffering";

/** Restart a parked loop. Called on resume; a no-op if the loop is already running or nothing is scheduled. */
function resumeKaraoke() {
  if (!karaokeRaf && karaokeTick && karaokeWords.length) karaokeRaf = requestAnimationFrame(karaokeTick);
}

function stopKaraoke() {
  if (karaokeRaf) { cancelAnimationFrame(karaokeRaf); karaokeRaf = 0; }
  karaokeWords = [];
  karaokeLastIdx = -2;
  karaokeTick = null;
}

/** Schedule (or clear) the pill for the sentence that just started playing at ctx time `t0`.
 *  `audio0` is the position the element had ALREADY reached when the anchor was taken — `play()` resolves
 *  after audio has begun, so anchoring at 0 would bake that offset in as permanent drift (RAWY-264). */
function startKaraoke(words: TtsWord[], t0: number, myGen: number, audio0 = 0) {
  stopKaraoke();
  useTts.setState({ words, wordIndex: -1 });
  if (!words.length) return; // no timing → sentence-level only (no pill)
  karaokeWords = words;
  // RAWY-264: the anchor advances audio-time per wall-second, so its rate is simply the listener's speed —
  // word offsets are always on the natural (1.0) timeline now, and the element consumes that timeline
  // `speed` times faster. One rule for both engines, with no per-engine special case.
  karaokeAnchor = { wall: t0, audio: audio0, rate: useTts.getState().speed };
  const c = audioCtx();
  const tick = () => {
    const st = useTts.getState();
    if (myGen !== gen || !st.active) { karaokeRaf = 0; karaokeTick = null; return; }
    // RAWY-FINAL: PARK (release the frame, keep the state) whenever nothing is sounding or being awaited.
    // `resumeKaraoke()` restarts it; every other exit from these states bumps `gen`, which the check above
    // then turns into a real stop.
    if (!karaokeShouldRun(st.status)) { karaokeRaf = 0; return; }
    const audioTime = karaokeAnchor.audio + (c.currentTime - karaokeAnchor.wall) * karaokeAnchor.rate;
    // RAWY-264 (measurement, not behaviour): the media pipeline exposes its OWN position in the same
    // timeline the word offsets use, so the pill's derived clock is compared against ground truth every
    // frame. Sampled only while sound is actually being produced.
    if (mediaEl && !mediaEl.paused && mediaEl.currentTime > 0) {
      noteDrift((audioTime - mediaEl.currentTime) * 1000, mediaEl.currentTime);
    }
    let k = -1;
    for (let j = 0; j < karaokeWords.length; j++) {
      if (karaokeWords[j].offset / 1e7 <= audioTime) k = j; // 100-ns ticks → seconds; offsets ascend
      else break;
    }
    if (k !== karaokeLastIdx) { karaokeLastIdx = k; useTts.setState({ wordIndex: k }); }
    karaokeRaf = requestAnimationFrame(tick);
  };
  karaokeTick = tick;
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

// RAWY-264: the element IS the source, so it obeys the same contract the AudioBufferSourceNode did —
// silent immediately, and its `ended` handler detached so a stopped sentence can never advance the queue.
// The slot's blob URL is NOT revoked here: `stopSource` runs at every sentence transition, and the URL is
// released when its slot is next reused (or by `releaseMedia` at session end). That is what bounds live
// blob URLs to the pool size instead of the session length.
const stopSource = () => {
  clearWatchdog(); // RAWY-159: a new/stopped source must not leave a stale advance timer running
  if (mediaEl) {
    try {
      mediaEl.onended = null;
      mediaEl.pause();
    } catch {
      /* already stopped */
    }
    mediaEl = null;
  }
};

// RAWY-172 (AUD-1) / RAWY-231: bounded memory is the scheduler's job — `reprioritize(idx)` trims the
// decoded-audio cache on every advance/seek, so a decoded sentence's ~0.19 MB/s of PCM can't accumulate the
// ~650 MB/hour it once did. RAWY-257 4B (A2): the trim bound is now [idx-CACHE_KEEP_BEHIND … the point at
// which LEAD_TARGET_SECONDS of decoded audio is reached], hard-capped at PREFETCH_MAX_AHEAD units — so the
// bound is ~15 s of audio (≈2.9 MB) rather than a unit count whose size in MB varied 2.5× with content.
// A skip-back below the window simply re-synthesizes (a cache miss re-requests), so nothing depends on
// retaining old buffers.

// RAWY-172 (AUD-2): resolve `p`, or reject after `ms` if it stalls — so a never-resolving synth can't
// hang the queue. The scheduler drops a rejected index from its
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
// RAWY-257 4B (A2): the depth is no longer a constant — the scheduler reports how many indices ahead the
// DECODED lead justifies, and it grows by exactly ONE per landed synth (D71's "one request at a time").
// Re-requesting the indices already held is free: `request()` returns the existing entry.
function prefetchFrom(idx: number): void {
  const want = scheduler.wantedAhead();
  for (let k = 1; k <= want; k++) {
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
  // RAWY-257 3C-1 (C7): retire the OLD sentence's karaoke state in the SAME publish that announces the new
  // index. `words`/`wordIndex` describe the sentence that just finished; the moment `index` moves they are
  // stale, and `stopKaraoke()` clears only its module-local copies — the STORE kept the old values until
  // `startKaraoke` runs, which is at the very END of this function, after the synth await.
  //
  // On an AUTO-ADVANCE that underruns, that window is the whole wait, and Reader's two effects then paint a
  // wrong pill inside it: the first rebuilds the word sub-ranges for the NEW sentence out of the PREVIOUS
  // sentence's word list, and the `playing → buffering` status flip re-runs the second with the stale
  // `wordIndex`, so a pill is drawn on the new sentence while nothing is being spoken. MEASURED: 12/12
  // samples across a buffering window carried a pill; the same window reached by `skip()` — which already
  // resets `wordIndex` — carried none in 10/10, which is what localises the fix here.
  //
  // Publishing empty values is sufficient and needs NO Reader change: `setReadingWords` returns early on an
  // empty list (leaving `wordRanges` empty) and `showReadingWord(-1)` removes the pill and draws nothing —
  // the correct state while nothing is being spoken. `startKaraoke` republishes the real values when the
  // audio actually starts, so timing and audio-clock anchoring are untouched.
  set({ index: idx, status: ready ? "playing" : "buffering", words: [], wordIndex: -1 });
  if (!ready && !establishLead) { ttsUnderruns++; logStall("underrun", idx); }

  // RAWY-159: skip the current sentence and continue — one bad segment must NEVER halt the queue. A
  // genuine dead end (a RUN of FAIL_LIMIT consecutive failures, e.g. offline) still surfaces
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
    // an unspeakable sentence still skips per RAWY-159.
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
    // or swap the voice — PAUSE and surface the explicit "Edge unavailable" state (Retry),
    // visible in EVERY pill state (the player force-expands out of the kashida on this status). A non-Edge
    // failure (unspeakable "…"/"..." that yields empty audio) keeps RAWY-159 skip.
    // RESILIENCE-1 / WP-5B: a voice that cannot render this book's script is TERMINAL and must not be
    // offered as "Edge unavailable — Retry", which is a different problem with a useless action here.
    // Checked BEFORE the edge-down branch because the marker would otherwise be absorbed by it.
    if (String(e).includes(VOICE_MISMATCH_MARKER)) {
      noteFailure(idx, e);
      stopSource();
      set({ status: "voice-mismatch", mismatch: { voiceId: curVoice, engine: curEngine, bookScript: lastStart?.bookScript ?? null } });
      return;
    }
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
  // it silently. An empty buffer can be legitimate punctuation-only text, so keep the RAWY-159 skip.
  // RAWY-264: the same condition, now read off the duration decoding measured (and the byte length) rather
  // than a retained AudioBuffer — zero-length audio is still detected exactly where it always was.
  if (!synthd.bytes || synthd.bytes.byteLength === 0 || synthd.durationSec === 0) {
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
  // RAWY-159: advance exactly ONCE, whether the sentence ends normally OR the watchdog fires.
  let advanced = false;
  const advance = () => {
    if (advanced || myGen !== gen) return;
    advanced = true;
    clearWatchdog();
    void playFrom(idx + 1, myGen);
  };

  // RAWY-264: hand the sentence to the next element in the pool. Alternating slots is what lets the element
  // that just finished be torn down while the new one is already loading, and it bounds live blob URLs to
  // the pool size. `media-src 'self' blob:` in tauri.conf.json exists for exactly this `createObjectURL`.
  const pool = mediaPool(c);
  mediaSlot = (mediaSlot + 1) % pool.length;
  const el = pool[mediaSlot];
  revokeSlot(mediaSlot); // whatever this slot played last is now unreachable
  // MP3 through an <audio> element. On WebKitGTK this depends on the system's GStreamer plugins,
  // which is exactly the kind of thing that differs from WebView2 and would not show up as a
  // synthesis failure.
  ttrace("media START", { bytes: synthd.bytes.byteLength, type: "audio/mpeg" });
  const url = URL.createObjectURL(new Blob([synthd.bytes], { type: "audio/mpeg" }));
  blobsCreated++;
  mediaUrls[mediaSlot] = url;
  el.src = url;
  el.playbackRate = useTts.getState().speed; // TIME-STRETCHED, not resampled — the voice is preserved
  el.onended = advance;
  mediaEl = el;
  const startedAt = c.currentTime;
  try {
    ttrace("media canPlayType", { mpeg: el.canPlayType("audio/mpeg"), mp4: el.canPlayType("audio/mp4") });
    await el.play().then(
      () => ttrace("media play OK", { paused: el.paused, dur: el.duration, ctx: (mediaCtx && mediaCtx.state) || "no-ctx" }),
      (e) => { ttrace("media play FAILED", String(e).slice(0, 200)); throw e; },
    );
  } catch {
    // A rejected play() would strand playback in silence with no visible cause, so it is treated as a failed
    // sentence and takes the SAME route a synth failure takes (RAWY-159 skip, dead-end counting).
    playRejections++;
    if (myGen !== gen) return;
    skipSegment("tts.playRejected");
    return;
  }
  // `play()` is awaited, so a stop/skip may have landed while it resolved — that generation check is the
  // difference between a stopped sentence going silent and it speaking over its replacement.
  if (myGen !== gen) { try { el.pause(); } catch { /* raced with stopSource */ } return; }
  // The watchdog is the safety net for a sentence whose `ended` never arrives (an edge-case stuck element)
  // — it advances only after the audio COULD have finished even at the slowest speed, and it polls the
  // AudioContext clock (which freezes while paused), so a long pause never trips it.
  const maxCtxSeconds = synthd.durationSec / TTS_MIN_SPEED + 2; // slowest-case play time + margin
  clearWatchdog();
  watchdog = setInterval(() => {
    if (myGen !== gen) { clearWatchdog(); return; }
    if (c.currentTime - startedAt > maxCtxSeconds) advance();
  }, 500);
  // RAWY-127: schedule the karaoke pill against the AudioContext clock (empty words → sentence-level only).
  // RAWY-264: anchored on the element's OWN position, because `play()` resolved after audio had already
  // begun — anchoring at 0 would bake that head start in as a permanent offset.
  startKaraoke(synthd.words, c.currentTime, myGen, el.currentTime);
}

// Play from `fromIndex`. Edge synthesizes over the network with no local model, so there is nothing to
// prepare before playback. Shared by start / setVoice / resumeEdge (RAWY-193).
async function ensureAndPlay(voice: string, fromIndex: number, myGen: number) {
  void voice;
  if (myGen !== gen) return;
  // RAWY-231: an ENTRY into playback — establish the one-ahead lead before beginning (invariant A), so the
  // second sentence of a chapter/landing never underruns.
  void playFrom(fromIndex, myGen, true);
}

// DIAGNOSTIC BUILD ONLY — instrumentation, no behaviour change.
function ttrace(event: string, detail?: unknown): void {
  const line = detail === undefined ? `TTS      ${event}` : `TTS      ${event} ${JSON.stringify(detail).slice(0, 400)}`;
  const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__?.invoke;
  try { void inv?.("diag_log", { line: `[tts] ${line}` }); } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log(line);
}

export const useTts = create<TtsState>((rawSet, get) => {
  // Every transition, with the state it came from: the spinner is a status that never advances, and
  // only the sequence shows which one it stopped at.
  const set: typeof rawSet = ((patch: unknown, ...rest: unknown[]) => {
    const p = typeof patch === "function" ? "(fn)" : patch;
    if (p && typeof p === "object" && "status" in (p as Record<string, unknown>)) {
      ttrace("status", { from: (get() as { status?: string }).status, to: (p as { status?: unknown }).status, error: (p as { error?: unknown }).error ?? null });
    }
    return (rawSet as (...a: unknown[]) => unknown)(patch, ...rest);
  }) as typeof rawSet;
  return {
  active: false,
  status: "idle",
  mismatch: null,
  endDismissed: false,
  engine: "edge",
  voice: "",
  lang: "en",
  speed: 1,
  volume: 1, // RAWY-180: full volume until the user lowers it (or a saved level loads on start)
  index: 0,
  total: 0,
  words: [],
  wordIndex: -1,
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
    const { sentences: sen, lang, startIndex = 0, chapterLabel, bookScript = null } = opts;
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
    // RAWY-281: an in-range stored value is SNAPPED to the nearest selectable speed, so the invariant
    // "speed is always a member of TTS_SPEEDS" holds on the restore path too, not only through
    // `setSpeed`. Lossless for every value that could have been stored — the old grid's six are all
    // members, and 1.10 (which only the new list can produce) maps to itself.
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? nearestSpeed(saved) : get().speed;
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
    set({ active: true, status: "preparing", endDismissed: false, lang, speed, volume, index: startIndex, total: units.length, chapterLabel, error: null, words: [], wordIndex: -1 });
    if (units.length === 0) {
      set({ status: "error", error: TTS_EMPTY });
      return;
    }
    // Resolve the saved voice for this language inside the gesture chain.
    ttrace("resolveVoicePref START", { lang });
    const { engine, id } = await resolveVoicePref(lang).then(
      (v) => { ttrace("resolveVoicePref OK", v); return v; },
      (e) => { ttrace("resolveVoicePref FAILED", String(e).slice(0, 200)); throw e; },
    );
    if (myGen !== gen) return;
    curEngine = engine;
    curVoice = id;
    set({ engine, voice: id });

    // RESILIENCE-1 / WP-5A — THE PRE-FLIGHT. Refuse BEFORE the first synthesis, never after.
    //
    // Measured (M1): a non-Arabic Edge voice fed Arabic returns HTTP success carrying 6 bytes — the
    // reader hears silence and nothing in the pipeline sees a failure. Worse: an English
    // model fed Arabic returns REAL audio, phonemised under English rules, so there is no signal at
    // all. Neither can be caught after the fact, which is why the check lives here.
    //
    // The voice id carries its own locale for BOTH engines ("ar-EG-SalmaNeural", "ar_JO-kareem-
    // medium"), so no voice-list lookup is needed and the gate cannot be defeated by a cold cache.
    if (bookScript && voiceCompatibility(bookScript, { id, lang: id }) === "incompatible") {
      const allowed = await settingsGet(`${VOICE_OK_PREFIX}${id}`).catch(() => null);
      if (myGen !== gen) return;
      if (!allowed) {
        // A terminal state, NOT an error the ladder can retry — nothing was dispatched, so there is
        // nothing to retry. The reader chooses a voice or overrides; both are explicit presses.
        set({ status: "voice-mismatch", mismatch: { voiceId: id, engine, bookScript } });
        return;
      }
    }
    void ensureAndPlay(id, Math.min(startIndex, units.length - 1), myGen);
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
      resumeKaraoke(); // RAWY-FINAL: the loop parked itself on pause — hand the frame back
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
    // control (Retry), never by a transport move. The guard used to block only
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

  // RAWY-264: speed is a property of PLAYBACK again. The element time-stretches, so the sentence in flight
  // changes speed WITHOUT changing voice and without restarting, and every buffered sentence stays valid at
  // the new speed. No cache clear, no generation bump, no re-synthesis, no network round trip.
  //
  // This RESTORES D71 ("no buffer clear on a speed change"), which the speed-at-synthesis implementation
  // had to break: with the rate baked into the audio, cached sentences carried the OLD rate and had to be
  // discarded. That discard was the direct cause of the G-264B boundary underrun, which cannot occur now.
  setSpeed: (s) => {
    // RAWY-281: snap to the nearest SELECTABLE speed instead of to a 0.25 grid. For every value the
    // old quantiser could produce the result is identical — the grid's six values are all in the list
    // — so no existing behaviour changes; 1.10 simply stops being rounded away to 1.00.
    const sp = nearestSpeed(s);
    if (mediaEl) mediaEl.playbackRate = sp;
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
    stopKaraoke(); // RAWY-127: changing the voice drops any pill; playFrom re-decides
    clearSkipSettle(); // RAWY-185: a live voice/engine switch supersedes a pending rapid-skip landing synth
    set({ engine, voice: id, status: "preparing", error: null, wordIndex: -1 });
    void ensureAndPlay(id, st.index, myGen);
  },

  // Re-run the last Listen after a download/synth failure (RAWY-106: a visible way to recover from a
  // flaky first-use download without leaving the reader).
  retry: () => {
    if (lastStart) void get().start(lastStart);
  },

  // RAWY-193: the "Edge unavailable" state's Retry — re-attempt the CURRENT sentence on the SAME engine
  // (the voice was never changed). Clears the cache so a stale failed synth from the outage can't
  // instantly re-trip the error, and resumes from the current index. Retry is the only action offered.
  resumeEdge: () => {
    const st = get();
    if (!st.active) return;
    scheduler.clearCache(); // RAWY-231: drop the outage's stale rejected synths so Retry re-attempts cleanly
    failStreak = 0;
    const myGen = ++gen;
    stopSource();
    stopKaraoke();
    set({ status: "preparing", error: null });
    void ensureAndPlay(curVoice, st.index, myGen);
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
    // RAWY-264: the session is over, so everything the playback substrate owns goes with it — elements
    // stopped and detached from their media, blob URLs revoked, source nodes disconnected. A blob URL is a
    // document-lifetime reference, so this is the point at which they would otherwise accumulate across
    // sessions. The next session rebuilds the pool on first use.
    releaseMedia();
    resetDrift(); // per-session, like the counters above it
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, error: null, words: [], wordIndex: -1, underruns: 0, abandoned: 0, lastFailure: null, retryAttempt: 0 });
  },
  };
});

// WP-5C: a dev/debug surface for the STORE itself, same convention as `window.__sardTtsStats` —
// it lets a harness drive a state (e.g. the voice-mismatch card) and measure how it RENDERS, without
// needing the network or a matching book. Read-only from the app's point of view: no UI, no
// behaviour, and nothing in the product reads it back.
if (typeof window !== "undefined") {
  (window as unknown as { __sardTtsStore?: unknown }).__sardTtsStore = useTts;
}
