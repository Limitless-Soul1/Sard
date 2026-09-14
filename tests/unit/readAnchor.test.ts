// When a jump stops being a jump — the rule that decides whether the return pill survives its own
// landing. It was wrong once, in a way that only showed on some books, so every case is written down.
import { describe, expect, it } from "vitest";

import { landingStep } from "../../src/features/reader/readAnchor";

const THAW = 3;

describe("recording where a jump landed", () => {
  it("the first relocate after an anchor becomes the landing", () => {
    expect(landingStep(null, 42, false, THAW)).toEqual({ baseline: 42, thaw: false });
  });

  it("arriving is never adopting, however far the jump went", () => {
    expect(landingStep(null, 900, false, THAW).thaw).toBe(false);
  });

  it("while the navigation is still in flight, every relocate is still the landing", () => {
    // `goToSearchHit` navigates to the cfi and then scrolls to the hit's re-found text: two settles
    // for one jump. Measuring the second against the first is what made the pill vanish on arrival.
    expect(landingStep(42, 47, true, THAW)).toEqual({ baseline: 47, thaw: false });
    expect(landingStep(42, 900, true, THAW)).toEqual({ baseline: 900, thaw: false });
  });

  it("once the jump has resolved, reading on thaws", () => {
    expect(landingStep(42, 45, false, THAW)).toEqual({ baseline: 42, thaw: true });
    expect(landingStep(42, 60, false, THAW)).toEqual({ baseline: 42, thaw: true });
  });

  it("but not before the distance is reached", () => {
    expect(landingStep(42, 42, false, THAW).thaw).toBe(false);
    expect(landingStep(42, 43, false, THAW).thaw).toBe(false);
    expect(landingStep(42, 44, false, THAW).thaw).toBe(false);
  });

  it("paging BACK from the landing is inspection, not adoption", () => {
    expect(landingStep(42, 41, false, THAW).thaw).toBe(false);
    expect(landingStep(42, 0, false, THAW).thaw).toBe(false);
  });

  it("the baseline is left alone once fixed, so the distance is measured from one place", () => {
    expect(landingStep(42, 44, false, THAW).baseline).toBe(42);
    expect(landingStep(42, 41, false, THAW).baseline).toBe(42);
  });

  it("a settled jump that lands beyond the old baseline no longer thaws itself", () => {
    // The regression, stated as a test: same numbers, in flight versus resolved.
    expect(landingStep(42, 46, true, THAW).thaw).toBe(false);
    expect(landingStep(42, 46, false, THAW).thaw).toBe(true);
  });
});
