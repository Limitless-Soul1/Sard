// TTS playback (RAWY-105) — the frontend half of read-aloud. Rust synthesizes each sentence and
// returns raw audio bytes; here we decode them with WebAudio and play a QUEUE of sentences,
// synthesizing the NEXT while the current plays (hides synth latency). Controls: play/pause,
// skip ±sentence, speed.
//
// RAWY-110/111 (engine abstraction): a voice is {engine, id}; `synth` calls the dispatching
// `tts_synthesize(engine, id, text)`. Engine-agnostic — WebAudio decodes both Piper's WAV and Edge's
// MP3, so play/pause/skip/speed work the same. The chosen engine+voice persists PER LANGUAGE
// (`tts_voice:ar`/`tts_voice:en`), defaulting to EDGE (neural, design 6). Edge is online-required — a
// transient failure falls back to Piper PER SENTENCE (RAWY-113) without changing the user's chosen
// engine, and auto-recovers to Edge on the next sentence.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { settingsGet, settingsSet, ttsDownloadVoice, ttsEdgeVoices, ttsStop, ttsVoicePresent } from "./ipc";

export const TTS_MIN_SPEED = 0.75;
export const TTS_MAX_SPEED = 2.0;
export const TTS_SPEED_STEP = 0.25;
// Sentinel error the player localizes (RAWY-107) — distinct from a raw engine/download error, which
// the pill shows verbatim (RAWY-106). Set when a section genuinely has no readable text.
export const TTS_EMPTY = "empty-chapter";

// A voice is identified by its ENGINE + id (RAWY-110). "piper" = offline; "edge" = online neural.
export type TtsEngineKind = "piper" | "edge";
export interface TtsVoiceRef { engine: TtsEngineKind; id: string }
export type TtsLang = "ar" | "en";

// The bundled Piper voices (one per language) — the OFFLINE anchor, always available (also the
// per-sentence fallback when Edge hiccups, RAWY-113).
export const PIPER_VOICE: Record<TtsLang, string> = {
  ar: "ar_JO-kareem-medium",
  en: "en_US-lessac-medium",
};
export const piperVoiceRef = (lang: TtsLang): TtsVoiceRef => ({ engine: "piper", id: PIPER_VOICE[lang] });

// RAWY-113: Edge (neural) is the DEFAULT engine per design 6. First-use with no saved pref = Edge;
// if offline, playback falls back to Piper PER SENTENCE (non-destructive) until Edge resumes.
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

type Status = "idle" | "preparing" | "downloading" | "playing" | "paused" | "error";

interface StartOpts { sentences: string[]; lang: TtsLang; startIndex?: number; chapterLabel: string }

interface TtsState {
  active: boolean; // player pill visible
  status: Status;
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
  notice: string | null; // transient message (e.g. fell back to Piper); auto-clears
  start: (o: StartOpts) => Promise<void>;
  toggle: () => void;
  skip: (delta: number) => void;
  setSpeed: (s: number) => void;
  setVolume: (v: number) => void; // RAWY-180 (Part A): read-aloud output volume 0..1 (persisted)
  setVoice: (engine: TtsEngineKind, id: string, lang: TtsLang) => void;
  setEngine: (engine: TtsEngineKind) => void;
  retry: () => void;
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
let curLang: TtsLang = "en";
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let gen = 0; // bumped by stop/skip/start to invalidate in-flight async work
let lastStart: StartOpts | null = null; // for retry() after a download/synth failure

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
const clearWatchdog = () => {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
};

// Show a transient notice in the pill for a few seconds (RAWY-111: e.g. "Edge unavailable — Piper").
function flashNotice(msg: string) {
  useTts.setState({ notice: msg });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => useTts.setState({ notice: null }), 5000);
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

// RAWY-127: the Rust response is FRAMED — `[u32 BE json_len][json words][audio bytes]` — so the audio
// stays raw (no base64) while carrying its per-word timing. Split the header off; `words` is `[]` for
// Piper (and the Edge→Piper fallback), which keeps that sentence at the Phase-1 sentence level.
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
        // RAWY-113 (bug #14 fix): a transient Edge failure (dropped warm socket / net blip) falls back
        // to Piper for THIS SENTENCE ONLY — it does NOT change the user's chosen engine or the persisted
        // pref, so the NEXT sentence retries Edge and playback auto-recovers when connectivity resumes.
        // RAWY-127: the Piper fallback returns an empty word list, so this sentence degrades to
        // sentence-level (no pill) and the next Edge sentence resumes karaoke — seamless.
        if (curEngine !== "edge") throw e;
        flashNotice("tts.edgeHiccup");
        raw = await invoke<ArrayBuffer>("tts_synthesize", { engine: "piper", id: PIPER_VOICE[curLang], text: sentences[i] });
      }
      const { words, audio } = parseFramed(raw);
      return { buffer: await audioCtx().decodeAudioData(audio), words };
    })();
    cache.set(i, p);
  }
  return p;
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
  if (!words.length) return; // Piper / fallback / no timing → sentence-level only (no pill)
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

async function playFrom(i: number, myGen: number) {
  const set = useTts.setState;
  if (i >= sentences.length) {
    // reached the end of the chapter (Stage 2: auto-advance to the next chapter)
    set({ status: "paused", index: Math.max(0, sentences.length - 1) });
    return;
  }
  const idx = Math.max(0, i);
  set({ index: idx, status: "playing" });
  evictAudioBelow(idx); // RAWY-172 (AUD-1): free the buffers we've moved past — bounded memory

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
    // RAWY-172 (AUD-2): bound the synth so a stalled socket advances instead of freezing. Edge failures
    // still self-heal per-sentence inside synth() (RAWY-113); a genuine stall rejects here → skipSegment.
    synthd = await withTimeout(synth(idx), SYNTH_TIMEOUT_MS);
  } catch (e) {
    // This segment couldn't be synthesized (an unspeakable "…"/"..." that yields empty audio the
    // decoder rejects, a Piper exit with no WAV, both engines down, …). Skip it and keep reading.
    cache.delete(idx); // don't keep a rejected promise cached (a later skip-back would re-throw)
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
  if (idx + 1 < sentences.length) void synth(idx + 1).catch(() => {}); // prefetch next
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
// model, so it skips straight to playback. Shared by start / setVoice / the Edge→Piper fallback.
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
  void playFrom(fromIndex, myGen);
}

export const useTts = create<TtsState>((set, get) => ({
  active: false,
  status: "idle",
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
  notice: null,

  start: async (opts) => {
    lastStart = opts;
    const { sentences: sen, lang, startIndex = 0, chapterLabel } = opts;
    audioCtx(); // create within the user gesture so autoplay policy unlocks it
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127
    cache = new Map();
    failStreak = 0; // RAWY-159: a fresh Listen starts the dead-end counter clean
    sentences = sen.map((s) => s.trim()).filter(Boolean);
    curLang = lang;
    const saved = Number(await settingsGet("tts_speed").catch(() => null));
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? saved : get().speed;
    // RAWY-180: restore the saved volume (0..1). An UNSET key must not read as 0 (muted), so treat only
    // an in-range stored value as valid; otherwise keep the current (default full) level.
    const volStr = await settingsGet("tts_volume").catch(() => null);
    const volNum = volStr == null ? NaN : Number(volStr);
    const volume = volNum >= 0 && volNum <= 1 ? volNum : get().volume;
    curVolume = volume;
    if (gainNode) gainNode.gain.value = volume;
    set({ active: true, status: "preparing", lang, speed, volume, index: startIndex, total: sentences.length, progress: 0, chapterLabel, error: null, notice: null, words: [], wordIndex: -1 });
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

  skip: (delta) => {
    const st = get();
    if (!st.active || st.status === "preparing") return;
    const myGen = ++gen;
    stopSource();
    stopKaraoke(); // RAWY-127: drop the old sentence's pill; playFrom restarts karaoke for the new one
    failStreak = 0; // RAWY-159: a user skip is a fresh attempt — don't count it toward a dead end
    set({ wordIndex: -1 });
    void playFrom(Math.max(0, Math.min(sentences.length - 1, st.index + delta)), myGen);
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
    set({ engine, voice: id, status: "preparing", error: null, notice: null, wordIndex: -1 });
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

  stop: () => {
    gen++;
    stopSource();
    stopKaraoke(); // RAWY-127
    cache = new Map();
    sentences = [];
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, progress: 0, error: null, notice: null, words: [], wordIndex: -1 });
  },
}));
