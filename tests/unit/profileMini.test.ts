// What the miniature is told about a profile.
//
// These exist because the four background props were stubbed out here for a whole stage — `bgImg`
// was hard-coded to "none" and `trans` to 1, so the library specimen showed no image and no texture
// however the profile was configured, and nothing failed. The visual result still needs the running
// binary; what CAN be pinned without it is that the mapping is performed at all, and that it uses
// the production numbers rather than a second interpretation of them.
import { describe, expect, it } from "vitest";

import { miniOf } from "../../src/features/profiles/mini";
import { parseProfileData, TEXTURE_ALPHA } from "../../src/features/profiles/model/profile";
import { scrimAlpha } from "../../src/lib/background";
import type { Profile } from "../../src/features/profiles/model/profile";

const profile = (data: unknown): Profile => ({
  id: "u:test",
  name: "مَساء",
  description: null,
  author: null,
  iconKind: "seal",
  iconRef: null,
  derivedFrom: null,
  createdAt: 0,
  updatedAt: 0,
  data: parseProfileData(JSON.stringify(data)),
});

describe("miniOf — the library miniature's props", () => {
  it("shows no image when the profile carries none, and asks for no blur", () => {
    const m = miniOf(profile({}), null);
    expect(m.bgImg).toBe("none");
    expect(m.bgOn).toBe(0);
    expect(m.scrim).toBe(0);
    expect(m.blur).toBe("0px");
  });

  it("carries the library image through when one is resolved", () => {
    const m = miniOf(profile({}), "http://asset.localhost/x.png");
    expect(m.bgImg).toBe('url("http://asset.localhost/x.png")');
    expect(m.bgOn).toBe(1);
  });

  it("uses PRODUCTION's presence→scrim function, not its own", () => {
    const p = profile({ bg: { library: { ref: "a".repeat(32), params: { presence: 52, blur: 18 } } } });
    const m = miniOf(p, "http://asset.localhost/x.png");
    expect(m.scrim).toBeCloseTo(scrimAlpha(52, "library"), 10);
    expect(m.blur).toBe("18px");
  });

  it("a higher presence lets more image through — a lower scrim", () => {
    const url = "http://asset.localhost/x.png";
    const low = miniOf(profile({ bg: { library: { params: { presence: 10 } } } }), url);
    const high = miniOf(profile({ bg: { library: { params: { presence: 90 } } } }), url);
    expect(high.scrim).toBeLessThan(low.scrim);
  });

  it("carries the interface texture rather than pinning it opaque", () => {
    expect(miniOf(profile({ texture: "opaque" }), null).trans).toBe(TEXTURE_ALPHA.opaque);
    expect(miniOf(profile({ texture: "light" }), null).trans).toBe(TEXTURE_ALPHA.light);
    expect(miniOf(profile({ texture: "glass" }), null).trans).toBe(TEXTURE_ALPHA.glass);
    // The bug this replaces: every profile reported a fully opaque interface.
    expect(miniOf(profile({ texture: "glass" }), null).trans).not.toBe(1);
  });

  it("still carries the profile's own colours and mark", () => {
    const m = miniOf(profile({ theme: { base: "moonlit" } }), null);
    expect(m.paper).toMatch(/^#/);
    expect(m.ink).toMatch(/^#/);
  });
});
