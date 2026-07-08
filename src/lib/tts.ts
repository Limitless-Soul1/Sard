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
  index: number; // current sentence
  total: number;
  progress: number; // voice-download fraction 0–1 (only meaningful while status === "downloading")
  chapterLabel: string;
  error: string | null;
  notice: string | null; // transient message (e.g. fell back to Piper); auto-clears
  start: (o: StartOpts) => Promise<void>;
  toggle: () => void;
  skip: (delta: number) => void;
  setSpeed: (s: number) => void;
  setVoice: (engine: TtsEngineKind, id: string, lang: TtsLang) => void;
  setEngine: (engine: TtsEngineKind) => void;
  retry: () => void;
  stop: () => void;
}

// ---- imperative playback engine (WebAudio), kept outside the reactive store ----
let ctx: AudioContext | null = null;
let sentences: string[] = [];
let source: AudioBufferSourceNode | null = null;
let cache = new Map<number, Promise<AudioBuffer>>();
let curEngine: TtsEngineKind = "piper";
let curVoice = "";
let curLang: TtsLang = "en";
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let gen = 0; // bumped by stop/skip/start to invalidate in-flight async work
let lastStart: StartOpts | null = null; // for retry() after a download/synth failure

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

const synth = (i: number): Promise<AudioBuffer> => {
  let p = cache.get(i);
  if (!p) {
    p = (async () => {
      let buf: ArrayBuffer;
      try {
        buf = await invoke<ArrayBuffer>("tts_synthesize", { engine: curEngine, id: curVoice, text: sentences[i] });
      } catch (e) {
        // RAWY-113 (bug #14 fix): a transient Edge failure (dropped warm socket / net blip) falls back
        // to Piper for THIS SENTENCE ONLY — it does NOT change the user's chosen engine or the persisted
        // pref, so the NEXT sentence retries Edge and playback auto-recovers when connectivity resumes.
        if (curEngine !== "edge") throw e;
        flashNotice("tts.edgeHiccup");
        buf = await invoke<ArrayBuffer>("tts_synthesize", { engine: "piper", id: PIPER_VOICE[curLang], text: sentences[i] });
      }
      return await audioCtx().decodeAudioData(buf);
    })();
    cache.set(i, p);
  }
  return p;
};

const stopSource = () => {
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

async function playFrom(i: number, myGen: number) {
  const set = useTts.setState;
  if (i >= sentences.length) {
    // reached the end of the chapter (Stage 2: auto-advance to the next chapter)
    set({ status: "paused", index: Math.max(0, sentences.length - 1) });
    return;
  }
  const idx = Math.max(0, i);
  set({ index: idx, status: "playing" });
  let buffer: AudioBuffer;
  try {
    buffer = await synth(idx); // Edge failures self-heal per-sentence inside synth() (RAWY-113)
  } catch (e) {
    // reached only if BOTH the chosen engine AND the Piper fallback failed (e.g. offline + the Piper
    // voice isn't downloaded) — a genuine dead end, shown as a retryable error.
    if (myGen === gen) set({ status: "error", error: String(e) });
    return;
  }
  if (myGen !== gen) return; // superseded by stop/skip
  if (idx + 1 < sentences.length) void synth(idx + 1).catch(() => {}); // prefetch next
  const c = audioCtx();
  if (c.state === "suspended") await c.resume();
  if (myGen !== gen) return;
  stopSource();
  const s = c.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = useTts.getState().speed;
  s.connect(c.destination);
  s.onended = () => {
    if (myGen === gen) void playFrom(idx + 1, myGen);
  };
  source = s;
  s.start();
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
  index: 0,
  total: 0,
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
    cache = new Map();
    sentences = sen.map((s) => s.trim()).filter(Boolean);
    curLang = lang;
    const saved = Number(await settingsGet("tts_speed").catch(() => null));
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? saved : get().speed;
    set({ active: true, status: "preparing", lang, speed, index: startIndex, total: sentences.length, progress: 0, chapterLabel, error: null, notice: null });
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
    void playFrom(Math.max(0, Math.min(sentences.length - 1, st.index + delta)), myGen);
  },

  setSpeed: (s) => {
    const sp = Math.max(TTS_MIN_SPEED, Math.min(TTS_MAX_SPEED, Math.round(s / TTS_SPEED_STEP) * TTS_SPEED_STEP));
    if (source) source.playbackRate.value = sp;
    set({ speed: sp });
    void settingsSet("tts_speed", String(sp)).catch(() => {});
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
    const myGen = ++gen;
    stopSource();
    set({ engine, voice: id, status: "preparing", error: null, notice: null });
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
    cache = new Map();
    sentences = [];
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, progress: 0, error: null, notice: null });
  },
}));
