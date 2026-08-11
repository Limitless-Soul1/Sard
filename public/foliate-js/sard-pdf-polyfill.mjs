// PDF.js COMPATIBILITY LAYER — three built-ins that older WebViews do not have.
//
// SARD LOCAL ADDITION (see VENDOR.txt). This is Sard's file, not vendored code: pdf.js is never
// edited, it is given an engine that meets its assumptions.
//
// THE DEFECT THIS EXISTS FOR, measured on a real device rather than reasoned about. PDF.js 5.5.207
// calls three modern built-ins with no feature detection of its own. On Android System WebView
// 124.0.6367.219 none of the three exists, and the failure is not a clean error — `getDocument()`
// never settles, so opening a PDF hangs for ever with nothing in the log to explain it:
//
//   Promise.try                       pdf.mjs ×4, pdf.worker.mjs ×4 — the main-thread↔worker message
//                                     handler. The FIRST thing to fail, and the one that hangs.
//   Uint8Array.prototype.toHex        pdf.worker.mjs:59575 — the document fingerprint, computed on
//                                     every open.
//   Map.prototype.getOrInsertComputed pdf.mjs ×9, pdf.worker.mjs ×6 — surfaces at getPage().
//
// WHAT IS DELIBERATELY NOT HERE. `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` were in
// Sard's old capability check and are NOT in this file, because instrumenting the polyfills with call
// counters against a PDF carrying 23 embedded TrueType fonts measured them at ZERO calls. They serve
// `createFontFaceRule`, digital signatures and XFA — none of which is on Sard's path. Requiring them
// excluded devices that would have rendered PDFs perfectly well.
//
// `Float16Array` is not here either: pdf.js feature-detects that one itself
// (`isFloat16ArraySupported`) and degrades without it.
//
// WHY EACH POLYFILL IS FEATURE-DETECTED. On a current engine this file must do nothing at all — a
// native implementation is faster and is the one pdf.js was tested against. Every guard below is
// `typeof … !== "function"`, so a modern WebView leaves this module inert.
//
// VERIFIED: with these three installed, Chromium 124 produces byte-identical results to Chromium 150
// native — same document fingerprints, same text-item counts, same text-layer geometry, same
// selection rectangles, on Latin, Arabic and embedded-font PDFs.
//
// THIS FILE IS LOADED TWICE, INTO TWO REALMS, AND THAT IS NOT A MISTAKE:
//   * the page, from index.html, before the application bundle — so the capability probe in
//     `src/lib/runtime.ts` measures what Sard can actually do rather than what the engine shipped;
//   * the pdf.js worker, concatenated ahead of it by scripts/build-pdf-worker.mjs — because a worker
//     is a separate realm and a polyfill on the page does not reach it.
// Loading it twice is harmless: each realm has its own globals and each guard is independent.

if (typeof Promise.try !== "function") {
  // Spec shape: call fn synchronously, resolve with its result, and turn a synchronous throw into a
  // rejection. `new Promise` already converts a throw in its executor into a rejection, so this is
  // the whole semantic.
  Promise.try = function (fn, ...args) {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

if (typeof Uint8Array.prototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    writable: true,
    // Lower-case, two digits per byte, no separator — matched byte for byte against the native
    // implementation on Chromium 150 before this was relied on.
    value: function toHex() {
      let s = "";
      for (const b of this) s += b.toString(16).padStart(2, "0");
      return s;
    },
  });
}

if (typeof Map.prototype.getOrInsertComputed !== "function") {
  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    configurable: true,
    writable: true,
    // `has` rather than `get() === undefined`: a key whose value IS undefined must not be recomputed,
    // and pdf.js stores maps of maps where that distinction matters.
    value: function getOrInsertComputed(key, callbackfn) {
      if (!this.has(key)) this.set(key, callbackfn(key));
      return this.get(key);
    },
  });
}
