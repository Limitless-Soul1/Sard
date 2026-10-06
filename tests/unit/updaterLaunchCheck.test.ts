// WHAT THE UPDATER ACTUALLY DOES WHEN SARD STARTS.
//
// The store is the whole decision: `auto()` is called once, from `UpdateRosette`'s mount effect,
// and everything about whether a launch checks for an update is decided inside it. These tests drive
// the REAL store with the plugin, the app version and the settings table replaced at their module
// boundaries, so the gating is exercised rather than described.
//
// `autoDone` is per-store state, so every case re-imports the module to get a fresh one — which is
// also exactly what a new process gets. That is the point: a launch is a fresh module, a fresh
// `autoDone`, and a settings row that SURVIVED the previous launch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  ROWS: new Map<string, string>(),
  WRITES: [] as Array<[string, string]>,
  calls: { check: 0 },
  /** What `check()` should do this test: resolve to null (current), an update, or throw. */
  impl: null as null | (() => unknown),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => { H.calls.check++; return H.impl ? H.impl() : null; },
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.3.0" }));
vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  settingsGet: async (k: string) => H.ROWS.get(k) ?? null,
  settingsSet: async (k: string, v: string) => { H.WRITES.push([k, v]); H.ROWS.set(k, v); return true; },
}));

const KEY = "updater_last_check";
const DAY = 24 * 60 * 60 * 1000;

/** A fresh launch: a new module instance, as a new process would have. */
const launch = async () => {
  vi.resetModules();
  return (await import("../../src/lib/updater")).useUpdater;
};

beforeEach(() => { H.ROWS.clear(); H.WRITES.length = 0; H.calls.check = 0; H.impl = null; });
afterEach(() => { vi.useRealTimers(); });

describe("the automatic check on launch", () => {
  it("runs when nothing has ever been checked", async () => {
    const useUpdater = await launch();
    await useUpdater.getState().auto();
    expect(H.calls.check).toBe(1);
  });

  it("runs at most once per launch, however many times the rosette mounts", async () => {
    // The Library remounts whenever the reader is closed, so the effect fires again in one process.
    const useUpdater = await launch();
    await useUpdater.getState().auto();
    await useUpdater.getState().auto();
    await useUpdater.getState().auto();
    expect(H.calls.check).toBe(1);
  });

  it("STILL runs on a launch moments after the previous one checked", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A persisted 24-hour gate used to live in `auto()`, and a
    // reader who restarted Sard a minute later performed no check at all — a release published in
    // between stayed invisible until the row aged past a day. "Checked yesterday" is not evidence
    // about today. A row left behind by any previous launch must not suppress this one.
    H.ROWS.set(KEY, String(Date.now() - 60_000));  // whatever a previous launch may have written
    const useUpdater = await launch();             // a brand-new process
    await useUpdater.getState().auto();
    expect(H.calls.check).toBe(1);
  });

  it("checks on every one of several consecutive launches", async () => {
    // Deterministic rather than accidental: five fresh processes, five checks. Each launch leaves
    // whatever state it leaves; none of it may reach the next one.
    for (let i = 0; i < 5; i++) {
      const useUpdater = await launch();
      await useUpdater.getState().auto();
      expect(H.calls.check, `launch ${i + 1}`).toBe(i + 1);
    }
  });

  it("does not gate on any persisted row, however old or new", async () => {
    // Guards the specific regression of a time window coming back in any form.
    for (const age of [0, 1_000, 60_000, DAY - 1, DAY + 1, 10 * DAY]) {
      H.calls.check = 0;
      H.ROWS.set(KEY, String(Date.now() - age));
      const useUpdater = await launch();
      await useUpdater.getState().auto();
      expect(H.calls.check, `age ${age}ms`).toBe(1);
    }
  });

  it("shows the dialog state only when an update is genuinely offered", async () => {
    H.impl = () => ({ version: "1.4.0", currentVersion: "1.3.0", body: "notes", download: async () => {}, install: async () => {} });
    const useUpdater = await launch();
    await useUpdater.getState().auto();
    const s = useUpdater.getState().state;
    expect(s.k).toBe("available");
    if (s.k === "available") { expect(s.version).toBe("1.4.0"); expect(s.current).toBe("1.3.0"); }
  });

  it("stays silent when the launch check finds nothing", async () => {
    const useUpdater = await launch();
    await useUpdater.getState().auto();
    // Deliberate: an automatic check must not interrupt a reader to say nothing happened.
    expect(useUpdater.getState().state.k).toBe("idle");
  });

  it("stays silent, and does not become a startup failure, when the check throws", async () => {
    H.impl = () => { throw new Error("error sending request: dns error"); };
    const useUpdater = await launch();
    await expect(useUpdater.getState().auto()).resolves.toBeUndefined();
    expect(useUpdater.getState().state.k).toBe("idle");
  });

  it("a failed check never suppresses the next launch", async () => {
    // THE SECOND HALF OF THE SAME DEFECT. The timestamp used to be written on the error path too, so
    // one launch with no network armed the gate for a day and the next launch skipped the check even
    // once the network was back — a check that never reached the endpoint recorded as one that had.
    H.impl = () => { throw new Error("error sending request: dns error"); };
    const first = await launch();
    await first.getState().auto();
    expect(first.getState().state.k).toBe("idle");  // silent, and not a startup failure

    H.calls.check = 0;
    H.impl = null;                                  // the network is back
    const second = await launch();                  // a brand-new process
    await second.getState().auto();
    expect(H.calls.check).toBe(1);
  });

  it("writes no persisted check-gate row at all", async () => {
    // The row is gone, not merely unread: leaving a write-only key would invite the gate back.
    H.impl = () => ({ version: "1.4.0", currentVersion: "1.3.0", body: "", download: async () => {}, install: async () => {} });
    const useUpdater = await launch();
    await useUpdater.getState().auto();
    await useUpdater.getState().manual();
    expect(H.WRITES.map(([k]) => k)).not.toContain(KEY);
  });
});

describe("the manual check", () => {
  it("always checks, whatever the persisted row says", async () => {
    H.ROWS.set(KEY, String(Date.now()));
    const useUpdater = await launch();
    await useUpdater.getState().manual();
    expect(H.calls.check).toBe(1);
  });

  it("reports being up to date, which the automatic path does not", async () => {
    const useUpdater = await launch();
    await useUpdater.getState().manual();
    const s = useUpdater.getState().state;
    expect(s.k).toBe("uptodate");
    if (s.k === "uptodate") expect(s.current).toBe("1.3.0");
  });

  it("surfaces a failure as an error state rather than silence", async () => {
    H.impl = () => { throw new Error("404 not found"); };
    const useUpdater = await launch();
    await useUpdater.getState().manual();
    const s = useUpdater.getState().state;
    expect(s.k).toBe("error");
    if (s.k === "error") expect(s.kind).toBe("server");
  });

  it("ignores a second tap while a check is already running", async () => {
    // The guard is what keeps repeated clicks from starting a second request. Driven by holding the
    // first check open, which is the only state in which a second tap is interesting.
    let release: () => void = () => {};
    H.impl = () => new Promise((r) => { release = () => r(null); });
    const useUpdater = await launch();
    const first = useUpdater.getState().manual();
    await Promise.resolve();
    await useUpdater.getState().manual();          // the second tap
    await useUpdater.getState().manual();          // and a third
    expect(H.calls.check).toBe(1);
    release();
    await first;
  });

  it("holds the spin long enough to be seen", async () => {
    // A check that resolves in a few ms would otherwise read as a dead button.
    const useUpdater = await launch();
    const started = Date.now();
    await useUpdater.getState().manual();
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });
});

describe("error classification", () => {
  it("maps each cause to its own sentence, and refuses to guess", async () => {
    const { classifyError } = await import("../../src/lib/updater");
    expect(classifyError(new Error("minisign: untrusted signature"))).toBe("signature");
    expect(classifyError(new Error("error sending request: dns error"))).toBe("offline");
    expect(classifyError(new Error("Could not fetch: 404 Not Found"))).toBe("server");
    expect(classifyError(new Error("unexpected EOF while streaming body"))).toBe("download");
    expect(classifyError(new Error("failed to spawn installer: permission denied"))).toBe("install");
    // Anything unrecognised must stay generic rather than be force-fitted into a category that
    // would tell the reader something untrue about their own machine.
    expect(classifyError(new Error("something entirely unfamiliar"))).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });
});
