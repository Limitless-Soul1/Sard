// THE THREE STEPS MUST BE TELLABLE APART IN EVERY THEME.
//
// The defect this guards was not a wrong number, it was three numbers too close together: with a
// library picture the old mapping rendered Light and Glass at 80% and 80%, and Opaque 5 points away.
// A test asserting "three distinct values" passed on that, because 80 and 80 came from a code path
// it never exercised. So this asserts SEPARATION, in points of alpha, for every shipped theme.
import { describe, expect, it } from "vitest";
import { minChromeAlpha, stepBlur, stepK } from "../../src/lib/texture";
import { THEMES } from "../../src/theme/themes";

/** The panel's rendered alpha, exactly as the stylesheet computes it. */
const alphaOf = (step: "opaque" | "light" | "glass", floor: number, base = 1) =>
  Math.min(base, floor) + (base - Math.min(base, floor)) * stepK(step);

describe("interface texture is legible as three distinct steps", () => {
  // A library picture with NO scrim over it is the hardest case and the one the reader had.
  const HARDEST_SCRIM = 0;

  for (const [id, theme] of Object.entries(THEMES)) {
    it(`${id}: the three steps are far enough apart to name`, () => {
      const floor = minChromeAlpha(HARDEST_SCRIM, theme.colors);
      const [o, l, g] = (["opaque", "light", "glass"] as const).map((s) => alphaOf(s, floor));

      // Opaque means opaque: the desk does not show through the panel at all.
      expect(o).toBe(1);
      // Strictly ordered, and never under the floor the contrast measurement demands.
      expect(o).toBeGreaterThan(l);
      expect(l).toBeGreaterThan(g);
      expect(g).toBeGreaterThanOrEqual(floor - 1e-9);

      // The frost is the other half of the cue and must also be ordered and non-trivial.
      expect(stepBlur("opaque")).toBe(0);
      expect(stepBlur("glass")).toBeGreaterThan(stepBlur("light"));
      expect(stepBlur("light")).toBeGreaterThan(0);

      // Either the alpha separation is perceptible on its own, or the frost carries it. Three points
      // of alpha with no blur is what "I cannot tell them apart" looked like.
      const gapOL = (o - l) * 100;
      const gapLG = (l - g) * 100;
      expect(gapOL + stepBlur("light")).toBeGreaterThan(8);
      expect(gapLG + (stepBlur("glass") - stepBlur("light"))).toBeGreaterThan(8);
    });
  }
});
