#!/usr/bin/env node
// RESILIENCE-1 — the paged-mode fragmentation harness.
//
// WHAT IT GUARDS. In paged mode foliate columnises a section by making `<html>` a multicol container
// with a fixed height (`paginator.js` `columnize()`), and every "page" is one column. That only works
// if the section's content can actually be FRAGMENTED across columns.
//
// Per CSS Fragmentation, an element that establishes a scroll container is MONOLITHIC — it cannot be
// split across columns. So a single `overflow: hidden` on `<body>` silently converts the whole
// chapter into one unbreakable box: it renders in column 1, everything past the first screen is
// clipped, and the section reports one page when it needs dozens.
//
// Sard emitted exactly that, paged-mode only, from `injectedCss.ts`:
//     html, body { height: 100%; overflow: hidden; }
// Measured on the real app before the fix: a 26-paragraph chapter laid out to 20,331 px inside a
// 624 px box, ONE column, ~97% of the chapter unreachable. With the `body` half removed: 23 columns.
//
// This harness reproduces the geometry in real Chromium — jsdom cannot answer a fragmentation
// question — and is the reason the regression cannot come back silently.
//
// Usage:  node tests/harness/pagination.mjs        (exit 0 iff every case matches its expectation)

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** foliate's own `columnize()` output, transcribed from paginator.js. */
const FOLIATE_COLUMNIZE = `
  html {
    box-sizing: border-box !important;
    column-width: 688px !important;
    column-gap: 56px !important;
    column-fill: auto !important;
    height: 624px !important;
    padding: 0 28px !important;
    overflow: hidden !important;
    overflow-wrap: break-word !important;
    position: static !important; border: 0 !important; margin: 0 !important;
    max-height: none !important; max-width: none !important;
    min-height: none !important; min-width: none !important;
  }
  body { max-height: none !important; max-width: none !important; margin: 0 !important; }
`;

/**
 * Each case is ONE body rule. `expectFragmented` is what a correct reader requires: a chapter longer
 * than the page must occupy more than one column.
 */
export const CASES = {
  "sard-v1.1.0": {
    body: "html, body { height: 100%; overflow: hidden; }",
    expectFragmented: false,
    why: "THE DEFECT. `overflow:hidden` on body makes it a scroll container, which CSS cannot fragment — the whole chapter lands in column 1 and is clipped.",
  },
  "fixed-no-body-overflow": {
    body: "html { height: 100%; overflow: hidden; } body { height: 100%; }",
    expectFragmented: true,
    why: "THE FIX. `html` keeps the deterministic box (and foliate sets it anyway); `body` stops being a scroll container, so the chapter fragments into pages.",
  },
  "body-overflow-alone": {
    body: "body { overflow: hidden; }",
    expectFragmented: false,
    why: "Control: overflow is the whole cause — height plays no part.",
  },
  "body-height-alone": {
    body: "html, body { height: 100%; }",
    expectFragmented: true,
    why: "Control: `height:100%` on body is harmless. Only `overflow` breaks fragmentation.",
  },
};

const page = (bodyRule) => `<!doctype html><meta charset=utf-8>
<style>${FOLIATE_COLUMNIZE}${bodyRule}</style>
<div id=out>pending</div>
<script>
  // A chapter far longer than one page — the shape every real chapter has.
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('p');
    p.textContent = 'Paragraph ' + i + '. ' + 'Alice was beginning to get very tired of sitting by her sister on the bank. '.repeat(4);
    frag.appendChild(p);
  }
  document.body.appendChild(frag);
  // Measured SYNCHRONOUSLY after forcing layout. requestAnimationFrame is unreliable under headless
  // virtual time — it silently failed to fire for one case and reported "no result", which looked
  // like a failing assertion rather than a harness problem.
  void document.body.offsetHeight;
  try {
    const ps = [...document.body.querySelectorAll('p')];
    const lefts = [...new Set(ps.map(p => Math.round(p.getBoundingClientRect().left)))];
    const maxTop = Math.max(...ps.map(p => Math.round(p.getBoundingClientRect().top)));
    document.getElementById('out').textContent = 'RESULT ' + JSON.stringify({
      columns: lefts.length, fragmented: lefts.length > 1, maxTop,
    });
  } catch (e) {
    document.getElementById('out').textContent = 'RESULT ' + JSON.stringify({ error: String(e) });
  }
</scr` + `ipt>`;

function findEdge() {
  return EDGE_CANDIDATES.find((p) => existsSync(p));
}

export async function runPaginationHarness({ quiet = false } = {}) {
  const edge = findEdge();
  if (!edge) return { skipped: "Microsoft Edge not found — the harness needs a Chromium binary" };

  const dir = mkdtempSync(join(tmpdir(), "sard-pagination-"));
  const rows = [];
  try {
    for (const [name, c] of Object.entries(CASES)) {
      const file = join(dir, `${name}.html`);
      writeFileSync(file, page(c.body), "utf8");
      const { stdout } = await execFileAsync(
        edge,
        ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000", "--dump-dom", `file://${file.replace(/\\/g, "/")}`],
        { maxBuffer: 8 << 20 },
      );
      const m = stdout.match(/RESULT (\{[^<]*\})/);
      const r = m ? JSON.parse(m[1]) : { error: "no result" };
      rows.push({ name, ...r, expected: c.expectFragmented, pass: r.fragmented === c.expectFragmented, why: c.why });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!quiet) {
    console.log(`\n  Paged-mode column-fragmentation harness\n`);
    for (const r of rows) {
      console.log(`    ${r.pass ? "✓" : "✗"} ${r.name.padEnd(24)} columns=${String(r.columns).padStart(3)}  fragmented=${String(r.fragmented).padEnd(5)} (expected ${r.expected})`);
      console.log(`        ${r.why}`);
    }
    console.log("");
  }
  return { rows, allPass: rows.every((r) => r.pass) };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("pagination.mjs")) {
  const out = await runPaginationHarness();
  if (out.skipped) {
    console.log(`\n  ⓘ SKIPPED — ${out.skipped}\n`);
    process.exit(0);
  }
  process.exit(out.allPass ? 0 : 1);
}
