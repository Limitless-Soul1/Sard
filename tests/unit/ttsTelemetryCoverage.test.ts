// SESSION COVERAGE of the read-aloud resilience telemetry — every way a listening session can begin
// must produce a record, and every way it can end must leave a valid one.
//
// THE DEFECT THIS PINS. A chapter that played out suspended the instrument, and nothing lifted the
// suspension while the player stayed active — but automatic continuation starts the next chapter
// without going through idle. Measured on a real day of listening: the older instrument recorded 11
// sessions, this one 2, and every chapter that began by continuation was missing — including the one
// with the day's only failure. An instrument that goes blind exactly when the listener keeps listening
// is worse than none, because its silence reads as a quiet session.
//
// The observer is driven through the real store, so the transitions here are the ones the player
// makes. Persistence is stubbed in memory; no write ever reaches a database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
vi.mock("../../src/lib/ipc", () => ({
  settingsGet: async (k: string) => settings.get(k) ?? null,
  settingsSet: async (k: string, v: string) => { settings.set(k, v); },
}));

// The suite runs in plain Node, by design (see vitest.config.ts). The observer needs `window` for one
// thing only — its `pagehide` listener — so a bare event target stands in for it. No DOM is shimmed.
(globalThis as unknown as { window: EventTarget }).window = new EventTarget();

import { useTts } from "../../src/lib/tts";
import { registerTtsTelemetry, resetTtsTelemetry, ttsTelemetry, ttsTelemetryHealth } from "../../src/lib/ttsTelemetry";

const PRIVATE_LABEL = "PRIVATE-CHAPTER-LABEL-MUST-NEVER-BE-RECORDED";
const set = (patch: Partial<ReturnType<typeof useTts.getState>>) => useTts.setState(patch as never);
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The player as `start()` leaves it: active, preparing, the chapter's sentence count and label known. */
function startChapter(total: number, index = 0) {
  set({ active: true, status: "preparing", index, total, chapterLabel: PRIVATE_LABEL, engine: "edge", voice: "en-AU-WilliamMultilingualNeural", speed: 1.3, retryAttempt: 0, error: null });
}
function play(index: number) { set({ status: "playing", index }); }
function chapterEnds() { set({ status: "chapter-end" }); }
function stop() { set({ active: false, status: "idle" }); }

describe("resilience telemetry — a session for every way listening begins", () => {
  beforeEach(async () => {
    settings.clear();
    await resetTtsTelemetry();
    stop();
    await tick();
    registerTtsTelemetry();
  });

  it("a manual start opens a session; a chapter that plays out closes it", async () => {
    startChapter(121, 96); await tick();
    play(96); play(97); play(98); await tick();
    chapterEnds(); await tick();
    const s = await ttsTelemetry();
    expect(s.length).toBe(1);
    expect(s[0].endReason).toBe("chapterEnd");
    expect(s[0].units).toBe(121);
    expect(s[0].unitsAdvanced).toBe(2);
    expect(s[0].endedAt).not.toBeNull();
  });

  it("REGRESSION: a chapter that continues automatically after a chapter end gets its own session", async () => {
    startChapter(121, 96); await tick();
    play(96); play(97); await tick();
    chapterEnds(); await tick();
    // the player never goes idle: the next chapter is started while still active
    startChapter(125, 0); await tick();
    play(0); play(1); play(2); await tick();
    chapterEnds(); await tick();
    // ...and a third, the same way
    startChapter(123, 0); await tick();
    play(0); play(1); await tick();
    chapterEnds(); await tick();
    const s = await ttsTelemetry();
    expect(s.map((x) => [x.units, x.unitsAdvanced, x.endReason])).toEqual([
      [121, 1, "chapterEnd"],
      [125, 2, "chapterEnd"],
      [123, 1, "chapterEnd"],
    ]);
    expect(ttsTelemetryHealth().faults).toBe(0);
  });

  it("a chapter change while a chapter is still playing closes the old session as 'chapterChange' and opens the next", async () => {
    startChapter(121, 0); await tick();
    play(0); play(1); await tick();
    startChapter(140, 0); await tick(); // the listener pressed Next mid-chapter
    play(0); await tick();
    stop(); await tick();
    const s = await ttsTelemetry();
    expect(s.map((x) => [x.units, x.endReason])).toEqual([[121, "chapterChange"], [140, "stop"]]);
  });

  it("a voice change and a retry after an error stay inside the same session", async () => {
    startChapter(121, 0); await tick();
    play(0); await tick();
    set({ status: "preparing", voice: "ar-EG-ShakirNeural" }); await tick(); // setVoice
    play(1); await tick();
    set({ status: "edge-error", error: "edge-unavailable: recovery failed" }); await tick();
    set({ status: "preparing", error: null }); await tick(); // Retry
    play(1); await tick();
    stop(); await tick();
    const s = await ttsTelemetry();
    expect(s.length).toBe(1);
    expect(s[0].voiceChanges).toBe(1);
    expect(s[0].userRetries).toBe(1);
    expect(s[0].edgeErrors).toBe(1);
  });

  it("stop then restart: the stop closes one record, the restart opens a fresh one", async () => {
    startChapter(121, 0); await tick();
    play(0); play(1); await tick();
    stop(); await tick();
    startChapter(121, 1); await tick();
    play(1); play(2); await tick();
    stop(); await tick();
    const s = await ttsTelemetry();
    expect(s.map((x) => x.endReason)).toEqual(["stop", "stop"]);
    expect(s[1].startedAt).toBeGreaterThanOrEqual(s[0].startedAt);
  });

  it("teardown while listening leaves a final, valid record", async () => {
    startChapter(121, 0); await tick();
    play(0); play(1); await tick();
    window.dispatchEvent(new Event("pagehide")); await tick();
    const s = await ttsTelemetry();
    expect(s.length).toBe(1);
    expect(s[0].endReason).toBe("teardown");
    expect(s[0].endedAt).not.toBeNull();
    expect(s[0].unitsAdvanced).toBe(1);
    // and it was persisted, as JSON the loader can read back
    const raw = settings.get("tts_resilience_v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).length).toBe(1);
  });

  it("privacy: no chapter label, title or text ever reaches the record — through every path above", async () => {
    startChapter(121, 96); await tick(); play(96); await tick(); chapterEnds(); await tick();
    startChapter(125, 0); await tick(); play(0); await tick();
    window.dispatchEvent(new Event("pagehide")); await tick();
    const dump = JSON.stringify(await ttsTelemetry()) + (settings.get("tts_resilience_v1") ?? "");
    expect(dump).not.toContain(PRIVATE_LABEL);
    expect(dump).not.toContain("chapterLabel");
    for (const s of await ttsTelemetry()) expect(Object.keys(s)).not.toContain("chapter");
  });
});
