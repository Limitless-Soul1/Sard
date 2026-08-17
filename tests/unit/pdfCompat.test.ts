// The PDF compatibility layer, and the wiring that delivers it to both realms.
//
// WHAT THIS PINS. PDF.js 5.5.207 calls three modern built-ins with no feature detection of its own,
// and on an engine lacking them `getDocument()` does not throw — it never settles, so a PDF hangs
// with nothing in the log. The layer supplies them; these tests assert it is CORRECT (same output as
// the native methods), INERT (a current engine keeps its own), and DELIVERED (page realm and worker
// realm, which are separate and both required).
//
// The polyfill is a static asset under `public/`, so it is read as text rather than imported: it is
// served to the browser and concatenated into the worker, never bundled by Vite.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const POLYFILL = join(ROOT, "public", "foliate-js", "sard-pdf-polyfill.mjs");
const PDF_WRAPPER = join(ROOT, "public", "foliate-js", "pdf.js");
const INDEX_HTML = join(ROOT, "index.html");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-pdf-worker.mjs");

const polyfillSource = readFileSync(POLYFILL, "utf8");

/**
 * The polyfill with its comments removed.
 *
 * The file EXPLAINS at length which built-ins it deliberately omits and why, so a naive scan of the
 * source finds `toBase64` in prose and concludes the opposite of the truth. Assertions about what the
 * layer DOES must read code only.
 */
const polyfillCode = polyfillSource
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

interface Realm {
  promiseTry: (fn: (...a: never[]) => unknown, ...args: unknown[]) => Promise<unknown>;
  toHex: (u: Uint8Array) => string;
  getOrInsertComputed: (m: Map<string, unknown>, k: string, fn: (k: string) => unknown) => unknown;
}

/**
 * Run the polyfill against private copies of the three constructors, with the built-ins removed.
 *
 * Subclasses rather than the real globals: deleting `Uint8Array.prototype.toHex` for a test would
 * corrupt every other file in the suite, which is precisely the hazard `runtime.ts` warns about.
 */
function realmWithoutBuiltins(): Realm {
  const P = class extends Promise<unknown> {};
  const U = class extends Uint8Array {};
  const M = class extends Map<string, unknown> {};
  delete (P as unknown as Record<string, unknown>).try;
  delete (U.prototype as unknown as Record<string, unknown>).toHex;
  delete (M.prototype as unknown as Record<string, unknown>).getOrInsertComputed;

  new Function("Promise", "Uint8Array", "Map", polyfillSource)(P, U, M);

  const pTry = (P as unknown as { try: (f: unknown, ...a: unknown[]) => Promise<unknown> }).try;
  const uHex = (U.prototype as unknown as { toHex: (this: Uint8Array) => string }).toHex;
  const mGet = (M.prototype as unknown as {
    getOrInsertComputed: (this: Map<string, unknown>, k: string, f: (k: string) => unknown) => unknown;
  }).getOrInsertComputed;

  return {
    promiseTry: (fn, ...args) => pTry.call(P, fn, ...args),
    toHex: (u) => uHex.call(u),
    getOrInsertComputed: (m, k, fn) => mGet.call(m, k, fn),
  };
}

describe("PDF compatibility layer — correctness", () => {
  const realm = realmWithoutBuiltins();

  it("toHex matches the native implementation byte for byte", () => {
    const sample = new Uint8Array([0, 1, 15, 16, 127, 128, 255, 42]);
    // The expected value was captured from the NATIVE method on Chromium 150 before the polyfill was
    // relied on; hard-coding it means this test still means something on an engine that lacks it.
    expect(realm.toHex(sample)).toBe("00010f107f80ff2a");
  });

  it("toHex renders an empty array as an empty string", () => {
    expect(realm.toHex(new Uint8Array([]))).toBe("");
  });

  it("Promise.try resolves with the function's result", async () => {
    await expect(realm.promiseTry(() => 42)).resolves.toBe(42);
  });

  it("Promise.try turns a SYNCHRONOUS throw into a rejection — the whole point of it", async () => {
    await expect(realm.promiseTry(() => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("Promise.try forwards arguments", async () => {
    await expect(realm.promiseTry((a, b) => (a as number) + (b as number), 2, 3)).resolves.toBe(5);
  });

  it("getOrInsertComputed inserts once and returns the stored value thereafter", () => {
    const m = new Map<string, unknown>();
    let calls = 0;
    const make = () => { calls += 1; return 7; };
    expect(realm.getOrInsertComputed(m, "k", make)).toBe(7);
    expect(realm.getOrInsertComputed(m, "k", make)).toBe(7);
    expect(calls).toBe(1);
  });

  it("getOrInsertComputed does not recompute a key whose stored value is undefined", () => {
    // `has` rather than `get() === undefined`: pdf.js stores maps of maps, and recomputing here
    // would silently discard an entry it had already built.
    const m = new Map<string, unknown>();
    m.set("k", undefined);
    let calls = 0;
    realm.getOrInsertComputed(m, "k", () => { calls += 1; return undefined; });
    expect(calls).toBe(0);
  });
});

describe("PDF compatibility layer — inert on a capable engine", () => {
  it("every polyfill is feature-detected, so a native implementation is never replaced", () => {
    // Four: Promise.try, URL.parse, Uint8Array.prototype.toHex, Map.prototype.getOrInsertComputed.
    const guards = polyfillCode.match(/typeof [^\n]*!== "function"/g) ?? [];
    expect(guards.length).toBe(4);
  });

  it("does not touch the two built-ins measured at zero calls", () => {
    // Requiring these refused PDFs on devices that render them perfectly well. Their absence here is
    // the fix, so a future edit that reinstates them should have to argue with this test.
    expect(polyfillCode).not.toContain("toBase64");
    expect(polyfillCode).not.toContain("fromBase64");
  });
});

describe("PDF compatibility layer — delivered to BOTH realms", () => {
  it("the page realm loads it from index.html BEFORE the application bundle", () => {
    const html = readFileSync(INDEX_HTML, "utf8");
    const polyfillAt = html.indexOf("sard-pdf-polyfill.mjs");
    const appAt = html.indexOf("/src/main.tsx");
    expect(polyfillAt).toBeGreaterThan(-1);
    // Ordering is the point: the capability probe must not run before the layer is installed.
    expect(polyfillAt).toBeLessThan(appAt);
  });

  it("pdf.js points the worker at the generated bundle, not the bare vendored worker", () => {
    const wrapper = readFileSync(PDF_WRAPPER, "utf8");
    expect(wrapper).toContain("pdf.worker.sard.mjs");
    expect(wrapper).not.toMatch(/workerSrc\s*=\s*pdfjsPath\('pdf\.worker\.mjs'\)/);
  });

  it("the generator concatenates rather than editing the vendored worker", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    expect(script).toContain("pdf.worker.sard.mjs");
    // A blob: wrapper is refused by the app CSP; this asserts the chosen mechanism is not that one.
    expect(script).not.toContain("createObjectURL");
  });

  it("the vendored worker is present and is never written by the generator", () => {
    expect(existsSync(join(ROOT, "public", "foliate-js", "vendor", "pdfjs", "pdf.worker.mjs"))).toBe(true);
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    const writes = script.match(/writeFileSync\([^,]+/g) ?? [];
    expect(writes.every((w) => w.includes("OUT"))).toBe(true);
  });
});
