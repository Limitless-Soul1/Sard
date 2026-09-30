// A هيئة'S PALETTE IS ITS OWN OBJECT — it is not a window onto the shipped theme.
//
// `snapshotPalette` used to store `colors: theme.colors`, and `theme` is usually an entry out of
// `THEMES`. So the shipped palette was handed out by reference: every هيئة this built shared one
// object with every other AND with the theme itself, and a single in-place write through any of them
//
//     data.theme.reading.colors.paperBg = "#2A1E14";
//
// edited `THEMES.ivory` for the rest of the process. Every هيئة built afterwards was born wearing it.
//
// It was latent, not live — every production path clones or serialises before it mutates — and it was
// found by a test that wrote in place. That is the whole argument for closing it: the defect was one
// careless line away, and the line that would have caused it looks entirely ordinary.
import { describe, expect, it } from "vitest";

import { captureCurrent, defaultProfileData } from "../../src/features/profiles/store";
import { DEFAULT_LIGHT, THEMES } from "../../src/theme/themes";

describe("the shipped themes cannot be written through a هيئة", () => {
  it("two fresh هيئات do not share one palette object", () => {
    const a = defaultProfileData();
    const b = defaultProfileData();
    expect(a.theme.reading.colors).not.toBe(b.theme.reading.colors);
    expect(a.theme.library.colors).not.toBe(b.theme.library.colors);
    // The two surfaces of ONE هيئة are separate too: they begin identical and must be free to part.
    expect(a.theme.reading.colors).not.toBe(a.theme.library.colors);
  });

  it("nor does one share the shipped theme it was built from", () => {
    const d = defaultProfileData();
    expect(d.theme.reading.colors).not.toBe(THEMES[DEFAULT_LIGHT].colors);
    expect(d.theme.reading.colors.highlight).not.toBe(THEMES[DEFAULT_LIGHT].colors.highlight);
  });

  it("writing a colour in place leaves the shipped theme untouched", () => {
    const shipped = THEMES[DEFAULT_LIGHT].colors.paperBg;
    const d = defaultProfileData();
    d.theme.reading.colors.paperBg = "#2A1E14";
    expect(THEMES[DEFAULT_LIGHT].colors.paperBg).toBe(shipped);
    expect(defaultProfileData().theme.reading.colors.paperBg).toBe(shipped);
  });

  it("…including a highlight pen, which is one object deeper", () => {
    const shipped = THEMES[DEFAULT_LIGHT].colors.highlight.amber;
    const d = defaultProfileData();
    d.theme.reading.colors.highlight.amber = "#010203";
    expect(THEMES[DEFAULT_LIGHT].colors.highlight.amber).toBe(shipped);
    expect(defaultProfileData().theme.reading.colors.highlight.amber).toBe(shipped);
  });

  it("and editing one هيئة cannot reach another built before it", () => {
    const first = defaultProfileData();
    const second = defaultProfileData();
    second.theme.library.colors.accent = "#FF00FF";
    second.theme.reading.colors.highlight.sky = "#FF00FF";
    expect(first.theme.library.colors.accent).not.toBe("#FF00FF");
    expect(first.theme.reading.colors.highlight.sky).not.toBe("#FF00FF");
  });

  it("the values themselves are unchanged — this is a copy, not a correction", () => {
    const d = defaultProfileData();
    expect(d.theme.reading.colors).toEqual(THEMES[DEFAULT_LIGHT].colors);
    expect(d.theme.library.colors).toEqual(THEMES[DEFAULT_LIGHT].colors);
  });

  it("`captureCurrent` is covered by the same fix, since it uses the same function", async () => {
    // It snapshots the RESOLVED live themes rather than a shipped entry, but the aliasing was in
    // `snapshotPalette`, so both callers were exposed and both are closed.
    const c = await captureCurrent();
    const shipped = THEMES[DEFAULT_LIGHT].colors.paperBg;
    c.theme.reading.colors.paperBg = "#0A0B0C";
    c.theme.library.colors.highlight.rose = "#0A0B0C";
    expect(THEMES[DEFAULT_LIGHT].colors.paperBg).toBe(shipped);
    expect(defaultProfileData().theme.reading.colors.paperBg).toBe(shipped);
  });
});
