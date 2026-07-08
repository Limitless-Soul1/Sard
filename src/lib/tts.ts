// TTS playback (RAWY-105) — the frontend half of read-aloud. Rust synthesizes each sentence and
// returns raw audio bytes; here we decode them with WebAudio and play a QUEUE of sentences,
// synthesizing the NEXT while the current plays (hides synth latency). Controls: play/pause,
// skip ±sentence, speed.
//
// RAWY-110 (engine abstraction): a voice is {engine, id}; `synth` calls the dispatching
// `tts_synthesize(engine, id, text)`. Everything here is engine-agnostic — WebAudio decodes both
// Piper's WAV and (Stage B) Edge's MP3, and play/pause/skip/speed work the same regardless. Stage A
// wires only "piper"; the Edge engine + voice picker come in Stage B.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { settingsGet, settingsSet, ttsDownloadVoice, ttsStop, ttsVoicePresent } from "./ipc";

export const TTS_MIN_SPEED = 0.75;
export const TTS_MAX_SPEED = 2.0;
export const TTS_SPEED_STEP = 0.25;
// Sentinel error the player localizes (RAWY-107) — distinct from a raw engine/download error, which
// the pill shows verbatim (RAWY-106). Set when a section genuinely has no readable text.
export const TTS_EMPTY = "empty-chapter";

// RAWY-110: a voice is identified by its ENGINE + id. Stage A ships only "piper"; "edge" (the free
// Edge Read-Aloud neural voices, incl. Arabic) lands in Stage B behind this same abstraction.
export type TtsEngineKind = "piper" | "edge";
export interface TtsVoiceRef { engine: TtsEngineKind; id: string }

// Default voice per book direction — Piper stays the offline default (Stage B adds the picker + the
// per-language engine/voice choice; an Arabic book can then opt into an Edge neural voice).
export const defaultVoiceForDir = (dir: string): TtsVoiceRef =>
  dir === "rtl"
    ? { engine: "piper", id: "ar_JO-kareem-medium" }
    : { engine: "piper", id: "en_US-lessac-medium" };

type Status = "idle" | "preparing" | "downloading" | "playing" | "paused" | "error";

interface StartOpts { sentences: string[]; engine: TtsEngineKind; voice: string; startIndex?: number; chapterLabel: string }

interface TtsState {
  active: boolean; // player pill visible
  status: Status;
  engine: TtsEngineKind;
  voice: string; // voice id within the engine
  speed: number;
  index: number; // current sentence
  total: number;
  progress: number; // voice-download fraction 0–1 (only meaningful while status === "downloading")
  chapterLabel: string;
  error: string | null;
  start: (o: StartOpts) => Promise<void>;
  toggle: () => void;
  skip: (delta: number) => void;
  setSpeed: (s: number) => void;
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
let gen = 0; // bumped by stop/skip/start to invalidate in-flight async work
let lastStart: StartOpts | null = null; // for retry() after a download/synth failure

const audioCtx = (): AudioContext => {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  return ctx;
};

const synth = (i: number): Promise<AudioBuffer> => {
  let p = cache.get(i);
  if (!p) {
    p = (async () => {
      const buf = await invoke<ArrayBuffer>("tts_synthesize", { engine: curEngine, id: curVoice, text: sentences[i] });
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
    buffer = await synth(idx);
  } catch (e) {
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

export const useTts = create<TtsState>((set, get) => ({
  active: false,
  status: "idle",
  engine: "piper",
  voice: "",
  speed: 1,
  index: 0,
  total: 0,
  progress: 0,
  chapterLabel: "",
  error: null,

  start: async (opts) => {
    lastStart = opts;
    const { sentences: sen, engine, voice, startIndex = 0, chapterLabel } = opts;
    audioCtx(); // create within the user gesture so autoplay policy unlocks it
    const myGen = ++gen;
    stopSource();
    cache = new Map();
    sentences = sen.map((s) => s.trim()).filter(Boolean);
    curEngine = engine;
    curVoice = voice;
    const saved = Number(await settingsGet("tts_speed").catch(() => null));
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? saved : get().speed;
    set({ active: true, status: "preparing", engine, voice, speed, index: startIndex, total: sentences.length, progress: 0, chapterLabel, error: null });
    if (sentences.length === 0) {
      set({ status: "error", error: TTS_EMPTY });
      return;
    }
    // Only PIPER voices fetch on demand (~60 MB) with a REAL progress bar (RAWY-106). Edge (Stage B)
    // synthesizes over the network with no local model, so it skips this step entirely.
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
    if (myGen !== gen) return; // stopped during download
    void playFrom(Math.min(startIndex, sentences.length - 1), myGen);
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
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, progress: 0, error: null });
  },
}));
