// THE AFTER-UPDATE WHAT'S NEW, ACROSS LAUNCHES.
//
// Drives the REAL store with the app version and the settings table replaced at their module
// boundaries, exactly as `updaterLaunchCheck.test.ts` does for the update check. A launch is a fresh
// module instance — what a new process gets — while the settings rows SURVIVE from one launch to the
// next, as the database does.
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  ROWS: new Map<string, string>(),
  WRITES: [] as Array<[string, string]>,
  version: "1.4.1",
  calls: { getVersion: 0, settingsGet: 0 },
  failRead: false,
  failWrite: false,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => {
    H.calls.getVersion++;
    return H.version;
  },
}));
vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  settingsGet: async (k: string) => {
    H.calls.settingsGet++;
    if (H.failRead) throw new Error("read failed");
    return H.ROWS.get(k) ?? null;
  },
  settingsSet: async (k: string, v: string) => {
    if (H.failWrite) throw new Error("write failed");
    H.WRITES.push([k, v]);
    H.ROWS.set(k, v);
    return true;
  },
}));

import { SEEN_KEY, WHATS_NEW_VERSION } from "../../src/features/updater/whatsNew";

/** A fresh launch: a new module instance, as a new process would have. */
const launch = async () => {
  vi.resetModules();
  return await import("../../src/features/updater/afterUpdate");
};

beforeEach(() => {
  H.ROWS.clear();
  H.WRITES.length = 0;
  H.version = WHATS_NEW_VERSION;
  H.calls.getVersion = 0;
  H.calls.settingsGet = 0;
  H.failRead = false;
  H.failWrite = false;
});

describe("a fresh install", () => {
  it("is not shown what's new — the first-run picker records the installed version first", async () => {
    const m = await launch();
    await m.markFirstRun(); // the language picker, before the library mounts
    await m.useAfterUpdate.getState().check();
    expect(m.useAfterUpdate.getState().open).toBe(false);
    expect(H.ROWS.get(SEEN_KEY)).toBe(WHATS_NEW_VERSION);
  });

  it("nor on the launch after it", async () => {
    await (await launch()).markFirstRun();
    const next = await launch();
    await next.useAfterUpdate.getState().check();
    expect(next.useAfterUpdate.getState().open).toBe(false);
  });

  it("even when recording the version fails, the first launch itself shows nothing", async () => {
    H.failWrite = true;
    const m = await launch();
    await m.markFirstRun();
    await m.useAfterUpdate.getState().check();
    expect(m.useAfterUpdate.getState().open).toBe(false);
  });
});

describe("updating to the version the notes describe", () => {
  it("shows them on the first launch, and records nothing until the reader closes them", async () => {
    // An installation that ran an earlier version: a language was chosen, no seen-version recorded.
    H.ROWS.set("ui_lang", "ar");
    const m = await launch();
    await m.useAfterUpdate.getState().check();
    expect(m.useAfterUpdate.getState().open).toBe(true);
    expect(m.useAfterUpdate.getState().version).toBe(WHATS_NEW_VERSION);
    expect(H.WRITES).toEqual([]); // presented, not yet confirmed: nothing marked

    await m.useAfterUpdate.getState().confirm();
    expect(m.useAfterUpdate.getState().open).toBe(false);
    expect(H.WRITES).toEqual([[SEEN_KEY, WHATS_NEW_VERSION]]);
  });

  it("does not show them again after a restart", async () => {
    const first = await launch();
    await first.useAfterUpdate.getState().check();
    await first.useAfterUpdate.getState().confirm();

    const second = await launch();
    await second.useAfterUpdate.getState().check();
    expect(second.useAfterUpdate.getState().open).toBe(false);
  });

  it("shows them again if Sard closed before the reader dismissed them", async () => {
    const first = await launch();
    await first.useAfterUpdate.getState().check();
    expect(first.useAfterUpdate.getState().open).toBe(true);
    // …the process ends here, without confirm().

    const second = await launch();
    await second.useAfterUpdate.getState().check();
    expect(second.useAfterUpdate.getState().open).toBe(true);
  });

  it("shows them over a record of an older version", async () => {
    H.ROWS.set(SEEN_KEY, "1.4.0");
    const m = await launch();
    await m.useAfterUpdate.getState().check();
    expect(m.useAfterUpdate.getState().open).toBe(true);
  });

  it("decides once per launch, however often the library remounts", async () => {
    const m = await launch();
    await m.useAfterUpdate.getState().check();
    await m.useAfterUpdate.getState().confirm();
    await m.useAfterUpdate.getState().check(); // a book was opened and closed: the library mounted again
    expect(m.useAfterUpdate.getState().open).toBe(false);
    expect(H.calls.getVersion).toBe(1);
    expect(H.calls.settingsGet).toBe(1);
  });
});

describe("failures never mark the version as seen", () => {
  it("a settings read that fails shows nothing and records nothing", async () => {
    H.failRead = true;
    const m = await launch();
    await m.useAfterUpdate.getState().check();
    expect(m.useAfterUpdate.getState().open).toBe(false);
    expect(H.WRITES).toEqual([]);

    H.failRead = false; // the next launch can read: the notes are still due
    const next = await launch();
    await next.useAfterUpdate.getState().check();
    expect(next.useAfterUpdate.getState().open).toBe(true);
  });

  it("a record that fails to save leaves the notes due on the next launch", async () => {
    const m = await launch();
    await m.useAfterUpdate.getState().check();
    H.failWrite = true;
    await m.useAfterUpdate.getState().confirm();
    expect(m.useAfterUpdate.getState().open).toBe(false); // closed for this session

    H.failWrite = false;
    const next = await launch();
    await next.useAfterUpdate.getState().check();
    expect(next.useAfterUpdate.getState().open).toBe(true);
  });
});

describe("a build the notes do not describe", () => {
  it("shows nothing — a development build still numbered as the previous release", async () => {
    H.version = "1.4.0";
    const m = await launch();
    await m.useAfterUpdate.getState().check();
    expect(m.useAfterUpdate.getState().open).toBe(false);
  });
});
