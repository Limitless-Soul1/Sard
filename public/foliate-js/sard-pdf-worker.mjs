// THE pdf.js WORKER SARD LOADS: the compatibility layer, then the vendored worker.
//
// SARD LOCAL ADDITION (see VENDOR.txt). Two static imports, in this order, and nothing else.
//
// ── WHY A SEPARATE ENTRY AT ALL ─────────────────────────────────────────────────────────────────
//
// A worker is its own realm. The copy of the compatibility layer that `index.html` loads into the
// page does not reach it, and the worker is where the two worst failures live: `Promise.try` on the
// first request of every PDF, and `Uint8Array.prototype.toHex` on the document fingerprint. Without
// the layer in THIS realm the page realm can be perfectly healthy and the open still hangs.
//
// ── WHY STATIC IMPORTS RATHER THAN A GENERATED BUNDLE ───────────────────────────────────────────
//
// pdf.js constructs its worker as a MODULE worker — `new Worker(workerSrc, { type: "module" })`
// (pdf.mjs:15301) — so this file may use static imports, and they are evaluated in source order
// before any of its own body runs. That gives the ordering the layer needs with no build step.
//
// Three deliveries were considered:
//
//   blob: URL wrapper   Refused by the application's own CSP (`script-src 'self'`). pdf.js only
//                       builds one for a cross-origin worker, which is a second reason to keep the
//                       worker same-origin: see `_createCDNWrapper` at pdf.mjs:15236.
//   concatenation       Generate one file containing the layer followed by the vendored worker. It
//                       works, but the output is a ~2 MB generated artifact that has to be produced
//                       by every path that serves the frontend, kept out of the repository, and
//                       regenerated on every re-vendor. It also has to be written into the vendored
//                       directory, because `pdf.worker.mjs` reads `import.meta.url` to find its own
//                       cmaps and standard fonts, and concatenation would otherwise move that URL.
//   STATIC IMPORTS      What this is. No build step, no generated file, nothing to keep in sync, and
//                       `import.meta.url` inside the vendored worker is unchanged — each module keeps
//                       its own, so pdf.js still resolves its resources from its own directory
//                       wherever this entry happens to live.
//
// The vendored directory stays byte-identical to upstream, which is the rule VENDOR.txt exists to
// enforce: a re-vendor overwrites it and this file keeps working.

import "./sard-pdf-compat.mjs";
import "./vendor/pdfjs/pdf.worker.mjs";
