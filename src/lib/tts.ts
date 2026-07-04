// TTS playback (RAWY-105, Phase 1) — the frontend half of read-aloud. Rust synthesizes each
// sentence with the bundled piper engine and returns raw WAV bytes; here we decode them with
// WebAudio and play a QUEUE of sentences, synthesizing the NEXT one while the current plays (hides
// piper's sub-second latency). Controls: play/pause, skip ±sentence, speed. Voice is ensured
// (downloaded on demand) before playback. Kept deliberately extensible for Stage 2 (voice picker,
// listen-from-selection, hidden-text-safe extraction).

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { settingsGet, settingsSet, ttsDownloadVoice, ttsStop, ttsVoicePresent } from "./ipc";

export const TTS_MIN_SPEED = 0.75;
export const TTS_MAX_SPEED = 2.0;
export const TTS_SPEED_STEP = 0.25;

// Default voice per book direction (Stage 1: one Arabic + one English; Stage 2 adds the picker).
export const defaultVoiceForDir = (dir: string): string =>
  dir === "rtl" ? "ar_JO-kareem-medium" : "en_US-lessac-medium";

type Status = "idle" | "preparing" | "playing" | "paused" | "error";

interface TtsState {
  active: boolean; // player pill visible
  status: Status;
  voice: string;
  speed: number;
  index: number; // current sentence
  total: number;
  chapterLabel: string;
  error: string | null;
  start: (o: { sentences: string[]; voice: string; startIndex?: number; chapterLabel: string }) => Promise<void>;
  toggle: () => void;
  skip: (delta: number) => void;
  setSpeed: (s: number) => void;
  stop: () => void;
}

// ---- imperative playback engine (WebAudio), kept outside the reactive store ----
let ctx: AudioContext | null = null;
let sentences: string[] = [];
let source: AudioBufferSourceNode | null = null;
let cache = new Map<number, Promise<AudioBuffer>>();
let curVoice = "";
let gen = 0; // bumped by stop/skip/start to invalidate in-flight async work

const audioCtx = (): AudioContext => {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  return ctx;
};

const synth = (i: number): Promise<AudioBuffer> => {
  let p = cache.get(i);
  if (!p) {
    p = (async () => {
      const buf = await invoke<ArrayBuffer>("tts_synthesize", { id: curVoice, text: sentences[i] });
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
  voice: "",
  speed: 1,
  index: 0,
  total: 0,
  chapterLabel: "",
  error: null,

  start: async ({ sentences: sen, voice, startIndex = 0, chapterLabel }) => {
    audioCtx(); // create within the user gesture so autoplay policy unlocks it
    const myGen = ++gen;
    stopSource();
    cache = new Map();
    sentences = sen.map((s) => s.trim()).filter(Boolean);
    curVoice = voice;
    const saved = Number(await settingsGet("tts_speed").catch(() => null));
    const speed = saved >= TTS_MIN_SPEED && saved <= TTS_MAX_SPEED ? saved : get().speed;
    set({ active: true, status: "preparing", voice, speed, index: startIndex, total: sentences.length, chapterLabel, error: null });
    if (sentences.length === 0) {
      set({ status: "error", error: "empty chapter" });
      return;
    }
    try {
      if (!(await ttsVoicePresent(voice))) await ttsDownloadVoice(voice);
    } catch (e) {
      set({ status: "error", error: `voice: ${e}` });
      return;
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

  stop: () => {
    gen++;
    stopSource();
    cache = new Map();
    sentences = [];
    if (ctx && ctx.state !== "closed") void ctx.suspend().catch(() => {});
    void ttsStop().catch(() => {});
    set({ active: false, status: "idle", index: 0, total: 0, error: null });
  },
}));
