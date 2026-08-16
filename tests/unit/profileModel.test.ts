// PROFILES (stage 3) — the model, and the boundary that keeps a profile out of the reader's layout.
//
// THE TEST THAT MATTERS IS `the boundary`. Everything else here is ordinary parsing cover; that one
// is the feature's central promise, expressed as an assertion: a profile writes a fixed set of
// settings keys and patches the reading blob at exactly two fields. Line spacing, measure, margins,
// paragraph spacing, tracking, alignment, diacritics, zoom, weight and flow are the reader's own,
// and no profile — including one that arrives from someone else — can reach them.

import { describe, expect, it } from "vitest";

import {
  PROFILE_READING_FIELDS,
  PROFILE_WRITES,
  parseProfileData,
  profileRefs,
  profileSettings,
  profileTheme,
  readingPatch,
  serialiseProfileData,
  type Profile,
} from "../../src/features/profiles/model/profile";
import { THEMES } from "../../src/theme/themes";
import type { CustomThemeId } from "../../src/theme/tokens";

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: "u:test" as CustomThemeId,
  name: "مَساء",
  description: null,
  author: null,
  iconKind: "seal",
  iconRef: null,
  derivedFrom: "moonlit",
  createdAt: 1,
  updatedAt: 1,
  data: parseProfileData(JSON.stringify({ theme: { base: "moonlit" } })),
  ...over,
});

describe("the boundary — what a profile may write", () => {
  // The reading-layout settings, by name. If a profile could ever write one of these, importing a
  // stranger's look would change how the recipient reads.
  const FORBIDDEN = [
    "lineHeight", "pageWidth", "marginPx", "pageFitWindow", "paragraphSpacing", "letterSpacing",
    "align", "firstLineIndent", "diacritics", "zoom", "fontWeight", "flowMode",
    "hideChapterTitles", "hideFirstLine", "overrideBookColor",
  ];

  it("writes only the whitelisted settings keys", () => {
    const keys = profileSettings(profile()).map(([k]) => k);
    for (const k of keys) expect(PROFILE_WRITES).toContain(k);
  });

  it("writes no key that names a book", () => {
    // A `book_style:<id>` row is the reader's per-book work. Nothing here may name one.
    for (const [k] of profileSettings(profile())) {
      expect(k.startsWith("book_style"), k).toBe(false);
    }
  });

  it("patches the reading style at exactly two fields", () => {
    expect([...PROFILE_READING_FIELDS]).toEqual(["arabicFont", "latinFont"]);
    expect(Object.keys(readingPatch(profile())).sort()).toEqual(["arabicFont", "latinFont"]);
  });

  it("the reading patch cannot express a layout field", () => {
    const patch = readingPatch(profile()) as Record<string, unknown>;
    for (const f of FORBIDDEN) expect(patch[f], f).toBeUndefined();
  });

  it("none of the whitelisted keys is a reading-layout key", () => {
    for (const k of PROFILE_WRITES) {
      expect(FORBIDDEN, k).not.toContain(k);
      expect(k).not.toBe("reading_style");
      expect(k).not.toBe("style_scope");
      expect(k).not.toBe("ui_lang");
      expect(k).not.toBe("book_css");
    }
  });

  // GROWN ONCE, DELIBERATELY. Stage 4 added the two surface bindings, their two parameter blobs and
  // the texture step — what backgrounds and texture need, and nothing else. The list is pinned rather
  // than derived precisely so widening it is an edit someone has to make on purpose: if this fails,
  // the whitelist grew and the question is whether it should have.
  it("the whitelist is exactly the fourteen keys the design needs — no quiet growth", () => {
    expect([...PROFILE_WRITES].sort()).toEqual([
      "bg_library_id", "bg_library_params", "bg_reading_id", "bg_reading_params",
      "book_theme_id", "bookmark_color", "bookmark_pos", "bookmark_size", "bookmark_style",
      "profile_active", "read_marker", "theme_id", "ui_font", "ui_texture",
    ]);
  });
});

describe("parsing is total", () => {
  it("a damaged blob yields a usable profile rather than throwing", () => {
    for (const bad of ["", "{", "null", "[]", '"a string"', "{}"]) {
      const d = parseProfileData(bad);
      expect(d.theme.colors.paperBg).toBeTruthy();
      expect(d.marks.bookmarkShape).toBeTruthy();
      expect(d.type.arabic).toBeTruthy();
    }
  });

  it("unknown fields are ignored, not rejected — a blob from a future Sard still opens", () => {
    const d = parseProfileData(
      JSON.stringify({ theme: { base: "sepia" }, somethingNew: { deep: [1, 2] }, v: 99 }),
    );
    expect(d.theme.base).toBe("sepia");
    expect(d.v).toBe(99);
  });

  it("missing fields take the base theme's own values", () => {
    const d = parseProfileData(JSON.stringify({ theme: { base: "moonlit" } }));
    expect(d.theme.colors.paperBg).toBe(THEMES.moonlit.colors.paperBg);
    expect(d.theme.dark).toBe(true);
  });

  it("an unknown base theme falls back rather than carrying a dangling id", () => {
    const d = parseProfileData(JSON.stringify({ theme: { base: "u:gone" } }));
    expect(d.theme.base).toBeNull();
  });

  it("rejects a colour that is not a plain hex", () => {
    // Load-bearing: these values are interpolated into the CSS injected into the book iframe.
    const d = parseProfileData(
      JSON.stringify({
        theme: { base: "ivory", colors: { paperBg: "red;} body{display:none}", text: "#123456" } },
      }),
    );
    expect(d.theme.colors.paperBg).toBe(THEMES.ivory.colors.paperBg); // the attack fell back
    expect(d.theme.colors.text).toBe("#123456"); // the valid one survived
  });

  it("clamps numbers into their measured ranges", () => {
    const d = parseProfileData(
      JSON.stringify({ marks: { bookmarkSize: 9999, bookmarkPos: -4 } }),
    );
    expect(d.marks.bookmarkSize).toBeLessThanOrEqual(120);
    expect(d.marks.bookmarkPos).toBeGreaterThanOrEqual(0);
  });

  it("rejects an unknown bookmark shape and read-marker", () => {
    const d = parseProfileData(
      JSON.stringify({ marks: { bookmarkShape: "../etc/passwd", readMarker: "nope" } }),
    );
    expect(d.marks.bookmarkShape).toBe("ribbon");
    expect(d.marks.readMarker).toBe("accentTrail");
  });

  it("round-trips through serialise", () => {
    const d = parseProfileData(JSON.stringify({ theme: { base: "sage" } }));
    expect(parseProfileData(serialiseProfileData(d))).toEqual(d);
  });
});

describe("a profile is its own theme", () => {
  it("registers under the profile's own id — one id, no mapping", () => {
    const p = profile();
    expect(profileTheme(p).id).toBe(p.id);
  });

  it("carries the reader's typed name, shown as written", () => {
    // Not translatable: it is text a person typed, and an imported profile keeps its author's name.
    expect(profileTheme(profile({ name: "ليالي الشتاء" })).name).toBe("ليالي الشتاء");
  });

  it("an unnamed profile still yields a usable theme", () => {
    expect(profileTheme(profile({ name: null })).name).toBeTruthy();
  });

  it("carries the authored polarity, not one inferred from the paper", () => {
    const p = profile();
    expect(profileTheme(p).dark).toBe(p.data.theme.dark);
  });
});

describe("bookmark colour follows the accent unless authored", () => {
  it("null means the accent", () => {
    const p = profile();
    p.data.theme.bookmark = null;
    const color = profileSettings(p).find(([k]) => k === "bookmark_color")![1];
    expect(color).toBe(p.data.theme.colors.accent);
  });

  it("an authored colour wins", () => {
    const p = profile();
    p.data.theme.bookmark = "#1F6F6B";
    const color = profileSettings(p).find(([k]) => k === "bookmark_color")![1];
    expect(color).toBe("#1F6F6B");
  });
});

describe("stage 4 — backgrounds and texture", () => {
  // THE "NO MIGRATION" PROOF. Every profile written before stage 4 has no `bg` and no `texture` in
  // its blob. If absence did not default cleanly, those rows would need a migration; because it
  // does, adding these fields was a code change and nothing on disk had to move.
  it("a profile written before backgrounds existed still parses, and means 'no image'", () => {
    const old = JSON.stringify({
      v: 1,
      theme: { base: "ivory" },
      type: { arabic: "amiri", latin: "literata" },
      marks: { bookmarkShape: "ribbon" },
    });
    const d = parseProfileData(old);
    expect(d.bg.library.ref).toBeNull();
    expect(d.bg.reading.ref).toBeNull();
    expect(d.bg.reading.sameAsLibrary).toBe(false);
    expect(d.texture).toBe("opaque");
    // and the treatment falls back to the shipped defaults rather than zeroes
    expect(d.bg.library.params.presence).toBeGreaterThan(0);
    expect(d.bg.library.params.pageOpacity).toBe(1);
  });

  it("a damaged or hostile blob cannot smuggle in a background id", () => {
    const d = parseProfileData(
      JSON.stringify({ bg: { library: { ref: "../../etc/passwd" } }, texture: "invisible" }),
    );
    expect(d.bg.library.ref).toBeNull();
    expect(d.texture).toBe("opaque");
  });

  // THE COLLECTOR'S VIEW. `profileRefs` is what becomes the row's columns, and `gc()` reads only
  // those. If this ever disagrees with `data`, the image is deleted while still in use.
  it("profileRefs mirrors what the collector must keep", () => {
    const d = parseProfileData(
      JSON.stringify({ bg: { library: { ref: "aabbcc11" }, reading: { ref: "ddee2233" } } }),
    );
    const p = { id: "u:x", data: d } as unknown as Profile;
    expect(profileRefs(p)).toEqual({ bgLibrary: "aabbcc11", bgReading: "ddee2233" });
  });

  it("'the same image, quieter' resolves the reading surface to the library's hash", () => {
    const d = parseProfileData(
      JSON.stringify({
        bg: { library: { ref: "aabbcc11" }, reading: { ref: "ddee2233", sameAsLibrary: true } },
      }),
    );
    const p = { id: "u:x", data: d } as unknown as Profile;
    expect(profileRefs(p).bgReading).toBe("aabbcc11");
    const s = new Map(profileSettings(p));
    expect(s.get("bg_reading_id")).toBe("aabbcc11");
    expect(s.get("bg_library_id")).toBe("aabbcc11");
  });

  it("no image writes an empty binding, not a stale one", () => {
    const p = { id: "u:x", data: parseProfileData("{}") } as unknown as Profile;
    const s = new Map(profileSettings(p));
    expect(s.get("bg_library_id")).toBe("");
    expect(s.get("bg_reading_id")).toBe("");
    expect(s.get("ui_texture")).toBe("opaque");
  });

  // THE BOUNDARY, RESTATED FOR THE NEW KEYS. Backgrounds widened the whitelist; they must not have
  // widened it into the reader's layout.
  it("the widened whitelist still names nothing the reader owns", () => {
    const forbidden = /line|margin|spacing|tracking|align|diacritic|zoom|weight|measure|page_width|flow|book_style|reading_style/i;
    for (const k of PROFILE_WRITES) expect(k).not.toMatch(forbidden);
    expect(PROFILE_READING_FIELDS).toEqual(["arabicFont", "latinFont"]);
  });
});
