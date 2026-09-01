// PROFILES (stage 6) — the package format's trust boundary.
//
// One test per refusal, because this validator is the only thing between a file from a stranger and
// the reader's settings, and a rule nobody exercises is a rule nobody has. The acceptance tests
// matter just as much: a validator that refuses everything is safe and useless.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { PROFILE_READING_FIELDS } from "../../src/features/profiles/model/profile";
import { ARABIC_DEFAULTS } from "../../src/reader-engine/injectedCss";

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

// THE FIREWALL AT THE BORDER, and what it defends has MOVED with the model.
//
// It used to refuse the reader's whole layout, because a هيئة was a palette and the measure was the
// reader's alone. A هيئة is the complete reading preset now: the measure, the page's width and the
// read-aloud marks are its own, so they cross with it. What may NOT cross is everything a هيئة does
// not own — refused BY NAME rather than stripped, so a sender is never told they sent something they
// did not — and the list is derived from `PROFILE_READING_FIELDS` rather than written out, so a new
// `ReadingStyle` field is refused until someone declares it profile-owned.
describe("the firewall", () => {
  it.each([
    ["flowMode", { flowMode: "paged" }],
    ["pageFitWindow", { pageFitWindow: true }],
    ["textColor", { textColor: "#ff0000" }],
    ["pageColor", { pageColor: "#ff0000" }],
    ["immHidePill", { immHidePill: true }],
    ["refRuleWeight", { refRuleWeight: 2 }],
  ])("refuses a package carrying %s", (field, extra) => {
    const r = inspectPackage(wrap({ theme: { base: "ivory" }, ...extra }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe("pkg.err.carriesReadingSettings");
      if (r.refusal.code === "pkg.err.carriesReadingSettings") expect(r.refusal.field).toBe(field);
    }
  });

  it.each([
    ["lineHeight", { type: { reading: { lineHeight: 2.4 } } }],
    ["pageWidth", { type: { reading: { pageWidth: 0.8 } } }],
    ["zoom", { type: { reading: { zoom: 1.4 } } }],
    ["marginPx", { type: { reading: { marginPx: 120 } } }],
    ["diacritics", { type: { reading: { diacritics: "hide" } } }],
    ["the read-aloud marks", { voice: { ttsSpotlightColor: "#6E7F5B" } }],
  ])("but ADMITS %s, which a هيئة owns", (_name, extra) => {
    const r = inspectPackage(wrap({ theme: { base: "ivory" }, ...extra }));
    expect(r.ok, JSON.stringify((r as { refusal?: unknown }).refusal)).toBe(true);
  });

  it("and `book_style` stays refused — the removed per-book scope may not return by post", () => {
    const r = inspectPackage(wrap({ theme: { base: "ivory" }, book_style: { zoom: 2 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("pkg.err.carriesReadingSettings");
  });

  it("finds a forbidden field NESTED, not only at the top", () => {
    // `zoom` is a هيئة's own now, so the depth test uses one that is not.
    const r = inspectPackage(wrap({ theme: { base: "ivory" }, type: { deep: { flowMode: "paged" } } }));
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
  it("lets a mark's framing through, and would not have if it were called flowMode", () => {
    // The original pair used `zoom`, which a هيئة owns today — so the collision it guards against is
    // shown with a name that is still refused. The argument is unchanged: the scan matches key NAMES
    // at any depth, so an unrelated field borrowing a reading field's name would export a package
    // Sard itself refuses.
    const framing = { theme: { base: "ivory" }, icon: { focalX: 20, focalY: 80, scale: 2 } };
    expect(inspectPackage(wrap(framing)).ok).toBe(true);

    const named = { theme: { base: "ivory" }, icon: { focalX: 20, focalY: 80, flowMode: "paged" } };
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

describe("the two firewalls cannot drift apart", () => {
  // THE DEFECT THIS PINS. Rust re-checks the manifest on commit rather than trusting the frontend —
  // which is right, and is why the list has to be written twice. It had drifted: Rust still refused
  // `lineHeight`, `zoom`, `pageWidth` and `align` long after a هيئة owned them, so a هيئة carrying its
  // own measure was refused at the door by the very process that had just exported it. The comment
  // over it said "kept in step with model/package.ts", which is a promise no one can keep by hand.
  //
  // So the promise is a test. It reads the Rust source, parses the array, and compares it to what
  // TypeScript DERIVES from `PROFILE_READING_FIELDS`.
  const RS = readFileSync(
    join(import.meta.dirname, "..", "..", "src-tauri/src/profiles/package.rs"), "utf8");

  const rustList = (): string[] => {
    const m = /const FORBIDDEN: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(RS);
    expect(m, "the FORBIDDEN array should be findable in package.rs").toBeTruthy();
    return [...(m![1].matchAll(/"([^"]+)"/g))].map((x) => x[1]);
  };

  /** What TypeScript refuses: every `ReadingStyle` field a هيئة does not own, plus the two rows. */
  const tsList = (): string[] => [
    ...Object.keys(ARABIC_DEFAULTS).filter(
      (k) => !(PROFILE_READING_FIELDS as readonly string[]).includes(k),
    ),
    "reading_style",
    "book_style",
  ];

  it("Rust refuses exactly what TypeScript refuses", () => {
    expect([...rustList()].sort()).toEqual([...tsList()].sort());
  });

  it("and the declared length matches the array, so a stale count cannot hide an entry", () => {
    const declared = /const FORBIDDEN: \[&str; (\d+)\]/.exec(RS);
    expect(Number(declared![1])).toBe(rustList().length);
  });

  it("neither list refuses anything a هيئة owns", () => {
    for (const k of PROFILE_READING_FIELDS as readonly string[]) {
      expect(rustList(), k + " is profile-owned and must cross").not.toContain(k);
      expect(tsList(), k + " is profile-owned and must cross").not.toContain(k);
    }
  });

  it("and both still refuse the removed per-book scope", () => {
    expect(rustList()).toContain("book_style");
    expect(tsList()).toContain("book_style");
  });
});
