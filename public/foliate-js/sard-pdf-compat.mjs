// PDF.js COMPATIBILITY LAYER — the built-ins pdf.js assumes, supplied where an engine lacks them.
//
// SARD LOCAL ADDITION (see VENDOR.txt). This is Sard's file, not vendored code: pdf.js is never
// edited. Where it assumes a built-in that an older WebView2 does not have, the engine is given the
// built-in rather than the library being patched.
//
// ── WHAT GOES WRONG WITHOUT THIS ────────────────────────────────────────────────────────────────
//
// PDF.js 5.5.207 calls these with no feature detection of its own. Each line names the call site in
// the CURRENTLY VENDORED copy, traced rather than assumed:
//
//   Promise.try                        pdf.worker.mjs:60114 (+3), pdf.mjs:8404 (+3)
//                                      `MessageHandler` dispatch. `sendWithPromise` (pdf.mjs:8445)
//                                      ALWAYS sets a callbackId, and the worker takes this branch
//                                      whenever one is present — so it runs on the first request of
//                                      every PDF. Missing, it throws inside a `message` handler,
//                                      where nothing the caller awaits can reject: `getDocument()`
//                                      never settles and the open hangs silently.
//   Promise.withResolvers              pdf.mjs ×26, pdf.worker.mjs ×14, including `sendWithPromise`
//                                      itself. Same path, same first request.
//   Uint8Array.prototype.toHex         pdf.worker.mjs:59575 — the document fingerprint, awaited
//                                      unconditionally at :62425 on every GetDoc.
//   Map.prototype.getOrInsertComputed  pdf.mjs ×9, pdf.worker.mjs ×6. Reached through `_intentStates`
//                                      when a page renders and `#methodPromises` during that setup.
//                                      MEASURED: with this removed from the page realm, a real
//                                      two-page PDF opened, paginated and extracted text, then threw
//                                      `this[#methodPromises].getOrInsertComputed is not a function`
//                                      at render.
//   URL.parse                          pdf.mjs ×8, pdf.worker.mjs ×3. `PDFWorker._isSameOrigin`
//                                      (pdf.mjs:15229) calls it INSIDE the try that wraps
//                                      `new Worker(...)` (:15301). Missing, that throws, the catch
//                                      runs `#setupFakeWorker()`, and pdf.js parses on the MAIN
//                                      THREAD for the rest of the session. Everything still renders,
//                                      which is why it hides: the only symptom is that page turns
//                                      block the interface.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────
//
// `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` are NOT supplied, and are no longer
// demanded by the capability gate either. They were in the old gate, and they are unreachable in
// Sard's configuration:
//
//   toBase64     pdf.mjs:7434, inside `createFontFaceRule()`. That is the FALLBACK branch: the
//                preferred path is `createNativeFontFace()`, taken whenever `isFontLoadingAPISupported`
//                is true (pdf.mjs:7276) — i.e. wherever the FontFace API exists, which is every
//                engine Sard supports. Also pdf.mjs:24263, signature compression, which Sard has no
//                call path to.
//   fromBase64   pdf.mjs:24267 (signature decompression) and :46916 (XFA `$content`). Sard does not
//                pass `enableXfa`, so pdf.js leaves XFA off, and Sard calls no signature API.
//
// MEASURED, not reasoned: with each of the two deleted from the page realm, a real PDF still opened,
// paginated, extracted text and rendered. Supplying them would be patching shared prototypes for
// paths nothing reaches.
//
// `Float16Array` is not here either — pdf.js feature-detects that one itself and degrades without it.
//
// ── ON A CURRENT ENGINE THIS FILE DOES NOTHING ──────────────────────────────────────────────────
//
// Every install is guarded by `typeof … !== "function"`. A native implementation is faster and is the
// one pdf.js was tested against, so it is never replaced, wrapped or re-described. On the WebView2
// this was developed against (Chrome 152) all five are native and this module installs nothing.
//
// ── TWO REALMS ──────────────────────────────────────────────────────────────────────────────────
//
// A worker is a separate realm and does not see the page's globals, so this is loaded twice:
//
//   * the page — from index.html, before the application bundle, so the capability probe in
//     `src/lib/runtime.ts` measures what Sard can actually do rather than what the engine shipped;
//   * the pdf.js worker — through `sard-pdf-worker.mjs`, which imports this first and the vendored
//     worker second.
//
// Each realm has its own globals and its own guards, so loading it twice is independent, not double
// work.

// Built-ins are writable and configurable but NOT enumerable. `defineProperty` is used for every
// install so the shape matches — a plain assignment would create an enumerable property, which is a
// visible difference from the native one it stands in for.
const install = (target, name, value) => {
  Object.defineProperty(target, name, { value, writable: true, enumerable: false, configurable: true });
};

if (typeof Promise.try !== "function") {
  // Spec shape: call fn synchronously, resolve with its result, turn a synchronous throw into a
  // rejection. `new Promise` already converts a throw in its executor into a rejection, so that is
  // the whole semantic. `new this` rather than `new Promise` because the spec builds the capability
  // from the receiver, so `Subclass.try(...)` yields a Subclass.
  install(Promise, "try", function (fn, ...args) {
    return new this((resolve) => resolve(fn(...args)));
  });
}

if (typeof Promise.withResolvers !== "function") {
  // Returns the promise together with its own settle functions. `new this` for the same reason.
  install(Promise, "withResolvers", function () {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  });
}

if (typeof Uint8Array.prototype.toHex !== "function") {
  // Lower-case, two digits per byte, no separator.
  install(Uint8Array.prototype, "toHex", function toHex() {
    let s = "";
    for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, "0");
    return s;
  });
}

if (typeof Map.prototype.getOrInsertComputed !== "function") {
  // `has` rather than `get() === undefined`: a key whose stored value IS undefined must not be
  // recomputed, and pdf.js stores maps whose values can legitimately be undefined.
  install(Map.prototype, "getOrInsertComputed", function getOrInsertComputed(key, callbackfn) {
    if (typeof callbackfn !== "function") throw new TypeError("callbackfn is not a function");
    if (!this.has(key)) this.set(key, callbackfn(key));
    return this.get(key);
  });
}

if (typeof URL.parse !== "function") {
  // Returns null instead of throwing on a URL that will not parse — the whole reason the static
  // exists, and what `_isSameOrigin` depends on.
  install(URL, "parse", function parse(url, base) {
    try {
      return base === undefined ? new URL(url) : new URL(url, base);
    } catch {
      return null;
    }
  });
}
