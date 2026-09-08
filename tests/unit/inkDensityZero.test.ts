// «كثافة الحبر» REACHES ZERO, AND ZERO MEANS NO COLOUR AT ALL.
//
// THE DEFECT THIS PINS. The density scale began at `INK_MIN`, and a second guard held the final
// opacity at 0.06 whatever arrived — two floors, both put there so a mark could never become
// invisible by accident. The consequence was that the lowest a reader could go still laid colour
// over the words, and "keep the mark, drop the wash" — an ordinary thing to want, with the note, the
// tags and the place all surviving — had no value on the dial.
//
// ZERO IS NOT A DENSITY, which is why it is answered before both floors rather than by lowering
// them. Everything above zero keeps the meaning it has always had: no stored density changes
// appearance, and nothing already saved has to be migrated.
import { describe, expect, it } from "vitest";

import {
  INK_BASE_DARK,
  INK_BASE_LIGHT,
  INK_MIN,
  INK_NONE,
  resolveHighlightInk,
} from "../../src/lib/highlightInk";

const AMBER = "#E8C36A";
const LIGHT = { ink: AMBER, dark: false, paper: "#F6EFE2" };
const DARK = { ink: AMBER, dark: true, paper: "#161310" };

describe("zero", () => {
  it("paints nothing at all", () => {
    expect(resolveHighlightInk({ ...LIGHT, alpha: 0 }).opacity).toBe(0);
  });

  it("paints nothing on a dark paper either", () => {
    expect(resolveHighlightInk({ ...DARK, alpha: 0 }).opacity).toBe(0);
  });

  it("and is exactly the constant the control uses, so the two cannot drift", () => {
    expect(INK_NONE).toBe(0);
    expect(resolveHighlightInk({ ...LIGHT, alpha: INK_NONE }).opacity).toBe(0);
  });

  it("still resolves a colour and a blend — the mark exists, it is simply not shown", () => {
    // What must NOT happen is the row losing its identity: the note, the tags and the colour the
    // reader chose all stay, and only the wash goes.
    const r = resolveHighlightInk({ ...LIGHT, alpha: 0 });
    expect(r.fill).toBe(AMBER);
    expect(r.blend).toBe("multiply");
  });

  it("a value below zero cannot arrive, but if one did it would also be nothing", () => {
    expect(resolveHighlightInk({ ...LIGHT, alpha: -0.4 }).opacity).toBe(0);
  });
});

describe("every other value means exactly what it always meant", () => {
  // The compatibility requirement, checked against the arithmetic rather than against a snapshot:
  // `base * clamp(alpha) * 1.35`, capped at `base * 1.35`.
  const expected = (base: number, alpha: number) =>
    Math.max(0.06, Math.min(base * 1.35, base * Math.max(INK_MIN, Math.min(1, alpha)) * 1.35));

  for (const alpha of [0.15, 0.2, 0.3, 0.5, 0.75, 0.9, 1]) {
    it(`light paper at ${alpha} is unchanged`, () => {
      expect(resolveHighlightInk({ ...LIGHT, alpha }).opacity).toBeCloseTo(expected(INK_BASE_LIGHT, alpha), 10);
    });
  }

  for (const alpha of [0.15, 0.5, 1]) {
    it(`dark paper at ${alpha} is unchanged`, () => {
      expect(resolveHighlightInk({ ...DARK, alpha }).opacity).toBeCloseTo(expected(INK_BASE_DARK, alpha), 10);
    });
  }

  it("a value between zero and the floor is still lifted to the floor, as before", () => {
    // The floor is what stops a density becoming invisible BY ACCIDENT. It is untouched; only the
    // one value that is not a density at all now passes it.
    expect(resolveHighlightInk({ ...LIGHT, alpha: 0.02 }).opacity)
      .toBeCloseTo(resolveHighlightInk({ ...LIGHT, alpha: INK_MIN }).opacity, 10);
    expect(resolveHighlightInk({ ...LIGHT, alpha: 0.02 }).opacity).toBeGreaterThan(0);
  });

  it("a mark that has never been dialled still follows the theme", () => {
    expect(resolveHighlightInk({ ...LIGHT, alpha: null }).opacity).toBeCloseTo(INK_BASE_LIGHT, 10);
    expect(resolveHighlightInk({ ...LIGHT }).opacity).toBeCloseTo(INK_BASE_LIGHT, 10);
  });

  it("null is NOT zero — an untouched mark is not an invisible one", () => {
    // The one confusion that would be catastrophic on an existing library: every highlight ever made
    // without touching the control carries a null density.
    expect(resolveHighlightInk({ ...LIGHT, alpha: null }).opacity).toBeGreaterThan(0);
  });
});

describe("the control can actually reach it", () => {
  it("the strip lands on «بلا» in its first half-bar, and the editor says so in words", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/features/reader/AnnotationLayer.tsx"), "utf8");
    expect(src).toContain("raw <= HALF_BAR ? INK_NONE");
    expect(src).toContain("next <= HALF_BAR ? INK_NONE");
    // A percentage a reader has to interpret is not the answer to "is there any colour?".
    expect(src).toContain('t("ne.densityNone")');
    // And the keyboard has to be able to say it too.
    expect(src).toContain("aria-valuemin={0}");
  });
});
