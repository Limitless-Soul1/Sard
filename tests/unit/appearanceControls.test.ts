// APPEARANCE CONTROLS — that each one reaches something the reader can see.
//
// The standard these guard is not "the value changed". Every one of the three faults behind this
// file passed that bar already: the presence slider moved and stored correctly, the bookmark sliders
// existed, and the size range was honoured by everything that read it. What failed was the last
// step — whether anything on screen was different.
//
// A unit test cannot watch pixels, so what it can hold is the STRUCTURE that made the pixels wrong:
// a chapter that edits one face while showing another, a control hidden behind a press, a range
// raised in one place and clamped in another. The pixels themselves are measured by
// two probes in the private test harness.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BOOKMARK_SIZE_MAX, BOOKMARK_SIZE_MIN } from "../../src/lib/bookmarkStyle";
import { parseProfileData } from "../../src/features/profiles/model/profile";
import { presenceMaxFor, scrimAlpha } from "../../src/lib/background";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const EDITOR = read("src/features/profiles/ProfileEditor.tsx");
const BM = read("src/lib/bookmarkStyle.ts");
const SHAPE = read("src/features/reader/BookmarkShape.tsx");
const CSS = read("src/styles/global.css");

/** the file with `//` lines dropped — the prose here names the very things being searched for */
const codeOf = (src: string) =>
  src.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join(String.fromCharCode(10));

describe("a background change happens where it can be seen", () => {
  it("each background section brings its own face forward", () => {
    // THE FAULT THIS PREVENTS. `background` is the one chapter with no face lock, and the book's
    // background layers exist only on the book face — so editing the book's presence while the
    // library face was up changed nothing visible. Measured: the value was right at every step
    // (scrim 1.000 → 0.620 → 0.012 across 0..260) and none of it was on screen.
    const code = codeOf(EDITOR);
    expect(code).toContain('onTouch={() => setFace("library")}');
    expect(code).toContain('onTouch={() => setFace("book")}');
  });

  it("and every write in the section goes through that switch", () => {
    // One wrapper, so a control added later cannot forget to do it.
    const code = codeOf(EDITOR);
    expect(code).toContain("const touchPatch = (f: (d: ProfileData) => void) => { onTouch(); patch(f); };");
    expect(code).toContain("touchPatch((d) => { at(d).params.presence");
    expect(code).toContain("touchPatch((d) => { at(d).params.blur");
    expect(code).toContain("touchPatch((d) => { d.bg.reading.params.pageOpacity");
  });

  it("presence still spans a range the eye can tell apart", () => {
    // The arithmetic behind what the probe measured: distinct scrims across the reading range.
    const seen = [0, 30, 60, 100, 180, 260].map((p) => Number(scrimAlpha(p, "reading").toFixed(3)));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe(1);
    expect(seen[seen.length - 1]).toBeLessThan(0.02);
    expect(presenceMaxFor("reading")).toBe(260);
    // the library's own range is untouched by any of this
    expect(presenceMaxFor("library")).toBe(100);
  });
});

describe("the bookmark controls are simply there", () => {
  it("no press stands between the chapter and its sliders", () => {
    // Measured before this: opening «العلامات» showed ZERO sliders; both were behind
    // «الحجم وموضع الحافّة».
    const code = codeOf(EDITOR);
    expect(code).not.toContain("setAdv");
    expect(code).not.toContain("profiles.marks.advancedHide");
    expect(code).toContain('{t("profiles.marks.advanced")}');
  });

  it("both sliders are still there, with their own hints", () => {
    const code = codeOf(EDITOR);
    expect(code).toContain("d.marks.bookmarkSize = Number(e.target.value)");
    expect(code).toContain("d.marks.bookmarkPos = Number(e.target.value)");
    expect(code).toContain('{t("gs.bookmark.posHint")}');
  });
});

describe("the larger bookmark is larger everywhere, not just on the slider", () => {
  it("the range was raised", () => {
    expect(BOOKMARK_SIZE_MAX).toBe(200);
    expect(BOOKMARK_SIZE_MIN).toBe(40);
  });

  it("there is exactly one cap, and the parser clamps to the same one", () => {
    // A range raised in the editor and clamped in the store would look like a working slider and
    // render a capped marker. Both limits are this constant.
    expect(codeOf(BM)).toContain("Math.min(BOOKMARK_SIZE_MAX, Math.round(n))");
    const at = (bookmarkSize: number) =>
      parseProfileData(JSON.stringify({ marks: { bookmarkSize } })).marks.bookmarkSize;
    expect(at(200)).toBe(200);
    expect(at(160)).toBe(160);
    expect(at(999)).toBe(BOOKMARK_SIZE_MAX);
    expect(at(1)).toBe(BOOKMARK_SIZE_MIN);
  });

  it("the renderer derives every dimension from the size, with no limit of its own", () => {
    const code = codeOf(SHAPE);
    expect(code).toContain("const W = h;");
    expect(code).not.toMatch(/Math\.min\([^)]*\bh\b/);
    expect(code).not.toContain("maxHeight");
    // and the element the reader sees carries no size of its own
    const rule = CSS.slice(CSS.indexOf(".page-bookmark {"), CSS.indexOf(".page-bookmark {") + 400);
    expect(rule).not.toContain("width:");
    expect(rule).not.toContain("height:");
    expect(rule).not.toContain("max-width");
  });
});

describe("a stored presence survives being read back", () => {
  it("the reading surface keeps values past 100", () => {
    // The editor offers 0..260 on the reading surface and the parser clamped to 100, so anything a
    // reader set above it was reduced on every load. Measured on a real library: three profiles
    // storing 224 and 260, all coming back as 100.
    const at = (presence: number, surface: "library" | "reading") => {
      const key = surface === "reading" ? "reading" : "library";
      const d = parseProfileData(JSON.stringify({ bg: { [key]: { params: { presence } } } }));
      return surface === "reading" ? d.bg.reading.params.presence : d.bg.library.params.presence;
    };
    expect(at(224, "reading")).toBe(224);
    expect(at(260, "reading")).toBe(260);
    expect(at(9999, "reading")).toBe(presenceMaxFor("reading"));
  });

  it("and the library surface still stops at its own measured floor", () => {
    const d = parseProfileData(JSON.stringify({ bg: { library: { params: { presence: 260 } } } }));
    expect(d.bg.library.params.presence).toBe(presenceMaxFor("library"));
    expect(presenceMaxFor("library")).toBe(100);
  });

  it("the two ceilings come from one function, not two literals", () => {
    const src = read("src/features/profiles/model/profile.ts");
    expect(src).toContain("num(o.presence, 0, presenceMaxFor(surface), BG_DEFAULT_PARAMS.presence)");
    expect(src).not.toContain("num(o.presence, 0, 100,");
  });
});
