// Auto-scrolling while dragging.
//
// Direct manipulation cannot reach what it cannot see: a drag holds the pointer, so a destination
// further down the page was unreachable without abandoning the operation. This is the arithmetic
// behind "approach an edge and the container follows you" — the part that decides how fast, and
// the part that decides whether anything should move at all.

import { describe, it, expect } from "vitest";
import { edgeScrollStep } from "../../src/features/library/design/dragScroll";

// A container occupying y = 100..600, comfortably taller than two 64px bands.
const TOP = 100;
const BOTTOM = 600;

describe("how fast a container follows the pointer", () => {
  it("does nothing while the pointer is clear of both edges", () => {
    expect(edgeScrollStep(300, TOP, BOTTOM)).toBe(0);
    expect(edgeScrollStep(350, TOP, BOTTOM)).toBe(0);
  });

  it("scrolls UP near the top edge and DOWN near the bottom", () => {
    expect(edgeScrollStep(TOP + 10, TOP, BOTTOM)).toBeLessThan(0);
    expect(edgeScrollStep(BOTTOM - 10, TOP, BOTTOM)).toBeGreaterThan(0);
  });

  it("speeds up as the pointer gets closer to the edge", () => {
    // The requirement is "gradually", so each step deeper must be at least as fast as the last,
    // and the extremes must genuinely differ.
    const depths = [60, 45, 30, 15, 2].map((d) => Math.abs(edgeScrollStep(TOP + d, TOP, BOTTOM)));
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    expect(depths[depths.length - 1]).toBeGreaterThan(depths[0]);
  });

  it("starts gently rather than bolting the moment it enters the band", () => {
    // Quadratic, not linear: one pixel inside the band is a crawl.
    const firstTouch = Math.abs(edgeScrollStep(TOP + 63, TOP, BOTTOM));
    const atTheEdge = Math.abs(edgeScrollStep(TOP, TOP, BOTTOM));
    expect(firstTouch).toBeLessThanOrEqual(2);
    expect(atTheEdge).toBeGreaterThan(firstTouch * 4);
  });

  it("never exceeds its ceiling, however far past the edge the pointer goes", () => {
    for (const y of [TOP, TOP - 50, TOP - 5000]) expect(edgeScrollStep(y, TOP, BOTTOM)).toBeGreaterThanOrEqual(-15);
    for (const y of [BOTTOM, BOTTOM + 50, BOTTOM + 5000]) expect(edgeScrollStep(y, TOP, BOTTOM)).toBeLessThanOrEqual(15);
  });

  it("always moves at least a pixel once it has decided to move", () => {
    // A step that rounds to zero would look like a container that has stopped responding.
    for (let d = 0; d < 64; d++) {
      const s = edgeScrollStep(TOP + d, TOP, BOTTOM);
      if (s !== 0) expect(Math.abs(s)).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves a container too short to have two distinct edges alone", () => {
    // Otherwise a small box would scroll in both directions at once and simply judder.
    expect(edgeScrollStep(60, 50, 150)).toBe(0);
    expect(edgeScrollStep(140, 50, 150)).toBe(0);
  });

  it("is symmetric — the same depth gives the same speed at either end", () => {
    for (const d of [5, 20, 40, 60]) {
      expect(Math.abs(edgeScrollStep(TOP + d, TOP, BOTTOM))).toBe(
        Math.abs(edgeScrollStep(BOTTOM - d, TOP, BOTTOM)),
      );
    }
  });

  it("respects a caller's own band and ceiling", () => {
    expect(edgeScrollStep(TOP + 5, TOP, BOTTOM, 10, 4)).toBe(-1);
    expect(edgeScrollStep(TOP, TOP, BOTTOM, 10, 4)).toBe(-4);
    expect(edgeScrollStep(TOP + 20, TOP, BOTTOM, 10, 4)).toBe(0);
  });
});
