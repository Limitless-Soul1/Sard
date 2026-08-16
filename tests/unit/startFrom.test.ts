// What a new profile is allowed to CLAIM it started from.
//
// The defect this pins: "A paper of your own" offers no swatches, yet the create dialog's unshown
// `base` default (Ivory) was written to the profile anyway — so the rail, the card and the switcher
// all announced "Ivory" for a paper the reader was never offered, and the claim was persisted.
//
// Measured before the fix, driving the real dialog: choosing "A paper of your own" produced a row
// with derived_from "ivory", theme.base "ivory" and Ivory's #F5EEDD, and the rail read "Ivory".
import { describe, expect, it } from "vitest";

import { chosenPreset, type StartFrom } from "../../src/features/profiles/startFrom";
import { THEME_ORDER } from "../../src/theme/themes";

describe("chosenPreset", () => {
  it("claims the picked paper when the reader picked one of the sixteen", () => {
    expect(chosenPreset("theme", "sage")).toBe("sage");
    expect(chosenPreset("theme", "ivory")).toBe("ivory");
  });

  it("claims NOTHING for a paper of your own, whatever canvas it opens on", () => {
    // The canvas is still Ivory — the editor has to open on something — but a canvas is not a claim.
    expect(chosenPreset("custom", "ivory")).toBeNull();
    expect(chosenPreset("custom", "moonlit")).toBeNull();
  });

  it("claims nothing for how Sard looks now — the live paper may be another profile", () => {
    expect(chosenPreset("current", "ivory")).toBeNull();
  });

  it("never lets the unshown default leak through any option but the one that shows it", () => {
    // The exact shape of the bug: with `base` left at its useState default, only "theme" may
    // return it. If this ever fails, a reader is again being told they chose a paper they never saw.
    const starts: StartFrom[] = ["current", "custom"];
    for (const s of starts) expect(chosenPreset(s, "ivory")).toBeNull();
  });

  it("passes every one of the sixteen through untouched when it IS the chosen one", () => {
    for (const id of THEME_ORDER) expect(chosenPreset("theme", id)).toBe(id);
    expect(THEME_ORDER).toHaveLength(16);
  });
});
