// THE PREPARED SEQUENCE MUST BE THE SPOKEN SEQUENCE.
//
// Cross-chapter preparation keys audio on the opening units of the NEXT section, read from that
// section's raw document. The reader speaks the RENDERED section, where a hide toggle makes certain
// blocks invisible and read-aloud segmentation therefore skips them. If the two disagree by even one
// unit, every prepared unit is one behind the queue: the first prepared unit is swept unused and the
// lead gate still pays a full synthesis.
//
// MEASURED before this was closed — a fixture with a numbered first line, both toggles varied:
//     hideFirstLine off               8 of 8 sections aligned
//     hideFirstLine on                6 of 8 SHIFTED BY ONE
//     hideFirstLine + hideChapterTitles on   7 of 8 SHIFTED BY ONE
// and in a real day's listening, 6 of 6 chapter boundaries shifted.
//
// What is pinned here is the thing that makes the two agree: ONE list of hidden-block selectors,
// used both to build the rule that hides them in the reading frame and to drop them from the raw
// document before it is segmented. A second, hand-kept copy is exactly how they drifted.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARABIC_DEFAULTS,
  buildReadingCss,
  hiddenBlockSelectors,
  HIDDEN_BY_CHAPTER_TITLES,
  HIDDEN_BY_FIRST_LINE,
  type BookThemeFlags,
} from "../../src/reader-engine/injectedCss";
import { THEMES } from "../../src/theme/themes";

const flags = (o: Partial<BookThemeFlags>): BookThemeFlags => ({ overrideBookColor: false, hideChapterTitles: false, hideFirstLine: false, ...o });

describe("hidden blocks · one list, two uses", () => {
  it("names nothing while both toggles are off", () => {
    expect(hiddenBlockSelectors(flags({}))).toEqual([]);
    expect(hiddenBlockSelectors(undefined)).toEqual([]);
  });

  it("names the book's own headings when chapter titles are hidden", () => {
    expect(hiddenBlockSelectors(flags({ hideChapterTitles: true }))).toEqual(HIDDEN_BY_CHAPTER_TITLES);
    expect(HIDDEN_BY_CHAPTER_TITLES).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
  });

  it("names the detected first line — and only an unrevealed one — when that toggle is on", () => {
    expect(hiddenBlockSelectors(flags({ hideFirstLine: true }))).toEqual(HIDDEN_BY_FIRST_LINE);
    // a line the reader chose to reveal is spoken, so preparation must keep it too
    expect(HIDDEN_BY_FIRST_LINE[0]).toContain(":not(.sard-revealed)");
  });

  it("names both when both are on", () => {
    expect(hiddenBlockSelectors(flags({ hideChapterTitles: true, hideFirstLine: true })))
      .toEqual([...HIDDEN_BY_CHAPTER_TITLES, ...HIDDEN_BY_FIRST_LINE]);
  });

  it("every selector on the list is one the reading CSS actually hides", () => {
    // The list would be worthless if the CSS hid something else: the raw document would keep a block
    // the reader never hears, and the shift would come straight back.
    for (const f of [flags({ hideChapterTitles: true }), flags({ hideFirstLine: true }), flags({ hideChapterTitles: true, hideFirstLine: true })]) {
      const css = buildReadingCss(ARABIC_DEFAULTS, THEMES.ivory, f);
      for (const sel of hiddenBlockSelectors(f)) {
        expect(css, `${sel} is on the list but the CSS does not hide it`).toContain(sel);
      }
    }
  });

  it("a toggle that is off hides nothing, in the CSS or on the list", () => {
    const css = buildReadingCss(ARABIC_DEFAULTS, THEMES.ivory, flags({}));
    expect(css).not.toContain(".sard-chapter-heading:not(.sard-revealed)");
    expect(hiddenBlockSelectors(flags({}))).toHaveLength(0);
  });
});

describe("the preparation path follows the rendered decisions", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "src/reader-engine/FoliateController.ts"), "utf8");
  const raw = src.slice(src.indexOf("async rawSectionFirstUnits"), src.indexOf("hasNextSection()"));

  it("runs the same heading detector, with the same input the rendered section gets", () => {
    // `.sard-chapter-heading` exists only because this ran; without it the hide below sees nothing.
    expect(raw).toContain("markInBodyHeading(doc, sectionTocLabel(this.view, index))");
    const rendered = src.match(/markInBodyHeading\(doc, sectionTocLabel\(view, index\)\)/);
    expect(rendered, "the rendered path must still call it the same way").not.toBeNull();
  });

  it("drops exactly the blocks the shared list names, and nothing else", () => {
    expect(raw).toContain("hiddenBlockSelectors(this.flags)");
    expect(raw).toMatch(/for \(const el of Array\.from\(doc\.querySelectorAll\(sel\)\)\) el\.remove\(\)/);
    // no second opinion about what is hidden — in the CODE; the prose above it may explain freely
    const code = raw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\bh1\b|sard-chapter-heading|hideFirstLine|hideChapterTitles/);
  });

  it("segments with the same walk the rendered chapter uses", () => {
    expect(raw).toContain("this.unitsForRoot(doc.body, doc, lang)");
  });

  it("cannot throw its way out of preparing — a section it cannot mark is still segmented", () => {
    expect(raw).toMatch(/catch \{[^}]*\}/);
  });
});
