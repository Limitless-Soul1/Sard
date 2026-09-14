// THE PDF COMPATIBILITY LAYER — what it supplies, what it refuses to touch, and where it is loaded.
//
// `public/foliate-js/sard-pdf-compat.mjs` lives outside the TypeScript bundle: it is served as-is to
// the page and imported by the worker entry, so Vite never sees it and nothing else would notice if
// it broke. These tests read the real file and exercise the real implementations.
//
// WHY THE POLYFILLS ARE EVALUATED IN A SANDBOX RATHER THAN IMPORTED. Importing the module would
// install its patches onto THIS process's `Map.prototype`, `Promise` and `Uint8Array.prototype` for
// every test that runs afterwards — the exact "a test that monkey-patches a prototype can corrupt
// every other test" hazard that `runtime.test.ts` was split apart to avoid. Each case below builds a
// disposable realm out of the file's own source instead, so the semantics under test are the shipped
// ones and nothing leaks.
import { describe, expect, it } from "vitest";
import { CAPABILITY_FEATURES, FEATURE_LABELS, readEnv } from "../../src/lib/runtime";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(__dirname, "..", "..");
const SOURCE = readFileSync(resolve(ROOT, "public/foliate-js/sard-pdf-compat.mjs"), "utf8");
const WORKER_ENTRY = readFileSync(resolve(ROOT, "public/foliate-js/sard-pdf-worker.mjs"), "utf8");
const INDEX_HTML = readFileSync(resolve(ROOT, "index.html"), "utf8");
const PDF_ADAPTER = readFileSync(resolve(ROOT, "public/foliate-js/pdf.js"), "utf8");

/**
 * Run the layer in a throwaway realm.
 *
 * `strip` names built-ins to remove BEFORE the layer runs, which is how an older engine is
 * simulated: the layer's own feature detection then has something to detect.
 *
 * Everything happens INSIDE the realm. A vm context has its own intrinsics, so comparing its
 * `Promise` with this process's would compare two different objects and prove nothing — the natives
 * are therefore captured inside the realm before the layer runs and handed back alongside it.
 *
 * `URL` is the exception: a vm context has no web globals, so one is passed in. It is a SUBCLASS with
 * `parse` shadowed, never the real `URL` with a deleted static — deleting that would break this
 * process's own URL for every test that ran afterwards.
 */
function realm(strip: string[] = []) {
  const stripUrl = strip.includes("URL.parse");
  class TestURL extends URL {}
  if (stripUrl) Object.defineProperty(TestURL, "parse", { value: undefined, configurable: true, writable: true });
  const ctx = vm.createContext({ URL: TestURL });

  const before = vm.runInContext(
    `({ tryFn: Promise.try, withResolvers: Promise.withResolvers,
        toHex: Uint8Array.prototype.toHex, goc: Map.prototype.getOrInsertComputed })`,
    ctx,
  ) as Record<string, unknown>;

  const removals = strip
    .filter((n) => n !== "URL.parse")
    .map((name) => {
      if (name === "Promise.try") return "delete Promise.try;";
      if (name === "Promise.withResolvers") return "delete Promise.withResolvers;";
      if (name === "Uint8Array.prototype.toHex") return "delete Uint8Array.prototype.toHex;";
      if (name === "Map.prototype.getOrInsertComputed") return "delete Map.prototype.getOrInsertComputed;";
      throw new Error(`unknown built-in to strip: ${name}`);
    })
    .join("\n");

  vm.runInContext(`${removals}\n${SOURCE}`, ctx);

  const g = vm.runInContext(`({ Promise, Uint8Array, Map, URL, Object })`, ctx) as {
    Promise: PromiseConstructor;
    Uint8Array: Uint8ArrayConstructor;
    Map: MapConstructor;
    URL: typeof URL;
    Object: ObjectConstructor;
  };
  return { ...g, before };
}

describe("what the layer supplies when an engine lacks it", () => {
  it("Promise.try resolves with the function's result", async () => {
    const r = realm(["Promise.try"]);
    await expect(r.Promise.try(() => 7)).resolves.toBe(7);
  });

  it("Promise.try turns a SYNCHRONOUS throw into a rejection — the whole point of it", async () => {
    // This is the semantic pdf.js depends on: its message handler calls an action that may throw
    // synchronously, and the throw has to become a rejection rather than escape the handler.
    const r = realm(["Promise.try"]);
    await expect(r.Promise.try(() => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("Promise.try forwards its arguments", async () => {
    const r = realm(["Promise.try"]);
    await expect(r.Promise.try((a: number, b: number) => a + b, 2, 3)).resolves.toBe(5);
  });

  it("Promise.withResolvers hands back a promise with its own settle functions", async () => {
    const r = realm(["Promise.withResolvers"]);
    const { promise, resolve } = r.Promise.withResolvers<number>();
    resolve(42);
    await expect(promise).resolves.toBe(42);
  });

  it("Promise.withResolvers can reject too", async () => {
    const r = realm(["Promise.withResolvers"]);
    const { promise, reject } = r.Promise.withResolvers<number>();
    reject(new Error("no"));
    await expect(promise).rejects.toThrow("no");
  });

  it("toHex matches the native implementation byte for byte", () => {
    const r = realm(["Uint8Array.prototype.toHex"]);
    const bytes = [0, 1, 15, 16, 127, 128, 200, 255];
    const native = Buffer.from(bytes).toString("hex");
    expect(r.Uint8Array.from(bytes).toHex()).toBe(native);
  });

  it("toHex renders an empty array as an empty string", () => {
    const r = realm(["Uint8Array.prototype.toHex"]);
    expect(new r.Uint8Array([]).toHex()).toBe("");
  });

  it("toHex pads every byte to two lower-case digits", () => {
    // A missing pad is the classic hex bug, and it would silently corrupt document fingerprints.
    const r = realm(["Uint8Array.prototype.toHex"]);
    expect(r.Uint8Array.from([0, 5, 10]).toHex()).toBe("00050a");
  });

  it("getOrInsertComputed inserts once and returns the stored value thereafter", () => {
    const r = realm(["Map.prototype.getOrInsertComputed"]);
    const m = new r.Map<string, number>();
    let calls = 0;
    const make = () => { calls++; return 1; };
    expect(m.getOrInsertComputed("k", make)).toBe(1);
    expect(m.getOrInsertComputed("k", make)).toBe(1);
    expect(calls).toBe(1);
  });

  it("getOrInsertComputed passes the key to the callback", () => {
    const r = realm(["Map.prototype.getOrInsertComputed"]);
    const m = new r.Map<string, string>();
    expect(m.getOrInsertComputed("abc", (k: string) => k.toUpperCase())).toBe("ABC");
  });

  it("getOrInsertComputed does not recompute a key whose stored value is undefined", () => {
    // `has` rather than `get() === undefined`. pdf.js stores maps whose values can be undefined, and
    // recomputing one would run a side-effecting factory a second time.
    const r = realm(["Map.prototype.getOrInsertComputed"]);
    const m = new r.Map<string, undefined>();
    m.set("k", undefined);
    let calls = 0;
    m.getOrInsertComputed("k", () => { calls++; return undefined; });
    expect(calls).toBe(0);
  });

  it("URL.parse returns null instead of throwing on a URL that will not parse", () => {
    // What `PDFWorker._isSameOrigin` depends on: it calls URL.parse and tests the result.
    const r = realm(["URL.parse"]);
    expect(r.URL.parse("not a url")).toBeNull();
    expect(r.URL.parse("https://example.test/a")?.origin).toBe("https://example.test");
  });

  it("URL.parse resolves against a base, as the static does", () => {
    const r = realm(["URL.parse"]);
    expect(r.URL.parse("b.mjs", "https://example.test/a/")?.href).toBe("https://example.test/a/b.mjs");
  });
});

describe("it never disturbs an engine that already has these", () => {
  it("never replaces a built-in the engine already has", () => {
    // Captured inside the realm before the layer ran, and compared with what is there after: a
    // native must be the SAME function object, not merely a working one.
    //
    // Only the ones that WERE native are asserted. Which those are depends on the engine running the
    // suite — this Node, for instance, has no `Map.prototype.getOrInsertComputed`, so the layer
    // rightly installs one and there is no native to preserve. Asserting identity for an absent
    // built-in would make the test fail on exactly the engines the layer exists for.
    const r = realm([]);
    const pairs: [string, unknown, unknown][] = [
      ["Promise.try", r.before.tryFn, r.Promise.try],
      ["Promise.withResolvers", r.before.withResolvers, r.Promise.withResolvers],
      ["Uint8Array.prototype.toHex", r.before.toHex, (r.Uint8Array.prototype as unknown as Record<string, unknown>).toHex],
      ["Map.prototype.getOrInsertComputed", r.before.goc, (r.Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed],
    ];
    let checked = 0;
    for (const [name, was, now] of pairs) {
      if (typeof was !== "function") continue; // absent here — nothing to preserve
      expect(now, `${name} must still be the engine's own implementation`).toBe(was);
      checked++;
    }
    expect(checked, "at least one built-in should have been native to check against").toBeGreaterThan(0);
  });

  it("guards every install with a typeof check, so a native is never replaced", () => {
    const guards = SOURCE.match(/if \(typeof [^)]+ !== "function"\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  it("matches built-in property attributes: writable, configurable, NOT enumerable", () => {
    // A plain assignment would create an ENUMERABLE property, which is a visible difference from the
    // native built-in it stands in for — `Object.keys(Promise)` would start listing it.
    const r = realm(["Promise.try", "Promise.withResolvers", "Uint8Array.prototype.toHex", "Map.prototype.getOrInsertComputed"]);
    const checks: [object, string][] = [
      [r.Promise, "try"],
      [r.Promise, "withResolvers"],
      [r.Uint8Array.prototype, "toHex"],
      [r.Map.prototype, "getOrInsertComputed"],
    ];
    for (const [target, name] of checks) {
      const d = Object.getOwnPropertyDescriptor(target, name);
      expect(d, `${name} must be installed`).toBeDefined();
      expect(d!.enumerable, `${name} must not be enumerable`).toBe(false);
      expect(d!.writable, `${name} must be writable`).toBe(true);
      expect(d!.configurable, `${name} must be configurable`).toBe(true);
    }
  });

  it("adding getOrInsertComputed does not make Map.prototype enumerable to for-in", () => {
    // Prototype patching that shows up in for-in would change unrelated code's behaviour — including
    // every EPUB path, which shares these prototypes.
    const r = realm(["Map.prototype.getOrInsertComputed"]);
    const m = new r.Map([["a", 1]]);
    const seen: string[] = [];
    for (const k in m) seen.push(k);
    expect(seen).toEqual([]);
  });
});

describe("the two built-ins it deliberately does NOT supply", () => {
  it("leaves Uint8Array.prototype.toBase64 and Uint8Array.fromBase64 alone", () => {
    // Measured unreachable in Sard's configuration: toBase64 serves `createFontFaceRule`, the branch
    // taken only where the FontFace API is absent, plus signature compression; fromBase64 serves
    // signatures and XFA, and Sard does not enable XFA. Patching shared prototypes for paths nothing
    // reaches is exactly what the old gate got wrong in the other direction.
    expect(SOURCE).not.toMatch(/install\(\s*Uint8Array\.prototype\s*,\s*"toBase64"/);
    expect(SOURCE).not.toMatch(/install\(\s*Uint8Array\s*,\s*"fromBase64"/);
  });

  it("says why, so the next person does not undo the omission", () => {
    expect(SOURCE).toMatch(/WHAT IS DELIBERATELY NOT HERE/);
  });
});

describe("delivery — both realms, in the right order", () => {
  it("the page gets it from index.html BEFORE the application bundle", () => {
    const compat = INDEX_HTML.indexOf("sard-pdf-compat.mjs");
    const bundle = INDEX_HTML.indexOf("/src/main.tsx");
    expect(compat, "the layer must be referenced by index.html").toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(-1);
    expect(compat, "the layer must come first, or the capability probe measures the wrong thing").toBeLessThan(bundle);
  });

  it("and it is in the HEAD, which is what makes that survive the build", () => {
    // THE BUG THIS PINS, found by building and reading the output rather than by reasoning: a body
    // script precedes the bundle in the SOURCE, but `vite build` lifts the application bundle into
    // the head and leaves the body script behind it. Measured in dist/index.html before the fix:
    // bundle on line 7, layer on line 19 — inverted in the built product only, where it matters.
    const headEnd = INDEX_HTML.indexOf("</head>");
    const compat = INDEX_HTML.indexOf("sard-pdf-compat.mjs");
    expect(headEnd).toBeGreaterThan(-1);
    expect(compat, "the layer must sit inside <head>").toBeLessThan(headEnd);
  });

  it("the BUILT page keeps the order, when a build is present to check", () => {
    // Conditional on purpose: `dist/` is a build artifact and is not always there. When it is, it is
    // the only direct evidence of what a reader's copy actually does.
    const dist = resolve(ROOT, "dist/index.html");
    if (!existsSync(dist)) return;
    const built = readFileSync(dist, "utf8");
    const compat = built.indexOf("sard-pdf-compat.mjs");
    const bundle = built.search(/<script[^>]+src="\/assets\/index-[^"]+\.js"/);
    expect(compat, "the built page must still load the layer").toBeGreaterThan(-1);
    if (bundle === -1) return; // a build without a hashed entry chunk — nothing to order against
    expect(compat, "the built page must load the layer before the application bundle").toBeLessThan(bundle);
  });

  it("the worker entry imports the layer BEFORE the vendored worker", () => {
    const compat = WORKER_ENTRY.indexOf('import "./sard-pdf-compat.mjs"');
    const vendored = WORKER_ENTRY.indexOf('import "./vendor/pdfjs/pdf.worker.mjs"');
    expect(compat).toBeGreaterThan(-1);
    expect(vendored).toBeGreaterThan(-1);
    expect(compat).toBeLessThan(vendored);
  });

  it("pdf.js points the worker at Sard's entry, not the bare vendored worker", () => {
    // Pointing at the vendored worker leaves the worker realm unguarded, and that is where the
    // silent hang lives.
    expect(PDF_ADAPTER).toMatch(/workerSrc = new URL\('sard-pdf-worker\.mjs', import\.meta\.url\)/);
    expect(PDF_ADAPTER).not.toMatch(/workerSrc = pdfjsPath\('pdf\.worker\.mjs'\)/);
  });

  it("the vendored worker is untouched — the layer is imported, never concatenated in", () => {
    const vendored = readFileSync(resolve(ROOT, "public/foliate-js/vendor/pdfjs/pdf.worker.mjs"), "utf8");
    expect(vendored).not.toMatch(/sard-pdf-compat/);
    expect(vendored.length).toBeGreaterThan(1_000_000);
  });
});

describe("the gate and the layer cannot drift apart", () => {
  // THE HOLE THIS CLOSES, found by mutation testing. Nothing else ties `runtime.ts`'s PDF list to
  // what pdf.js actually needs: deleting `promiseTry` from the gate, or adding a built-in pdf.js
  // never calls, left every other test green. Both are exactly the errors the old gate had.
  //
  // The layer is the single place that declares "pdf.js needs this", because it is the thing that
  // supplies it. So the gate is required to check precisely what the layer supplies — no more, and
  // no less — with one documented exception.
  //
  // `URL.parse` is that exception: its absence costs the worker, not correctness (pdf.js falls back
  // to main-thread parsing and still renders), so it is supplied but deliberately not gated. Listing
  // it here is what keeps that a decision rather than an oversight.
  const UNGATED_BY_DESIGN = ["URL.parse"];

  /**
   * Every built-in the layer guards, read from its own source.
   *
   * The name must be DOTTED. The layer also type-checks its own `callbackfn` argument with the same
   * `typeof ... !== "function"` shape, and a looser pattern swept that up as though it were a
   * built-in Sard supplies — which it is not.
   */
  const supplied = () =>
    [...SOURCE.matchAll(/if \(typeof ([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+) !== "function"\)/g)].map((m) => m[1]);

  it("supplies a non-trivial set of built-ins", () => {
    expect(supplied().length).toBeGreaterThanOrEqual(5);
  });

  it("gates exactly what it supplies, minus the documented exception", () => {
    const gated = CAPABILITY_FEATURES.pdf.map((f) => FEATURE_LABELS[f]).sort();
    const shouldGate = supplied().filter((n) => !UNGATED_BY_DESIGN.includes(n)).sort();
    expect(gated, "the gate must check every built-in the layer exists to supply").toEqual(shouldGate);
  });

  it("the documented exception really is supplied but not gated", () => {
    for (const name of UNGATED_BY_DESIGN) {
      expect(supplied(), `${name} should still be supplied`).toContain(name);
      expect(CAPABILITY_FEATURES.pdf.map((f) => FEATURE_LABELS[f]), `${name} must not be gated`).not.toContain(name);
    }
  });

  it("every gated PDF feature has a label, and every label a probe", () => {
    for (const f of CAPABILITY_FEATURES.pdf) {
      expect(FEATURE_LABELS[f], `${f} needs a human-readable label`).toBeTruthy();
      expect(Object.keys(readEnv()), `${f} must be probed by readEnv()`).toContain(f);
    }
  });
});
