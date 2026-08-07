// RESILIENCE-1 / WP-7 — HOSTILE INPUT. These tests exist to BREAK the sanitiser.
//
// Written adversarially: each case is an attempt to smuggle a banned declaration past the filter
// using CSS syntax the naive reading of the rules does not anticipate. A test that fails here is a
// finding, not a defect in the test — the sanitiser is assumed wrong until it survives.
//
// Attack surface being probed:
//   * whitespace and case variation inside `!important`
//   * comments used as token separators inside property names and values
//   * escapes and encodings in property names
//   * calc() hiding an absolute or negative length
//   * strings and url() containing the characters the parser splits on
//   * pathological sizes

import { describe, expect, it } from "vitest";
import { keepDeclaration, sanitiseBookCss } from "../../src/reader-engine/cssSanitiser";

/** Declaration values only — selectors legitimately contain hyphen-digit and `:` (see corpus test). */
const values = (out: string) => out.split(/[{}]/).filter((_, i) => i % 2 === 1).join(";");

describe("HOSTILE — !important smuggling", () => {
  it("blocks the plain form", () => {
    expect(keepDeclaration("text-align", "right !important", "p")).toBe(false);
  });

  it("blocks it in any case", () => {
    expect(keepDeclaration("text-align", "right !IMPORTANT", "p")).toBe(false);
    expect(keepDeclaration("text-align", "right !ImPoRtAnT", "p")).toBe(false);
  });

  // FINDING-1 (FIXED): CSS permits whitespace between the bang and the keyword.
  it("blocks it with a SPACE after the bang — CSS permits this", () => {
    // `! important` is valid CSS and means exactly the same thing.
    expect(keepDeclaration("text-align", "right ! important", "p")).toBe(false);
  });

  // FINDING-1 (FIXED): comments are a legal token separator here too.
  it("blocks it with a comment used as the separator", () => {
    // Comments are stripped by the sheet-level pass, but a value handed straight to
    // keepDeclaration (as the block filter does) may still carry one.
    expect(keepDeclaration("text-align", "right !/**/important", "p")).toBe(false);
  });

  // FINDING-1 (FIXED), verified end-to-end through a whole sheet.
  it("blocks it end-to-end through a whole sheet", () => {
    for (const v of ["right !important", "right ! important", "right !IMPORTANT"]) {
      const out = sanitiseBookCss(`body { text-align: ${v}; }`, "sanitised");
      expect(values(out), v).not.toMatch(/!\s*important/i);
    }
  });
});

describe("HOSTILE — absolute and negative lengths in disguise", () => {
  it("blocks an absolute length inside calc()", () => {
    expect(keepDeclaration("margin", "calc(100% - 80pt)", "p")).toBe(false);
    expect(keepDeclaration("font-size", "calc(1em + 4px)", "p")).toBe(false);
  });

  it("blocks a negative produced by calc()", () => {
    expect(keepDeclaration("margin-left", "calc(0px - 80px)", "p")).toBe(false);
  });

  it("blocks an absolute length in any case", () => {
    expect(keepDeclaration("margin", "10PT", "p")).toBe(false);
    expect(keepDeclaration("margin", "10Pt", "p")).toBe(false);
  });

  it("blocks a negative written with a space after the sign", () => {
    // `- 5em` is not valid CSS, but a malformed sheet can contain it and must not slip through.
    expect(keepDeclaration("margin", "- 5em", "p")).toBe(false);
  });

  it("blocks scientific notation", () => {
    expect(keepDeclaration("margin", "-1e2px", "p")).toBe(false);
  });
});

describe("HOSTILE — property-name obfuscation", () => {
  it("drops an unknown property, however it is spelled", () => {
    // Fail-closed: only names in KEEP survive, so an escape or encoding cannot smuggle anything in.
    for (const p of ["\\6D argin", "MARGIN\\0", "mar gin", "màrgin", "margin​"]) {
      expect(keepDeclaration(p, "-80pt", "p"), p).toBe(false);
    }
  });

  it("is case-insensitive for the names it DOES know", () => {
    expect(keepDeclaration("FONT-STYLE", "italic", "p")).toBe(true);
    expect(keepDeclaration("Margin", "1em", "p")).toBe(true);
  });

  it("drops a banned property regardless of case", () => {
    expect(keepDeclaration("POSITION", "absolute", "p")).toBe(false);
    expect(keepDeclaration("Line-Height", "3", "p")).toBe(false);
  });
});

describe("HOSTILE — parser confusion", () => {
  it("a semicolon inside a string cannot corrupt the following declaration", () => {
    const out = sanitiseBookCss(`p { content: "a;b"; font-style: italic; }`, "sanitised");
    expect(out).toContain("font-style: italic");
    expect(out).not.toContain("content");
  });

  it("a colon inside a url() cannot be read as a property separator", () => {
    const out = sanitiseBookCss(`p { background: url(http://x/y.png); font-style: italic; }`, "sanitised");
    expect(out).not.toContain("background");
    expect(out).toContain("font-style: italic");
  });

  it("a brace inside a string cannot end the rule early", () => {
    const out = sanitiseBookCss(`p[x="}"] { margin: -80pt; } q { font-style: italic; }`, "sanitised");
    expect(values(out)).not.toMatch(/-\s*80/);
    expect(out).toContain("font-style: italic");
  });

  it("an unterminated comment does not swallow the whole sheet silently", () => {
    // Whatever it does, it must not throw and must not emit the banned declaration.
    const out = sanitiseBookCss(`p { font-style: italic; } /* q { margin: -80pt; }`, "sanitised");
    expect(values(out)).not.toMatch(/-\s*80/);
  });

  it("nested at-rules are dropped with everything inside them", () => {
    const css = `@media screen { @supports (x:y) { p { margin: -80pt; } } }`;
    expect(sanitiseBookCss(css, "sanitised")).toBe("");
  });

  it("an at-rule that LOOKS like a normal rule is still dropped", () => {
    expect(sanitiseBookCss(`@page :first { margin: 2cm; }`, "sanitised")).toBe("");
  });
});

describe("HOSTILE — pathological input", () => {
  it("survives a very large sheet without throwing or hanging", () => {
    const big = "p { font-style: italic; margin: -80pt; }\n".repeat(20_000);
    const t0 = Date.now();
    const out = sanitiseBookCss(big, "sanitised");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(values(out)).not.toMatch(/-\s*80/);
  });

  it("survives deeply nested braces", () => {
    const deep = "@media a {".repeat(500) + "p{margin:-80pt}" + "}".repeat(500);
    expect(() => sanitiseBookCss(deep, "sanitised")).not.toThrow();
  });

  it("survives a single enormous declaration value", () => {
    const css = `p { font-style: ${"a".repeat(200_000)}; }`;
    expect(() => sanitiseBookCss(css, "sanitised")).not.toThrow();
  });

  it("handles a sheet that is only whitespace or punctuation", () => {
    for (const css of ["", " ", "\n\n", ";;;;", "{}{}{}", "@@@", "/**/"]) {
      expect(() => sanitiseBookCss(css, "sanitised"), JSON.stringify(css)).not.toThrow();
    }
  });
});
