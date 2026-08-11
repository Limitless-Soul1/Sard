// CAPABILITIES MUST NOT GRANT A PERMISSION ITS PLATFORM HAS NO PLUGIN FOR.
//
// `updater` and `process` are registered under `#[cfg(all(desktop, not(feature = "diag")))]`, and
// `single-instance` cannot even compile for mobile. A capability that still lists `updater:default`
// on Android or iOS is asking the ACL for a permission no registered plugin provides — a mobile-only
// failure that no desktop build, and no desktop test, can reach.
//
// So the invariant is asserted here, over the capability files themselves, where it is cheap and
// platform-independent. These files are data: nothing else in the suite reads them, and a hand edit
// that re-granted a desktop permission to mobile would otherwise be found by a device, months later.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", "src-tauri", "capabilities");

interface Capability {
  identifier: string;
  platforms?: string[];
  windows?: string[];
  permissions: string[];
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (f: string): Capability => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const caps = files.map((f) => ({ file: f, cap: load(f) }));

const DESKTOP = ["linux", "macOS", "windows"] as const;
const MOBILE = ["android", "iOS"] as const;

/** Permission prefixes whose plugin is registered only on desktop — see src-tauri/src/lib.rs. */
const DESKTOP_ONLY_PREFIXES = ["updater:", "process:"];

describe("capabilities — every platform is covered exactly once", () => {
  it("declares platforms explicitly on every capability", () => {
    // An omitted `platforms` means "all targets" — which is precisely the bug this guards against,
    // because it silently re-grants desktop permissions to mobile.
    for (const { file, cap } of caps) {
      expect(Array.isArray(cap.platforms), `${file} must declare platforms`).toBe(true);
      expect(cap.platforms!.length, `${file} must not declare an empty platform list`).toBeGreaterThan(0);
    }
  });

  it("covers all five targets with no gap and no overlap", () => {
    const seen = new Map<string, string>();
    for (const { file, cap } of caps) {
      for (const p of cap.platforms!) {
        expect(seen.has(p), `${p} is claimed by both ${seen.get(p)} and ${file}`).toBe(false);
        seen.set(p, file);
      }
    }
    expect([...seen.keys()].sort()).toEqual([...DESKTOP, ...MOBILE].sort());
  });
});

describe("capabilities — mobile is not granted desktop-only permissions", () => {
  const mobileCaps = caps.filter(({ cap }) => cap.platforms!.some((p) => (MOBILE as readonly string[]).includes(p)));

  it("has at least one mobile capability, or this suite proves nothing", () => {
    expect(mobileCaps.length).toBeGreaterThan(0);
  });

  it("grants no updater or process permission on any mobile target", () => {
    for (const { file, cap } of mobileCaps) {
      for (const perm of cap.permissions) {
        for (const prefix of DESKTOP_ONLY_PREFIXES) {
          expect(perm.startsWith(prefix), `${file} grants "${perm}", whose plugin is desktop-only`).toBe(false);
        }
      }
    }
  });
});

describe("capabilities — desktop is unchanged", () => {
  const desktop = caps.find(({ cap }) => cap.identifier === "default")!;

  it("still targets exactly the three desktop platforms", () => {
    expect(desktop.cap.platforms!.slice().sort()).toEqual([...DESKTOP].slice().sort());
  });

  // The permission list is asserted VERBATIM, not by property. Desktop behaviour must be preserved
  // exactly across this change, and an exact list is the only assertion that would notice a silent
  // addition or removal.
  it("keeps every permission it had before the split", () => {
    expect(desktop.cap.permissions).toEqual([
      "core:default",
      "opener:default",
      "dialog:default",
      "updater:default",
      "process:allow-restart",
      "core:window:allow-set-fullscreen",
      "core:window:allow-is-fullscreen",
      "core:window:allow-destroy",
    ]);
  });

  it("still scopes to the main window", () => {
    expect(desktop.cap.windows).toEqual(["main"]);
  });
});
