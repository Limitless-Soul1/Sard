// A NEW هيئة IS BORN HOLDING THE MEASURE THE READER IS READING AT — and nothing else of the last one.
//
// A هيئة has always begun with an EMPTY typography, which is what lets it defer to the reader:
// `readingPatch` clears every field it has no opinion about and `defaultsForDir` answers instead.
// Deferring is right for a هيئة nobody has touched and wrong at the moment of creation — a reader who
// has settled their size and measure does not want the next هيئة to forget it.
//
// These tests hold the two halves of that apart. The measure crosses. The LOOK does not, and neither
// does `lineHeight`, which is the one field of the five that would have carried a reading direction
// with it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  READING_MEASURE_SNAPSHOT, resolveAppearanceStyle, withReadingMeasure,
} from "../../src/features/reader/bookAppearance";
import { defaultProfileData } from "../../src/features/profiles/store";
import { ARABIC_DEFAULTS, LATIN_DEFAULTS, defaultsForDir, type ReadingStyle } from "../../src/reader-engine/injectedCss";
import { EMPTY_TYPOGRAPHY, TYPOGRAPHY_KEYS, parseProfileData, readingPatch, type Profile } from "../../src/features/profiles/model/profile";

/** A هيئة that has opinions about its measure, the way one the reader has tuned would. */
const settled = (): Profile => {
  const data = defaultProfileData();
  data.type.arabic = "notoNaskh";
  data.type.latin = "sourceSerif";
  data.type.reading = { ...data.type.reading, zoom: 1.4, paragraphSpacing: 1.2, pageWidth: 0.47, lineHeight: 2.1 };
  // REPLACED, NOT MUTATED IN PLACE. `snapshotPalette` stores `colors: theme.colors` — a reference to
  // the shipped `THEMES` entry — so writing through it would edit that shipped theme for the whole
  // process and every later `defaultProfileData()` with it. Latent rather than live (every
  // production path clones or serialises first), but a test must not be the thing that trips it.
  data.theme.reading.colors = { ...data.theme.reading.colors, paperBg: "#2A1E14" };
  data.texture = "glass";
  return { id: "u:worn", name: "Worn", iconKind: "seal", iconRef: null, data } as unknown as Profile;
};
const styleOf = (p: Profile, dir?: string): ReadingStyle =>
  resolveAppearanceStyle(p, dir, defaultsForDir(dir));

describe("what the snapshot carries", () => {
  it("names exactly the five categories, and lineHeight is not one of them", () => {
    expect([...READING_MEASURE_SNAPSHOT]).toEqual(["arabicFont", "latinFont", "zoom", "paragraphSpacing", "pageWidth"]);
    expect(READING_MEASURE_SNAPSHOT as readonly string[]).not.toContain("lineHeight");
  });

  it("every field in it is direction-insensitive, which is what makes it safe", () => {
    // THE TEST EACH ONE HAD TO PASS. A field whose baseline differs by script would carry the
    // direction of whichever book happened to be open into a هيئة both scripts read.
    for (const k of ["zoom", "paragraphSpacing", "pageWidth"] as const) {
      expect(ARABIC_DEFAULTS[k], k).toBe(LATIN_DEFAULTS[k]);
    }
    // …and the two faces name their own script, so neither can stand in for the other.
    expect(ARABIC_DEFAULTS.arabicFont).toBe(LATIN_DEFAULTS.arabicFont);
    expect(ARABIC_DEFAULTS.latinFont).toBe(LATIN_DEFAULTS.latinFont);
  });

  it("takes the RESOLVED values a worn هيئة means", () => {
    const d = withReadingMeasure(defaultProfileData(), styleOf(settled(), "rtl"));
    expect(d.type.arabic).toBe("notoNaskh");
    expect(d.type.latin).toBe("sourceSerif");
    expect(d.type.reading.zoom).toBe(1.4);
    expect(d.type.reading.paragraphSpacing).toBe(1.2);
    expect(d.type.reading.pageWidth).toBe(0.47);
  });

  it("and resolves through the fallback when the هيئة itself has no opinion", () => {
    // THE CASE THAT MADE "COPY THE ACTIVE هيئة'S TYPOGRAPHY" THE WRONG DESIGN: almost every هيئة
    // stores nulls, so copying the stored values would have copied nothing.
    const blank = { id: "u:b", name: null, iconKind: "seal", iconRef: null, data: defaultProfileData() } as unknown as Profile;
    expect(blank.data.type.reading).toEqual(EMPTY_TYPOGRAPHY);
    const d = withReadingMeasure(defaultProfileData(), styleOf(blank, "rtl"));
    expect(d.type.reading.zoom).toBe(ARABIC_DEFAULTS.zoom);
    expect(d.type.reading.pageWidth).toBe(ARABIC_DEFAULTS.pageWidth);
    expect(d.type.reading.paragraphSpacing).toBe(ARABIC_DEFAULTS.paragraphSpacing);
  });
});

describe("lineHeight stays the reader's", () => {
  it("is null however loudly the source states one", () => {
    const d = withReadingMeasure(defaultProfileData(), styleOf(settled(), "rtl"));
    expect(d.type.reading.lineHeight).toBeNull();
  });

  it("so a هيئة created while reading Arabic carries no leading into a Latin book", () => {
    // THE DEFECT THIS AVOIDS, spelled out. Arabic resolves 1.9 and Latin 1.6; a snapshot of the
    // number would have set 1.9 on a هيئة both scripts read.
    expect(ARABIC_DEFAULTS.lineHeight).not.toBe(LATIN_DEFAULTS.lineHeight);
    const fromArabic = styleOf(settled(), "rtl");
    expect(fromArabic.lineHeight).toBe(2.1);                 // what the reader was reading at
    const d = withReadingMeasure(defaultProfileData(), fromArabic);
    // The هيئة carries nothing, so `readingPatch` CLEARS it and the per-script baseline answers.
    const patch = readingPatch({ id: "u:n", name: null, iconKind: "seal", iconRef: null, data: d } as unknown as Profile);
    expect(patch.clear).toContain("lineHeight");
    expect(patch.set.lineHeight).toBeUndefined();
    expect(resolveAppearanceStyle({ id: "u:n", name: null, iconKind: "seal", iconRef: null, data: d } as unknown as Profile,
      "ltr", defaultsForDir("ltr")).lineHeight).toBe(LATIN_DEFAULTS.lineHeight);
  });

  it("and the four it DOES carry are asserted rather than cleared", () => {
    const d = withReadingMeasure(defaultProfileData(), styleOf(settled(), "rtl"));
    const patch = readingPatch({ id: "u:n", name: null, iconKind: "seal", iconRef: null, data: d } as unknown as Profile);
    for (const k of ["zoom", "paragraphSpacing", "pageWidth"] as const) {
      expect(patch.set[k], k).toBeDefined();
      expect(patch.clear, k).not.toContain(k);
    }
    // The six it does not carry still defer, exactly as before.
    for (const k of TYPOGRAPHY_KEYS) {
      if (["zoom", "paragraphSpacing", "pageWidth"].includes(k)) continue;
      expect(patch.clear, k).toContain(k);
    }
  });
});

describe("what the snapshot must NOT carry", () => {
  it("no colour, no picture, no texture, no identity — the look is Sard's own", () => {
    const fresh = defaultProfileData();
    const d = withReadingMeasure(fresh, styleOf(settled(), "rtl"));
    const worn = settled().data;
    expect(d.theme.reading.colors.paperBg).not.toBe(worn.theme.reading.colors.paperBg);
    expect(d.theme).toEqual(fresh.theme);
    expect(d.texture).toBe(fresh.texture);
    expect(d.bg).toEqual(fresh.bg);
    expect(d.marks).toEqual(fresh.marks);
    expect(d.seal).toEqual(fresh.seal);
    expect(d.icon).toEqual(fresh.icon);
    expect(d.voice).toEqual(fresh.voice);
    expect(d.refs).toEqual(fresh.refs);
    expect(d.type.ui).toBe(fresh.type.ui);
  });

  it("`defaultProfileData()` itself is untouched — it still begins from nothing", () => {
    // Every other caller depends on this: import, migration, and the tests that pin a fresh هيئة.
    const a = defaultProfileData();
    withReadingMeasure(a, styleOf(settled(), "rtl"));
    expect(a.type.reading).toEqual(EMPTY_TYPOGRAPHY);
    expect(a.type.arabic).toBe("amiri");
    expect(a.type.latin).toBe("literata");
    expect(defaultProfileData().type.reading).toEqual(EMPTY_TYPOGRAPHY);
  });
});

describe("a snapshot, not a link", () => {
  it("editing the new هيئة cannot reach the source", () => {
    const source = settled();
    const before = JSON.stringify(source.data);
    const d = withReadingMeasure(defaultProfileData(), styleOf(source, "rtl"));
    d.type.reading.zoom = 0.9;
    d.type.arabic = "cairo";
    d.theme.reading.colors.paperBg = "#FFFFFF";
    expect(JSON.stringify(source.data)).toBe(before);
  });

  it("and editing the source cannot reach the new one", () => {
    const source = settled();
    const d = withReadingMeasure(defaultProfileData(), styleOf(source, "rtl"));
    const after = JSON.stringify(d);
    source.data.type.reading.zoom = 3;
    source.data.type.arabic = "cairo";
    expect(JSON.stringify(d)).toBe(after);
  });

  it("the returned data is a fresh object, not the one handed in", () => {
    const fresh = defaultProfileData();
    expect(withReadingMeasure(fresh, styleOf(settled(), "rtl"))).not.toBe(fresh);
  });
});

describe("what the rest of the model still guarantees", () => {
  it("a هيئة written before this parses exactly as it always did", () => {
    expect(parseProfileData("{}").type.reading).toEqual(EMPTY_TYPOGRAPHY);
  });

  it("duplicate semantics are untouched — it still clones the whole هيئة, measure and look alike", () => {
    // `duplicateProfile` clones `p.data` wholesale; nothing here changes that, and a duplicate must
    // keep the look a new هيئة deliberately does not.
    const src = "src/features/profiles/store.ts";
    const code = readFileSync(join(process.cwd(), src), "utf8");
    expect(code).toContain("return createProfile(name, structuredClone(p.data), p.id);");
  });

  it("the creation boundary is the only place the snapshot is taken", () => {
    const code = readFileSync(join(process.cwd(), "src/features/profiles/ProfilesSection.tsx"), "utf8");
    expect(code).toContain("withReadingMeasure(");
    expect(code).toContain("resolveAppearance(activeId, profiles)");
    // The draft is included on purpose: `resolveAppearance` returns it when one is held.
    expect(code).toContain("peekGlobalStyle() ?? defaultsForDir(dir)");
    // And nothing else in the tree takes one.
    for (const f of ["src/features/profiles/store.ts", "src/features/profiles/ImportSheet.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toContain("withReadingMeasure");
    }
  });
});
