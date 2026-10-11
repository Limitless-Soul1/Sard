// RETRY FROM THE "EDGE UNAVAILABLE" PAUSE, set against a fresh Listen.
//
// Driven through the REAL store — `start()` is Toolbar Listen, `resumeEdge()` is the pause's Retry button,
// `stop()` is ✕ — with the real scheduler and the real failure classifier. Only the boundaries are stubbed:
// `tts_synthesize` (every call is recorded, and answered with the exact error text the Rust side produces)
// and the WebAudio / media element surfaces, which plain Node does not have. Time is virtual.
//
// The two operations are deliberately different and these tests keep them apart. Listen begins a NEW
// queue: the cache is dropped and every sentence is synthesized again. Retry continues the SAME queue
// (failure isolation): the sentence that failed is attempted again, and the sentences already prepared
// after it play from cache without another request.
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type Answer = { ok: true; ms?: number } | { ok: false; err: string; ms?: number } | { stall: true };
interface Call { text: string; budgetMs: number | null; settled?: "ok" | "err" | "cancelled" }

const h = vi.hoisted(() => {
  // A framed `[u32 BE json_len][json words][audio]` body — the shape `tts_synthesize` returns.
  const framed = (text: string): ArrayBuffer => {
    const json = new TextEncoder().encode("[]");
    const audio = new Uint8Array(4000 + text.length).fill(0xff);
    const out = new Uint8Array(4 + json.length + audio.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    out.set(audio, 4 + json.length);
    return out.buffer;
  };
  const state = {
    calls: [] as Call[],
    script: ((): Answer => ({ ok: true })) as (text: string, nth: number) => Answer,
    cancelCurrent: null as null | (() => void),
    onPlay: null as null | (() => void),
    framed,
  };

  // Plain Node has no WebAudio and no media element. Each sentence decodes to 2 s of audio and its
  // element ends 2 s (scaled by the playback rate) after `play()`.
  class FakeAudioContext {
    state = "running";
    destination = {};
    get currentTime() { return performance.now() / 1000; }
    createGain() { return { gain: { value: 1 }, connect() {}, context: this }; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    async suspend() { this.state = "suspended"; }
    async resume() { this.state = "running"; }
    async decodeAudioData() { return { length: 48_000, duration: 2 }; }
  }
  class FakeAudio {
    src = "";
    playbackRate = 1;
    preload = "";
    preservesPitch = true;
    onended: null | (() => void) = null;
    currentTime = 0;
    duration = NaN;
    ended = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    play() {
      state.onPlay?.();
      this.ended = false;
      this.duration = 2;
      this.currentTime = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.currentTime = this.duration;
        this.ended = true;
        this.onended?.();
      }, (this.duration / this.playbackRate) * 1000);
      return Promise.resolve();
    }
    pause() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
    removeAttribute() { this.src = ""; }
    load() {}
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = new EventTarget();
  g.AudioContext = FakeAudioContext;
  g.Audio = FakeAudio;
  return state;
});

// The engine. One call at a time is the frontend's contract with it (see ttsLadder.test.ts); a cancel
// reaches the call in flight, which then answers "edge synth cancelled" — as `tts_cancel_synth` does.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { text: string; budgetMs: number | null; firstAudioMs: number | null }) => {
    if (cmd !== "tts_synthesize") return Promise.reject(`unexpected command: ${cmd}`);
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const call: Call = { text: args.text, budgetMs: args.budgetMs };
      h.calls.push(call);
      const answer = h.script(args.text, h.calls.filter((c) => c.text === args.text).length);
      let done = false;
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        if (h.cancelCurrent === cancel) h.cancelCurrent = null;
        f();
      };
      const cancel = () => finish(() => { call.settled = "cancelled"; reject("edge synth cancelled"); });
      h.cancelCurrent = cancel;
      if ("stall" in answer) {
        // A socket that sends nothing: the engine reports it at its first-audio bound.
        setTimeout(() => finish(() => { call.settled = "err"; reject("edge synth stalled: no audio"); }), args.firstAudioMs ?? args.budgetMs ?? 12_000);
        return;
      }
      setTimeout(() => finish(() => {
        if (answer.ok) { call.settled = "ok"; resolve(h.framed(args.text)); }
        else { call.settled = "err"; reject(answer.err); }
      }), answer.ms ?? 200);
    });
  },
}));

vi.mock("../../src/lib/ipc", () => ({
  settingsGet: async (k: string) => (k === "tts_voice:en" ? "edge:en-US-TestNeural" : null),
  settingsSet: async () => {},
  ttsCancelSynth: async () => { h.cancelCurrent?.(); return true; },
  ttsEdgeVoices: async () => [],
  ttsStop: async () => { h.cancelCurrent?.(); },
  ttsSynthStreaming: async () => false,
}));

import { ttsStats, useTts } from "../../src/lib/tts";

// The error text, verbatim in shape, that the Rust side returns (`format!("edge connect: {e:?}")`):
// a WebSocket handshake the service refused. Its status code makes it a PERMANENT failure to the
// classifier, so the scheduler never retries it on its own.
const HANDSHAKE_403 =
  'edge connect: TungsteniteError(Http(Response { status: 403, version: HTTP/1.1, headers: {"content-length": "0"}, body: None }))';
// A transient failure: the host could not be reached.
const HOST_DOWN = 'edge connect: TungsteniteError(Io(Os { code: 11001, kind: Uncategorized, message: "No such host is known." }))';

const S = [
  "The first sentence of the chapter.",
  "The second sentence follows it.",
  "A third one comes next.",
  "Here is the fourth sentence.",
  "The fifth sentence is near the end.",
  "And the sixth one closes the chapter.",
];
const st = () => useTts.getState();
const requestsFor = (i: number) => h.calls.filter((c) => c.text === S[i]).length;
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
let played: number[] = [];

async function listen(startIndex = 0) {
  void st().start({ sentences: S, lang: "en", startIndex, chapterLabel: "Chapter" });
  await run(0);
}
/** Advance until `pred` holds (checked every 50 ms of virtual time), failing after `limit` ms. */
async function until(pred: () => boolean, limit = 60_000) {
  for (let t = 0; t <= limit; t += 50) {
    if (pred()) return;
    await run(50);
  }
  throw new Error(`timed out waiting; status=${st().status} index=${st().index} calls=${h.calls.length}`);
}
/** One synthesis in flight at most, ever; nothing left in flight once the player is idle. */
function expectEngineSound() {
  expect(ttsStats().maxConcurrent).toBeLessThanOrEqual(1);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"] });
});
beforeEach(() => {
  h.calls.length = 0;
  h.script = () => ({ ok: true });
  played = [];
  h.onPlay = () => played.push(st().index);
});
afterEach(async () => {
  st().stop();
  await run(1_000);
  const s = ttsStats();
  expect(s.liveDispatches).toBe(0);
  expect(s.inFlight).toBe(-1);
  expect(s.cached).toBe(0);
  expect(s.inRecovery).toBe(false);
});

describe("Listen", () => {
  it("plays every sentence in order, requesting each exactly once", async () => {
    await listen();
    await until(() => st().status === "chapter-end");
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expect(S.map((_, i) => requestsFor(i))).toEqual([1, 1, 1, 1, 1, 1]);
    expectEngineSound();
  });
});

describe("Retry after a failure the classifier calls permanent", () => {
  it("REGRESSION: the first request fails — Retry sends a NEW request for that sentence and plays it", async () => {
    h.script = (text, nth) => (text === S[0] && nth === 1 ? { ok: false, err: HANDSHAKE_403 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    expect(st().index).toBe(0);
    expect(requestsFor(0)).toBe(1);

    st().resumeEdge();
    await until(() => played.includes(0));
    expect(requestsFor(0)).toBe(2);
    await until(() => st().status === "chapter-end");
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectEngineSound();
  });

  it("REGRESSION: after partial playback, Retry re-attempts the failed sentence and keeps the ones prepared after it", async () => {
    h.script = (text, nth) => (text === S[3] && nth === 1 ? { ok: false, err: HANDSHAKE_403 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    expect(st().index).toBe(3);
    expect(played).toEqual([0, 1, 2]);
    expect(requestsFor(4)).toBe(1); // prepared past the failure (failure isolation)
    expect(requestsFor(5)).toBe(1);

    st().resumeEdge();
    await until(() => st().status === "chapter-end");
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expect(requestsFor(3)).toBe(2); // exactly one new attempt
    expect(requestsFor(4)).toBe(1); // NOT synthesized again: this is Retry, not a new Listen
    expect(requestsFor(5)).toBe(1);
    expectEngineSound();
  });

  it("REGRESSION: two sentences that failed as look-ahead are both re-attempted by ONE Retry", async () => {
    h.script = (text, nth) => ((text === S[2] || text === S[3]) && nth === 1 ? { ok: false, err: HANDSHAKE_403 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    expect(st().index).toBe(2);

    st().resumeEdge();
    await until(() => st().status === "chapter-end" || st().status === "edge-error");
    expect(st().status).toBe("chapter-end"); // no second pause on the next failed sentence
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expect([requestsFor(2), requestsFor(3)]).toEqual([2, 2]);
    expect([requestsFor(4), requestsFor(5)]).toEqual([1, 1]);
    expectEngineSound();
  });

  it("a failure that persists: each Retry makes exactly one request, and nothing retries it in between", async () => {
    h.script = (text) => (text === S[0] ? { ok: false, err: HANDSHAKE_403 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    expect(requestsFor(0)).toBe(1);
    await run(120_000); // a permanent failure is never retried on its own
    expect(requestsFor(0)).toBe(1);
    expect(st().status).toBe("edge-error");

    for (const expected of [2, 3]) {
      st().resumeEdge();
      await until(() => st().status === "edge-error");
      await run(1_000);
      expect(requestsFor(0)).toBe(expected);
      expect(st().status).toBe("edge-error");
      expect(ttsStats().liveDispatches).toBe(0);
      expect(ttsStats().inRecovery).toBe(false);
    }
    expect(played).toEqual([]);
    expectEngineSound();
  });

  it("cancellation followed by retry: ✕ during the retry discards it; the next Listen starts clean", async () => {
    h.script = (text, nth) => {
      if (text !== S[0]) return { ok: true };
      if (nth === 1) return { ok: false, err: HANDSHAKE_403 };
      if (nth === 2) return { stall: true }; // the retry is still waiting when the listener closes the player
      return { ok: true };
    };
    await listen();
    await until(() => st().status === "edge-error");

    st().resumeEdge();
    await until(() => requestsFor(0) === 2);
    st().stop();
    await run(15_000);
    expect(h.calls.filter((c) => c.text === S[0]).map((c) => c.settled)).toEqual(["err", "cancelled"]);
    expect(st().status).toBe("idle");
    expect(played).toEqual([]); // the cancelled call cannot start playback

    await listen();
    await until(() => st().status === "chapter-end");
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectEngineSound();
  });
});

describe("Retry after a transient failure (unchanged behaviour)", () => {
  it("a failed recovery round pauses; Retry re-attempts and plays", async () => {
    h.script = (text, nth) => (text === S[0] && nth <= 3 ? { ok: false, err: HOST_DOWN, ms: 30 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    const before = requestsFor(0);
    expect(before).toBeLessThanOrEqual(3); // ONE bounded round: at most three attempts

    st().resumeEdge();
    await until(() => st().status === "chapter-end");
    expect(requestsFor(0)).toBe(4);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectEngineSound();
  });

  it("timeout followed by retry: a stalled socket surfaces inside the 12 s budget; Retry recovers", async () => {
    h.script = (text, nth) => (text === S[0] && nth <= 3 ? { stall: true } : { ok: true });
    const t0 = performance.now();
    await listen();
    await until(() => st().status === "edge-error");
    expect(performance.now() - t0).toBeLessThanOrEqual(12_000 + 1_000);

    st().resumeEdge();
    await until(() => st().status === "chapter-end");
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectEngineSound();
  });

  it("a failure that persists: each Retry runs one bounded round", async () => {
    h.script = (text) => (text === S[0] ? { ok: false, err: HOST_DOWN, ms: 30 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    const n1 = requestsFor(0);
    st().resumeEdge();
    await until(() => st().status === "edge-error");
    const n2 = requestsFor(0);
    expect(n2 - n1).toBeGreaterThanOrEqual(1);
    expect(n2 - n1).toBeLessThanOrEqual(3);
    expect(played).toEqual([]);
    expectEngineSound();
  });
});

describe("Listen after a failure is a different operation from Retry", () => {
  it("a fresh Listen re-synthesizes the sentences Retry would have kept", async () => {
    h.script = (text, nth) => (text === S[3] && nth === 1 ? { ok: false, err: HANDSHAKE_403 } : { ok: true });
    await listen();
    await until(() => st().status === "edge-error");
    expect(requestsFor(4)).toBe(1);

    // Toolbar Listen from the same sentence: a new queue, so nothing prepared survives.
    played = [];
    await listen(3);
    await until(() => st().status === "chapter-end");
    expect(played).toEqual([3, 4, 5]);
    expect(requestsFor(3)).toBe(2);
    expect(requestsFor(4)).toBe(2); // re-synthesized — unlike Retry, which keeps it
    expectEngineSound();
  });
});
