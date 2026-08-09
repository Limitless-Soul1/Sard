// RESILIENCE-1 — paged-mode pagination.
//
// THE BUG THIS PINS. In paged mode Sard injected, into every section:
//
//     html, body { height: 100%; overflow: hidden; }
//
// `overflow: hidden` makes `<body>` a scroll container, and per CSS Fragmentation a scroll container
// is MONOLITHIC — it cannot be split across columns. foliate paginates by columnising `<html>` and
// treating each column as a page, so this silently collapsed every chapter into ONE unbreakable box:
// it rendered in column 1 and everything past the first screen was clipped.
//
// MEASURED on the real app, Alice chapter I (26 paragraphs): laid out to 20,331 px inside a 624 px
// box, ONE column, ~97 % of the chapter unreachable, and the section reported 3 pages when it needed
// ~23. With the `body` half of the rule removed: 23 columns.
//
// It also caused the reported TOC defect. `paginator.js #scrollToRect` maps an anchor to a page with
// `Math.floor(rect.left / size)`; with no fragmentation every anchor in a section shares the same
// `left`, so every TOC entry pointing into one section resolved to the SAME page. In Alice the first
// three entries all point into one front-matter document, so two of them appeared to do nothing.
//
// A separate end-to-end check proves the CSS mechanism in real Chromium. This file guards the one
// thing a unit test can guard: that Sard never emits the rule again.

import { describe, it, expect } from "vitest";
import { buildReadingCss, ARABIC_DEFAULTS, LATIN_DEFAULTS, type ReadingStyle } from "../../src/reader-engine/injectedCss";

const paged = (base: ReadingStyle): ReadingStyle => ({ ...base, flowMode: "paged" });
const scrolled = (base: ReadingStyle): ReadingStyle => ({ ...base, flowMode: "scrolled" });

/** Collect the declarations that apply to a bare `body` selector (not `body *`, not `:root:root body`). */
function bodyDeclarations(css: string): string[] {
  const out: string[] = [];
  // Match `…{ … }` blocks whose selector list contains a standalone `body`.
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    const hitsBareBody = selectors.some((s) => s === "body" || /^html\s*,?\s*$/.test(s) === false && s === "body");
    const hitsHtmlBodyGroup = selectors.some((s) => s === "body");
    if (hitsBareBody || hitsHtmlBodyGroup) out.push(m[2].trim());
  }
  return out;
}

describe("paged mode must not make <body> a scroll container", () => {
  for (const [name, base] of [
    ["Latin defaults", LATIN_DEFAULTS],
    ["Arabic defaults", ARABIC_DEFAULTS],
  ] as const) {
    it(`${name}: no bare \`body\` rule sets overflow`, () => {
      // THE REGRESSION GUARD. Any `overflow` on a bare `body` selector re-breaks fragmentation —
      // `hidden`, `clip`, `auto` and `scroll` all establish a scroll container.
      const css = buildReadingCss(paged(base));
      for (const decls of bodyDeclarations(css)) {
        expect(decls, `a \`body\` rule must not set overflow:\n${decls}`).not.toMatch(/(^|;)\s*overflow\s*:/);
      }
    });
  }

  it("does not emit the exact v1.1.0 rule in paged mode", () => {
    const css = buildReadingCss(paged(LATIN_DEFAULTS));
    expect(css.replace(/\s+/g, " ")).not.toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden/i);
  });

  it("still gives the section a deterministic box via <html>", () => {
    // The rule existed for a reason (RAWY-04: no stray paginated scrollbar). `html` must keep it —
    // dropping BOTH halves would trade one defect for another.
    const css = buildReadingCss(paged(LATIN_DEFAULTS)).replace(/\s+/g, " ");
    expect(css).toMatch(/html\s*\{[^}]*overflow:\s*hidden/i);
    expect(css).toMatch(/html\s*\{[^}]*height:\s*100%/i);
  });

  it("scrolled mode is untouched — it must set no height/overflow on html or body", () => {
    // BACKWARD COMPATIBILITY. Scrolled is the default flow and demonstrably works; the fix must not
    // reach it. foliate makes the section full-height and the CONTAINER scrolls, so forcing a height
    // or an overflow here would clip the scroll (the RAWY-25 note).
    const css = buildReadingCss(scrolled(LATIN_DEFAULTS)).replace(/\s+/g, " ");
    expect(css).not.toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden/i);
    expect(css).not.toMatch(/html\s*\{[^}]*height:\s*100%/i);
  });

  it("the paged and scrolled sheets differ ONLY in the section-box rule", () => {
    // A guard on the blast radius: if a future edit makes flow mode change anything else in this
    // sheet, that is a separate decision and should be visible here.
    const p = buildReadingCss(paged(LATIN_DEFAULTS));
    const s = buildReadingCss(scrolled(LATIN_DEFAULTS));
    const strip = (css: string) => css.replace(/html\s*\{[^}]*\}/g, "").replace(/\s+/g, " ").trim();
    expect(strip(p)).toBe(strip(s));
  });
});
