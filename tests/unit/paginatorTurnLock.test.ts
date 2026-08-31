// PATCH 12 — the paginator must not throw at the ends of a book, and a throw must not be fatal.
//
// WHAT THIS CAN AND CANNOT PROVE. `paginator.js` is VENDORED and has no test seam: it is a custom
// element that needs a document, an iframe and a real book. So this reads it as a FILE, the way
// `readerSurface.test.ts` and `readerNavGuard.test.ts` do, and defends the two properties whose loss
// is otherwise invisible. The behaviour itself is proven by
// a private test-harness probe against the real application.
//
// It exists because this is VENDORED code. The single most likely way for this fix to disappear is a
// re-vendor that silently restores upstream — no compile error, no failing behaviour until a reader
// reaches the last page of a book. VENDOR.txt records the patch for a human; this fails the build.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "..", "public", "foliate-js", "paginator.js"),
  "utf8",
);
const NL = String.fromCharCode(10);

/** The source from a marker to the end of the enclosing method, roughly — enough to assert order. */
const after = (needle: string, chars = 900) => {
  const at = SRC.indexOf(needle);
  expect(at, needle + " should be present").toBeGreaterThan(-1);
  return SRC.slice(at, at + chars);
};

describe("12a — an out-of-range section index is refused, not dereferenced", () => {
  it("#goTo guards on #canGoToIndex before touching this.sections", () => {
    const body = after("async #goTo({ index, anchor, select}) {");
    const guard = body.indexOf("if (!this.#canGoToIndex(index)) return");
    const deref = body.indexOf("this.sections[index].load()");
    expect(guard, "the guard must exist").toBeGreaterThan(-1);
    expect(deref, "upstream's dereference is still there").toBeGreaterThan(-1);
    // Order is the whole point: a guard after the dereference guards nothing.
    expect(guard).toBeLessThan(deref);
  });

  it("it reuses upstream's own predicate rather than a second copy of the rule", () => {
    // `#canGoToIndex` already encodes "0 .. sections.length - 1", and already rejects `undefined`
    // and an empty sections array. Re-stating it would be a rule that can drift.
    expect(SRC).toContain("#canGoToIndex(index) {");
    expect(after("async #goTo({ index, anchor, select}) {", 200)).toContain("#canGoToIndex");
  });

  it("#adjacentIndex is still the upstream one that can return undefined", () => {
    // If someone "fixes" this by making #adjacentIndex clamp instead, 12a becomes dead code AND the
    // ends of the book start behaving differently (clamping would re-enter the current section).
    const body = after("#adjacentIndex(dir) {", 220);
    expect(body).toContain("for (let index = this.#index + dir");
    expect(body).not.toContain("Math.max");
    expect(body).not.toContain("Math.min");
  });
});

describe("12b — the turn lock is released even when the body rejects", () => {
  it("#turnPage releases #locked in a finally", () => {
    const body = after("async #turnPage(dir, distance) {", 1400);
    expect(body).toContain("try {");
    expect(body).toContain("} finally {");
    // The release must be INSIDE the finally, not merely somewhere after the try.
    const fin = body.indexOf("} finally {");
    const release = body.indexOf("this.#locked = false", fin);
    expect(fin).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(fin);
  });

  it("the awaits that can reject are inside the try", () => {
    const body = after("async #turnPage(dir, distance) {", 1400);
    const tryAt = body.indexOf("try {");
    const fin = body.indexOf("} finally {");
    for (const call of ["this.#scrollPrev(distance)", "this.#scrollNext(distance)", "await this.#goTo({"]) {
      const at = body.indexOf(call);
      expect(at, call + " must be inside the try").toBeGreaterThan(tryAt);
      expect(at).toBeLessThan(fin);
    }
  });

  it("PATCH 5's depth-one turn coalescing survives, and still runs after the unlock", () => {
    // The pending replay must NOT be inside the finally: it re-enters #turnPage, and re-entering
    // while the lock is still held would simply re-queue itself.
    const body = after("async #turnPage(dir, distance) {", 1400);
    const fin = body.indexOf("} finally {");
    const closeFin = body.indexOf("}", body.indexOf("this.#locked = false", fin));
    const pending = body.indexOf("const pending = this.#pendingTurn");
    expect(pending, "patch 5 must still be here").toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(closeFin);
    expect(body).toContain("this.#pendingTurn = { dir, distance }");
  });
});

describe("the patch is registered where a re-vendor will look", () => {
  it("VENDOR.txt carries an entry 12 naming both halves", () => {
    const vendor = readFileSync(
      join(import.meta.dirname, "..", "..", "public", "foliate-js", "VENDOR.txt"),
      "utf8",
    );
    expect(vendor).toContain("12. paginator.js");
    expect(vendor).toContain("12a");
    expect(vendor).toContain("12b");
    // The convention every other entry follows, and the one that matters most on a re-vendor.
    const entry = vendor.slice(vendor.indexOf("12. paginator.js"));
    expect(entry).toContain("IF THIS PATCH IS LOST ON A RE-VENDOR");
    expect(entry).toContain("Regression test:");
  });

  it("both markers are in the source, so a diff shows them", () => {
    expect(SRC).toContain("SARD LOCAL PATCH 12a");
    expect(SRC).toContain("SARD LOCAL PATCH 12b");
    expect(SRC).toContain("end SARD LOCAL PATCH 12b");
  });
});
