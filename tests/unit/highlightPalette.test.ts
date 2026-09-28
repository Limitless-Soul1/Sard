// THE SWATCH AND THE MARK ARE ONE PALETTE — the book's reading one, never the Library's.
//
// THE DEFECT THESE CLOSE. `useHl()` read `useTheme.themeId`, which is the LIBRARY (app chrome) theme
// by its own definition in `theme/store.ts`. The mark on the page is painted by `FoliateController`
// from `this.theme.colors.highlight`, and `this.theme` is the READING theme the Reader hands it. So
// the eight swatches in the floating selection toolbar and the eight pens that actually draw came
// from two different palettes.
//
// MEASURED IN THE RUNNING READER before the fix: Library `ivory`, book `ink`. The swatch rendered
// #E8C36A — ivory's amber — while the page painted #F4C430, ink's. A هيئة whose two halves carry
// different pens is not exotic: `SARD-THEME/1` carries `highlight` on each palette and a designed
// appearance routinely differs between them.
//
// The fix resolves nothing new. The Reader already computes `readingTheme` and passes that SAME
// object to `ctrl.applyTheme`; it now also hands it to the layer, so the two cannot disagree.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RECIPE_FENCE, RECIPE_FORMAT } from "../../src/features/profiles/model/exchange/recipe";
import { readPastedDesign } from "../../src/features/profiles/model/exchange/read";
import { profileReadingTheme, profileTheme } from "../../src/features/profiles/model/profile";
import { defaultProfileData } from "../../src/features/profiles/store";
import { THEMES } from "../../src/theme/themes";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LAYER = read("src/features/reader/AnnotationLayer.tsx");
const PANEL = read("src/features/reader/AnnotationsPanel.tsx");
const READER = read("src/features/reader/Reader.tsx");
const CONTROLLER = read("src/reader-engine/FoliateController.ts");
/** Source with comment lines stripped — the prose names the old expression on purpose. */
const code = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

/** A هيئة whose two halves carry visibly different pens — the case the defect turned on. */
const twoPalettes = () => {
  const d = defaultProfileData();
  d.theme.library.colors = { ...d.theme.library.colors, highlight: { ...d.theme.library.colors.highlight, amber: "#AAAAAA" } };
  d.theme.reading.colors = { ...d.theme.reading.colors, highlight: { ...d.theme.reading.colors.highlight, amber: "#BB5500" } };
  return { id: "u:t", name: "T", iconKind: "seal", iconRef: null, data: d } as never;
};

describe("Library palette A, book reading palette B — the toolbar shows B", () => {
  it("the two halves really do differ, or nothing below proves anything", () => {
    const p = twoPalettes();
    expect(profileTheme(p).colors.highlight.amber).toBe("#AAAAAA");
    expect(profileReadingTheme(p).colors.highlight.amber).toBe("#BB5500");
  });

  it("the swatches read the palette handed in, not a theme they resolve themselves", () => {
    expect(code(LAYER)).toContain("export function useHl() {");
    expect(code(LAYER)).toContain("return useReadingTheme().colors.highlight;");
    // The one expression that caused it may never come back.
    expect(code(LAYER)).not.toMatch(/useTheme\(\(s\) => s\.themeId\)/);
    expect(code(PANEL)).not.toMatch(/useTheme\(\(s\) => s\.themeId\)/);
  });

  it("and the Reader hands the layer the SAME object it gives the controller", () => {
    // Identity, not equality: one palette cannot drift from itself.
    expect(code(READER)).toContain("<AnnotationLayer ctrlRef={ctrlRef} readingTheme={readingTheme}");
    expect(code(READER)).toContain("readingTheme={readingTheme}");
    expect(code(READER)).toContain("ctrlRef.current?.applyTheme(readingTheme,");
  });

  it("the mark on the page is still painted from that same field", () => {
    // Untouched by this change — it is the definition the swatch was brought into line with.
    expect(code(CONTROLLER)).toContain("this.theme?.colors.highlight");
  });
});

describe("the custom-colour picker previews against the page it will sit on", () => {
  it("takes its dark and its paper from the reading palette", () => {
    expect(code(LAYER)).toContain("const reading = useReadingTheme();");
    expect(code(LAYER)).toContain("const themeDark = reading.dark;");
    expect(code(LAYER)).toContain("const themePaper = reading.colors.paperBg;");
    expect(code(LAYER)).not.toMatch(/resolveTheme\(themeId\)\.colors\.paperBg/);
  });

  it("and still composites through the shared resolver rather than its own arithmetic", () => {
    expect(code(LAYER)).toContain("resolveHighlightInk({ ink: inkHex, dark: themeDark, paper: themePaper, alpha })");
  });
});

describe("the annotations panel", () => {
  it("has no palette hook of its own any more — it imports the one", () => {
    expect(code(PANEL)).toContain('import { ColorRow, ReadingPalette, useHl } from "./AnnotationLayer";');
    expect(code(PANEL)).not.toContain("function useHl()");
  });

  it("and is given the book's palette by the Reader", () => {
    expect(code(PANEL)).toContain("readingTheme: Theme;");
    expect(code(PANEL)).toContain("<ReadingPalette.Provider value={readingTheme}>");
  });
});

describe("what must NOT have changed", () => {
  it("the Library's own surfaces still wear the Library's palette", () => {
    // In the Library the library palette IS the right answer; these were never the defect.
    for (const f of ["src/features/library/archive/SlipWall.tsx", "src/features/library/archive/Cabinet.tsx",
                     "src/features/library/archive/SlipSheet.tsx"]) {
      expect(read(f), f).not.toContain("ReadingPalette");
    }
    expect(read("src/features/deposit/DepositMap.tsx"))
      .toContain("resolveTheme(useTheme((s) => s.themeId)).colors.highlight");
  });

  it("the sixteen shipped themes are untouched", () => {
    const src = read("src/theme/themes.ts");
    expect(src).toContain('amber: "#E8C36A"');   // the shared default set
    expect(THEMES.ivory.colors.highlight.amber).toBe("#E8C36A");
    expect(THEMES.ink.colors.highlight.amber).toBe("#F4C430");
  });

  it("no colour is hard-coded into the toolbar", () => {
    const swatch = code(LAYER).slice(code(LAYER).indexOf("hl-pop-swatch") - 400, code(LAYER).indexOf("hl-pop-swatch") + 400);
    expect(swatch).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(swatch).toContain("background: hl[c]");
  });
});

describe("a designed palette is used exactly as supplied", () => {
  it("a SARD-THEME/1 recipe's pens reach the reading palette unaltered", () => {
    const PENS = { amber: "#112233", marigold: "#223344", coral: "#334455", rose: "#445566",
                   purple: "#556677", sky: "#667788", teal: "#778899", green: "#8899AA" };
    const r = readPastedDesign("```" + RECIPE_FENCE + "\n" + JSON.stringify({
      format: RECIPE_FORMAT, name: "n",
      palette: { reading: { dark: false, paperBg: "#F1E6D6", text: "#2A2230", accent: "#9C5A3C", highlight: { ...PENS } } },
    }) + "\n```");
    if (!r.ok) throw new Error("refused");
    expect(r.out.data.theme.reading.colors.highlight).toEqual(PENS);
    // And that is the set the toolbar will show, because it reads the reading palette.
    const p = { id: "u:d", name: "D", iconKind: "seal", iconRef: null, data: r.out.data } as never;
    expect(profileReadingTheme(p).colors.highlight).toEqual(PENS);
  });
});
