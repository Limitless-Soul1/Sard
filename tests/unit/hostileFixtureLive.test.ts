// RESILIENCE-1 / WP-7 — FINDING-6's guard: a hostile fixture must actually MATCH something.
//
// FINDING-6: the corpus book `word-generated--unknown-title` carries the declaration the entire
// sanitiser rationale was built on — `margin: 0 369pt 0 -84.8pt` — on selector `.block_`, which
// MEASURED `hostileMatchedElements: 0`. It matches nothing. The most dangerous-looking CSS in the
// corpus is unreachable, and every conclusion drawn from "it didn't clip" was therefore worthless.
//
// The generated `hostile-css` fixture was checked against the same failure and is SOUND: it targets
// `.para` and `.chap`, which are exactly the classes `buildChapter` emits. These tests pin that
// correspondence, because it is invisible — the CSS lives in one part of generate.mjs and the markup
// in another, and nothing but this file connects them. If either side is renamed, the fixture
// silently becomes a dead selector and every hostile test built on it starts passing vacuously.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — .mjs helper, intentionally untyped
import { zipEntries, zipRead, decodeXml } from "../lib/epub-read.mjs";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "epub");

/** The class selectors a stylesheet targets, and the classes the chapter markup actually carries. */
function fixtureParts(file: string) {
  const buf = readFileSync(join(FIXTURES, file));
  const entries = zipEntries(buf) ?? [];
  const cssEntry = entries.find((e: { name: string }) => /\.css$/i.test(e.name));
  const chapter = entries.find((e: { name: string }) => /c1\.xhtml$/i.test(e.name));
  const css = (cssEntry ? decodeXml(zipRead(buf, cssEntry)) : "") as string;
  const html = (chapter ? decodeXml(zipRead(buf, chapter)) : "") as string;
  const targeted = [...css.matchAll(/(^|[\s,{}])\.([a-zA-Z][\w-]*)/g)].map((m) => m[2]);
  const present = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  return { css, html, targeted: [...new Set(targeted)], present: [...new Set(present)] };
}

describe("FINDING-6 guard — hostile-css targets real elements", () => {
  const f = fixtureParts("hostile-css.epub");

  it("the fixture carries a stylesheet and a chapter at all", () => {
    expect(f.css.length).toBeGreaterThan(50);
    expect(f.html.length).toBeGreaterThan(50);
  });

  it("EVERY class the stylesheet targets exists in the markup", () => {
    // The exact check FINDING-6 would have failed on. A targeted class with no matching element
    // means that rule can never reach computed style, so any test asserting it was neutralised
    // proves nothing at all.
    expect(f.targeted.length).toBeGreaterThan(0);
    for (const cls of f.targeted) {
      expect(f.present, `.${cls} is targeted by the CSS but no element carries it`).toContain(cls);
    }
  });

  it("still carries the dangerous declarations it claims to", () => {
    // Guards the other direction: a fixture that matches everything but has been softened would
    // also pass vacuously.
    expect(f.css).toMatch(/-84\.8pt/);          // negative horizontal margin — the load-bearing case
    expect(f.css).toMatch(/position:\s*absolute/);
    expect(f.css).toMatch(/font-size:\s*9pt/);  // absolute size
    expect(f.css).toMatch(/@page/);
  });

  it("the negative margin is on the HORIZONTAL axis", () => {
    // MEASURED (FINDING-3): RAWY-195 hardens `margin-block` — vertical — with !important, so a
    // vertical hostile margin is neutralised by Sard regardless of the sanitiser. Only the
    // horizontal axis is unprotected, so only a horizontal negative margin exercises the sanitiser's
    // one genuinely load-bearing rule. `margin: 0 369pt 0 -84.8pt` = top/bottom 0, left -84.8pt. ✓
    const m = f.css.match(/margin:\s*([^;]+);/);
    expect(m, "the fixture must declare a shorthand margin").toBeTruthy();
    const parts = (m![1] ?? "").trim().split(/\s+/);
    expect(parts.length, "a 4-value shorthand, so the axis is unambiguous").toBe(4);
    expect(parts[0], "top must be harmless — the vertical axis is already hardened").toBe("0");
    expect(parts[3], "LEFT carries the negative — this is the unprotected axis").toMatch(/^-/);
  });
});

describe("FINDING-6 guard — the benign control is genuinely benign", () => {
  const f = fixtureParts("benign-css.epub");

  it("targets real elements too", () => {
    for (const cls of f.targeted) expect(f.present).toContain(cls);
  });

  it("contains nothing the sanitiser should strip", () => {
    // The control's job is to prove the sanitiser is not simply a shredder. If it ever acquires an
    // absolute or negative length, a passing "the control survives" test would be meaningless.
    expect(f.css).not.toMatch(/\b\d*\.?\d+\s*(pt|px|cm|mm|in|pc)\b/);
    expect(f.css).not.toMatch(/-\s*\d/);
    expect(f.css).not.toContain("!important");
  });
});
