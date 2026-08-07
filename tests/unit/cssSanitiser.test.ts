// RESILIENCE-1 / WP-7A — the sanitiser, tested before it is wired to anything.
//
// The staged rollout depends on this file: the sanitiser must be provably correct BEFORE the CSP
// token makes book stylesheets reachable at all. Every case below is either a rule from the approved
// keep/neutralise table or a defect measured in a real corpus book.
//
// THE ONE THAT MATTERS MOST. The Word/Calibre book carries `margin: 0 369pt 0 -84.8pt`. In a ~600 px
// column the negative left margin pushes content outside the box, where foliate's `overflow: hidden`
// clips it away silently. If exactly one test in this file is ever allowed to fail, it is not this one.

import { describe, expect, it } from "vitest";
import { keepDeclaration, sanitiseBookCss } from "../../src/reader-engine/cssSanitiser";

describe("WP-7A — mode `off` is the shipping default and must erase everything", () => {
  it("returns nothing at all, whatever the sheet contains", () => {
    expect(sanitiseBookCss("p { font-weight: bold; }", "off")).toBe("");
    expect(sanitiseBookCss("body { margin: -80pt; }", "off")).toBe("");
    expect(sanitiseBookCss("", "off")).toBe("");
  });
});

describe("WP-7A — mode `raw` passes through untouched", () => {
  it("is byte-identical to its input", () => {
    const css = "p { margin: 0 369pt 0 -84.8pt; }";
    expect(sanitiseBookCss(css, "raw")).toBe(css);
  });
});

describe("WP-7A — the clipping rule (data loss, not cosmetics)", () => {
  it("REJECTS the real Word margin that clips content out of the column", () => {
    expect(keepDeclaration("margin", "0 369pt 0 -84.8pt", "p")).toBe(false);
    expect(sanitiseBookCss("p { margin: 0 369pt 0 -84.8pt; }", "sanitised")).toBe("");
  });

  it("rejects EVERY negative margin, in every unit", () => {
    for (const v of ["-1pt", "-0.5em", "-2%", "-10px", "0 0 0 -3rem"]) {
      expect(keepDeclaration("margin-left", v, "p"), v).toBe(false);
    }
  });

  it("rejects absolute margins even when positive", () => {
    for (const v of ["10pt", "2cm", "0.5in", "24px", "3mm"]) {
      expect(keepDeclaration("margin", v, "p"), v).toBe(false);
    }
  });

  it("KEEPS relative margins, which cannot escape the column", () => {
    for (const v of ["1em", "0 0 1.5em", "5%", "0"]) {
      expect(keepDeclaration("margin", v, "p"), v).toBe(true);
    }
  });

  it("drops padding entirely — it has the same escape geometry and no authorial value", () => {
    expect(keepDeclaration("padding-left", "2em", "p")).toBe(false);
  });
});

describe("WP-7A — what a book legitimately owns (emphasis and voice)", () => {
  it("keeps the declarations that are being lost today", () => {
    for (const [p, v] of [
      ["font-style", "italic"], ["font-weight", "700"], ["font-variant", "small-caps"],
      ["text-transform", "uppercase"], ["text-decoration", "underline"], ["text-align", "center"],
    ] as const) {
      expect(keepDeclaration(p, v, "p"), `${p}: ${v}`).toBe(true);
    }
  });

  it("emits them as valid CSS", () => {
    const out = sanitiseBookCss("em.x { font-style: italic; padding: 4pt; }", "sanitised");
    expect(out).toBe("em.x { font-style: italic }");
  });
});

describe("WP-7A — the reader's controls stay authoritative", () => {
  it("rejects absolute font-size but keeps relative", () => {
    expect(keepDeclaration("font-size", "12pt", "p")).toBe(false);
    expect(keepDeclaration("font-size", "14px", "p")).toBe(false);
    expect(keepDeclaration("font-size", "1.2em", "p")).toBe(true);
    expect(keepDeclaration("font-size", "110%", "p")).toBe(true);
  });

  it("drops the properties RAWY-195 hardened deliberately", () => {
    // line-height, font-family and direction are the reader's, not the book's.
    for (const p of ["line-height", "font-family", "direction", "zoom"]) {
      expect(keepDeclaration(p, "anything", "p"), p).toBe(false);
    }
  });

  it("never lets a book's !important outrank the reader", () => {
    // Measured in the corpus: لورد الغوامض ships `body { text-align: right !important }`.
    expect(keepDeclaration("text-align", "right !important", "body")).toBe(false);
  });

  it("lets a book colour a WORD but not the page", () => {
    expect(keepDeclaration("color", "#a00", "span.red")).toBe(true);
    expect(keepDeclaration("color", "#a00", "body")).toBe(false);
    expect(keepDeclaration("color", "#a00", "html")).toBe(false);
    expect(keepDeclaration("background-color", "#fff", "p")).toBe(false);
  });
});

describe("WP-7A — the engine keeps ownership of layout and pagination", () => {
  it("drops everything that escapes the column", () => {
    for (const p of ["position", "float", "width", "height", "max-width", "overflow"]) {
      expect(keepDeclaration(p, "anything", "div"), p).toBe(false);
    }
  });

  it("drops column and page-break control", () => {
    for (const p of ["column-count", "column-gap", "page-break-before", "break-inside"]) {
      expect(keepDeclaration(p, "2", "div"), p).toBe(false);
    }
  });

  it("drops @page, @media, @font-face and @import wholesale", () => {
    const css = `
      @import url("other.css");
      @page { margin: 2cm; }
      @media screen { p { font-weight: bold; } }
      @font-face { font-family: X; src: url(x.ttf); }
      p { font-style: italic; }`;
    const out = sanitiseBookCss(css, "sanitised");
    expect(out).toBe("p { font-style: italic }");
  });
});

describe("WP-7A — the parser survives real stylesheets", () => {
  it("ignores braces inside strings and url()", () => {
    const css = `p[title="a{b}c"] { font-style: italic; } q { font-weight: bold; }`;
    const out = sanitiseBookCss(css, "sanitised");
    expect(out).toContain("font-style: italic");
    expect(out).toContain("font-weight: bold");
  });

  it("strips comments, including ones containing braces", () => {
    const out = sanitiseBookCss("/* { not a rule } */ p { font-style: italic; }", "sanitised");
    expect(out).toBe("p { font-style: italic }");
  });

  it("tolerates a malformed sheet without throwing", () => {
    for (const css of ["p {", "}", "p { color", "", "@media {", 'p { content: "unclosed }']) {
      expect(() => sanitiseBookCss(css, "sanitised")).not.toThrow();
    }
  });

  it("emits no rule for a block whose declarations were all removed", () => {
    // An empty `p { }` in the output would be harmless but noisy; more importantly its absence
    // proves the filter ran rather than passing the block through.
    expect(sanitiseBookCss("p { padding: 2pt; width: 50%; }", "sanitised")).toBe("");
  });
});

describe("WP-7A — the property that makes stage 7.1 safe", () => {
  it("no pt/cm/in/px or negative length can EVER reach the frame in sanitised mode", () => {
    // The blanket assertion, over a sheet built from every hostile pattern measured in the corpus.
    const hostile = `
      body { margin: 0 369pt 0 -84.8pt; text-align: right !important; }
      div.a { position: absolute; left: -200px; width: 800px; }
      p.b { font-size: 12pt; text-indent: -30pt; padding: 1in; }
      @page { size: A4; margin: 2cm; }
      p.c { font-style: italic; margin: 1em 0; }`;
    const out = sanitiseBookCss(hostile, "sanitised");
    expect(out).not.toMatch(/\b\d*\.?\d+\s*(pt|px|cm|mm|in|pc)\b/i);
    expect(out).not.toMatch(/-\s*\d/);
    expect(out).not.toContain("!important");
    // …while the one legitimate declaration in that sheet survives.
    expect(out).toContain("font-style: italic");
    expect(out).toContain("margin: 1em 0");
  });
});
