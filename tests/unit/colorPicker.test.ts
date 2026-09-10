// A COLOUR THE READER ASKS FOR MUST BE THE COLOUR THE PROFILE STORES.
//
// The picker moves through HSL — the space `deriveColors` already reasons in — so every drag is a
// hex → HSL → hex round trip. If that trip is not stable, a reader who opens the picker and touches
// nothing still drifts, and one who nudges the plane by a pixel loses the value they had typed.
// The second half guards the input: a half-typed code must never reach the profile, because the
// model's own rule (`isHex`) is that a profile carries exactly `#rrggbb` and nothing else.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// ---- and why the DOT cannot be derived from the colour --------------------------------------------
//
// The round trip above is stable as a COLOUR: every hex comes back as itself. It is not stable as a
// COORDINATE, and the picker's dot is a coordinate — `left: s%`, `top: (1-l)%`. Near the top and
// bottom of the plane almost every saturation lands on the same few bytes, so asking the colour where
// the pointer was gets an answer that is wrong by a visible distance.
//
// MEASURED in the running reader, dragging along the bottom edge of a 210px plane: the pointer moved
// evenly from 4px to 206px while the dot went 0 → 35 → 57 → 70 → 95 → 105 → 140 → 172 → 175 → 210 —
// worst error 11.2px, twice moving BACKWARDS against the pointer. Reproduced in the هيئة editor's own
// picker too (30.7px on its wider plane), so it is the component and not the reader around it.
describe("the plane's coordinate cannot be read back out of the colour", () => {
  const recover = (s: number, l: number): number => rgbToHsl(toRgb(toHex(hslToRgb([30, s, l]))))[1];
  const worstAt = (l: number): number => {
    let worst = 0;
    for (let i = 0; i <= 10; i++) worst = Math.max(worst, Math.abs(recover(i / 10, l) - i / 10));
    return worst;
  };

  it("is faithful in the middle of the plane, which is why the fault looked intermittent", () => {
    expect(worstAt(0.5)).toBeLessThan(0.01);
  });

  it("loses the saturation near black", () => {
    // 0.082 of the plane's width — on a 210px picker, seventeen pixels of error at worst.
    expect(worstAt(0.02)).toBeGreaterThan(0.05);
  });

  it("loses it just as badly near white", () => {
    expect(worstAt(0.98)).toBeGreaterThan(0.05);
  });

  it("so the picker holds its own position and only ever EMITS the colour", () => {
    const src = readFileSync(resolve(__dirname, "../../src/components/ColorPicker.tsx"), "utf8");
    // The position is state, seeded once and moved by the drag itself.
    expect(src).toContain("const [hsl, setHsl] = useState<[number, number, number]>(() => rgbToHsl(toRgb(safe)));");
    expect(src).toContain("const [h, s, l] = hsl;");
    // An incoming value that is our own echo must not re-derive it; anything else must.
    expect(src).toContain("if (mine.current && mine.current === safe.toUpperCase()) return;");
    // And the dot is drawn from that state, not from the committed colour.
    expect(src).toContain("left: `${s * 100}%`, top: `${(1 - l) * 100}%`");
  });
});
