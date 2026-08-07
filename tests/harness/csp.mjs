#!/usr/bin/env node
// WP-0 (RESILIENCE-1) — the CSP / book-stylesheet harness.
//
// WHAT IT IS FOR. WP-7 turns on the book's own stylesheet, which today never enters the cascade.
// The investigation isolated the cause to a single missing token by reproducing Sard's exact model
// — a parent document with Sard's real CSP header, creating a `blob:` iframe with
// `sandbox="allow-same-origin"` that links a `blob:` stylesheet — and varying ONE factor at a time.
// That experiment is the evidence WP-7 rests on, so it lives here as a runnable harness rather than
// as a paragraph in a report.
//
// WHY REAL CHROMIUM AND NOT jsdom. The question is "does the browser's CSP implementation block
// this stylesheet?" — a jsdom answer would be a fiction. This drives headless Edge, the same engine
// family as WebView2. It is NOT the app: for questions about Sard's own rendering, use
// byte-identity.mjs, which drives the real binary.
//
// Usage:  npm run harness:csp
// Exit 0 iff every variant matches its expected outcome.

import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

// Sard's shipped policy, minus style-src, which each variant supplies. Kept in this shape so a
// future edit to tauri.conf.json can be transcribed here without re-deriving the rest.
const BASE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "img-src 'self' blob: data:; font-src 'self' blob: data:; " +
  "connect-src 'self'; media-src blob:; frame-src 'self' blob:";

/**
 * Each variant isolates ONE factor. `expectApplied` is what the investigation measured on
 * Chromium 151 (Edge stable, 2026-08-04); a change here is a finding, not a flake.
 */
export const VARIANTS = {
  "sard-as-shipped": {
    styleSrc: "'self' 'unsafe-inline'",
    sandbox: "allow-same-origin",
    expectApplied: false,
    why: "v1.1.0 exactly. The book's <link> stylesheet is blocked — no EPUB's CSS has ever applied.",
  },
  "style-src-with-blob": {
    styleSrc: "'self' 'unsafe-inline' blob:",
    sandbox: "allow-same-origin",
    expectApplied: true,
    why: "WP-7's one-token change. Adding blob: is sufficient — this is the whole fix.",
  },
  "no-sandbox": {
    styleSrc: "'self' 'unsafe-inline'",
    sandbox: null,
    expectApplied: false,
    why: "Control: the sandbox is NOT the cause. Removing it changes nothing while style-src lacks blob:.",
  },
  "no-csp": {
    styleSrc: null,
    sandbox: "allow-same-origin",
    expectApplied: true,
    why: "Control: with no CSP at all the stylesheet applies, confirming CSP is the only blocker.",
  },
};

const page = (sandbox) => `<!doctype html><meta charset=utf-8><div id=out>pending</div>
<script>
const css = "p.probe { margin-left: 10%; font-size: 90%; letter-spacing: 0.12em; }";
const cssUrl = URL.createObjectURL(new Blob([css], {type:'text/css'}));
const html = '<!doctype html><html><head><link rel="stylesheet" href="' + cssUrl + '"></head>'
           + '<body><p class="probe" id="p">probe</p></body></html>';
const f = document.createElement('iframe');
${sandbox ? `f.setAttribute('sandbox','${sandbox}');` : ""}
f.src = URL.createObjectURL(new Blob([html], {type:'text/html'}));
f.onload = () => setTimeout(() => {
  const r = {};
  try {
    const d = f.contentDocument, p = d.getElementById('p');
    const cs = d.defaultView.getComputedStyle(p);
    r.marginLeft = cs.marginLeft;
    r.fontSize = cs.fontSize;
    r.letterSpacing = cs.letterSpacing;
    r.sheetCount = d.styleSheets.length;
    // The book's rules only entered the cascade if a property the UA would not set has changed.
    r.applied = cs.fontSize !== '16px' && cs.marginLeft !== '0px';
  } catch (e) { r.error = String(e); }
  document.getElementById('out').textContent = 'RESULT ' + JSON.stringify(r);
}, 400);
document.body.appendChild(f);
</scr` + `ipt>`;

// `require` is not defined in an ES module — an earlier version called it inside a try/catch here,
// which made every lookup throw and the harness report "Edge not found" and SKIP with exit 0. It
// looked like a pass. Caught by actually running it; hence the explicit import above.
function findEdge() {
  return EDGE_CANDIDATES.find((p) => existsSync(p));
}

export async function runCspHarness({ port = 8733, quiet = false } = {}) {
  const edge = findEdge();
  if (!edge) return { skipped: "Microsoft Edge not found — the harness needs a Chromium binary" };

  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^\//, "") || "sard-as-shipped";
    const v = VARIANTS[name];
    if (!v) {
      res.statusCode = 404;
      return res.end("no such variant");
    }
    if (v.styleSrc) res.setHeader("Content-Security-Policy", `${BASE_CSP}; style-src ${v.styleSrc}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page(v.sandbox));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  const results = {};
  try {
    for (const name of Object.keys(VARIANTS)) {
      const { stdout } = await execFileAsync(
        edge,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--virtual-time-budget=4000",
          "--dump-dom",
          `http://127.0.0.1:${port}/${name}`,
        ],
        { maxBuffer: 8 << 20 },
      );
      const m = stdout.match(/RESULT (\{[^<]*\})/);
      results[name] = m ? JSON.parse(m[1]) : { error: "no result emitted" };
    }
  } finally {
    server.close();
  }

  const rows = Object.entries(VARIANTS).map(([name, v]) => ({
    name,
    expected: v.expectApplied,
    actual: results[name]?.applied ?? null,
    pass: results[name]?.applied === v.expectApplied,
    detail: results[name],
    why: v.why,
  }));
  if (!quiet) {
    console.log(`\n  Book-stylesheet / CSP harness  (${edge.split("\\").pop()})\n`);
    for (const r of rows) {
      console.log(
        `    ${r.pass ? "✓" : "✗"} ${r.name.padEnd(22)} applied=${String(r.actual).padEnd(5)}` +
          ` (expected ${r.expected})   ${r.detail?.marginLeft ?? "?"} / ${r.detail?.fontSize ?? "?"}`,
      );
      console.log(`        ${r.why}`);
    }
    console.log("");
  }
  return { rows, allPass: rows.every((r) => r.pass) };
}

if (process.argv[1]?.endsWith("csp.mjs")) {
  const out = await runCspHarness();
  if (out.skipped) {
    console.log(`\n  ⓘ SKIPPED — ${out.skipped}\n`);
    process.exit(0);
  }
  process.exit(out.allPass ? 0 : 1);
}
