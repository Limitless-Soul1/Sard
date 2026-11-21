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
import { readFileSync } from "node:fs";
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

  it("keeps padding inside the book's own boxes only while it cannot squeeze the line", () => {
    // A summary box's `padding: 0.9em 1.2em` is the book's look; a column-wide padding is not.
    expect(keepDeclaration("padding", "0.9em 1.2em", "div.summary-box")).toBe(true);
    expect(keepDeclaration("padding-top", "1.5em", "div.meta")).toBe(true);
    expect(keepDeclaration("padding-left", "2pt", "p")).toBe(false);
    expect(keepDeclaration("padding", "-1em", "p")).toBe(false);
    expect(keepDeclaration("padding", "0 9em", "p")).toBe(false);
    expect(keepDeclaration("padding-inline", "40%", "p")).toBe(false);
    expect(keepDeclaration("padding", "calc(1em + 4em)", "p")).toBe(false);
  });

  it("never lets a book shape the page's own box — that measure is the reader's", () => {
    // Measured with a book's sheet passed through untouched: `body { padding: 1.5em 2em; max-width: 38em }`
    // squeezed the text into a narrow strip in a narrow column.
    for (const sel of ["body", "html", ":root", "*", "html > body", "body.calibre", "p, body"]) {
      expect(keepDeclaration("padding", "1.5em 2em", sel), sel).toBe(false);
      expect(keepDeclaration("margin", "1em 1.5em", sel), sel).toBe(false);
      expect(keepDeclaration("max-width", "90%", sel), sel).toBe(false);
      expect(keepDeclaration("background-color", "#000", sel), sel).toBe(false);
    }
    // …while the same declarations on the book's own boxes stand, and so does the body's alignment.
    for (const sel of ["tbody", "body p", "div.body", "*.x"]) {
      expect(keepDeclaration("margin", "1em", sel), sel).toBe(true);
    }
    expect(keepDeclaration("text-align", "right", "body")).toBe(true);
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
    // A box may have its own ground (a summary box, a table header), as a plain colour; the page may not.
    expect(keepDeclaration("background-color", "#fdf8f0", "div.summary-box")).toBe(true);
    expect(keepDeclaration("background", "#3a2a0a", "th")).toBe(true);
    expect(keepDeclaration("background-color", "#fff", "body")).toBe(false);
    expect(keepDeclaration("background", "url(x.png)", "div")).toBe(false);
    expect(keepDeclaration("background", "linear-gradient(red, blue)", "div")).toBe(false);
    expect(keepDeclaration("background", "#fff url(x.png) no-repeat", "div")).toBe(false);
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
    expect(sanitiseBookCss("p { padding: 2pt; height: 50%; }", "sanitised")).toBe("");
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

describe("the book's look — what other readers show, held to the same safety", () => {
  const out = (css: string) => sanitiseBookCss(css, "sanitised");

  it("draws a rule or a frame with its width named, never measured", () => {
    expect(out("h1 { border-bottom: 1px solid #ccc; }")).toBe("h1 { border-bottom: thin solid #ccc }");
    expect(out(".box { border-right: 3px solid #c8a96e; }")).toBe(".box { border-right: medium solid #c8a96e }");
    expect(out(".x { border-top: 0.5em double; }")).toBe(".x { border-top: thick double }");
    expect(out(".x { border-width: 1px 2pt; }")).toBe(".x { border-width: thin medium }");
    expect(out(".x { border: thin dotted currentColor; }")).toBe(".x { border: thin dotted currentColor }");
    expect(keepDeclaration("border-left", "-2px solid red", "p")).toBe(false);
    expect(keepDeclaration("border-radius", "6px", "p")).toBe(false);
    expect(keepDeclaration("border-radius", "0.3em", "p")).toBe(true);
  });

  it("keeps a faded label, but never so faint it cannot be read", () => {
    expect(keepDeclaration("opacity", "0.5", ".label")).toBe(true);
    expect(keepDeclaration("opacity", "35%", ".label")).toBe(true);
    expect(keepDeclaration("opacity", "0.1", ".label")).toBe(false);
    expect(keepDeclaration("opacity", "0", ".label")).toBe(false);
    expect(keepDeclaration("opacity", "2", ".label")).toBe(false);
  });

  it("lets a span become a block, and nothing more exotic", () => {
    expect(keepDeclaration("display", "block", "span.title")).toBe(true);
    expect(keepDeclaration("display", "inline-block", "span")).toBe(true);
    // Hidden text would still be read aloud, so a book cannot hide it.
    expect(keepDeclaration("display", "none", ".count")).toBe(false);
    expect(keepDeclaration("display", "flex", "div")).toBe(false);
    expect(keepDeclaration("display", "block", "body")).toBe(false);
  });

  it("sizes a box only as a share of the column", () => {
    expect(keepDeclaration("width", "80%", ".item")).toBe(true);
    expect(keepDeclaration("width", "auto", ".item")).toBe(true);
    expect(keepDeclaration("max-width", "none", ".item")).toBe(true);
    expect(keepDeclaration("width", "120%", ".item")).toBe(false);
    expect(keepDeclaration("width", "300px", ".item")).toBe(false);
    expect(keepDeclaration("width", "20em", ".item")).toBe(false);
  });

  it("filters an inline style attribute instead of erasing it", () => {
    // The engine hands each style="…" to the same hook: a list of declarations, no braces.
    expect(out("text-align:center; margin-left:-40pt; color:#aaa")).toBe("text-align: center; color: #aaa");
    expect(out("font-style:italic; font-size:0.85em; font-family:Georgia,serif;")).toBe("font-style: italic; font-size: 0.85em");
    expect(out("position:absolute; left:-9999px")).toBe("");
    expect(out("text-align: right !important")).toBe("");
  });

  it("a book styled like the reported ones keeps its look and nothing measured", () => {
    // The shapes of two real Arabic books: a centred title page with faded lines, a chapter header with
    // a rule under it, a framed summary box, and a page box the reader must keep.
    const sheet = `
      body { font-family: Georgia, serif; direction: rtl; text-align: right; margin: 0 auto; max-width: 38em;
             padding: 1.5em 2em; line-height: 2; color: #1a1a1a; background: #fff; }
      .titlepage { text-align: center; margin-top: 20%; padding: 3em 2em; }
      .titlepage .main-title { font-size: 2.4em; font-weight: bold; letter-spacing: 0.04em; }
      .titlepage .ornament { font-size: 1.6em; opacity: 0.4; margin: 1.5em 0; }
      .meta { font-size: 0.85em; opacity: 0.5; border-top: 1px solid currentColor; padding-top: 1.5em; }
      .chapter-header { text-align: center; margin: 2em 0 2.5em 0; border-bottom: 1px solid currentColor; }
      .chapter-label { font-size: 0.78em; opacity: 0.5; }
      .summary-box { margin-top: 2em; padding: 0.9em 1.2em; border-right: 3px solid #c8a96e; background: #fdf8f0; }
      .summary-title { font-weight: bold; color: #8B6914; display: block; }
      .button { display: block; width: 60%; margin: 3em auto; border: 2px solid #c8a050; border-radius: 6px; }`;
    const css = out(sheet);
    const values = css.split(/[{}]/).filter((_, i) => i % 2 === 1).join(";");
    expect(values).not.toMatch(/\b\d*\.?\d+\s*(pt|px|cm|mm|in|pc)\b/i);
    expect(values).not.toMatch(/-\s*\d/);
    expect(css).not.toContain("!important");
    // the page box is the reader's: only the body's alignment survives
    expect(css).toContain("body { text-align: right }");
    // the look is the book's
    for (const kept of [
      ".titlepage { text-align: center; margin-top: 20%; padding: 3em 2em }",
      ".titlepage .ornament { font-size: 1.6em; opacity: 0.4; margin: 1.5em 0 }",
      ".meta { font-size: 0.85em; opacity: 0.5; border-top: thin solid currentColor; padding-top: 1.5em }",
      ".chapter-header { text-align: center; margin: 2em 0 2.5em 0; border-bottom: thin solid currentColor }",
      ".summary-box { margin-top: 2em; padding: 0.9em 1.2em; border-right: medium solid #c8a96e; background: #fdf8f0 }",
      ".summary-title { font-weight: bold; color: #8B6914; display: block }",
      ".button { display: block; width: 60%; margin: 3em auto; border: medium solid #c8a050 }",
    ]) expect(css).toContain(kept);
  });

  it("names a width without touching the colour beside it", () => {
    expect(out(".x { border: 1px solid #1a1a1a; }")).toBe(".x { border: thin solid #1a1a1a }");
    expect(out(".x { border: 2px solid #12a; }")).toBe(".x { border: medium solid #12a }");
    expect(out(".x { border: 1px solid rgb(10,20,30); }")).toBe(".x { border: thin solid rgb(10,20,30) }");
  });

  it("parses on an older WebKitGTK: no regex lookbehind in the module", () => {
    // A lookbehind is a syntax error to an older JavaScriptCore, and this module is in the Linux bundle.
    const src = readFileSync("src/reader-engine/cssSanitiser.ts", "utf8");
    expect(src).not.toMatch(/\(\?<[=!]/);
  });
});
