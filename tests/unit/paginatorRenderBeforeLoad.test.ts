// PATCH 13 — the paginator must not lay out a view whose section has not loaded.
//
// WHAT THIS CAN AND CANNOT PROVE. `paginator.js` is VENDORED and has no test seam (see
// `paginatorTurnLock.test.ts` for the same limitation and the same answer). The behaviour — a first
// page in ~350 ms every time instead of ~3.5 s in one open out of three — was measured in a Blink
// WebView with a CPU profile and a trace. What runs here defends the shape of the fix against the one
// thing most likely to remove it: a re-vendor that quietly restores upstream's `if (!this.#view)`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "..", "public", "foliate-js", "paginator.js"),
  "utf8",
);

const after = (needle: string, chars = 600) => {
  const at = SRC.indexOf(needle);
  expect(at, needle + " should be present").toBeGreaterThan(-1);
  return SRC.slice(at, at + chars);
};

describe("13 — a render before the section has loaded is skipped, not applied to about:blank", () => {
  it("Paginator.render() guards on the view having LOADED, not merely existing", () => {
    // `#createView()` publishes the view before `load()` resolves, so existence proves nothing.
    // The patch's own comment quotes upstream's line; only the code is judged.
    const NL = String.fromCharCode(10);
    const code = after("    render() {", 2600).split(NL).filter((l) => !l.trim().startsWith("//")).join(NL);
    expect(code).toContain("if (!this.#view?.loaded) return");
    expect(code).not.toContain("if (!this.#view) return");
  });

  it("the flag is raised inside load(), immediately before the load's own render", () => {
    const body = after("async load(src, afterLoad, beforeRender) {", 1600);
    const flag = body.indexOf("this.#loaded = true");
    const render = body.indexOf("this.render(layout)");
    expect(flag, "the flag must be set in load()").toBeGreaterThan(-1);
    expect(render, "load() still renders once the document is there").toBeGreaterThan(-1);
    // Order is the point: the load's own render must not be the one that is skipped.
    expect(flag).toBeLessThan(render);
  });

  it("starts false and is read through a getter, so the paginator cannot forge it", () => {
    expect(SRC).toContain("#loaded = false");
    expect(after("get loaded() {", 80)).toContain("return this.#loaded");
    expect(SRC.split("this.#loaded = true").length - 1, "exactly one assignment, in load()").toBe(1);
  });
});
