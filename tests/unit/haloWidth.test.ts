// HOW THICK THE HALO IS — the knob a halo never had, and the one the report actually asked for.
//
// THE DEFECT THIS PINS. A halo had two controls and neither of them was thickness:
//
//   STRENGTH is opacity. Turn it up and the same thin ring of light merely gets denser.
//   SOFTNESS is the blur radius. Turn it up and the light reaches further but gets FAINTER as it
//     goes, because a blur spreads a fixed amount of ink over a larger area.
//
// Neither can give the halo mass close to the glyph, which is what a reader means by "thicker". The
// reason is in the primitive: `text-shadow` has no spread. `box-shadow` does — which is why the plate
// could be given air and the halo could not.
//
// What produces mass for a text shadow is REPETITION: copies of the glyph offset around a circle of
// radius w, whose displaced silhouettes overlap into a continuous band of that width. That is what
// `haloWidth` measures, and it is a different thing from `strokeWidth`, which draws a line ON the
// letterform. Both exist; they are not the same control and must not be confused for one.
//
// AND IT MAY NOT DISTURB THE TYPE. `text-shadow` takes no part in layout at any radius, so no width
// can move a line break or change the fitted size — the rule every treatment here is held to.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HALO_WIDTH,
  HALO_WIDTH_MAX_EM,
  backingStyle,
  type BackingInput,
} from "../../src/features/photo/legibility";

const BASE: BackingInput = {
  mode: "halo",
  strength: 0.6,
  softness: 0.5,
  textColor: "#241a10",
  paper: "#f6efe2",
};

/** The shadows a treatment resolves to, split apart so each can be looked at. */
const shadows = (input: Partial<BackingInput>): string[] =>
  (backingStyle({ ...BASE, ...input }).textShadow ?? "")
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The offset of one shadow, in em — how far from the glyph it is drawn. */
const offsetOf = (s: string): number => {
  const [x, y] = s.split(/\s+/).map((n) => parseFloat(n));
  return Math.hypot(x, y);
};

describe("a halo with no thickness is the halo Sard has always drawn", () => {
  it("renders exactly what it rendered before the control existed", () => {
    // The compatibility requirement: every card saved before this carries no `haloWidth`, and none
    // of them may change appearance.
    expect(backingStyle({ ...BASE }).textShadow).toBe(backingStyle({ ...BASE, haloWidth: 0 }).textShadow);
  });

  it("which is two rings of light, and a third once softness asks for reach", () => {
    expect(shadows({ haloWidth: 0 })).toHaveLength(2);
    expect(shadows({ haloWidth: 0, softness: 0.9 })).toHaveLength(3);
  });

  it("and every one of them is centred on the glyph — light, with no body", () => {
    for (const s of shadows({ haloWidth: 0 })) expect(offsetOf(s)).toBe(0);
  });
});

describe("thickness is mass, and it is measurable", () => {
  it("puts a body around the glyph that was not there before", () => {
    const before = shadows({ haloWidth: 0 }).length;
    expect(shadows({ haloWidth: 0.1 }).length).toBeGreaterThan(before);
  });

  it("the body stands OFF the glyph, at the width the reader asked for", () => {
    // The property that makes it thickness rather than glow: the copies are displaced by w.
    for (const w of [0.04, 0.12, 0.24]) {
      const offsets = shadows({ haloWidth: w }).map(offsetOf).filter((d) => d > 0);
      expect(offsets.length, `no body at ${w}`).toBeGreaterThan(4);
      for (const d of offsets) expect(d).toBeCloseTo(w, 3);
    }
  });

  it("and it gets THICKER across the range, which is the whole point", () => {
    const reach = (w: number) => Math.max(...shadows({ haloWidth: w }).map(offsetOf));
    expect(reach(0.02)).toBeLessThan(reach(0.1));
    expect(reach(0.1)).toBeLessThan(reach(HALO_WIDTH_MAX_EM));
    expect(reach(HALO_WIDTH_MAX_EM)).toBeCloseTo(HALO_WIDTH_MAX_EM, 3);
  });

  it("the ring closes up as it widens, so a thick halo is a band and not a row of points", () => {
    // The gaps between neighbouring copies grow with the radius, so the count has to grow with it.
    const copies = (w: number) => shadows({ haloWidth: w }).filter((s) => offsetOf(s) > 0).length;
    expect(copies(0.24)).toBeGreaterThan(copies(0.04));
  });

  it("reaches its maximum — the control is not a range that stops short of its own end", () => {
    // THE REPORTED SYMPTOM, in its general form: a control whose two halves disagree about the unit
    // cannot reach the value the track claims to offer.
    expect(shadows({ haloWidth: HALO_WIDTH_MAX_EM }).some((s) => offsetOf(s) > 0.29)).toBe(true);
  });

  it("and cannot be pushed past it, where the lines of a setting would close up", () => {
    const far = Math.max(...shadows({ haloWidth: 5 }).map(offsetOf));
    expect(far).toBeCloseTo(HALO_WIDTH_MAX_EM, 3);
  });

  it("the default it arrives at is visible, and short of a statement", () => {
    expect(DEFAULT_HALO_WIDTH).toBeGreaterThan(0);
    expect(DEFAULT_HALO_WIDTH).toBeLessThan(HALO_WIDTH_MAX_EM / 2);
  });
});

describe("thickness and stroke are different things", () => {
  it("a halo's thickness draws no outline on the letterform", () => {
    const s = backingStyle({ ...BASE, haloWidth: 0.2 }) as Record<string, unknown>;
    expect(s.WebkitTextStroke).toBeUndefined();
    expect(s.paintOrder).toBeUndefined();
  });

  it("and it belongs to the halo alone — no other treatment has a body to thicken", () => {
    for (const mode of ["veil", "plate"] as const) {
      const withW = backingStyle({ ...BASE, mode, haloWidth: 0.24 });
      const without = backingStyle({ ...BASE, mode, haloWidth: 0 });
      expect(withW, mode + " grew a halo body").toEqual(without);
    }
  });

  it("nothing at all at strength zero, however thick it is asked to be", () => {
    expect(backingStyle({ ...BASE, strength: 0, haloWidth: 0.3 })).toEqual({});
  });
});

describe("A HALO IS PAINTED, NEVER LAID OUT", () => {
  it("touches nothing that decides where a line breaks, at any thickness", () => {
    // The rule the whole toolkit is held to. `text-shadow` is the only property a halo returns, and
    // it takes no part in layout — so the fitted size and the wrapping are the same at every width.
    for (let w = 0; w <= HALO_WIDTH_MAX_EM; w += 0.02) {
      expect(Object.keys(backingStyle({ ...BASE, haloWidth: w })).sort()).toEqual(["textShadow"]);
    }
  });

  it("and says the same thing for the same input, twice", () => {
    expect(backingStyle({ ...BASE, haloWidth: 0.13 })).toEqual(backingStyle({ ...BASE, haloWidth: 0.13 }));
  });
});

describe("the control and the value speak the same unit", () => {
  // THE ROOT CAUSE OF "IT STOPS AT 0.8". The stroke's slider read its value as a percentage of the
  // type size (w × 100) and wrote it back as a per-mille (v ÷ 1000), so every drag stored a TENTH of
  // what the handle showed: the track ran to 24 and the number could never pass 2.4 — and at the soft
  // end of the track it appeared to stop at 0.8. That is not a range that needs widening.
  it("both readability widths convert one way and back again", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/features/photo/Inspector.tsx"), "utf8");
    for (const [read, write] of [
      ["selected.style.haloWidth ?? 0) * 1000) / 10", "haloWidth: v / 100"],
      ["selected.style.strokeWidth ?? 0) * 1000) / 10", "strokeWidth: v / 100"],
    ]) {
      expect(src, "the control no longer displays " + write).toContain(read);
      expect(src, write + " does not answer in the unit it is displayed in").toContain(write);
    }
    // …and neither writes a per-mille any more.
    expect(src).not.toContain("strokeWidth: v / 1000");
    expect(src).not.toContain("haloWidth: v / 1000");
  });

  it("and each track ends where its property does", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/features/photo/Inspector.tsx"), "utf8");
    expect(src).toContain("max={Math.round(HALO_WIDTH_MAX_EM * 100)}");
    expect(src).toContain("max={Math.round(STROKE_MAX_EM * 100)}");
  });
});
