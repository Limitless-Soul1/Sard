// THE PREVIEW PAGE IS TWO BOXES, AND EVERYTHING ON IT BELONGS TO ONE OF THEM.
//
// `BookFace` states the arrangement in its own words: the sheet is sized, then a text host is inset
// inside it — "Two boxes, each with one job, and no arithmetic to get wrong." `.pf-page` is the sheet
// at `pageGeo.sheet`; `.pf-page-body` is the host at `pageGeo.text`, centred.
//
// The running head was in neither. It was a bare child of the sheet with no measure of its own, so it
// took the sheet's full width while the body it heads was inset — and being RTL, its text sat flush
// against the paper's right edge with the column's right edge some 130px inside it. Measured in the
// running editor at (0, 101) 861px wide, against a body ending near 730. That is why it was reported
// as a small strange line floating above the page rather than as a chapter title: it was not aligned
// with anything.
//
// This guards the property, not the pixels: the head and the body take their width from the SAME
// number and centre the same way, so no future edit can move one without the other.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "..", "src/features/profiles/editor/stage/BookFace.tsx"),
  "utf8",
);

/** the inline style object attached to the element carrying `cls` */
const styleOf = (cls: string): string => {
  const at = SRC.indexOf(`className="${cls}"`);
  if (at < 0) return "";
  const from = SRC.indexOf("style={{", at);
  if (from < 0) return "";
  // to the matching close of the style object literal
  let depth = 0;
  for (let i = from + 7; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(from, i + 1);
    }
  }
  return "";
};

describe("the preview's running head belongs to the text column", () => {
  it("the specimen itself is still there", () => {
    // It is a type specimen: it shows the chapter-title line set in the profile's own Arabic face.
    // The reported symptom was its PLACEMENT, and removing it would delete the only place that face
    // is shown at heading weight.
    expect(SRC).toContain("الفصل الثالث · في المجالس");
    expect(SRC).toMatch(/className="pf-page-label"/);
  });

  it("and it is set in the profile's Arabic book face, not the interface font", () => {
    expect(styleOf("pf-page-label")).toContain("bookFaceCss(profile.data.type.arabic)");
  });

  it("the head and the body take their width from the same one number", () => {
    const head = styleOf("pf-page-label");
    expect(head).toContain("pageGeo.text");
    // `.pf-page-body` carries a template-literal className, so it is matched on its own terms.
    const bodyAt = SRC.indexOf("pf-page-body");
    const bodyStyle = SRC.slice(bodyAt, bodyAt + 400);
    expect(bodyStyle).toContain("pageGeo.text");
  });

  it("and both centre themselves inside the sheet", () => {
    expect(styleOf("pf-page-label")).toContain('marginInline: "auto"');
    const bodyAt = SRC.indexOf("pf-page-body");
    expect(SRC.slice(bodyAt, bodyAt + 400)).toContain('marginInline: "auto"');
  });

  it("the head does not take the SHEET's measure, which is what put it outside the column", () => {
    const head = styleOf("pf-page-label");
    expect(head).not.toContain("pageGeo.sheet");
  });

  it("the sheet is still the sheet, and still the only thing sized to it", () => {
    // If this ever fails, the two boxes have been collapsed into one and the note in BookFace that
    // explains why they are separate no longer describes the code.
    expect(styleOf("pf-page")).toContain("pageGeo.sheet");
  });
});

describe("the preview's running head is sized by the same control as the body", () => {
  // It held a flat `10.5px` in the stylesheet while everything else on that page is stated in the
  // READER's pixels and reduced once by the miniature's zoom. So the body answered the text-size
  // control and the head could not: measured across the 0.8-2.5 range the body ran 12.8 -> 40px, the
  // head stayed at 10.5, and their relationship drifted 3.12x — 0.82 down to 0.26.
  //
  // What the design actually chose was a PROPORTION: 10.5 against the reader's base 16.

  it("the ratio is named once, from the base the body is built on", () => {
    expect(SRC).toMatch(/export const LABEL_RATIO = 10\.5 \/ READER_BASE_PX;/);
  });

  it("and the head is that ratio of the body's own expression", () => {
    const head = styleOf("pf-page-label");
    expect(head).toContain("READER_BASE_PX * AR.zoom * LABEL_RATIO");
    // the body, for comparison — the same two terms without the proportion
    const bodyAt = SRC.indexOf("const arStyle");
    expect(SRC.slice(bodyAt, bodyAt + 300)).toContain("READER_BASE_PX * AR.zoom");
  });

  it("the stylesheet no longer names a size for it", () => {
    // A flat px there would win nothing (inline beats the sheet) but would leave two sources for one
    // decision, which is how the first value drifted out of the design in the first place.
    const css = readFileSync(
      join(import.meta.dirname, "..", "..", "src/styles/profiles.css"), "utf8");
    const at = css.indexOf(".pf-page-label {");
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).not.toMatch(/font-size|font:\s*\d/);
    expect(rule).toContain("font-weight: 600");
  });

  it("and the gap beneath it is proportional, so a bigger head does not crowd the body", () => {
    const css = readFileSync(
      join(import.meta.dirname, "..", "..", "src/styles/profiles.css"), "utf8");
    const at = css.indexOf(".pf-page-label {");
    const rule = css.slice(at, css.indexOf("}", at));
    // 22 / 10.5 — the proportion the design drew, not a new number.
    expect(rule).toMatch(/margin-bottom:\s*2\.095em/);
  });
});
