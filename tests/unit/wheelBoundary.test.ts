// A CHAPTER SHORTER THAN THE WINDOW MUST STILL BE ONE YOU CAN LEAVE — IN BOTH DIRECTIONS.
//
// Books are full of sections with almost nothing in them: a dedication, a part title, an epigraph, a
// one-line colophon. In scrolled flow they have NO travel — the viewport is taller than the whole
// section — so the reader's usual way out, scrolling to an edge and pushing again, has no distance to
// cover and the position alone cannot say which edge the gesture began at.
//
// Measured in the running reader before the fix (window 1280x860, a book of such sections): a
// one-line section reported viewSize 228 against size 860 and start 0. Scrolling down left it every
// time; scrolling up never did, on any short section, in Arabic and in English — three deliberate
// gestures each, and the reader stayed exactly where they were. The engine was never the obstacle:
// `prev()` called directly moved back immediately.
//
// The numbers in these tests are the measured ones, not invented ones.
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_PAUSE_MS,
  IDLE_GESTURE,
  wheelBoundary,
  type WheelGeometry,
  type WheelGesture,
} from "../../src/reader-engine/wheelBoundary";

const UP = -120;
const DOWN = 120;

/** A section with no travel at all — measured: a one-line chapter in an 860px-tall window. */
const SHORT: WheelGeometry = { viewSize: 228, size: 860, start: 0 };
/** An ordinary chapter, with room to scroll inside it. */
const LONG: WheelGeometry = { viewSize: 1801, size: 860, start: 0 };
const LONG_AT_BOTTOM: WheelGeometry = { viewSize: 1801, size: 860, start: 941 };
const LONG_MIDDLE: WheelGeometry = { viewSize: 1801, size: 860, start: 400 };

/**
 * One deliberate gesture: a pause, then a burst of notches.
 *
 * This is what a reader does — flick, look, flick again — and it is also what the boundary rule is
 * built around, since a gesture may cross at most one boundary however long the burst.
 */
function gesture(
  geom: WheelGeometry,
  delta: number,
  state: WheelGesture,
  startAt: number,
  notches = 5,
) {
  let s = state;
  const actions: string[] = [];
  let t = startAt;
  for (let i = 0; i < notches; i++) {
    const out = wheelBoundary(delta, geom, s, t);
    actions.push(out.action);
    s = out.state;
    t += 20; // inside one gesture, notches arrive ~16-80ms apart
  }
  return { actions, state: s, endedAt: t };
}

/** Make a fresh gesture by leaving a gap longer than the boundary pause. */
const afterPause = (t: number) => t + BOUNDARY_PAUSE_MS + 40;

describe("a chapter with no scroll travel", () => {
  it("can be left BACKWARDS — the reported failure", () => {
    // Before the fix this returned "hold" for every notch of every gesture, for ever.
    const { actions } = gesture(SHORT, UP, IDLE_GESTURE, 1000);
    expect(actions).toContain("prev");
  });

  it("can be left FORWARDS, as it always could", () => {
    const { actions } = gesture(SHORT, DOWN, IDLE_GESTURE, 1000);
    expect(actions).toContain("next");
  });

  it("crosses at most ONE boundary per gesture, in either direction", () => {
    // A hard flick must not sail through several chapters at once.
    const up = gesture(SHORT, UP, IDLE_GESTURE, 1000, 12);
    expect(up.actions.filter((a) => a === "prev")).toHaveLength(1);
    const down = gesture(SHORT, DOWN, IDLE_GESTURE, 1000, 12);
    expect(down.actions.filter((a) => a === "next")).toHaveLength(1);
  });

  it("answers a second, deliberate gesture in the same direction", () => {
    // Two chapters back takes two gestures, and gets them.
    const first = gesture(SHORT, UP, IDLE_GESTURE, 1000);
    expect(first.actions).toContain("prev");
    const second = gesture(SHORT, UP, first.state, afterPause(first.endedAt));
    expect(second.actions).toContain("prev");
  });

  it("lets the reader change their mind and go the other way", () => {
    const back = gesture(SHORT, UP, IDLE_GESTURE, 1000);
    expect(back.actions).toContain("prev");
    const forward = gesture(SHORT, DOWN, back.state, afterPause(back.endedAt));
    expect(forward.actions).toContain("next");
  });

  it("does not move within one continuous gesture that has already acted", () => {
    // The rest of a burst holds: this is what stops a single flick chaining chapters.
    const { actions } = gesture(SHORT, UP, IDLE_GESTURE, 1000, 8);
    const firstPrev = actions.indexOf("prev");
    expect(actions.slice(firstPrev + 1).every((a) => a === "hold")).toBe(true);
  });

  it("behaves the same at any window size, because it reads geometry and not pixels", () => {
    // A tall desktop window and a short one: in both, the section has no travel, so both must answer.
    for (const size of [500, 860, 1400, 2200]) {
      const geom = { viewSize: 228, size, start: 0 };
      expect(gesture(geom, UP, IDLE_GESTURE, 1000).actions).toContain("prev");
      expect(gesture(geom, DOWN, IDLE_GESTURE, 1000).actions).toContain("next");
    }
  });

  it("behaves the same at any font size, which only changes how tall the content is", () => {
    // Larger type makes a short section taller; while it still does not fill the window, nothing
    // changes. The case where it grows PAST the window is an ordinary chapter and is covered below.
    for (const viewSize of [40, 120, 228, 600, 856]) {
      const geom = { viewSize, size: 860, start: 0 };
      expect(gesture(geom, UP, IDLE_GESTURE, 1000).actions).toContain("prev");
    }
  });
});

describe("an ordinary chapter is untouched", () => {
  it("scrolls in the middle rather than changing chapter", () => {
    const { actions } = gesture(LONG_MIDDLE, DOWN, IDLE_GESTURE, 1000, 6);
    expect(actions.every((a) => a === "scroll")).toBe(true);
    const up = gesture(LONG_MIDDLE, UP, IDLE_GESTURE, 1000, 6);
    expect(up.actions.every((a) => a === "scroll")).toBe(true);
  });

  it("at its top, goes back on a deliberate gesture", () => {
    expect(gesture(LONG, UP, IDLE_GESTURE, 1000).actions).toContain("prev");
  });

  it("at its bottom, goes on", () => {
    expect(gesture(LONG_AT_BOTTOM, DOWN, IDLE_GESTURE, 1000).actions).toContain("next");
  });

  it("at its top, scrolling DOWN is a scroll and never a chapter change", () => {
    const { actions } = gesture(LONG, DOWN, IDLE_GESTURE, 1000, 6);
    expect(actions).not.toContain("next");
    expect(actions.every((a) => a === "scroll")).toBe(true);
  });

  it("at its bottom, scrolling UP is a scroll and never a chapter change", () => {
    const { actions } = gesture(LONG_AT_BOTTOM, UP, IDLE_GESTURE, 1000, 6);
    expect(actions).not.toContain("prev");
    expect(actions.every((a) => a === "scroll")).toBe(true);
  });

  it("does not chain from the end of one chapter into the next mid-gesture", () => {
    // Reaching the bottom during a burst stops there; only a NEW gesture crosses.
    const reach = gesture(LONG_MIDDLE, DOWN, IDLE_GESTURE, 1000, 4);
    expect(reach.actions.every((a) => a === "scroll")).toBe(true);
    const atEdge = gesture(LONG_AT_BOTTOM, DOWN, reach.state, reach.endedAt + 20, 6);
    expect(atEdge.actions).not.toContain("next"); // same gesture, began mid-chapter
    const fresh = gesture(LONG_AT_BOTTOM, DOWN, atEdge.state, afterPause(atEdge.endedAt));
    expect(fresh.actions).toContain("next"); // a deliberate second push does cross
  });
});

describe("the guards that keep a wheel safe", () => {
  it("never traps the wheel before the renderer has laid out", () => {
    for (const geom of [{ viewSize: 0, size: 0, start: 0 }, { viewSize: NaN, size: 860, start: 0 }, { viewSize: 228, size: 0, start: 0 }]) {
      const out = wheelBoundary(UP, geom, IDLE_GESTURE, 1000);
      expect(out.action).toBe("scroll");
    }
  });

  it("does not let a mid-layout event start a gesture", () => {
    // The clock must not advance while the renderer is unmeasured, or the first real event after it
    // would not read as a fresh gesture and the reader's first push would be swallowed.
    const midLayout = wheelBoundary(UP, { viewSize: 0, size: 0, start: 0 }, IDLE_GESTURE, 1000);
    expect(midLayout.state.wheelTs).toBe(IDLE_GESTURE.wheelTs);
    expect(gesture(SHORT, UP, midLayout.state, 1000).actions).toContain("prev");
  });

  it("treats a section a hair taller than the window as short, not as scrollable", () => {
    // The tolerance exists so a sub-pixel overflow is not mistaken for room to scroll.
    const hair = { viewSize: 862, size: 860, start: 0 };
    expect(gesture(hair, UP, IDLE_GESTURE, 1000).actions).toContain("prev");
  });

  it("treats a section comfortably taller than the window as scrollable", () => {
    const real = { viewSize: 900, size: 860, start: 0 };
    const { actions } = gesture(real, DOWN, IDLE_GESTURE, 1000, 6);
    expect(actions.every((a) => a === "scroll")).toBe(true);
  });
});
