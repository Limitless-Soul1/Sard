// RESILIENCE-1 / WP-1 — the runtime capability gate.
//
// THE DEFECT THIS EXISTS FOR. Sard vendors two rendering engines under `public/foliate-js/`, and
// both need browser features newer than the WebView2 runtime some machines actually have:
//
//   * PDF.js 5.5.207 calls `Uint8Array.prototype.toHex()` on the unconditional PDF-open path
//     (pdf.worker.mjs:59575). Where that method is missing, EVERY PDF fails with
//     `UnknownErrorException: hashOriginal.toHex is not a function` — the reported defect.
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
  uint8ToHex: boolean;
  uint8ToBase64: boolean;
  uint8FromBase64: boolean;
}

/** Which named features each capability needs — used for the decision AND for the Details text. */
export const CAPABILITY_FEATURES: Record<Capability, readonly (keyof RuntimeEnv)[]> = {
  // foliate epub.js:178/:200/:206/:258 — the OPF metadata parser, run for every EPUB.
  epub: ["objectGroupBy", "mapGroupBy"],
  // PDF.js 5.5.207 — pdf.worker.mjs:59575 (every getDocument), pdf.mjs:7434 (embedded fonts),
  // pdf.mjs:24263/:24267 (signatures).
  pdf: ["uint8ToHex", "uint8ToBase64", "uint8FromBase64"],
};

/** The human-readable feature names, for the Details panel and for bug reports. */
export const FEATURE_LABELS: Record<keyof RuntimeEnv, string> = {
  objectGroupBy: "Object.groupBy",
  mapGroupBy: "Map.groupBy",
  uint8ToHex: "Uint8Array.prototype.toHex",
  uint8ToBase64: "Uint8Array.prototype.toBase64",
  uint8FromBase64: "Uint8Array.fromBase64",
};

/** Read the real globals. The ONLY place this module touches the environment. */
export function readEnv(): RuntimeEnv {
  const u8 = Uint8Array as unknown as { fromBase64?: unknown; prototype: Record<string, unknown> };
  return {
    objectGroupBy: typeof (Object as unknown as { groupBy?: unknown }).groupBy === "function",
    mapGroupBy: typeof (Map as unknown as { groupBy?: unknown }).groupBy === "function",
    uint8ToHex: typeof u8.prototype?.toHex === "function",
    uint8ToBase64: typeof u8.prototype?.toBase64 === "function",
    uint8FromBase64: typeof u8.fromBase64 === "function",
  };
}

/** Pure: which capabilities does this environment support? */
export function capabilitiesOf(env: RuntimeEnv): Record<Capability, boolean> {
  const has = (cap: Capability) => CAPABILITY_FEATURES[cap].every((f) => env[f]);
  return { epub: has("epub"), pdf: has("pdf") };
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
