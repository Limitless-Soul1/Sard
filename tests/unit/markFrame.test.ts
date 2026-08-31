// THE MARK'S FRAMING — the six surfaces that draw a profile's picture now ask one function how.
//
// Two things are pinned here and both are things that were once wrong in the product. That the
// DEFAULT emits exactly what those surfaces painted before framing existed, so a profile nobody has
// framed cannot move; and that the pan converts a pointer distance using the picture's real travel,
// which is what stops a drag crawling on a panorama and racing on a square.

import { describe, expect, it } from "vitest";

import { markFrame, panRange } from "../../src/features/profiles/model/markFrame";
import {
  ICON_FRAME_DEFAULT,
  ICON_SCALE_MAX,
  ICON_SCALE_MIN,
  isDefaultIconFrame,
  parseProfileData,
} from "../../src/features/profiles/model/profile";

describe("the framing a mark is drawn with", () => {
  it("emits no transform at the default, which is what `cover` always did", () => {
    const s = markFrame(ICON_FRAME_DEFAULT);
    expect(s.backgroundSize).toBe("cover");
    expect(s.backgroundPosition).toBe("50% 50%");
    expect(s.transform).toBeUndefined();
    expect(s.transformOrigin).toBeUndefined();
  });

  it("anchors the magnification to the SAME point it positions", () => {
    const s = markFrame({ focalX: 20, focalY: 80, scale: 2 });
    expect(s.backgroundPosition).toBe("20% 80%");
    expect(s.transform).toBe("scale(2)");
    // If these two ever disagreed the picture would slide out from under the reader's chosen point
    // as they zoomed — the one thing a crop control must never do.
    expect(s.transformOrigin).toBe(s.backgroundPosition);
  });

  it("treats a missing framing as the default rather than throwing", () => {
    expect(markFrame(null)).toEqual(markFrame(ICON_FRAME_DEFAULT));
    expect(markFrame(undefined).backgroundPosition).toBe("50% 50%");
  });

  it("knows when there is nothing to reset", () => {
    expect(isDefaultIconFrame(ICON_FRAME_DEFAULT)).toBe(true);
    expect(isDefaultIconFrame({ focalX: 50, focalY: 50, scale: 1.2 })).toBe(false);
    expect(isDefaultIconFrame({ focalX: 49, focalY: 50, scale: 1 })).toBe(false);
  });
});

describe("how far a picture can travel inside a mark", () => {
  it("is nothing at all for a square picture in a square box at 1x", () => {
    expect(panRange({ w: 220, h: 220 }, { w: 900, h: 900 }, 1)).toEqual({ x: 0, y: 0 });
  });

  it("is the overflow `cover` already creates when the aspects differ", () => {
    // A 2:1 picture in a square box: cover scales by height, so the width overflows by exactly the
    // box's own width.
    expect(panRange({ w: 200, h: 200 }, { w: 400, h: 200 }, 1)).toEqual({ x: 200, y: 0 });
  });

  it("grows with the scale, on both axes", () => {
    const r = panRange({ w: 200, h: 200 }, { w: 200, h: 200 }, 1.5);
    expect(r.x).toBeCloseTo(100, 6);
    expect(r.y).toBeCloseTo(100, 6);
  });

  it("refuses to invent a range from a picture of no size", () => {
    expect(panRange({ w: 200, h: 200 }, { w: 0, h: 0 }, 2)).toEqual({ x: 0, y: 0 });
    expect(panRange({ w: 0, h: 0 }, { w: 100, h: 100 }, 2)).toEqual({ x: 0, y: 0 });
  });
});

describe("what a stored framing is allowed to be", () => {
  const of = (icon: unknown) => parseProfileData(JSON.stringify({ icon })).icon;

  it("defaults for every profile written before framing existed", () => {
    expect(parseProfileData("{}").icon).toEqual(ICON_FRAME_DEFAULT);
    expect(parseProfileData("not json").icon).toEqual(ICON_FRAME_DEFAULT);
  });

  it("keeps a framing that is within range", () => {
    expect(of({ focalX: 12, focalY: 88, scale: 1.75 })).toEqual({ focalX: 12, focalY: 88, scale: 1.75 });
  });

  it("clamps rather than refuses — a drifted number is still a reader's own picture", () => {
    expect(of({ focalX: -40, focalY: 500, scale: 99 })).toEqual({
      focalX: 0, focalY: 100, scale: ICON_SCALE_MAX,
    });
    expect(of({ scale: 0.1 }).scale).toBe(ICON_SCALE_MIN);
  });

  it("ignores nonsense field by field", () => {
    expect(of({ focalX: "left", focalY: null, scale: NaN })).toEqual(ICON_FRAME_DEFAULT);
    expect(of("a string")).toEqual(ICON_FRAME_DEFAULT);
  });
});
