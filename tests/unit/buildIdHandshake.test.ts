// THE BUILD-ID HANDSHAKE — the one comparison that only matters in an emergency.
//
// The core's id (compiled in by build.rs) and the frontend's (defined by Vite) are generated ONCE by
// one script and then travel by completely separate routes into the same binary. If they disagree,
// the executable is not carrying the frontend it was built with: a partial install, a stale cached
// bundle, an update that wrote one half. That was the live hypothesis in the 2026-08-07 installer
// investigation and nothing in the running app could confirm or rule it out.
//
// Which means the MISMATCH branch is a line of code that has never fired in normal use and would be
// trusted the one time it mattered. So it is tested here rather than assumed — including the cases
// where the honest answer is UNKNOWN, because a check that reports agreement when it has no evidence
// is worse than no check.
import { describe, expect, it } from "vitest";
import { compareBuildIds } from "../../src/lib/diag";

const REL = "REL-20260807031955-8174cff+12";
const DIAG = "DIAG-20260807032144-8174cff+12";

describe("compareBuildIds", () => {
  it("reports MATCH when both halves carry the same id", () => {
    expect(compareBuildIds(REL, REL)).toMatch(/^MATCH/);
  });

  it("reports MISMATCH when the core and the frontend differ", () => {
    const r = compareBuildIds(REL, DIAG);
    expect(r).toMatch(/MISMATCH/);
    expect(r).toContain("NOT running the frontend it was built with");
  });

  it("catches a stale frontend from an earlier build of the SAME kind", () => {
    // The realistic failure: same machine, same branch, an older bundle left behind. Only the
    // timestamp differs, so an equality check is the only thing that would notice.
    expect(compareBuildIds("REL-20260807031955-8174cff+12", "REL-20260806220000-8174cff+12")).toMatch(/MISMATCH/);
  });

  it("catches a one-character difference in the sha", () => {
    expect(compareBuildIds("REL-20260807031955-8174cff", "REL-20260807031955-8174cfa")).toMatch(/MISMATCH/);
  });

  for (const [name, core, front] of [
    ["the core reported nothing", null, REL],
    ["the frontend reported nothing", REL, null],
    ["neither reported anything", null, null],
    ["an empty string", "", REL],
  ] as const) {
    it(`says UNKNOWN — not MATCH — when ${name}`, () => {
      const r = compareBuildIds(core, front);
      expect(r).toMatch(/^UNKNOWN/);
      expect(r).not.toMatch(/^MATCH/);
    });
  }

  it("says UNKNOWN when the build ran outside the build scripts", () => {
    // build.rs and vite.config.ts both fall back to a string starting "UNSET" rather than inventing
    // an id. Two identical fallbacks are EQUAL, so a naive comparison would cheerfully report MATCH
    // for two builds that were never identified at all.
    const unset = "UNSET — built directly, not through the Sard build scripts";
    expect(compareBuildIds(unset, unset)).toMatch(/^UNKNOWN/);
    expect(compareBuildIds(unset, REL)).toMatch(/^UNKNOWN/);
  });
});
