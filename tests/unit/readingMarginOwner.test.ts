// WHO OWNS THE READING MARGIN IN SCROLLED FLOW — and why the answer decides whether a reader can start
// a selection at the beginning of a line.
//
// THE BUG THIS PINS. The page margin used to be an inset on the reading HOST (`.page-host`,
// `inset-inline: var(--page-margin)`), so the blank strip beside the text belonged to the APP document,
// not to the book. The book's iframe therefore ended exactly where its text ended, and a press in that
// strip landed on the parent document: no caret was placed, and because the whole gesture belonged to
// the parent, holding the button and dragging into the text could not recover it either. In a
// right-to-left book that strip sits where every line STARTS, which is the natural place to begin a
// selection — so the failure was reachable by aiming at the first character.
//
// MEASURED in the running app (Arabic book, scrolled flow, 1400x900): the frame spanned 170..1245 and
// the line's start edge WAS 1245. A press at x<=1244 placed a caret and the parent window never saw it;
// at x>=1245 the parent saw the press and the selection stayed None. Every drag begun at or outside the
// edge ended with no Range.
//
// THE FIX, in two halves that only work together: in scrolled flow the host spans the sheet
// (`global.css`) and the SAME margin is applied inside the book as the body's inline padding
// (`injectedCss`). The reading content box is unchanged — 1075px either way, measured — so the text
// keeps its position, its measure and its wrap points; what changes is that the margin is now part of
// the reading surface, and a press there places a caret on the nearest line.
//
// Runtime evidence covers the behaviour. This file guards the pairing: neither half may be removed on
// its own, because one without the other either brings the dead strip back or doubles the margin.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReadingCss, ARABIC_DEFAULTS, LATIN_DEFAULTS } from "../../src/reader-engine/injectedCss";

const globalCss = readFileSync(resolve(__dirname, "../../src/styles/global.css"), "utf8");

/** The `padding-inline` the injected sheet gives the book's own `body`, in px, or null for none. */
const bodyPaddingInline = (css: string): number | null => {
  const m = css.match(/body\s*\{\s*padding-inline:\s*(\d+(?:\.\d+)?)px;?\s*\}/);
  return m ? Number(m[1]) : null;
};

describe("the reading margin belongs to the book in scrolled flow", () => {
  it("gives the book's body the page margin as inline padding", () => {
    const css = buildReadingCss({ ...ARABIC_DEFAULTS, marginPx: 56, flowMode: "scrolled" });
    expect(bodyPaddingInline(css)).toBe(56);
  });

  it("follows the reader's margin setting rather than a fixed number", () => {
    for (const px of [0, 24, 120]) {
      const css = buildReadingCss({ ...LATIN_DEFAULTS, marginPx: px, flowMode: "scrolled" });
      expect(bodyPaddingInline(css)).toBe(px);
    }
  });

  it("never emits a negative padding from a nonsense margin", () => {
    const css = buildReadingCss({ ...ARABIC_DEFAULTS, marginPx: -40, flowMode: "scrolled" });
    expect(bodyPaddingInline(css)).toBe(0);
  });

  it("leaves PAGED flow alone — there the host inset is also the column geometry", () => {
    const css = buildReadingCss({ ...ARABIC_DEFAULTS, marginPx: 56, flowMode: "paged" });
    expect(bodyPaddingInline(css)).toBeNull();
  });

  it("puts the padding on body, not html, where foliate's inline !important would beat it", () => {
    const css = buildReadingCss({ ...ARABIC_DEFAULTS, marginPx: 56, flowMode: "scrolled" });
    expect(css).not.toMatch(/html\s*\{[^}]*padding-inline:/);
  });
});

describe("the reading host gives that margin up in scrolled flow", () => {
  it("still insets the host by the page margin in the general case", () => {
    // Paged flow and PDFs keep this: it is the geometry foliate columnizes into.
    expect(globalCss).toMatch(/\.page-host\s*\{[^}]*inset-inline:\s*var\(--page-margin/);
  });

  it("drops the inset for scrolled flow, so the frame spans the sheet", () => {
    expect(globalCss).toMatch(/\.reader-root\.flow-scrolled\s+\.page-host\s*\{\s*inset-inline:\s*0;?\s*\}/);
  });

  it("keeps the scrolled rule AFTER the general one, or it would not win", () => {
    const general = globalCss.search(/\.page-host\s*\{[^}]*inset-inline:\s*var\(--page-margin/);
    const scrolled = globalCss.search(/\.reader-root\.flow-scrolled\s+\.page-host\s*\{\s*inset-inline:\s*0/);
    expect(general).toBeGreaterThan(-1);
    expect(scrolled).toBeGreaterThan(general);
  });
});

// ---- and therefore: a margin change has to reach the sheet ----------------------------------------
//
// THE BUG THIS PINS. Because the two halves above put the margin INSIDE the book in scrolled flow, the
// margin stopped being a chrome-only value there — and the controller's style diff still classed it as
// one. `marginPx` was in neither the PAINT nor the GEOMETRY key list, on a comment that called it
// "chrome-side ... touches neither", so no margin change ever asked for the sheet to be rewritten.
//
// MEASURED in the running reader, scrolled flow, dragging the control 8 → 120 → 8 → 160: the desk's
// `--page-margin` followed every step, `.page-host` stayed 1060px wide throughout (its inset is zeroed
// here, by the rule above), and the book frame kept the `padding-inline: 40px` it had been opened with.
// The number moved and the page did not. Reopening the book rebuilt the sheet, which is exactly why it
// "only worked after leaving the book".
describe("a margin change reaches the page it is supposed to move", () => {
  const withMargin = (base: typeof ARABIC_DEFAULTS, marginPx: number, flowMode: "paged" | "scrolled") =>
    buildReadingCss({ ...base, marginPx, flowMode }, undefined, undefined);

  it("changes the emitted sheet in scrolled flow", () => {
    // If these were equal the sheet would not carry the margin, and re-injecting could not help.
    expect(withMargin(ARABIC_DEFAULTS, 8, "scrolled")).not.toBe(withMargin(ARABIC_DEFAULTS, 160, "scrolled"));
    expect(withMargin(ARABIC_DEFAULTS, 8, "scrolled")).toContain("padding-inline: 8px");
    expect(withMargin(ARABIC_DEFAULTS, 160, "scrolled")).toContain("padding-inline: 160px");
  });

  it("leaves the sheet byte-identical in paged flow, where the host carries it", () => {
    // This is what makes the controller's gate right rather than merely convenient: re-injecting here
    // would buy a reflow and a repaint for a stylesheet that did not change.
    expect(withMargin(LATIN_DEFAULTS, 8, "paged")).toBe(withMargin(LATIN_DEFAULTS, 160, "paged"));
  });

  it("and the controller treats the margin as geometry in exactly that case", () => {
    const src = readFileSync(resolve(__dirname, "../../src/reader-engine/FoliateController.ts"), "utf8");
    // The decision has to see the flow, which is why it cannot live in the flat key list.
    expect(src).toContain('const marginGeom = style.flowMode !== "paged" && prev.marginPx !== style.marginPx;');
    expect(src).toContain("const geom = marginGeom || GEOMETRY_STYLE_KEYS.some((k) => prev[k] !== style[k]);");
    // And it must NOT have been "fixed" by putting it in the list, which would reflow paged reading too.
    const list = src.slice(src.indexOf("const GEOMETRY_STYLE_KEYS"), src.indexOf("// RAWY-200"));
    expect(list).not.toContain("marginPx");
  });
});
