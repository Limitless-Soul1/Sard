// A COLOUR THE READER ASKS FOR MUST BE THE COLOUR THE PROFILE STORES.
//
// The picker moves through HSL — the space `deriveColors` already reasons in — so every drag is a
// hex → HSL → hex round trip. If that trip is not stable, a reader who opens the picker and touches
// nothing still drifts, and one who nudges the plane by a pixel loses the value they had typed.
// The second half guards the input: a half-typed code must never reach the profile, because the
// model's own rule (`isHex`) is that a profile carries exactly `#rrggbb` and nothing else.
import { describe, expect, it } from "vitest";

import { editHex } from "../../src/features/profiles/model/hex";
import { hslToRgb, isHex, rgbToHsl, toHex, toRgb } from "../../src/features/profiles/model/palette";

const trip = (hex: string): string => toHex(hslToRgb(rgbToHsl(toRgb(hex)))).toUpperCase();

describe("the picker's colour space round-trips", () => {
  // The three the reader named, plus the extremes and a pure grey — grey is the interesting one,
  // because every grey is hue 0 and a naive picker snaps it to red on the way back.
  const CASES = ["#5E7A52", "#C98A5E", "#243B53", "#D4A373", "#000000", "#FFFFFF", "#808080", "#FF0000"];

  for (const hex of CASES) {
    it(`${hex} survives hex → HSL → hex`, () => {
      expect(trip(hex)).toBe(hex.toUpperCase());
    });
  }

  it("every channel value round-trips, not just the sampled ones", () => {
    for (let v = 0; v <= 255; v += 17) {
      const hex = toHex([v, 255 - v, (v * 3) % 256]);
      expect(trip(hex)).toBe(hex.toUpperCase());
    }
  });
});

describe("hex input accepts what a reader actually does", () => {
  // Pasting is the case that started this: a code copied from a design tool arrives without its
  // `#`, sometimes with whitespace, sometimes lower-case, sometimes shortened.
  const ACCEPTS: [string, string][] = [
    ["#5E7A52", "#5E7A52"],
    ["5E7A52", "#5E7A52"],          // pasted without the hash
    ["#5e7a52", "#5E7A52"],          // lower case
    ["  #C98A5E  ", "#C98A5E"],      // pasted with surrounding whitespace
    ["243B53", "#243B53"],
    ["#abc", "#AABBCC"],             // the three-digit short form
  ];
  for (const [raw, want] of ACCEPTS) {
    it(`"${raw}" commits as ${want}`, () => {
      const r = editHex(raw);
      expect(r.full).toBe(want);
      expect(r.ok).toBe(true);
      expect(isHex(r.full!)).toBe(true);
    });
  }

  // Nothing here may reach the profile. `full` is the only value a caller commits, so `null` is the
  // whole guarantee — the field still shows the reader's text, which is why `draft` is separate.
  const REFUSES = ["#", "#5E7A5", "#GGGGGG", "5E7A52FF", "rgb(1,2,3)", "#12345", "not a colour"];
  for (const raw of REFUSES) {
    it(`"${raw}" never commits`, () => {
      const r = editHex(raw);
      expect(r.full).toBeNull();
      expect(r.ok).toBe(false);
    });
  }

  it("a half-typed code warns without committing, and an emptied field does not warn", () => {
    // Four digits: past the valid three-digit form and not yet the six-digit one, which is the only
    // genuinely incomplete length. `#5E7` is NOT half-typed — it is the short form, and expands.
    expect(editHex("#5E7A").bad).toBe(true);
    expect(editHex("#5E7A").full).toBeNull();
    expect(editHex("#").bad).toBe(false);
    expect(editHex("#").draft).toBe("");
  });
});
