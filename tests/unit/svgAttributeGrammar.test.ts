// NO SVG PRESENTATION ATTRIBUTE MAY CARRY A CSS FUNCTION — anywhere in the desktop.
//
// `iconSizing.test.ts` guards the one component where this went wrong. This guards the CLASS. A
// presentation attribute (`width="…"`, `stroke-width="…"`, `r="…"`, `fill="…"`) is parsed with the
// property's own grammar, not as a CSS declaration; on the Chromium/WebView2 runtimes Sard's gate
// admits, `var()` in a length attribute is rejected, and a rejected attribute is ABSENT. For a
// dimension that means the container's size; for a stroke it means the SVG default. Nothing throws,
// nothing logs, and a current engine — which accepts the form — shows nothing wrong.
//
// So the rule is a source rule: an SVG attribute holds a literal (a number, a unit, a keyword, a
// colour, `currentColor`), and anything computed goes in `style` or a class. Every `.tsx` under `src/`
// is scanned. The scan is deliberately broad — any `<svg …>` or child-shape attribute in the list
// whose value contains `var(`, `calc(`, `clamp(`, `min(`, `max(`, `env(` or `color-mix(` fails —
// because a false positive costs a minute and a false negative costs a release.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) ? [p] : [];
  });

// Attributes SVG defines as presentation attributes with a length, number, paint or list grammar.
const ATTRS = "width|height|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|dx|dy|stroke-width|strokeWidth|stroke|fill|stroke-dasharray|strokeDasharray|stroke-dashoffset|strokeDashoffset|font-size|fontSize|opacity|fill-opacity|fillOpacity|stroke-opacity|strokeOpacity|transform|d|points";
const FUNCTIONS = /(var|calc|clamp|min|max|env|color-mix)\(/;

/** Every `attr="…"` / `attr={"…"}` / `attr={`…`}` / `attr={cond ? "…" : "…"}` on an svg-ish tag whose literal contains a CSS function. */
function offenders(src: string): string[] {
  const out: string[] = [];
  // Prose is not code: the comments that EXPLAIN this rule quote the forbidden forms verbatim, and
  // JSX comments sit inside the element. Strip block and line comments before looking.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  // Only inside svg markup: from an `<svg` to its closing `</svg>` (a component that IS an svg starts at `<svg`).
  for (const block of code.matchAll(/<svg[\s\S]*?<\/svg>/g)) {
    const re = new RegExp(`\\b(${ATTRS})=(\\{[^}]*\\}|"[^"]*")`, "g");
    for (const m of block[0].matchAll(re)) {
      if (FUNCTIONS.test(m[2])) out.push(`${m[1]}=${m[2].slice(0, 60)}`);
    }
  }
  return out;
}

describe("svg presentation attributes hold literals, never CSS functions", () => {
  const files = walk(SRC).filter((f) => !/features-mobile/.test(f));

  it("scans a meaningful tree", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => /components[\\/]Icon\.tsx$/.test(f))).toBe(true);
  });

  it("finds none in the desktop source", () => {
    const hits: string[] = [];
    for (const f of files) {
      const found = offenders(readFileSync(f, "utf8"));
      for (const h of found) hits.push(`${relative(SRC, f).replace(/\\/g, "/")}: ${h}`);
    }
    expect(hits, "computed values belong in style or a class, not in a presentation attribute").toEqual([]);
  });

  it("would have caught the 1.3.0 icon form", () => {
    // The shipped form, verbatim. If this ever stops being flagged, the scan is broken.
    const shipped = `<svg viewBox="0 0 24 24" width={SIZE[size]} height={"var(--icon-md)"} strokeWidth={filled ? undefined : "var(--icon-stroke)"}><path d="M1 1" /></svg>`;
    expect(offenders(shipped).length).toBe(2);
  });
});
