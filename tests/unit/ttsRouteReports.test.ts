// THE CONNECTION'S ROUTE REPORTS LEAVE PLAYBACK EXACTLY AS IT WAS.
//
// The engine now opens its synthesis connection over two routes (src-tauri/src/tts/edge_route.rs) and reports a
// failed connection as `edge connect: http <last status>; <route> <outcome> (<detail>), …` instead of the single
// route's `edge connect: http <status>; <debug text>`. Nothing in the frontend changed. These tests hold it to
// that: every failure is played through the REAL store, scheduler, classifier and Retry twice — once with the
// text the engine produced before, once with the text it produces now for the same condition — and the two runs
// must be indistinguishable. Only the boundaries are stubbed, as in ttsRetry.test.ts: `tts_synthesize` (each call
// recorded and answered by a script) and the WebAudio / media element surfaces. Time is virtual.
//
// The route texts below are exactly what the engine's own tests pin (`edge_route::tests`).
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type Answer = { ok: true; ms?: number } | { ok: false; err: string; ms?: number };
interface Call { text: string; settled?: "ok" | "err" | "cancelled" }

const h = vi.hoisted(() => {
  // A framed `[u32 BE json_len][json words][audio]` body. Each sentence carries ONE word timing — its own first
  // word — so a test can tell which sentence's words the player is showing.
  const framed = (text: string): ArrayBuffer => {
    const json = new TextEncoder().encode(JSON.stringify([{ text: text.split(" ")[0], offset: 0, duration: 5_000_000 }]));
    const audio = new Uint8Array(4000 + text.length).fill(0xff);
    const out = new Uint8Array(4 + json.length + audio.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    out.set(audio, 4 + json.length);
    return out.buffer;
  };
  // The scheduler jitters its background backoff with `Math.random`, read once when the module loads. A seeded
  // sequence, restarted for every session, gives both wordings of a failure the same jitter — so their runs can
  // be compared call for call rather than only in outline.
  let seed = 1;
  Math.random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const state = {
    calls: [] as Call[],
    script: ((): Answer => ({ ok: true })) as (text: string, nth: number) => Answer,
    cancelCurrent: null as null | (() => void),
    onPlay: null as null | (() => void),
    reseed: () => { seed = 1; },
    framed,
  };
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
  // The word highlight advances on animation frames; on the virtual clock, one every 16 ms.
  g.requestAnimationFrame = (cb: (t: number) => void) => globalThis.setTimeout(() => cb(performance.now()), 16);
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id);
  return state;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { text: string }) => {
    if (cmd !== "tts_synthesize") return Promise.reject(`unexpected command: ${cmd}`);
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const call: Call = { text: args.text };
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

import { isPermanentFailure, isRateLimited, ttsStats, useTts } from "../../src/lib/tts";

// ---- the two wordings of each failure ------------------------------------------------------------------------

/** The single route's report, as the engine produced it before (`edge_error`), debug text included. */
const before = (status: number) =>
  `edge connect: http ${status}; TungsteniteError(Http(Response { status: ${status}, version: HTTP/1.1, headers: {"content-length": "0"}, body: None }))`;
const HOST_DOWN_BEFORE = 'edge connect: TungsteniteError(Io(Os { code: 11001, kind: Uncategorized, message: "No such host is known." }))';
const RESET_BEFORE = 'edge connect: TungsteniteError(Io(Os { code: 10054, kind: ConnectionReset, message: "An existing connection was forcibly closed by the remote host." }))';

/** [condition, before, now] — "now" is what the routes report for the same condition. */
const WORDINGS: [string, string, string][] = [
  ["no upgrade on either route (the 2026-10-23 HTTP 200)", before(200), "edge connect: http 200; msedge refused (http 200), bing refused (http 200)"],
  ["credentials rejected on both (403)", before(403), "edge connect: http 403; msedge rejected (http 403), bing rejected (http 403)"],
  ["no upgrade, then credentials rejected", before(403), "edge connect: http 403; msedge refused (http 200), bing rejected (http 403)"],
  ["credentials rejected (401)", before(401), "edge connect: http 401; msedge rejected (http 401), bing rejected (http 401)"],
  ["endpoint gone (404)", before(404), "edge connect: http 404; msedge refused (http 404), bing refused (http 404)"],
  ["rate limited (429)", before(429), "edge connect: http 429; msedge rate-limited (http 429)"],
  ["server error (503)", before(503), "edge connect: http 503; msedge server-error (http 503)"],
  ["host not found", HOST_DOWN_BEFORE, "edge connect: msedge failed (io Uncategorized os 11001)"],
  ["connection reset", RESET_BEFORE, "edge connect: msedge failed (io ConnectionReset os 10054)"],
];
const EVERY_ROUTE_REFUSED = "edge connect: http 403; msedge refused (http 200), bing rejected (http 403)";
const ROUTE_DOWN = "edge connect: msedge failed (io Uncategorized os 11001)";

// ---- the harness ---------------------------------------------------------------------------------------------

const S = [
  "Alpha opens the chapter.",
  "Bravo follows it.",
  "Charlie comes next.",
  "Delta is the fourth.",
  "Echo is near the end.",
  "Foxtrot closes the chapter.",
];
const st = () => useTts.getState();
const requestsFor = (i: number) => h.calls.filter((c) => c.text === S[i]).length;
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
let played: number[] = [];
let statuses: string[] = [];
/** Every word list the player showed, with the sentence it was showing it for. */
let shown: { index: number; word: string }[] = [];
let unsubscribe: (() => void) | null = null;
const pauses = () => statuses.filter((s) => s === "edge-error").length;

async function listen(startIndex = 0) {
  void st().start({ sentences: S, lang: "en", startIndex, chapterLabel: "Chapter" });
  await run(0);
}
async function until(pred: () => boolean, limit = 60_000) {
  for (let t = 0; t <= limit; t += 50) {
    if (pred()) return true;
    await run(50);
  }
  return false;
}
/** The words shown always belong to the sentence being shown. */
function expectWordsMatchSentences() {
  for (const s of shown) expect(s.word).toBe(S[s.index].split(" ")[0]);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"] });
});
beforeEach(() => {
  h.calls.length = 0;
  h.script = () => ({ ok: true });
  played = [];
  shown = [];
  h.onPlay = () => played.push(st().index);
  statuses = [];
  unsubscribe = useTts.subscribe((s, prev) => {
    if (s.status !== prev.status) statuses.push(s.status);
    if (s.words !== prev.words && s.words.length) shown.push({ index: s.index, word: s.words[0].text });
  });
});
afterEach(async () => {
  unsubscribe?.();
  st().stop();
  await run(1_000);
  const s = ttsStats();
  expect(s.liveDispatches).toBe(0);
  expect(s.inFlight).toBe(-1);
  expect(s.cached).toBe(0);
  expect(s.inRecovery).toBe(false);
});

/** One listening session under a scripted failure, driven like a listener: Retry at each pause, up to three
 *  times. Returns everything a listener or the engine could observe. */
async function session(script: (text: string, nth: number) => Answer) {
  h.reseed();
  h.calls.length = 0;
  played = [];
  shown = [];
  statuses = [];
  h.script = script;
  await listen();
  for (let retries = 0; ; retries++) {
    await until(() => st().status === "chapter-end" || st().status === "edge-error");
    if (st().status !== "edge-error" || retries === 3) break;
    st().resumeEdge();
    await run(0);
  }
  const trace = {
    statuses: [...statuses],
    played: [...played],
    requests: S.map((_, i) => requestsFor(i)),
    settled: h.calls.map((c) => `${S.indexOf(c.text)}:${c.settled}`),
    maxConcurrent: ttsStats().maxConcurrent,
    words: shown.map((s) => `${s.index}:${s.word}`),
  };
  st().stop();
  await run(1_000);
  return trace;
}

// ---- 1. the same failure, worded either way, plays out identically --------------------------------------------

describe("each failure behaves exactly as it did, whichever way the engine words it", () => {
  for (const [condition, wordedBefore, wordedNow] of WORDINGS) {
    it(`${condition}: classified the same`, () => {
      expect(isPermanentFailure(wordedNow)).toBe(isPermanentFailure(wordedBefore));
      expect(isRateLimited(wordedNow)).toBe(isRateLimited(wordedBefore));
    });

    it(`${condition}: at the sentence being waited for, for one whole round`, async () => {
      const at = (err: string) => (text: string, nth: number): Answer => (text === S[0] && nth <= 3 ? { ok: false, err, ms: 30 } : { ok: true });
      const a = await session(at(wordedBefore));
      const b = await session(at(wordedNow));
      expect(b).toEqual(a);
      expect(b.maxConcurrent).toBeLessThanOrEqual(1);
    });

    it(`${condition}: once, ahead of playback`, async () => {
      const ahead = (err: string) => (text: string, nth: number): Answer => (text === S[3] && nth === 1 ? { ok: false, err, ms: 30 } : { ok: true });
      const a = await session(ahead(wordedBefore));
      const b = await session(ahead(wordedNow));
      expect(b).toEqual(a);
    });
  }
});

// ---- 2. every route down: the existing pause, no automatic resume, Retry from the right place ----------------

describe("when no route can give audio, the existing Retry flow is unchanged", () => {
  it("the bounded round, then the pause; the service returning does not resume playback; Retry plays on from the same sentence", async () => {
    let down = true;
    h.script = (text) => (text === S[3] && down ? { ok: false, err: EVERY_ROUTE_REFUSED, ms: 30 } : { ok: true });
    await listen();
    expect(await until(() => st().status === "edge-error")).toBe(true);
    expect(st().index).toBe(3);
    expect(played).toEqual([0, 1, 2]);
    expect(pauses()).toBe(1);

    // The service comes back. The background may repair the sentence, but the player waits for the listener.
    down = false;
    await run(120_000);
    expect(st().status).toBe("edge-error");
    expect(played).toEqual([0, 1, 2]);
    const repaired = h.calls.filter((c) => c.text === S[3]).at(-1)?.settled === "ok";
    const requestsBeforeRetry = requestsFor(3);

    st().resumeEdge();
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]); // from the same sentence: nothing skipped, repeated or reordered
    expect(pauses()).toBe(1);
    if (repaired) expect(requestsFor(3)).toBe(requestsBeforeRetry); // served from the cache, no new request
    expect([requestsFor(4), requestsFor(5)]).toEqual([1, 1]); // prepared past the failure, never synthesized again
    expectWordsMatchSentences();
    expect(ttsStats().maxConcurrent).toBeLessThanOrEqual(1);
  });

  it("while the service stays down, each Retry is one bounded round and the player stays where it was", async () => {
    let down = true;
    h.script = (text) => (text === S[2] && down ? { ok: false, err: EVERY_ROUTE_REFUSED, ms: 30 } : { ok: true });
    await listen();
    expect(await until(() => st().status === "edge-error")).toBe(true);
    for (let i = 0; i < 2; i++) {
      const n = requestsFor(2);
      st().resumeEdge();
      await run(0);
      expect(await until(() => st().status === "edge-error")).toBe(true);
      expect(requestsFor(2) - n).toBeGreaterThanOrEqual(1);
      expect(requestsFor(2) - n).toBeLessThanOrEqual(3);
      expect(st().index).toBe(2);
      expect(played).toEqual([0, 1]);
    }
    down = false;
    st().resumeEdge();
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectWordsMatchSentences();
  });
});

// ---- 3. a recovery round answered 429 ------------------------------------------------------------------------
//
// The engine may now try the other route once inside the round's final call (`edge_route`: three 429s in a row
// from the first route, on a call that carries the listener's budget). That happens INSIDE one `tts_synthesize`
// call, so all the frontend can ever see is that call's single result: audio, or one error. When that call brings
// audio, the round is exactly what it was — three calls. When it is rate-limited too, the round waits the limit out
// for ONE delayed call (the scheduler's RULE 2b), inside the same 12 s budget, and only then shows the same pause.

const LIMITED = "edge connect: http 429; msedge rate-limited (http 429)";
const BOTH_LIMITED = "edge connect: http 429; msedge rate-limited (http 429), bing rate-limited (http 429)";

describe("only a 429 reads as a rate limit", () => {
  it("of every condition the engine reports, both wordings of the rate limit and nothing else", () => {
    for (const [condition, wordedBefore, wordedNow] of WORDINGS) {
      const expected = condition === "rate limited (429)";
      expect(isRateLimited(wordedBefore), condition).toBe(expected);
      expect(isRateLimited(wordedNow), condition).toBe(expected);
    }
    expect(isRateLimited(BOTH_LIMITED)).toBe(true);
    // The marker is the last route's status: a 429 that moved on to a refusal is not a rate limit.
    expect(isRateLimited("edge connect: http 403; msedge rate-limited (http 429), bing rejected (http 403)")).toBe(false);
    expect(isRateLimited("edge synth stalled: no audio for 6000 ms (Content-Length: 429)")).toBe(false);
  });
});

describe("a recovery round answered 429 keeps its budget, plays as soon as it can, and pauses only once it cannot", () => {
  it("a single 429 as listening starts: the fast retry plays it — no pause, no delay, no extra call", async () => {
    h.script = (text, nth) => (text === S[0] && nth === 1 ? { ok: false, err: LIMITED, ms: 650 } : { ok: true });
    const t0 = performance.now();
    await listen();
    expect(await until(() => played.length > 0)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(requestsFor(0)).toBe(2);
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(pauses()).toBe(0);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectWordsMatchSentences();
  });

  it("three 429s as listening starts: the delayed call plays it inside the budget, counted 4 of 4, with nothing skipped or repeated", async () => {
    const seen: string[] = [];
    h.script = (text, nth) => {
      if (text !== S[0]) return { ok: true };
      if (nth > 1) seen.push(`${st().retryAttempt}/${st().retryOf}`);
      return nth <= 3 ? { ok: false, err: nth === 3 ? BOTH_LIMITED : LIMITED, ms: 650 } : { ok: true };
    };
    const t0 = performance.now();
    await listen();
    expect(await until(() => played.length > 0)).toBe(true);
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThan(4_500);
    expect(waited).toBeLessThan(12_000);
    expect(seen).toEqual(["2/3", "3/3", "4/4"]); // the indicator never shows more attempts than the round holds
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(pauses()).toBe(0);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expect(S.map((_, i) => requestsFor(i))).toEqual([4, 1, 1, 1, 1, 1]);
    expectWordsMatchSentences();
    expect(ttsStats().maxConcurrent).toBeLessThanOrEqual(1);
  });

  it("listening from the middle of the chapter, a sentence rate-limited three times: 3, 4, 5 play in order, each once", async () => {
    h.script = (text, nth) => (text === S[4] && nth <= 3 ? { ok: false, err: LIMITED, ms: 650 } : { ok: true });
    await listen(3);
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(played).toEqual([3, 4, 5]);
    expect(pauses()).toBe(0);
    expect([requestsFor(0), requestsFor(1), requestsFor(2)]).toEqual([0, 0, 0]);
    expect([requestsFor(3), requestsFor(5)]).toEqual([1, 1]);
    expect(h.calls.filter((c) => c.text === S[4] && c.settled === "ok").length).toBe(1);
    expectWordsMatchSentences();
  });
  it("the round's final call brings audio (the route recovered, or the other route answered): no pause, no extra call", async () => {
    h.script = (text, nth) => (text === S[0] && nth <= 2 ? { ok: false, err: LIMITED, ms: 30 } : { ok: true });
    const t0 = performance.now();
    await listen();
    expect(await until(() => played.length > 0)).toBe(true);
    expect(performance.now() - t0).toBeLessThanOrEqual(12_000); // inside the round's budget
    expect(requestsFor(0)).toBe(3); // the round's own three calls, not one more
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(pauses()).toBe(0);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expectWordsMatchSentences();
  });

  it("both routes limited on the final call: worded either way, the round plays out the same — its delayed call plays the sentence", async () => {
    const round = (first: string, last: string) => (text: string, nth: number): Answer =>
      text === S[0] && nth <= 3 ? { ok: false, err: nth === 3 ? last : first, ms: 30 } : { ok: true };
    const a = await session(round(before(429), before(429)));
    const b = await session(round(LIMITED, BOTH_LIMITED));
    expect(b).toEqual(a);
    expect(b.requests[0]).toBe(4);
    expect(b.statuses).not.toContain("edge-error");
  });

  it("a round mixing 429, a timeout and a refusal plays out exactly as it did", async () => {
    const mixed = (limited: string, refused: string) => (text: string, nth: number): Answer => {
      if (text !== S[0] || nth > 3) return { ok: true };
      return { ok: false, err: [limited, "edge connect timed out", refused][nth - 1], ms: 30 };
    };
    const a = await session(mixed(before(429), before(403)));
    const b = await session(mixed(LIMITED, EVERY_ROUTE_REFUSED));
    expect(b).toEqual(a);
  });

  it("every route limited: the pause holds while the service recovers, and Retry plays on from the same sentence", async () => {
    let limited = true;
    h.script = (text, nth) => (text === S[2] && limited ? { ok: false, err: nth % 3 === 0 ? BOTH_LIMITED : LIMITED, ms: 30 } : { ok: true });
    await listen();
    // From the moment playback waits on the sentence, the round makes at most its three fast calls and the one
    // delayed call a rate limit earns.
    expect(await until(() => st().index === 2 && st().status !== "playing")).toBe(true);
    const beforeRound = requestsFor(2);
    expect(await until(() => st().status === "edge-error")).toBe(true);
    expect(requestsFor(2) - beforeRound).toBeLessThanOrEqual(4);
    expect(played).toEqual([0, 1]);

    limited = false;
    await run(120_000);
    expect(st().status).toBe("edge-error"); // recovered in the background, but the player waits for the listener
    expect(played).toEqual([0, 1]);

    st().resumeEdge();
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pauses()).toBe(1);
    expectWordsMatchSentences();
    expect(ttsStats().maxConcurrent).toBeLessThanOrEqual(1);
  });
});

// ---- 4. failures on the way never disturb order, count or words --------------------------------------------

describe("route failures ahead of playback never skip, repeat or misplace a sentence", () => {
  it("one sentence refused on every route, another on a route that is down: both repaired before playback reaches them", async () => {
    h.script = (text, nth) => {
      if (text === S[2] && nth === 1) return { ok: false, err: EVERY_ROUTE_REFUSED, ms: 30 };
      if (text === S[4] && nth === 1) return { ok: false, err: ROUTE_DOWN, ms: 30 };
      return { ok: true };
    };
    await listen();
    expect(await until(() => st().status === "chapter-end")).toBe(true);
    expect(played).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pauses()).toBe(0);
    expect(S.map((_, i) => requestsFor(i))).toEqual([1, 1, 2, 1, 2, 1]);
    expectWordsMatchSentences();
    expect(shown.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
