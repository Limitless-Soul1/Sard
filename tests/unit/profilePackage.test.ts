// PROFILES (stage 6) — the package format's trust boundary.
//
// One test per refusal, because this validator is the only thing between a file from a stranger and
// the reader's settings, and a rule nobody exercises is a rule nobody has. The acceptance tests
// matter just as much: a validator that refuses everything is safe and useless.

import { describe, expect, it } from "vitest";

import {
  MAX_MANIFEST_BYTES,
  PACKAGE_VERSION,
  inspectPackage,
  manifestText,
  serialiseProfile,
  summarise,
} from "../../src/features/profiles/model/package";
import { PROFILE_DATA_VERSION, parseProfileData, serialiseProfileData, type Profile } from "../../src/features/profiles/model/profile";

const profile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: "u:abc123",
    name: "مَساء",
    description: null,
    author: "A reader",
    iconKind: "seal",
    iconRef: null,
    derivedFrom: "u:parent",
    createdAt: 0,
    updatedAt: 0,
    data: parseProfileData(
      JSON.stringify({ theme: { base: "moonlit" }, type: { arabic: "amiri", latin: "literata" } }),
    ),
    ...over,
  }) as Profile;

const wrap = (data: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ package: PACKAGE_VERSION, app: "1.2.3", name: "x", data, ...over });

describe("serialising a profile", () => {
  it("carries what the recipient needs and nothing local", () => {
    const m = serialiseProfile(profile(), "1.2.3");
    expect(m.package).toBe(PACKAGE_VERSION);
    expect(m.name).toBe("مَساء");
    expect(m.author).toBe("A reader");
    // provenance is local — a stranger's row id means nothing on another machine
    expect(m).not.toHaveProperty("derivedFrom");
    expect(m).not.toHaveProperty("id");
  });

  it("round-trips through the manifest text", () => {
    const p = profile();
    const got = inspectPackage(manifestText(serialiseProfile(p, "1.2.3")));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.theme.library.base).toBe("moonlit");
    expect(got.data.type.arabic).toBe("amiri");
    expect(got.manifest.name).toBe("مَساء");
  });
});

describe("every refusal", () => {
  it("refuses text that is not JSON", () => {
    const r = inspectPackage("not json {");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("pkg.err.unreadable");
  });

  it("refuses JSON that is not an object", () => {
    for (const bad of ["[]", '"a string"', "42", "null"]) {
      const r = inspectPackage(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe("pkg.err.unreadable");
    }
  });

  it("refuses a file that never claimed to be a Sard profile", () => {
    const r = inspectPackage(JSON.stringify({ hello: "world", data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("pkg.err.notSard");
  });

  it("refuses a package from a NEWER Sard rather than silently dropping what it cannot see", () => {
    const r = inspectPackage(wrap({}, { package: PACKAGE_VERSION + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe("pkg.err.newer");
      if (r.refusal.code === "pkg.err.newer") expect(r.refusal.found).toBe(PACKAGE_VERSION + 1);
    }
  });

  it("accepts an OLDER package — absence is how every field spells its default", () => {
    const r = inspectPackage(wrap({ theme: { base: "ivory" } }, { package: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.theme.library.base).toBe("ivory");
  });

  it("refuses a package with no data at all", () => {
    for (const bad of [undefined, null, "x", 3, []]) {
      const r = inspectPackage(JSON.stringify({ package: PACKAGE_VERSION, data: bad }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe("pkg.err.noData");
    }
  });

  it("refuses one larger than any real profile", () => {
    const r = inspectPackage("x".repeat(MAX_MANIFEST_BYTES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("pkg.err.tooLarge");
  });
});

// THE FIREWALL AT THE BORDER. A profile never carries the reader's layout. A package that claims to
// is refused BY NAME rather than stripped, so a sender is never told they sent something they did not.
describe("the firewall", () => {
  it.each([
    ["lineHeight", { lineHeight: 2.4 }],
    ["pageWidth", { pageWidth: 700 }],
    ["margins", { margins: 40 }],
    ["diacritics", { diacritics: "hide" }],
    ["zoom", { zoom: 1.4 }],
    ["textAlign", { textAlign: "justify" }],
    ["paragraphSpacing", { paragraphSpacing: 20 }],
  ])("refuses a package carrying %s", (field, extra) => {
    const r = inspectPackage(wrap({ theme: { base: "ivory" }, ...extra }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe("pkg.err.carriesReadingSettings");
      if (r.refusal.code === "pkg.err.carriesReadingSettings") expect(r.refusal.field).toBe(field);
    }
  });

  it("finds a forbidden field NESTED, not only at the top", () => {
    const r = inspectPackage(wrap({ theme: { base: "ivory" }, type: { deep: { zoom: 2 } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("pkg.err.carriesReadingSettings");
  });

  it("does not mistake a legitimate profile field for a layout one", () => {
    const r = inspectPackage(
      wrap({ theme: { base: "ivory" }, marks: { bookmarkSize: 68, bookmarkPos: 0.8 }, texture: "glass" }),
    );
    expect(r.ok).toBe(true);
  });

  /**
   * WHY A MARK'S MAGNIFICATION IS CALLED `scale` AND NEVER `zoom`.
   *
   * The firewall matches key NAMES at any depth. A mark's framing lives in the blob beside the seal,
   * so had the obvious name been used, every profile carrying a framed picture would have exported a
   * package Sard itself refuses — naming a reading setting its sender never touched. The pair below
   * is the whole argument, and it fails the moment anyone renames the field.
   */
  it("lets a mark's framing through, and would not have if it were called zoom", () => {
    const framing = { theme: { base: "ivory" }, icon: { focalX: 20, focalY: 80, scale: 2 } };
    expect(inspectPackage(wrap(framing)).ok).toBe(true);

    const named = { theme: { base: "ivory" }, icon: { focalX: 20, focalY: 80, zoom: 2 } };
    const r = inspectPackage(wrap(named));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("pkg.err.carriesReadingSettings");
  });

  it("carries a framing across the border intact", () => {
    const p = profile({
      iconKind: "image",
      iconRef: "a1b2c3d4",
      data: parseProfileData(JSON.stringify({ icon: { focalX: 12, focalY: 88, scale: 1.6 } })),
    });
    const got = inspectPackage(manifestText(serialiseProfile(p, "1.2.3")));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.icon).toEqual({ focalX: 12, focalY: 88, scale: 1.6 });
  });
});

describe("what the reader is shown before deciding", () => {
  it("summarises the package without importing it", () => {
    const r = inspectPackage(manifestText(serialiseProfile(profile(), "1.2.3")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = summarise(r);
    expect(s).toMatchObject({
      name: "مَساء",
      author: "A reader",
      themeBase: "moonlit",
      arabic: "amiri",
      latin: "literata",
      knownDataVersion: true,
    });
  });

  it("a hostile blob still yields a usable, plainly-described profile", () => {
    const r = inspectPackage(wrap({ theme: { base: "no-such-theme", colors: "nonsense" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // total parsing: an unknown base becomes "built from scratch", not a dangling id
    expect(r.data.theme.library.base).toBeNull();
    expect(r.data.theme.library.colors.paperBg).toMatch(/^#/);
    expect(summarise(r).texture).toBe("opaque");
  });
});

describe("the package carries both palettes", () => {
  it("a v2 profile round-trips its two palettes through the manifest", () => {
    const p = profile();
    p.data.theme.reading.colors.paperBg = "#123456";
    p.data.theme.library.colors.paperBg = "#ABCDEF";
    const back = parseProfileData(serialiseProfileData(p.data));
    expect(back.theme.library.colors.paperBg).toBe("#ABCDEF");
    expect(back.theme.reading.colors.paperBg).toBe("#123456");
    expect(back.v).toBe(PROFILE_DATA_VERSION);
  });

  it("a v1 package still imports, and both scopes take its one palette", () => {
    // THE COMPATIBILITY PROMISE. A package exported by any earlier Sard has a single `theme`; it
    // must import and look exactly as its author meant, on both surfaces.
    const v1 = JSON.stringify({ v: 1, theme: { base: "moonlit", colors: { text: "#101010" } } });
    const back = parseProfileData(v1);
    expect(back.theme.library.base).toBe("moonlit");
    expect(back.theme.reading.base).toBe("moonlit");
    expect(back.theme.reading.colors.text).toBe("#101010");
    expect(back.theme.library.colors).toEqual(back.theme.reading.colors);
  });

  it("the data version is reported so an import can say what it is", () => {
    expect(PROFILE_DATA_VERSION).toBe(2);
  });
});
