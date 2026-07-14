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
export type TtsLang = "ar" | "en";

// The bundled Piper voices (one per language) — the OFFLINE anchor, always available (the engine the user
// gets when they explicitly Switch to Piper from the Edge-unavailable state, RAWY-193).
export const PIPER_VOICE: Record<TtsLang, string> = {
  ar: "ar_JO-kareem-medium",
  en: "en_US-lessac-medium",
};
export const piperVoiceRef = (lang: TtsLang): TtsVoiceRef => ({ engine: "piper", id: PIPER_VOICE[lang] });

// RAWY-113: Edge (neural) is the DEFAULT engine per design 6. First-use with no saved pref = Edge;
// if offline, playback PAUSES in the explicit "Edge unavailable" state (RAWY-193) — never a silent Piper swap.
export const EDGE_DEFAULT: Record<TtsLang, string> = {
  ar: "ar-EG-SalmaNeural",
  en: "en-US-AriaNeural",
};
export const defaultVoiceForLang = (lang: TtsLang): TtsVoiceRef => ({ engine: "edge", id: EDGE_DEFAULT[lang] });

// Friendly display name for the player's VOICE CHIP (RAWY-112 — the design's labelled chip, not a
// bare icon). Piper: the two bundled names; Edge: the short_name's voice part ("ar-EG-SalmaNeural" → "Salma").
export function voiceLabel(engine: TtsEngineKind, id: string): string {
  if (engine === "piper") return id === PIPER_VOICE.ar ? "Kareem" : id === PIPER_VOICE.en ? "Lessac" : id;
  const tail = id.split("-").pop() ?? id; // "SalmaNeural"
  return tail.replace(/Neural$/, "") || id; // "Salma"
}

// A row in the voice picker (RAWY-111) — Piper (2, offline) + every Edge neural voice for ar/en.
export interface PickerVoice { engine: TtsEngineKind; id: string; lang: TtsLang; locale: string; label: string; gender: string }
const PIPER_PICKER: PickerVoice[] = [
  { engine: "piper", id: PIPER_VOICE.ar, lang: "ar", locale: "ar", label: "Kareem", gender: "" },
  { engine: "piper", id: PIPER_VOICE.en, lang: "en", locale: "en", label: "Lessac", gender: "" },
];
let edgeVoicesCache: PickerVoice[] | null = null;
/** Piper (offline) + Edge (online neural) voices for the picker. Edge list is fetched once + cached;
 *  a failure (offline) yields Piper-only rather than throwing. */
export async function loadPickerVoices(): Promise<PickerVoice[]> {
  if (!edgeVoicesCache) {
    try {
      const list = await ttsEdgeVoices();
      edgeVoicesCache = list.map((v) => ({
        engine: "edge" as const,
        id: v.id,
        lang: (v.lang.toLowerCase().startsWith("ar") ? "ar" : "en") as TtsLang,
        locale: v.lang,
        label: v.label,
        gender: v.gender,
      }));
    } catch {
      edgeVoicesCache = []; // offline / endpoint down → Piper-only picker
    }
  }
  return [...PIPER_PICKER, ...edgeVoicesCache];
}

// Resolve the saved engine+voice for a language (persisted as "engine:id"); default = Edge (design 6).
async function resolveVoicePref(lang: TtsLang): Promise<TtsVoiceRef> {
  const saved = await settingsGet(`tts_voice:${lang}`).catch(() => null);
  if (saved) {
    const i = saved.indexOf(":");
    const engine = saved.slice(0, i);
    const id = saved.slice(i + 1);
    if ((engine === "piper" || engine === "edge") && id) return { engine, id };
  }
  return defaultVoiceForLang(lang);
}

type Status = "idle" | "preparing" | "downloading" | "playing" | "paused" | "error" | "chapter-end" | "edge-error";

// RAWY-188: `deferPrefetch` — start the FIRST sentence only (no prefetch window). Used for the chapter-TOP
// start when a same-chapter resume is being offered: if the user then resumes, only ONE cold synth was
// spent on the top (not four) so the resume target isn't stuck behind them on the serialized engine.
interface StartOpts { sentences: string[]; lang: TtsLang; startIndex?: number; chapterLabel: string; deferPrefetch?: boolean }

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
let cache = new Map<number, Promise<Synthesized>>();
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
// captive portal, a sleeping router) must not freeze read-aloud. Every synth is raced against this
// ceiling; on timeout the sentence is SKIPPED (the same RAWY-159 recovery), so playback always advances.
// Well above a normal synth (a second or two), so a slow-but-live link never false-trips it.
const SYNTH_TIMEOUT_MS = 20000;
// RAWY-172 (AUD-1): how many already-played sentences to keep decoded (besides the current +
// prefetched-next), so a one-sentence skip-back stays instant while memory stays bounded.
const CACHE_KEEP_BEHIND = 1;
// RAWY-181 (BUG 3): how many UPCOMING sentences to synthesize ahead of need. Was effectively 1 (and
// only kicked off AFTER the current started playing), which left silence when a short sentence ended
// before Edge's network synth of the next finished. Prefetching a small WINDOW (started as soon as a
// sentence begins) keeps the pipeline 2–3 ahead so the next buffer is ready when the current ends.
// Memory stays bounded/O(1): eviction keeps only [idx-CACHE_KEEP_BEHIND … idx+PREFETCH_AHEAD] decoded
// (≈5 sentences), not the whole chapter.
const PREFETCH_AHEAD = 3;
const clearWatchdog = () => {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
};

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
  if (!st.active || (st.status !== "playing" && st.status !== "paused")) return false;
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

const synth = (i: number): Promise<Synthesized> => {
  let p = cache.get(i);
  if (!p) {
    p = (async () => {
      let raw: ArrayBuffer;
      try {
        raw = await invoke<ArrayBuffer>("tts_synthesize", { engine: curEngine, id: curVoice, text: sentences[i] });
      } catch (e) {
        // RAWY-193: NO silent engine fallback — the deleted D37 swapped the voice to Piper mid-paragraph
        // without asking (a correctness violation). For Edge, ONE bounded retry absorbs a transient blip (a
        // stale/dropped warm socket the Rust one-shot reconnect didn't catch) WITHOUT changing the voice and
        // WITHOUT any notice — a micro-blip must be invisible, and the healthy path never reaches here. NO
        // backoff: the cold WS reconnect (~2.7 s, measured RAWY-191) is itself the delay, so a cascade would
        // only pile up silence — a sustained failure is handed to the USER, not retried forever. If the retry
        // also fails, reject with TTS_EDGE_DOWN → playFrom pauses and shows the explicit "Edge unavailable"
        // choice, never a silent Piper swap. A non-Edge (Piper) failure keeps its RAWY-159 skip behaviour.
        if (curEngine !== "edge") throw e;
        try {
          raw = await invoke<ArrayBuffer>("tts_synthesize", { engine: "edge", id: curVoice, text: sentences[i] });
        } catch {
          throw new Error(TTS_EDGE_DOWN);
        }
      }
      const { words, audio } = parseFramed(raw);
      return { buffer: await audioCtx().decodeAudioData(audio), words };
    })();
    cache.set(i, p);
    // RAWY-193: never RETAIN a rejected synth — evict it so a later revisit (esp. after the user hits Retry,
    // or a prefetch that failed during a blip) re-attempts cleanly instead of instantly re-failing on a stale
    // cached rejection. playFrom also deletes the awaited index; this generalises it to prefetched ones.
    void p.catch(() => { if (cache.get(i) === p) cache.delete(i); });
  }
  return p;
};

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

// RAWY-172 (AUD-1): drop decoded audio for sentences we've moved past, keeping only a small window
// (previous · current · prefetched-next). A decoded sentence retains ~0.19 MB/s of PCM, so keeping a
// whole chapter grew memory ~650 MB/hour of continuous listening; this bounds it regardless of chapter
// length. A skip-back below the window simply re-synthesizes (synth() re-runs on a cache miss — skip()
// never resets the cache), so nothing depends on retaining the old buffers.
function evictAudioBelow(idx: number): void {
  const floor = idx - CACHE_KEEP_BEHIND;
  for (const k of cache.keys()) if (k < floor) cache.delete(k);
}

// RAWY-172 (AUD-2): resolve `p`, or reject after `ms` if it stalls — so a never-resolving synth can't
// hang the queue. Engine-agnostic (covers Piper + Edge). The underlying promise is left to settle into
// nothing; the caller drops it from the cache so a later revisit re-synthesizes cleanly.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("tts.synthTimeout")), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

// RAWY-181 (BUG 3) / RAWY-186 (Part B): warm a WINDOW of upcoming sentences so the next buffers are
// decoded before they're needed. synth() dedupes via the cache (already-fetched = no-op) and
// evictAudioBelow bounds memory. Kept separate so a skip's LANDING can prefetch without the wasted
// leading also prefetching (that backlog on the serialized engine is what delayed a long skip's audio).
function prefetchFrom(idx: number): void {
  for (let k = 1; k <= PREFETCH_AHEAD; k++) {
    const j = idx + k;
    if (j >= 0 && j < sentences.length) void synth(j).catch(() => {});
  }
}

async function playFrom(i: number, myGen: number, prefetch = true) {
  const set = useTts.setState;
  if (i >= sentences.length) {
    // RAWY-184 (Part B): reached the LAST sentence — STOP and enter the "chapter-end" state (the owner
    // chose a "next chapter" button over auto-advance). The pill then offers Next chapter (if one exists)
    // or a gentle end-of-book state; playing/paused-gated shortcuts (Space, arrows) no-op here.
    set({ status: "chapter-end", endDismissed: false, index: Math.max(0, sentences.length - 1) });
    return;
  }
  const idx = Math.max(0, i);
  set({ index: idx, status: "playing" });
  evictAudioBelow(idx); // RAWY-172 (AUD-1): free the buffers we've moved past — bounded memory

  // RAWY-181 (BUG 3): request the CURRENT sentence first (most urgent), then warm a WINDOW of upcoming
  // synths so the next buffers are ready before they're needed (covers Edge's per-sentence network
  // latency across short sentences). RAWY-186 (Part B): a SPECULATIVE leading skip passes prefetch=false
  // so a flown-past sentence doesn't also enqueue 3 wasted synths ahead of the real landing on the
  // serialized engine — the landing (and normal advance) prefetch as usual.
  const current = synth(idx);
  if (prefetch) prefetchFrom(idx);

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
    cache.delete(idx); // don't keep a rejected promise cached (a later skip-back would re-throw)
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
  // Empty/zero-length audio (some engines still RETURN a valid-but-silent buffer for punctuation-only
  // text) → there is nothing to play and `onended` timing is unreliable, so skip rather than stall.
  if (!synthd.buffer || synthd.buffer.length === 0 || synthd.buffer.duration === 0) {
    skipSegment(TTS_EMPTY);
    return;
  }
  failStreak = 0; // a real, speakable sentence played → reset the dead-end counter
  // (RAWY-181: the upcoming window was already prefetched at the top of playFrom.)
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
async function ensureAndPlay(engine: TtsEngineKind, voice: string, fromIndex: number, myGen: number, prefetch = true) {
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
  void playFrom(fromIndex, myGen, prefetch);
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

  start: async (opts) => {
    lastStart = opts;
    const { sentences: sen, lang, startIndex = 0, chapterLabel, deferPrefetch = false } = opts;
    audioCtx(); // create within the user gesture so autoplay policy unlocks it
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127
    clearSkipSettle(); // RAWY-185: a fresh Listen cancels any pending rapid-skip landing synth
    skipLeadTarget = -1;
    skipLastTarget = -1;
    lastSkipAt = 0; // RAWY-186: the first skip of a new session must lead (not read as a continuation)
    cache = new Map();
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
    void ensureAndPlay(engine, id, Math.min(startIndex, sentences.length - 1), myGen, !deferPrefetch);
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
    // Move the index + sentence spotlight INSTANTLY (the RAWY-126/127 reader effects follow `index`), so
    // rapid skipping tracks on screen even though the landing sentence's audio is deferred below.
    set({ wordIndex: -1, index: target, status: "playing" });

    // RAWY-185/186: debounce the SYNTH. Only the FIRST skip of a skipping session synthesizes immediately
    // (the leading edge → a single skip is instant); every skip within SKIP_CONTINUE_MS of the previous is
    // a CONTINUATION (a held arrow key or fast repeats — crucially this spans the OS key-repeat DELAY, so a
    // hold fires the leading ONCE, not once per repeat burst) and only moves the index. When skipping
    // settles, the LANDING sentence synthesizes once. This keeps flown-past + re-leading cold synths off
    // the serialized engine so the landing's audio isn't stuck behind them (the long-skip lag).
    skipLastTarget = target;
    const now = performance.now();
    const continuing = now - lastSkipAt < SKIP_CONTINUE_MS;
    lastSkipAt = now;
    if (!continuing) {
      skipLeadTarget = target;
      void playFrom(target, myGen, false); // leading: play it, but DON'T prefetch a window it may fly past
    }
    // (Re)arm the settle. When skipping has been idle ~SKIP_SETTLE_MS: if it moved past the leading play,
    // synth the LANDING (with its prefetch window); otherwise it was a lone skip already playing — just
    // warm the next few so continuation stays gapless (the leading deliberately skipped its prefetch).
    clearSkipSettle();
    skipSettleTimer = setTimeout(() => {
      skipSettleTimer = null;
      if (!get().active) return; // stopped during the window (stop() also clears this timer)
      if (skipLastTarget !== skipLeadTarget) void playFrom(skipLastTarget, ++gen, true);
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
    cache = new Map(); // new voice → invalidate cached audio
    failStreak = 0; // RAWY-159: a new engine/voice is a fresh attempt at the current sentence
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127: switching engine (e.g. Edge→Piper) drops any pill; playFrom re-decides
    clearSkipSettle(); // RAWY-185: a live voice/engine switch supersedes a pending rapid-skip landing synth
    set({ engine, voice: id, status: "preparing", error: null, wordIndex: -1 });
    void ensureAndPlay(engine, id, st.index, myGen);
  },

  // RAWY-113 (design 6): the Engine chip switches engine, keeping the current language. It picks that
  // engine's default voice for the language (the Voices chip then refines the specific voice).
  setEngine: (engine) => {
    const lang = get().lang;
    const id = engine === "edge" ? EDGE_DEFAULT[lang] : PIPER_VOICE[lang];
    get().setVoice(engine, id, lang);
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
    cache = new Map();
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
    cache = new Map();
    sentences = [];
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, progress: 0, error: null, words: [], wordIndex: -1 });
  },
}));
