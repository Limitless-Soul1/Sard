// RESILIENCE-1 / WP-1 — the runtime capability gate.
//
// THE DEFECT THIS EXISTS FOR. Sard vendors two rendering engines under `public/foliate-js/`, and
// both need browser features newer than the WebView2 runtime some machines actually have:
//
//   * PDF.js 5.5.207 calls four built-ins on the unconditional PDF-open path with no feature
//     detection of its own: `Promise.try` and `Promise.withResolvers` (the message handler, on the
//     first request of every PDF), `Uint8Array.prototype.toHex` (the document fingerprint,
//     pdf.worker.mjs:59575) and `Map.prototype.getOrInsertComputed` (page render). Missing `toHex`
//     fails every PDF with `UnknownErrorException: hashOriginal.toHex is not a function` — the
//     reported defect — and missing `Promise.try` is worse: it throws inside a `message` handler,
//     where nothing can reject, so `getDocument()` never settles and the open hangs silently.
//   * foliate's `epub.js` calls `Object.groupBy` / `Map.groupBy` in the OPF metadata parser
//     (epub.js:178, :200, :206, :258). Where those are missing, NO book of any kind opens.
//
// Nothing checked either. The vendored code lives in `public/`, so Vite never transpiles or even
// inspects it, and Tauri's installer only installs the WebView2 runtime when it is ABSENT — it does
// not upgrade an old one. So a machine with a runtime pinned by policy stays broken forever, and the
// failure surfaces as an internal exception 40 minutes later.
//
// WHY FEATURE DETECTION AND NOT A VERSION NUMBER. A version check is a second copy of the same fact,
// and the two copies desync the moment the vendored engines are re-pinned: whoever re-vendors would
// have to re-derive the version and remember to edit this file. A probe cannot desync — it asks for
// exactly the capability the engine will use. Version strings appear below ONLY as diagnostics, and
// no decision reads them.
//
// ⚠ ON RE-VENDOR: re-derive these probes from what the new engine calls. `public/foliate-js/VENDOR.txt`
// carries the standing instruction.
//
// WHAT THIS PROBE MEANS NOW. `public/foliate-js/sard-pdf-compat.mjs` is loaded from index.html BEFORE
// the application bundle, so by the time anything here reads a global, the compatibility layer has
// already supplied whatever the engine lacked. The question this module answers is therefore "can
// SARD render this here", not "did this engine ship the built-in natively" — which is the honest
// question, and it keeps the refusal truthful: if the layer ever failed to load, these probes read
// false and the reader is told, instead of meeting a hang.
//
// The PDF set was wrong in BOTH directions before this, and both errors were measured:
//
//   DEMANDED AND NEVER USED   `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64`. They serve
//                             `createFontFaceRule` (the fallback taken only where the FontFace API is
//                             absent), signature handling, and XFA — which Sard does not enable. With
//                             each deleted from the page realm a real PDF still opened, paginated,
//                             extracted text and rendered. Requiring them refused engines that work.
//   REQUIRED AND UNGUARDED    `Promise.try`, `Promise.withResolvers` and
//                             `Map.prototype.getOrInsertComputed`. Deleting the last of these threw
//                             at render; the first two are reached on the first worker request of
//                             every PDF, and their absence hangs rather than throws.
//
// `URL.parse` is supplied by the layer but deliberately NOT gated: its absence costs the worker, not
// correctness (pdf.js falls back to parsing on the main thread), so it is a performance fix rather
// than a capability.

/** What Sard can do on this machine. Each maps to a whole content format, not to a nicety. */
export type Capability = "epub" | "pdf";

/**
 * The raw feature readings, separated from the capability decision so both halves are testable
 * without stubbing globals — a test that monkey-patches `Uint8Array.prototype` is a test that can
 * corrupt every other test in the file.
 */
export interface RuntimeEnv {
  objectGroupBy: boolean;
  mapGroupBy: boolean;
  promiseTry: boolean;
  promiseWithResolvers: boolean;
  uint8ToHex: boolean;
  mapGetOrInsertComputed: boolean;
}

/** Which named features each capability needs — used for the decision AND for the Details text. */
export const CAPABILITY_FEATURES: Record<Capability, readonly (keyof RuntimeEnv)[]> = {
  // foliate epub.js:178/:200/:206/:258 — the OPF metadata parser, run for every EPUB.
  epub: ["objectGroupBy", "mapGroupBy"],
  // PDF.js 5.5.207, every one of them on the unconditional open/render path:
  // pdf.worker.mjs:60114 + pdf.mjs:8404 (`Promise.try`, the message handler — `sendWithPromise` at
  // pdf.mjs:8445 always sets a callbackId, so the worker takes that branch on the first request),
  // pdf.mjs/worker `Promise.withResolvers` (×40, including `sendWithPromise` itself),
  // pdf.worker.mjs:59575 (`toHex`, the fingerprint, awaited at :62425 on every GetDoc), and
  // `Map.prototype.getOrInsertComputed` (pdf.mjs ×9 / worker ×6, reached through `_intentStates` and
  // `#methodPromises` when a page renders).
  pdf: ["promiseTry", "promiseWithResolvers", "uint8ToHex", "mapGetOrInsertComputed"],
};

/**
 * WHICH OF THOSE FEATURES SARD SUPPLIES ITSELF.
 *
 * `public/foliate-js/sard-pdf-compat.mjs` installs these four behind a `typeof` guard, in the page
 * and again inside the PDF worker's own realm. That single fact decides what a MISSING feature
 * actually proves, and the two answers are not the same:
 *
 *   * A feature NOT on this list is one only the engine can provide. `Object.groupBy` and
 *     `Map.groupBy` are the whole EPUB capability and Sard supplies neither, so if they are absent
 *     the engine really is behind and updating it really is the answer.
 *
 *   * A feature ON this list is one Sard installs. If it is absent at the moment the capability is
 *     read, the layer did not reach that realm — which is a problem with this installation, not with
 *     the reader's WebView2. Telling them to update it would send them to fix something that is not
 *     broken, and the update would not help.
 *
 * `pdfCompat.test.ts` holds this list against what the shipped file actually installs, so the two
 * cannot drift apart.
 */
export const SUPPLIED_BY_COMPAT: readonly (keyof RuntimeEnv)[] = [
  "promiseTry",
  "promiseWithResolvers",
  "uint8ToHex",
  "mapGetOrInsertComputed",
];

/** The human-readable feature names, for the Details panel and for bug reports. */
export const FEATURE_LABELS: Record<keyof RuntimeEnv, string> = {
  objectGroupBy: "Object.groupBy",
  mapGroupBy: "Map.groupBy",
  promiseTry: "Promise.try",
  promiseWithResolvers: "Promise.withResolvers",
  uint8ToHex: "Uint8Array.prototype.toHex",
  mapGetOrInsertComputed: "Map.prototype.getOrInsertComputed",
};

/** Read the real globals. The ONLY place this module touches the environment. */
export function readEnv(): RuntimeEnv {
  const u8 = Uint8Array as unknown as { prototype: Record<string, unknown> };
  const promise = Promise as unknown as { try?: unknown; withResolvers?: unknown };
  const map = Map as unknown as { groupBy?: unknown; prototype: Record<string, unknown> };
  return {
    objectGroupBy: typeof (Object as unknown as { groupBy?: unknown }).groupBy === "function",
    mapGroupBy: typeof map.groupBy === "function",
    promiseTry: typeof promise.try === "function",
    promiseWithResolvers: typeof promise.withResolvers === "function",
    uint8ToHex: typeof u8.prototype?.toHex === "function",
    mapGetOrInsertComputed: typeof map.prototype?.getOrInsertComputed === "function",
  };
}

/** Pure: which capabilities does this environment support? */
export function capabilitiesOf(env: RuntimeEnv): Record<Capability, boolean> {
  const has = (cap: Capability) => CAPABILITY_FEATURES[cap].every((f) => env[f]);
  return { epub: has("epub"), pdf: has("pdf") };
}

/**
 * Pure: is the ENGINE itself behind for this capability?
 *
 * True only when something is missing that Sard does not supply — the one condition under which
 * "this runtime is too old" is a statement of fact rather than a guess. When every missing feature
 * is one the compatibility layer installs, the engine's age is not what has been established, and
 * the caller must say something else.
 */
export function engineIsBehind(env: RuntimeEnv, cap: Capability): boolean {
  return CAPABILITY_FEATURES[cap].some((f) => !env[f] && !SUPPLIED_BY_COMPAT.includes(f));
}

/** Pure: which named features are missing for a capability (for the Details text). */
export function missingFeatures(env: RuntimeEnv, cap: Capability): string[] {
  return CAPABILITY_FEATURES[cap].filter((f) => !env[f]).map((f) => FEATURE_LABELS[f]);
}

// ---------------------------------------------------------------------------
// The process-wide answer. Probed ONCE: a JS engine cannot grow a method mid-session, so re-reading
// would be pure cost, and caching means the reader's per-open check is free.
// ---------------------------------------------------------------------------

let cached: { env: RuntimeEnv; caps: Record<Capability, boolean> } | null = null;

function current() {
  if (!cached) {
    const env = readEnv();
    cached = { env, caps: capabilitiesOf(env) };
  }
  return cached;
}

/** Can this machine open this kind of content? */
export function canRender(cap: Capability): boolean {
  return current().caps[cap];
}

/**
 * The environment the DECISIONS were made from.
 *
 * Callers outside this module must use this, never `readEnv()`. They are not the same thing:
 * `readEnv()` takes a fresh reading of the live globals, while `canRender()` answers from the
 * cached one. Mixing them lets the Details block report a different environment than the one that
 * actually caused the failure — "nothing missing" printed underneath a missing-feature error.
 * (Found by the WP-1 tests, which is exactly the disagreement they were written to expose.)
 */
export function currentEnv(): RuntimeEnv {
  return current().env;
}

/** The engine string — DIAGNOSTICS ONLY. Never read by a decision (see the header note). */
export function engineLabel(): string {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] ?? navigator.userAgent.slice(0, 80);
}

/** Everything a bug report wants to know about the runtime, in one object. */
export function runtimeReport(): Record<string, string> {
  const { env, caps } = current();
  return {
    engine: engineLabel(),
    epub: caps.epub ? "ok" : `missing: ${missingFeatures(env, "epub").join(", ")}`,
    pdf: caps.pdf ? "ok" : `missing: ${missingFeatures(env, "pdf").join(", ")}`,
  };
}

/** Test seam: force a capability state. Never called by product code. */
export function __setRuntimeForTests(env: RuntimeEnv | null): void {
  cached = env ? { env, caps: capabilitiesOf(env) } : null;
}
