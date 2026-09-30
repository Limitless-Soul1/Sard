// THE READER'S INTERFACE AND THE BOOK'S PAGE DO NOT SHARE TYPOGRAPHY — all four directions.
//
// THE REGRESSION THESE EXIST FOR. `7498c72` gave `.reader-root` the ten tokens of `themeVars(...)`
// and fed it the READING palette. Two of those ten are ink: `--text` and `--muted`. Custom properties
// inherit, and 575 reader rules read these tokens — so changing the colour of the text INSIDE the
// book changed the colour of the toolbar's labels, the contents list, and every other piece of
// interface text. The same line did it to the surfaces (`--paper-bg`, `--chrome-bg`, `--app-bg`),
// which is the page-colour regression reported alongside this one. One boundary, both symptoms, and
// therefore one fix: `.reader-root` wears the هيئة's INTERFACE palette; the page wears its reading one.
//
// A هيئة carries both palettes on purpose. Nothing here asks the reader's interface to stop following
// the هيئة — a book wearing هيئة B must still be read inside B's interface, which is what that commit
// was written for. It asks only that the interface follow B's interface half.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildFontFaceCss, buildReadingCss, ARABIC_DEFAULTS } from "../../src/reader-engine/injectedCss";
import { defaultProfileData } from "../../src/features/profiles/store";
import { profileReadingTheme, profileTheme, type Profile } from "../../src/features/profiles/model/profile";
import { themeVars } from "../../src/theme/applyTheme";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const READER = read("src/features/reader/Reader.tsx");

/** A هيئة whose two palettes disagree about everything, so no token can be ambiguous. */
const twoPalettes = (): Profile => {
  const data = defaultProfileData();
  data.theme.library.colors = { ...data.theme.library.colors,
    paperBg: "#101828", surfaceBg: "#070B14", chromeBg: "#1B2436", text: "#E8EDF7", muted: "#93A4C4", accent: "#E2965C" };
  data.theme.library.dark = true;
  data.theme.reading.colors = { ...data.theme.reading.colors,
    paperBg: "#FDF2F8", surfaceBg: "#F7E6EF", chromeBg: "#FBE9F3", text: "#2B2521", muted: "#6B5A63", accent: "#B4557E" };
  data.theme.reading.dark = false;
  data.type.ui = "Inter";
  data.type.arabic = "notoNaskh";
  data.type.latin = "literata";
  return { id: "u:t", name: "T", iconKind: "seal", iconRef: null, data } as unknown as Profile;
};

describe("colour: the book's ink and the interface's ink are different tokens", () => {
  const p = twoPalettes();
  const ui = themeVars(profileTheme(p));
  const page = themeVars(profileReadingTheme(p));

  it("the two palettes really do disagree, or nothing below proves anything", () => {
    expect(ui["--text"]).not.toBe(page["--text"]);
    expect(ui["--muted"]).not.toBe(page["--muted"]);
    expect(ui["--paper-bg"]).not.toBe(page["--paper-bg"]);
  });

  it("the reader's own variables are derived from the INTERFACE palette", () => {
    expect(READER).toContain("const chromeTheme = uiProfile ? profileTheme(uiProfile) : null;");
    expect(READER).toContain("...(chromeTheme ? themeVars(chromeTheme) : {})");
  });

  it("and never from the reading one — the line that caused both regressions", () => {
    // The comment above the fix names the old expression on purpose — it is the record of what went
    // wrong — so this asks about CODE: no line may SPREAD the reading palette into those variables.
    const code = READER.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("...themeVars(readingTheme)");
    expect(code).not.toMatch(/\.\.\.themeVars\(\s*readingTheme\s*\)/);
  });

  it("the interface ink is the هيئة's interface text, not the book's", () => {
    expect(ui["--text"]).toBe("#E8EDF7");
    expect(page["--text"]).toBe("#2B2521");
  });

  it("the page and its desk are still the READING palette, so the page did not move", () => {
    expect(READER).toContain('"--reader-page": readingTheme.colors.paperBg');
    expect(READER).toContain("readingTheme.colors.surfaceBg");
  });

  it("the texture floor is measured against the palette the panel now wears", () => {
    // It guarantees contrast for the panel's OWN colours, so measuring it against the page would
    // have guaranteed the wrong thing.
    expect(READER).toContain("textureVars(uiProfile.data.texture, chromeTheme.colors, deskScrim)");
  });
});

describe("faces: the interface font and the book's faces are different tokens", () => {
  const p = twoPalettes();

  it("the reader names ONLY the interface font, and from `type.ui`", () => {
    expect(READER).toContain('"--ui-font": chromeStack(uiProfile.data.type.ui)');
    // The book's two faces are never named on `.reader-root`; they belong to the injected CSS below.
    expect(READER).not.toContain('"--ar-font"');
    expect(READER).not.toContain('"--book-font"');
  });

  it("the book's faces live in a sheet injected INTO the book, which no interface rule can see", () => {
    // `buildFontFaceCss` is the sheet the faces actually travel in — `<style data-sard-fonts>` inside
    // the book's own document. It is the only place a book face is named.
    const css = buildFontFaceCss({ ...ARABIC_DEFAULTS, arabicFont: "notoNaskh", latinFont: "inter" });
    expect(css).toContain("@font-face");
    expect(css).not.toContain("--ui-font");
  });

  it("changing a book face changes that sheet and nothing of the interface's", () => {
    const a = buildFontFaceCss({ ...ARABIC_DEFAULTS, arabicFont: "amiri" });
    const b = buildFontFaceCss({ ...ARABIC_DEFAULTS, arabicFont: "notoNaskh" });
    expect(a).not.toBe(b);                       // the book's face really changed
    expect(a.includes("--ui-font")).toBe(false); // and neither sheet touches the interface's
    expect(b.includes("--ui-font")).toBe(false);
    expect(p.data.type.ui).toBe("Inter");        // which is the هيئة's own, set separately
  });

  it("changing the interface font cannot reach the book's faces", () => {
    const q = twoPalettes();
    q.data.type.ui = "Cairo";
    expect(q.data.type.arabic).toBe("notoNaskh");
    expect(q.data.type.latin).toBe("literata");
    // The interface font reaches exactly one variable, and the book's sheet is built from the
    // reading style, which has no opinion about it.
    expect(buildFontFaceCss(ARABIC_DEFAULTS)).not.toContain("Cairo");
    expect(buildReadingCss(ARABIC_DEFAULTS, undefined, undefined, "rtl")).not.toContain("Cairo");
  });
});

describe("what a هيئة saves keeps the two apart", () => {
  it("the interface face, the two book faces and both palettes are separate fields", () => {
    const d = defaultProfileData();
    expect(Object.keys(d.type)).toEqual(expect.arrayContaining(["ui", "arabic", "latin"]));
    expect(Object.keys(d.theme)).toEqual(expect.arrayContaining(["library", "reading"]));
    // Editing one cannot reach the other: they are not the same object.
    const p = twoPalettes();
    p.data.theme.reading.colors.text = "#010203";
    expect(p.data.theme.library.colors.text).toBe("#E8EDF7");
    p.data.type.arabic = "cairo";
    expect(p.data.type.ui).toBe("Inter");
  });
});
