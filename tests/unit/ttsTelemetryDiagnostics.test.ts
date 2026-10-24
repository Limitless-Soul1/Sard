// SESSION DIAGNOSTICS of the read-aloud telemetry: the session in progress survives a crash, and each route the
// engine tried is filed under the session it happened in.
//
// The observer is driven through the real store, as in ttsTelemetryCoverage.test.ts. Persistence and the
// engine's route log are stubbed in memory; every write records the player's status at that instant, so the
// one guarantee that matters most here — nothing is ever written while audio is sounding — is checked on every
// write, not only where a test expects one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteTry } from "../../src/lib/ipc";

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  writes: [] as { key: string; status: string }[],
  routes: [] as RouteTry[],
  status: (): string => "",
  /** When set, the route read waits for it — so a test can let audio start while a snapshot is under way. */
  gate: null as Promise<void> | null,
}));
vi.mock("../../src/lib/ipc", () => ({
  settingsGet: async (k: string) => h.settings.get(k) ?? null,
  settingsSet: async (k: string, v: string) => { h.writes.push({ key: k, status: h.status() }); h.settings.set(k, v); },
  ttsRouteLog: async (since: number) => { if (h.gate) await h.gate; return h.routes.filter((r) => r.seq > since); },
}));
// The suite runs in plain Node (see vitest.config.ts); the observer needs `window` only for `pagehide`.
(globalThis as unknown as { window: EventTarget }).window = new EventTarget();

import { useTts } from "../../src/lib/tts";
import { registerTtsTelemetry, resetTtsTelemetry, ttsTelemetry, ttsTelemetryHealth, type ResilienceSession } from "../../src/lib/ttsTelemetry";
h.status = () => useTts.getState().status;

const LIVE = "tts_resilience_live";
const KEY = "tts_resilience_v1";
const PRIVATE_LABEL = "PRIVATE-CHAPTER-LABEL-MUST-NEVER-BE-RECORDED";
const set = (patch: Partial<ReturnType<typeof useTts.getState>>) => useTts.setState(patch as never);
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
function startChapter(total: number, index = 0) {
  set({ active: true, status: "preparing", index, total, chapterLabel: PRIVATE_LABEL, engine: "edge", voice: "en-AU-WilliamMultilingualNeural", speed: 1.3, retryAttempt: 0, error: null });
}
const play = (index: number) => set({ status: "playing", index });
const stop = () => set({ active: false, status: "idle" });
const route = (seq: number, at: number, r: string, outcome: string, status: number | null): RouteTry => ({ seq, at, route: r, outcome, status, ms: 600, waitedOn: true });
const live = (): ResilienceSession | null => { const v = h.settings.get(LIVE); return v ? (JSON.parse(v) as ResilienceSession) : null; };

beforeEach(async () => {
  h.settings.clear();
  h.writes.length = 0;
  h.routes.length = 0;
  h.gate = null;
  await resetTtsTelemetry();
  stop();
  await tick();
  registerTtsTelemetry();
  h.writes.length = 0;
});

describe("crash safety — the session in progress is on disk whenever nothing is sounding", () => {
  it("waiting, a recovery round and a pause each file the session so far; a write never happens while audio sounds", async () => {
    startChapter(40, 0); await tick();
    expect(live()?.endReason).toBe("open"); // preparing: nothing sounds yet
    play(0); await tick();
    const whilePlaying = h.writes.length;
    play(1); play(2); await tick();
    expect(h.writes.length).toBe(whilePlaying); // three sentences of audio: not one write
    set({ status: "buffering" }); await tick(); // playback waits for sentence 2
    set({ retryAttempt: 2 }); await tick();
    set({ retryAttempt: 3 }); await tick();
    set({ retryAttempt: 4 }); await tick(); // the delayed attempt a rate limit earns
    const s = live()!;
    expect(s.events.filter((e) => e.kind === "retryIndicator").map((e) => e.a)).toEqual([2, 3, 4]);
    expect(s.events.some((e) => e.kind === "recoveryStart")).toBe(true);
    play(2); set({ retryAttempt: 0 }); await tick();
    set({ status: "paused" }); await tick();
    expect(live()!.events.some((e) => e.kind === "pause")).toBe(true);
    for (const w of h.writes) expect(w.status, `write to ${w.key}`).not.toBe("playing");
    expect(ttsTelemetryHealth().faults).toBe(0);
  });

  it("a snapshot under way when audio starts is dropped, not written over the sound", async () => {
    startChapter(40, 0); await tick();
    play(0); await tick();
    let open!: () => void;
    h.gate = new Promise<void>((r) => { open = r; });
    set({ status: "buffering" }); await tick(); // a snapshot starts: it waits on the route read
    play(1); await tick(); // and audio starts before the read answers
    const writesBefore = h.writes.length;
    open(); h.gate = null; await tick();
    expect(h.writes.length).toBe(writesBefore); // the snapshot saw the sound and wrote nothing
    for (const w of h.writes) expect(w.status, `write to ${w.key}`).not.toBe("playing");
  });

  it("a session that ends normally is filed and its snapshot cleared", async () => {
    startChapter(40, 0); await tick();
    play(0); set({ status: "buffering" }); await tick();
    expect(live()).not.toBeNull();
    stop(); await tick();
    expect(h.settings.get(LIVE)).toBe("");
    const filed = JSON.parse(h.settings.get(KEY)!) as ResilienceSession[];
    expect(filed.map((x) => x.endReason)).toEqual(["stop"]);
  });

  it("privacy: the snapshot carries no chapter label, title or text", async () => {
    startChapter(40, 3); await tick(); play(3); set({ status: "buffering" }); await tick();
    const raw = h.settings.get(LIVE)!;
    expect(raw).not.toContain(PRIVATE_LABEL);
    expect(raw).not.toContain("chapterLabel");
  });
});

describe("crash safety — a snapshot left behind is filed on the next start", () => {
  it("the next launch files it, marked, exactly once, and clears the live key", async () => {
    // A session the last process never closed: still on the live key, not in the history.
    const orphan = { ...(await snapshotOf()), id: "crashed-session" };
    vi.resetModules();
    h.settings.clear();
    h.settings.set(KEY, JSON.stringify([]));
    h.settings.set(LIVE, JSON.stringify(orphan));
    const fresh = await import("../../src/lib/ttsTelemetry");
    fresh.registerTtsTelemetry();
    await tick();
    const all = await fresh.ttsTelemetry();
    const found = all.filter((x) => x.id === "crashed-session");
    expect(found.length).toBe(1);
    expect(found[0].meta.recoveredFromLive).toBe(true);
    expect(found[0].endReason).toBe("open");
    expect(h.settings.get(LIVE)).toBe("");
  });

  it("a snapshot of a session that WAS filed is not filed twice", async () => {
    const filed = { ...(await snapshotOf()), id: "already-filed", endReason: "stop" as const };
    vi.resetModules();
    h.settings.clear();
    h.settings.set(KEY, JSON.stringify([filed]));
    h.settings.set(LIVE, JSON.stringify({ ...filed, endReason: "open" }));
    const fresh = await import("../../src/lib/ttsTelemetry");
    fresh.registerTtsTelemetry();
    await tick();
    expect((await fresh.ttsTelemetry()).filter((x) => x.id === "already-filed").length).toBe(1);
    expect(h.settings.get(LIVE)).toBe("");
  });
});

describe("routes — each route the engine tried is filed under the session it happened in", () => {
  it("a 429 from the first route, the other route answering, and a try between sessions that belongs to neither", async () => {
    const before = Date.now() - 60_000;
    h.routes.push(route(1, before, "msedge", "ok", null)); // before this session: not its route
    startChapter(40, 0); await tick();
    const t = Date.now();
    h.routes.push(route(2, t, "msedge", "rate-limited", 429), route(3, t + 1, "bing", "ok", null));
    play(0); set({ status: "buffering" }); await tick();
    expect(live()!.routes!.map((r) => [r.route, r.outcome, r.status])).toEqual([["msedge", "rate-limited", 429], ["bing", "ok", null]]);
    play(0); await tick();
    h.routes.push(route(4, Date.now(), "msedge", "ok", null)); // the session's last try, before it ends
    stop(); await tick();
    const filed = JSON.parse(h.settings.get(KEY)!) as ResilienceSession[];
    expect(filed.length).toBe(1);
    expect(filed[0].routes!.map((r) => r.seq)).toEqual([2, 3, 4]); // in order, each once, the stray one left out
    for (const w of h.writes) expect(w.status).not.toBe("playing");
  });
});

/** A realistic session record, produced by the observer itself. */
async function snapshotOf(): Promise<ResilienceSession> {
  startChapter(40, 0); await tick();
  play(0); set({ status: "buffering" }); await tick();
  const s = live()!;
  stop(); await tick();
  return s;
}
