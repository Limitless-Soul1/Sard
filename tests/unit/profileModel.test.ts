// PROFILES (stage 3) — the model, and the boundary that keeps a profile out of the reader's layout.
//
// THE TEST THAT MATTERS IS `the boundary`. Everything else here is ordinary parsing cover; that one
// is the feature's central promise, expressed as an assertion: a profile writes a fixed set of
// settings keys and patches the reading blob at exactly two fields. Line spacing, measure, margins,
// paragraph spacing, tracking, alignment, diacritics, zoom, weight and flow are the reader's own,
// and no profile — including one that arrives from someone else — can reach them.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** The repository root, so these read the source they are asserting about. */
const R = join(import.meta.dirname, "..", "..");
import { BOOKMARK_SIZE_MAX, BOOKMARK_SIZE_MIN } from "../../src/lib/bookmarkStyle";

import {
  PROFILE_READING_FIELDS,
  TYPOGRAPHY_KEYS,
  PROFILE_WRITES,
  VOICE_KEYS,
  parseProfileData,
  profileReadingTheme,
  profileRefs,
  profileSettings,
  profileTheme,
  readingPatch,
  readingThemeId,
  serialiseProfileData,
  type Profile,
} from "../../src/features/profiles/model/profile";
import { inspectPackage, serialiseProfile } from "../../src/features/profiles/model/package";
import {
  ARABIC_DEFAULTS,
  LATIN_DEFAULTS,
  TTS_TRACKING_DEFAULTS,
} from "../../src/reader-engine/injectedCss";
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

  // THE PROPERTY THAT KEEPS EVERY EXISTING PROFILE UNCHANGED. A profile may now hold a typography
  // opinion, but a profile that holds none must emit exactly what it always did — the two faces and
  // nothing else. Emitting `null` would BLANK the reader's value; omitting leaves it alone.
  // The two faces, plus the number ink — which is always written because a profile is its only
  // source, so `null` has to be able to clear a colour a previous save wrote.
  /**
   * The patcher, as `store.ts` performs it: CLEAR first, then WRITE.
   *
   * A measure field the هيئة does not name is removed so the engine's own per-script default resolves
   * for it. Composing the two halves here is what lets a test state a هيئة SWITCH rather than a single
   * patch — which is where the leak lived.
   */
  const applyPatch = (blob: Record<string, unknown>, patch: ReturnType<typeof readingPatch>) => {
    for (const k of patch.clear) delete blob[k];
    Object.assign(blob, patch.set);
  };

  /** The three the patch always carries, plus the seven read-aloud marks it now always carries too. */
  const ALWAYS = ["arabicFont", "backgroundColor", "latinFont", "numberColor", "pageColor",
    ...VOICE_KEYS].sort();

  it("a profile with no typography opinion patches the faces, the number ink, the overlay and the page", () => {
    // `backgroundColor` joins for the same reason `numberColor` did: it is a LOOK the profile owns,
    // and omitting it on clear would leave the previous choice standing in `reading_style` with
    // nothing able to drop it. Both are written even when null, which is what "follow the theme"
    // persists as. The firewall this file guards is untouched: `readingPatch` still reaches only the
    // GLOBAL `reading_style`, and a per-book `book_style:<id>` is still never written by a profile.
    expect(Object.keys(readingPatch(profile()).set).sort()).toEqual(ALWAYS);
    expect(readingPatch(profile()).set.numberColor).toBeNull();
    expect(readingPatch(profile()).set.backgroundColor).toBeNull();
  });

  it("the page colour is always cleared, because a profile's answer to it is its reading paper", () => {
    // The third always-written field, and the one with the sharpest consequence for omitting it.
    // `.page-sheet` resolves the stored page colour BEFORE the reading palette, so a colour set once
    // in the reading drawer outranked every profile's paper for ever with nothing able to drop it —
    // measured on a real configuration as a page that survived A -> B -> A without moving. A profile
    // carries no page colour of its own and must not: its answer is the palette, so it writes null.
    const p = profile();
    p.data.theme.reading.colors = { ...p.data.theme.reading.colors, paperBg: "#123456" };
    expect(readingPatch(p).set.pageColor).toBeNull();
    // and it is emphatically NOT the paper — writing that here would put the palette's colour into a
    // per-reader override row, where a later palette change could never reach it again.
    expect(readingPatch(p).set.pageColor).not.toBe("#123456");
  });

  it("a profile emits only the typography fields it actually sets", () => {
    const p = profile();
    p.data.type.reading = { ...p.data.type.reading, lineHeight: 2.1, zoom: 1.4 };
    expect(Object.keys(readingPatch(p).set).sort()).toEqual([...ALWAYS, "lineHeight", "zoom"].sort());
    expect(readingPatch(p).set.lineHeight).toBe(2.1);
  });

  // ---- the read-aloud marks: a هيئة may carry them, and must be able to say it carries none ----

  it("a هيئة with no voice opinion asserts SARD'S OWN marks, not the last هيئة's", () => {
    // THE DEFECT THIS CLOSES. A patch merges into the reader's blob, so omitting these seven left
    // whatever the PREVIOUS هيئة had asserted standing: wearing A (a green spotlight) and then B
    // (no opinion) left the reader reading B in A's green. A هيئة is a complete look; activating
    // one has to establish the whole of it.
    const patch = readingPatch(profile()).set as Record<string, unknown>;
    for (const k of VOICE_KEYS) expect(Object.hasOwn(patch, k), k).toBe(true);
    for (const [k, v] of Object.entries(TTS_TRACKING_DEFAULTS)) expect(patch[k], k).toBe(v);
  });

  it("and those values ARE the engine's own defaults, not a second copy of them", () => {
    // `loadGlobalStyle` fills every absent field from `defaultsForDir`, into which
    // `TTS_TRACKING_DEFAULTS` is spread — so "absent" and "these seven values" are the same effective
    // state, and this writes the model's own spelling of "follow the default" rather than a new one.
    // Spread at call time, so a change to the engine's defaults reaches these هيئات too.
    expect(ARABIC_DEFAULTS.ttsSpotlightOn).toBe(TTS_TRACKING_DEFAULTS.ttsSpotlightOn);
    expect(ARABIC_DEFAULTS.ttsSpotlightColor).toBe(TTS_TRACKING_DEFAULTS.ttsSpotlightColor);
    expect(LATIN_DEFAULTS.ttsKaraokeOpacity).toBe(TTS_TRACKING_DEFAULTS.ttsKaraokeOpacity);
    const patch = readingPatch(profile()).set as Record<string, unknown>;
    expect(patch.ttsSpotlightColor).toBeNull();
    expect(patch.ttsSpotlightOn).toBe(true);
  });

  it("A(custom) -> B(none) -> A(custom): B does not wear A's marks, and A gets them back", () => {
    // The lifecycle the reader actually performs, as the patcher sees it. `patchReadingStyle` merges,
    // so this composes the two patches the way the store does and asserts the blob after each.
    const a = profile();
    a.data.voice = { ...TTS_TRACKING_DEFAULTS, ttsSpotlightColor: "#6E7F5B", ttsSpotlightOpacity: 0.4 };
    const b = profile(); // no voice block at all
    const blob: Record<string, unknown> = {};

    applyPatch(blob, readingPatch(a));
    expect(blob.ttsSpotlightColor).toBe("#6E7F5B");
    expect(blob.ttsSpotlightOpacity).toBe(0.4);

    applyPatch(blob, readingPatch(b));
    expect(blob.ttsSpotlightColor, "B must not inherit A's green").toBeNull();
    expect(blob.ttsSpotlightOpacity).toBeNull();

    applyPatch(blob, readingPatch(a));
    expect(blob.ttsSpotlightColor).toBe("#6E7F5B");
    expect(blob.ttsSpotlightOpacity).toBe(0.4);
  });

  it("a هيئة that carries them writes all seven, nulls included", () => {
    const p = profile();
    p.data.voice = {
      ttsSpotlightOn: true,
      ttsSpotlightColor: "#6E7F5B",
      // NULL IS A REAL VALUE HERE — "the theme's own band" — so it must be WRITTEN, not omitted.
      // Omitting it is how a colour the reader cleared went on being drawn for ever.
      ttsSpotlightOpacity: null,
      ttsSpotlightRule: false,
      ttsKaraokeOn: false,
      ttsKaraokeColor: null,
      ttsKaraokeOpacity: 0.5,
    };
    const patch = readingPatch(p).set as Record<string, unknown>;
    for (const k of VOICE_KEYS) expect(Object.hasOwn(patch, k), k).toBe(true);
    expect(patch.ttsSpotlightColor).toBe("#6E7F5B");
    expect(patch.ttsSpotlightOpacity).toBeNull();
    expect(patch.ttsSpotlightRule).toBe(false);
    expect(patch.ttsKaraokeOpacity).toBe(0.5);
  });

  it("absence and a block of defaults are different answers", () => {
    // The distinction the whole design rests on: "leave the reader's marks alone" is not the same
    // statement as "these marks, which happen to be the defaults", and a blob has to keep them apart.
    const none = parseProfileData(JSON.stringify({ v: 2 }));
    const some = parseProfileData(JSON.stringify({ v: 2, voice: {} }));
    expect(none.voice).toBeNull();
    expect(some.voice).not.toBeNull();
    expect(some.voice?.ttsSpotlightOn).toBe(true);
  });

  it("a profile written before the voice chapter existed carries no opinion", () => {
    // NOTHING ABOUT A STORED PROFILE CHANGED — only what activating one asserts. A v1 blob still
    // parses to `voice: null`, which is what it has always meant.
    const old = parseProfileData(JSON.stringify({
      v: 1, theme: { base: "moonlit" }, type: { arabic: "amiri", latin: "literata" },
    }));
    expect(old.voice).toBeNull();
    // And wearing it puts the marks back to Sard's own rather than leaving the last هيئة's standing.
    const patch = readingPatch({ ...profile(), data: old }).set as Record<string, unknown>;
    expect(patch.ttsSpotlightOn).toBe(TTS_TRACKING_DEFAULTS.ttsSpotlightOn);
    expect(patch.ttsKaraokeColor).toBeNull();
  });

  it("a hostile voice block is defaulted field by field, never trusted", () => {
    const p = parseProfileData(JSON.stringify({
      v: 2,
      voice: {
        ttsSpotlightOn: "yes",
        ttsSpotlightColor: "javascript:alert(1)",
        ttsSpotlightOpacity: 42,
        ttsKaraokeOpacity: 0.4,
      },
    }));
    expect(p.voice?.ttsSpotlightOn).toBe(true); // not the string
    expect(p.voice?.ttsSpotlightColor).toBeNull(); // not a hex → the theme's own
    expect(p.voice?.ttsSpotlightOpacity).toBeNull(); // out of range → the theme's own
    expect(p.voice?.ttsKaraokeOpacity).toBe(0.4); // a real value survives
  });

  // ---- the MEASURE: a هيئة is worn complete, never in the last one's margins ----

  it("A(margin 136) -> B(no margin) -> A: B does NOT inherit A's margin", () => {
    // THE DEFECT, as it was met in practice. One book's stored row carried `marginPx: 136`; the هيئة
    // worn over it carried a measure but no margin of its own; and because a field the هيئة did not
    // name was simply OMITTED from the patch, the 136 stayed in the shared row. Every book was then
    // read at 136px of margin — a fifth of the page — under a هيئة that never asked for it, and no
    // text size could reclaim it.
    const a = profile();
    a.data.type.reading = { ...a.data.type.reading, marginPx: 136, zoom: 2.5, lineHeight: 1.9 };
    const b = profile();
    b.data.type.reading = { ...b.data.type.reading, zoom: 2.3 }; // a measure, but no margin
    const blob: Record<string, unknown> = {};

    applyPatch(blob, readingPatch(a));
    expect(blob.marginPx).toBe(136);
    expect(blob.zoom).toBe(2.5);

    applyPatch(blob, readingPatch(b));
    expect(blob.marginPx, "B must not be worn in A's margin").toBeUndefined();
    expect(blob.lineHeight, "nor in A's leading").toBeUndefined();
    expect(blob.zoom).toBe(2.3);

    applyPatch(blob, readingPatch(a));
    expect(blob.marginPx).toBe(136);
    expect(blob.lineHeight).toBe(1.9);
  });

  it("ABSENT, not a written number — because the default differs by script", () => {
    // `loadGlobalStyle` fills an absent field from `defaultsForDir(dir)`, and those sets differ:
    // zoom 1.15/1.0, line-height 1.9/1.6, align start/justify. Writing one script's number into a row
    // both scripts read would open every Arabic book at the Latin baseline — the defect AUD-6 fixed.
    expect(ARABIC_DEFAULTS.zoom).not.toBe(LATIN_DEFAULTS.zoom);
    expect(ARABIC_DEFAULTS.lineHeight).not.toBe(LATIN_DEFAULTS.lineHeight);
    const patch = readingPatch(profile());
    expect(patch.clear.sort()).toEqual([...TYPOGRAPHY_KEYS].sort());
    for (const k of TYPOGRAPHY_KEYS) expect(patch.set[k], k).toBeUndefined();
  });

  it("A -> B -> C -> A leaves nothing of B or C behind", () => {
    const a = profile(); a.data.type.reading = { ...a.data.type.reading, marginPx: 136 };
    const b = profile(); b.data.type.reading = { ...b.data.type.reading, lineHeight: 2.4 };
    const c = profile(); c.data.type.reading = { ...c.data.type.reading, letterSpacing: 3 };
    const blob: Record<string, unknown> = {};
    for (const p2 of [a, b, c, a]) applyPatch(blob, readingPatch(p2));
    expect(blob.marginPx).toBe(136);
    expect(blob.lineHeight).toBeUndefined();
    expect(blob.letterSpacing).toBeUndefined();
  });

  it("a هيئة with NO measure at all clears the whole measure", () => {
    // The owner's rule: no opinion on a field means Sard's own default for that field — never the
    // value the previous هيئة supplied.
    const a = profile();
    a.data.type.reading = { ...a.data.type.reading, marginPx: 136, zoom: 2.5, align: "center" };
    const blob: Record<string, unknown> = {};
    applyPatch(blob, readingPatch(a));
    applyPatch(blob, readingPatch(profile()));
    for (const k of TYPOGRAPHY_KEYS) expect(blob[k], k).toBeUndefined();
  });

  it("an out-of-range value is refused rather than clamped, so it stays no opinion", () => {
    const raw = parseProfileData(JSON.stringify({
      v: 1, type: { arabic: "amiri", latin: "literata", reading: { zoom: 99, lineHeight: 1.8 } },
    }));
    expect(raw.type.reading.zoom).toBeNull();
    expect(raw.type.reading.lineHeight).toBe(1.8);
  });

  it("the reading patch cannot express a layout field the engine does not own", () => {
    const patch = readingPatch(profile()).set as Record<string, unknown>;
    // `flowMode`, `pageFitWindow` and the rest stay the reader's alone.
    for (const f of ["flowMode", "pageFitWindow", "hideChapterTitles", "hideFirstLine", "overrideBookColor"]) {
      expect(patch[f], f).toBeUndefined();
    }
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

describe("applying a هيئة is not always WEARING one", () => {
  // The list is ordered by USE, so what counts as use has to be exact. Two paths re-apply the هيئة
  // the reader is already in — saving it, and discarding session drift — and neither is a choice.
  // Measured before this was separated: saving the active هيئة moved its use stamp and floated it
  // above هيئات actually worn since.
  const STORE = readFileSync(join(R, "src/features/profiles/store.ts"), "utf8");
  const UNSAVED = readFileSync(join(R, "src/features/profiles/UnsavedChange.tsx"), "utf8");

  it("the stamp is written only when the application is a switch", () => {
    expect(STORE).toContain("if (opts.worn !== false) void profileTouch(p.id)");
  });

  it("saving the active هيئة repaints it without wearing it", () => {
    expect(STORE).toContain(
      "if (useProfiles.getState().activeId === p.id) await applyProfile(p, { worn: false });",
    );
  });

  it("discarding session drift re-applies without wearing", () => {
    expect(UNSAVED).toContain("await applyProfile(active, { worn: false });");
  });

  it("and every other caller is a switch, so it stamps by default", () => {
    // The default matters: a new call site that says nothing is a switch, which is what every
    // surface that offers a choice actually is.
    expect(STORE).toContain("opts: { worn?: boolean } = {},");
    for (const f of ["ProfilesSection.tsx", "ProfileSwitcher.tsx", "ImportSheet.tsx"]) {
      const src = readFileSync(join(R, "src/features/profiles", f), "utf8");
      expect(src, f).not.toContain("worn: false");
    }
  });
});

describe("deleting the هيئة you are wearing takes it OFF", () => {
  // Measured before this: `removeProfile` persisted `theme_id`/`book_theme_id` back to the fallback
  // but left the live theme store naming the deleted profile — and `refreshProfiles` had already
  // unregistered that palette, so the id dangled. Nothing repainted `:root`, so the reader kept
  // looking at the هيئة they had just deleted while the row on disk said `ivory`; only the next
  // launch made the two agree. Persisting a fallback is not wearing it.
  const STORE = readFileSync(join(R, "src/features/profiles/store.ts"), "utf8");
  const remove = STORE.slice(STORE.indexOf("export async function removeProfile"));
  const body = remove.slice(0, remove.indexOf("export", 40));

  it("repaints the fallback rather than only persisting it", () => {
    expect(body).toContain("applyTheme(resolveTheme(fallback));");
  });

  it("and moves BOTH live ids off the deleted profile", () => {
    expect(body).toContain("useTheme.setState({ themeId: fallback, bookThemeId: fallback });");
  });

  it("the fallback is typed as a theme id, so an id that resolves to nothing cannot be passed", () => {
    expect(STORE).toContain("removeProfile(p: Profile, fallback: ThemeId)");
  });
});

describe("parsing is total", () => {
  it("a damaged blob yields a usable profile rather than throwing", () => {
    for (const bad of ["", "{", "null", "[]", '"a string"', "{}"]) {
      const d = parseProfileData(bad);
      expect(d.theme.library.colors.paperBg).toBeTruthy();
      expect(d.marks.bookmarkShape).toBeTruthy();
      expect(d.type.arabic).toBeTruthy();
    }
  });

  it("unknown fields are ignored, not rejected — a blob from a future Sard still opens", () => {
    const d = parseProfileData(
      JSON.stringify({ theme: { base: "sepia" }, somethingNew: { deep: [1, 2] }, v: 99 }),
    );
    expect(d.theme.library.base).toBe("sepia");
    expect(d.v).toBe(99);
  });

  it("missing fields take the base theme's own values", () => {
    const d = parseProfileData(JSON.stringify({ theme: { base: "moonlit" } }));
    expect(d.theme.library.colors.paperBg).toBe(THEMES.moonlit.colors.paperBg);
    expect(d.theme.library.dark).toBe(true);
  });

  it("an unknown base theme falls back rather than carrying a dangling id", () => {
    const d = parseProfileData(JSON.stringify({ theme: { base: "u:gone" } }));
    expect(d.theme.library.base).toBeNull();
  });

  it("rejects a colour that is not a plain hex", () => {
    // Load-bearing: these values are interpolated into the CSS injected into the book iframe.
    const d = parseProfileData(
      JSON.stringify({
        theme: { base: "ivory", colors: { paperBg: "red;} body{display:none}", text: "#123456" } },
      }),
    );
    expect(d.theme.library.colors.paperBg).toBe(THEMES.ivory.colors.paperBg); // the attack fell back
    expect(d.theme.library.colors.text).toBe("#123456"); // the valid one survived
  });

  it("clamps numbers into their measured ranges", () => {
    const d = parseProfileData(
      JSON.stringify({ marks: { bookmarkSize: 9999, bookmarkPos: -4 } }),
    );
    // AGAINST THE CONSTANT, not a copy of it. This read 120, which is what the maximum happened to
    // be — so raising the range broke a test that was never about the number.
    expect(d.marks.bookmarkSize).toBeLessThanOrEqual(BOOKMARK_SIZE_MAX);
    expect(d.marks.bookmarkSize).toBeGreaterThanOrEqual(BOOKMARK_SIZE_MIN);
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
    expect(profileTheme(p).dark).toBe(p.data.theme.library.dark);
  });
});

describe("bookmark colour follows the accent unless authored", () => {
  it("null means the accent", () => {
    const p = profile();
    p.data.theme.reading.bookmark = null;
    const color = profileSettings(p).find(([k]) => k === "bookmark_color")![1];
    expect(color).toBe(p.data.theme.reading.colors.accent);
  });

  it("an authored colour wins", () => {
    const p = profile();
    p.data.theme.reading.bookmark = "#1F6F6B";
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
    // The whitelist grew to the nine the reading engine can honour, and no further. Everything in
    // FORBIDDEN that is NOT one of those nine must still be unreachable.
    const owned = new Set<string>([...PROFILE_READING_FIELDS]);
    for (const f of ["flowMode", "pageFitWindow", "hideChapterTitles", "hideFirstLine", "overrideBookColor"]) {
      expect(owned.has(f), f).toBe(false);
    }
  });

  // THE BORDER IS UNCHANGED. A profile's measure is local: it must never travel, or importing a
  // stranger's look would reshape how the recipient reads — and a package carrying it is refused by
  // `inspectPackage` anyway, so exporting one would produce a file Sard cannot import.
  it("an exported package carries the WHOLE measure — a هيئة is not sent in pieces", () => {
    // THE DEFECT THIS REPLACES. The exporter stripped `type.reading` and the firewall refused its
    // keys, so a shared هيئة arrived with the colours and none of the setting: no size, no leading,
    // no margins, no page width. That was right while a هيئة was a palette; it is the complete
    // reading preset now, so it travels complete.
    const p = profile();
    p.data.type.reading = {
      ...p.data.type.reading, lineHeight: 2.1, zoom: 1.4, letterSpacing: 2, pageWidth: 0.8,
      marginPx: 120,
    };
    const text = JSON.stringify(serialiseProfile(p, "1.2.2"));
    const seen = inspectPackage(text);
    expect(seen.ok, JSON.stringify((seen as { refusal?: unknown }).refusal)).toBe(true);
    if (seen.ok) {
      expect(seen.data.type.reading.lineHeight).toBe(2.1);
      expect(seen.data.type.reading.zoom).toBe(1.4);
      expect(seen.data.type.reading.letterSpacing).toBe(2);
      expect(seen.data.type.reading.pageWidth).toBe(0.8);
      expect(seen.data.type.reading.marginPx).toBe(120);
    }
  });

  it("and what it still refuses is exactly what a هيئة does not own", () => {
    // Derived, so this cannot drift: every `ReadingStyle` field that is not profile-owned is refused.
    for (const k of Object.keys(ARABIC_DEFAULTS)) {
      const owned = (PROFILE_READING_FIELDS as readonly string[]).includes(k);
      const r = inspectPackage(JSON.stringify({
        package: 2, app: "t", data: { theme: { base: "ivory" }, [k]: 1 },
      }));
      expect(r.ok, k + (owned ? " is owned and must cross" : " is not owned and must be refused"))
        .toBe(owned);
    }
  });

  // AND THE READ-ALOUD MARKS DO CROSS IT, which is the deliberate difference. They are a colour and a
  // strength — what the هيئة LOOKS like while Sard reads — not how the recipient's books are set, so
  // they travel with the palette and the bookmark rather than staying home with the measure.
  it("an exported package carries the read-aloud marks, and they survive the border", () => {
    const p = profile();
    p.data.voice = {
      ttsSpotlightOn: true, ttsSpotlightColor: "#7E6A9E", ttsSpotlightOpacity: 0.25,
      ttsSpotlightRule: false, ttsKaraokeOn: true, ttsKaraokeColor: null, ttsKaraokeOpacity: null,
    };
    const text = JSON.stringify(serialiseProfile(p, "1.2.2"));
    const seen = inspectPackage(text);
    expect(seen.ok, JSON.stringify((seen as { refusal?: unknown }).refusal)).toBe(true);
    if (seen.ok) {
      expect(seen.data.voice?.ttsSpotlightColor).toBe("#7E6A9E");
      expect(seen.data.voice?.ttsSpotlightRule).toBe(false);
    }
  });
});

describe("two palettes, and what happens to a profile written before there were two", () => {
  it("a v1 blob's single palette becomes BOTH scopes, identically", () => {
    // THE MIGRATION, AND THE WHOLE PROMISE OF IT. Every profile written before this change stored
    // one palette; nothing on disk is rewritten, and the parser hands that palette to the library
    // and to the book alike. So an existing profile renders exactly as it always did on both
    // surfaces, and the two only part when a reader deliberately edits one.
    const d = parseProfileData(JSON.stringify({ theme: { base: "moonlit" } }));
    expect(d.theme.library.base).toBe("moonlit");
    expect(d.theme.reading.base).toBe("moonlit");
    expect(d.theme.reading.colors).toEqual(d.theme.library.colors);
    expect(d.theme.reading.dark).toBe(d.theme.library.dark);
  });

  it("a v1 blob with authored colours carries them to both", () => {
    const d = parseProfileData(JSON.stringify({
      theme: { base: "ivory", colors: { text: "#123456" }, numbers: "#ABCDEF" },
    }));
    expect(d.theme.library.colors.text).toBe("#123456");
    expect(d.theme.reading.colors.text).toBe("#123456");
    expect(d.theme.reading.numbers).toBe("#ABCDEF");
  });

  it("a v2 blob keeps its two palettes apart", () => {
    const d = parseProfileData(JSON.stringify({
      v: 2,
      theme: { library: { base: "moonlit" }, reading: { base: "sepia" } },
    }));
    expect(d.theme.library.base).toBe("moonlit");
    expect(d.theme.reading.base).toBe("sepia");
    expect(d.theme.reading.colors.paperBg).not.toBe(d.theme.library.colors.paperBg);
  });

  it("a v2 blob naming only one scope lends it to the other", () => {
    // A hand-written or truncated manifest is a plain profile, never a half-painted one.
    const d = parseProfileData(JSON.stringify({ v: 2, theme: { library: { base: "sage" } } }));
    expect(d.theme.reading.colors).toEqual(d.theme.library.colors);
  });

  it("the two palettes register under DIFFERENT theme ids", () => {
    // The registry maps one id to one theme, so two palettes need two keys. The library keeps the
    // profile's own id, so every `theme_id` already stored on disk still resolves.
    const p = profile();
    expect(profileTheme(p).id).toBe(p.id);
    expect(profileReadingTheme(p).id).toBe(readingThemeId(p.id));
    expect(readingThemeId(p.id).startsWith("u:")).toBe(true);
  });

  it("applying a profile no longer writes one id to both keys", () => {
    // The defect this change exists to remove: `book_theme_id` used to be the profile's own id, so
    // the book page wore the library's palette and the two scopes could never differ.
    const p = profile();
    const s = new Map(profileSettings(p));
    expect(s.get("theme_id")).toBe(p.id);
    expect(s.get("book_theme_id")).toBe(readingThemeId(p.id));
    expect(s.get("book_theme_id")).not.toBe(s.get("theme_id"));
  });
});
