// RESILIENCE-1 / WP-7A — the sanitiser against REAL corpus stylesheets.
//
// The unit tests beside this file are synthetic: they prove each table rule in isolation. This one
// runs the sanitiser over every stylesheet the corpus actually ships (14 books, ~55 KB of CSS) and
// asserts the ONE property that makes stage 7.1 safe to enable later — no absolute or negative
// length, and no `!important`, can survive into the frame.
//
// It is a property test, not a golden-output test, deliberately: pinning exact output would break on
// any corpus change and would tell us nothing about safety. What must never change is the invariant.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sanitiseBookCss } from "../../src/reader-engine/cssSanitiser";
// @ts-expect-error — .mjs helper, intentionally untyped
import { zipEntries, zipRead, decodeXml } from "../lib/epub-read.mjs";

// `SARD_CORPUS` or nothing. No hardcoded default: a fallback bakes one machine's layout into the
// repository and fails everywhere else, including every CI runner.
const CORPUS = process.env.SARD_CORPUS ?? "";
const available = CORPUS !== "" && existsSync(CORPUS);

/**
 * Just the declaration VALUES from sanitised output.
 *
 * The invariant is about what reaches the CASCADE — i.e. values — and asserting it against the whole
 * output text was WRONG: a CSS selector legitimately contains a hyphen followed by a digit. Measured
 * in the corpus: `#chapter-14 blockquote` and `p.nth-last-child-2 time` both matched a naive
 * `-\d` scan, failing the property test on output that was perfectly correct.
 *
 * Caught only by running against real stylesheets; no synthetic case would have produced a selector
 * like that. Odd chunks of a `{}` split are declaration blocks, even chunks are selectors.
 */
function values(out: string): string {
  return out
    .split(/[{}]/)
    .filter((_, i) => i % 2 === 1)
    .join(";");
}

/** Every stylesheet in every corpus EPUB, as { book, name, css }. */
function corpusStylesheets(): { book: string; name: string; css: string }[] {
  const out: { book: string; name: string; css: string }[] = [];
  for (const f of readdirSync(CORPUS).filter((x) => /\.epub$/i.test(x))) {
    const buf = readFileSync(join(CORPUS, f));
    const entries = zipEntries(buf) ?? [];
    for (const e of entries.filter((x: { name: string }) => /\.css$/i.test(x.name))) {
      const css = decodeXml(zipRead(buf, e)) as string | null;
      if (css) out.push({ book: f, name: e.name, css });
    }
  }
  return out;
}

describe.skipIf(!available)("WP-7A — real corpus stylesheets", () => {
  // `skipIf` skips the TESTS, but this callback still runs during collection — so reading the corpus
  // here unconditionally threw ENOENT on a machine without it, and the suite failed instead of
  // skipping. The read has to be guarded, not just the tests it feeds.
  const sheets = available ? corpusStylesheets() : [];

  it("finds stylesheets to test (guards against a vacuous pass)", () => {
    expect(sheets.length).toBeGreaterThan(10);
  });

  it("mode `off` erases every real sheet", () => {
    for (const s of sheets) {
      expect(sanitiseBookCss(s.css, "off"), `${s.book} :: ${s.name}`).toBe("");
    }
  });

  it("NO absolute length survives sanitisation of any real sheet", () => {
    // The clipping guarantee, over real data rather than a constructed example.
    for (const s of sheets) {
      const out = sanitiseBookCss(s.css, "sanitised");
      expect(values(out), `${s.book} :: ${s.name}`).not.toMatch(/\b\d*\.?\d+\s*(pt|px|cm|mm|in|pc)\b/i);
    }
  });

  it("NO negative length survives", () => {
    for (const s of sheets) {
      const out = sanitiseBookCss(s.css, "sanitised");
      expect(values(out), `${s.book} :: ${s.name}`).not.toMatch(/-\s*\d/);
    }
  });

  it("NO !important survives", () => {
    // Measured in the corpus: at least one book ships `body { text-align: right !important }`.
    for (const s of sheets) {
      expect(sanitiseBookCss(s.css, "sanitised"), `${s.book} :: ${s.name}`).not.toContain("!important");
    }
  });

  it("no at-rule survives", () => {
    for (const s of sheets) {
      expect(sanitiseBookCss(s.css, "sanitised"), `${s.book} :: ${s.name}`).not.toContain("@");
    }
  });

  it("never throws on a real sheet", () => {
    for (const s of sheets) {
      expect(() => sanitiseBookCss(s.css, "sanitised"), `${s.book} :: ${s.name}`).not.toThrow();
    }
  });

  it("output is always balanced CSS", () => {
    // A malformed emission would corrupt the whole cascade rather than just its own rule.
    for (const s of sheets) {
      const out = sanitiseBookCss(s.css, "sanitised");
      const open = (out.match(/\{/g) ?? []).length;
      const close = (out.match(/\}/g) ?? []).length;
      expect(open, `${s.book} :: ${s.name}`).toBe(close);
    }
  });

  it("KEEPS something from at least one real book — the sanitiser is not just a shredder", () => {
    // Without this, every assertion above would pass trivially on empty output.
    const kept = sheets.filter((s) => sanitiseBookCss(s.css, "sanitised").length > 0);
    expect(kept.length).toBeGreaterThan(0);
  });
});
