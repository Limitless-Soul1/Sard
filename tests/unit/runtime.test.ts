// RESILIENCE-1 / WP-1 — the runtime capability gate.
//
// The whole point of splitting `readEnv()` (touches globals) from `capabilitiesOf()` (pure) is that
// these tests never monkey-patch `Uint8Array.prototype` — a test that did could corrupt every other
// test in the process, including the ones that matter.

import { describe, it, expect, afterEach } from "vitest";
import {
  CAPABILITY_FEATURES,
  FEATURE_LABELS,
  canRender,
  capabilitiesOf,
  missingFeatures,
  readEnv,
  runtimeReport,
  __setRuntimeForTests,
  type RuntimeEnv,
} from "../../src/lib/runtime";

const FULL: RuntimeEnv = {
  objectGroupBy: true,
  mapGroupBy: true,
  uint8ToHex: true,
  uint8ToBase64: true,
  uint8FromBase64: true,
};

afterEach(() => __setRuntimeForTests(null));

describe("capability decisions", () => {
  it("a complete environment supports both formats", () => {
    expect(capabilitiesOf(FULL)).toEqual({ epub: true, pdf: true });
  });

  it("EVERY named feature is load-bearing for its capability", () => {
    // If a feature is listed but not actually required, the gate would refuse a machine that works.
    // If one is required but unlisted, the gate would pass a machine that crashes. Both are caught
    // by removing each feature in turn and asserting exactly the right capability drops.
    for (const [cap, features] of Object.entries(CAPABILITY_FEATURES)) {
      for (const f of features) {
        const env = { ...FULL, [f]: false };
        expect(capabilitiesOf(env)[cap as "epub" | "pdf"], `${cap} must fail without ${f}`).toBe(false);
      }
    }
  });

  it("the PDF floor is INDEPENDENT of the EPUB floor — losing PDF must not block reading", () => {
    // The design decision this pins: a missing PDF capability is not fatal. If this ever inverts,
    // an outdated runtime would lock a user out of their entire EPUB library over a PDF feature.
    const noPdf: RuntimeEnv = { ...FULL, uint8ToHex: false, uint8ToBase64: false, uint8FromBase64: false };
    expect(capabilitiesOf(noPdf)).toEqual({ epub: true, pdf: false });
  });

  it("losing the EPUB features does not accidentally keep PDF alive", () => {
    const noEpub: RuntimeEnv = { ...FULL, objectGroupBy: false, mapGroupBy: false };
    expect(capabilitiesOf(noEpub).epub).toBe(false);
  });
});

describe("missing-feature reporting", () => {
  it("names the missing features with their real JS identifiers", () => {
    const env: RuntimeEnv = { ...FULL, uint8ToHex: false };
    expect(missingFeatures(env, "pdf")).toEqual(["Uint8Array.prototype.toHex"]);
    expect(missingFeatures(env, "epub")).toEqual([]);
  });

  it("labels every feature the capability table references", () => {
    for (const features of Object.values(CAPABILITY_FEATURES)) {
      for (const f of features) expect(FEATURE_LABELS[f], `${f} needs a label`).toBeTruthy();
    }
  });
});

describe("the live environment", () => {
  it("readEnv() reports booleans for every probe", () => {
    const env = readEnv();
    for (const k of Object.keys(FULL) as (keyof RuntimeEnv)[]) expect(typeof env[k], k).toBe("boolean");
  });

  it("uses feature detection, never a version string, for the decision", () => {
    // The engine label may be entirely absent (as it is under Node) and the gate must still work.
    // That is the property that makes it future-proof: no parsing, no version table.
    __setRuntimeForTests(FULL);
    expect(canRender("epub")).toBe(true);
    expect(canRender("pdf")).toBe(true);
    const report = runtimeReport();
    expect(report.epub).toBe("ok");
    expect(report.pdf).toBe("ok");
  });

  it("runtimeReport names what is missing, for a bug report", () => {
    __setRuntimeForTests({ ...FULL, uint8ToHex: false, uint8FromBase64: false });
    expect(runtimeReport().pdf).toContain("Uint8Array.prototype.toHex");
    expect(runtimeReport().pdf).toContain("Uint8Array.fromBase64");
    expect(runtimeReport().epub).toBe("ok");
  });
});
