// P7-B — navigation must never throw because the view is not loaded.
//
// WHAT THIS CAN AND CANNOT PROVE. Like `readerSurface.test.ts`, this reads `FoliateController.ts` as
// a FILE. It cannot prove the reader survives an arrow key — a CDP suite in the private harness does
// that against the real application. What it defends is the INVARIANT that produced the defect, and
// which no type or lint rule can see: that a page turn is guarded on the view being LOADED, not
// merely on the view EXISTING.
//
// The distinction is the whole bug. `this.view?.prev?.()` looks like a guard and is not one: `prev`
// is a prototype method on foliate's `View extends HTMLElement`, so it exists from `createElement`,
// and its body dereferences a `renderer` that only the awaited open creates. Both optional chains
// pass, and the call throws `TypeError: Cannot read properties of undefined (reading 'prev')`.
//
// So an edit that "simplifies" `navView()` back to `this.view` would restore the defect while still
// looking guarded. This test is what notices.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "reader-engine", "FoliateController.ts"),
  "utf8",
);
const NL = String.fromCharCode(10);

/** The body of a named method, from its signature to the first closing brace at class indentation. */
function methodBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  expect(at, signature + " should exist").toBeGreaterThan(-1);
  const rest = source.slice(at);
  const end = rest.indexOf(NL + "  }");
  return rest.slice(0, end === -1 ? 400 : end);
}

describe("the page-turn guard asks whether the view is LOADED", () => {
  it("forward() and backward() go through navView(), never through this.view directly", () => {
    for (const sig of ["forward(): void {", "backward(): void {"]) {
      const body = methodBody(SRC, sig);
      expect(body, sig + " must ask navView()").toContain("this.navView()");
      // The defect, exactly: reaching the element and trusting optional chaining to mean "loaded".
      expect(body).not.toContain("this.view?.next");
      expect(body).not.toContain("this.view?.prev");
    }
  });

  it("navView() requires BOTH the readiness flag and a live renderer", () => {
    const body = methodBody(SRC, "private navView(): any | null {");
    expect(body).toContain("this.navReady");
    // `renderer` is what every page turn ultimately reaches, so re-checking it here means a view
    // disposed between the flag being set and this being read cannot slip through.
    expect(body).toContain("renderer");
  });
});

describe("readiness is claimed at the right moments, and only there", () => {
  it("open() starts un-navigable, even though it claims the view immediately", () => {
    const at = SRC.indexOf("this.view = view;");
    expect(at).toBeGreaterThan(-1);
    // Within a couple of lines of claiming ownership, readiness must be withdrawn.
    expect(SRC.slice(at, at + 260)).toContain("this.navReady = false");
  });

  it("readiness is granted only AFTER the first render, not when the renderer appears", () => {
    // Granting it when `renderer` appeared would leave a SECOND window open: the renderer exists but
    // its sections do not, and an arrow there throws from inside foliate instead
    // (paginator.js:1062, `this.sections[index].load()`). Measured — both windows threw.
    const grant = SRC.indexOf("if (this.view === view) this.navReady = true;");
    const firstRender = SRC.indexOf("else await view.renderer.next();");
    expect(grant, "readiness must be granted somewhere").toBeGreaterThan(-1);
    expect(firstRender).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(firstRender);
  });

  it("a failed open releases the view instead of keeping a half-built one", () => {
    // The catch around `view.open()` must drop the element, so every OTHER `this.view?.…` member in
    // the class is safe after a failure too — not only the two paging methods.
    const at = SRC.indexOf('void diagProbeChain("view.open() threw");');
    expect(at).toBeGreaterThan(-1);
    const tail = SRC.slice(at, at + 900);
    expect(tail).toContain("this.view = null");
    expect(tail).toContain("this.navReady = false");
    expect(tail).toContain("throw e");
  });

  it("dispose() withdraws readiness with the view", () => {
    const body = methodBody(SRC, "dispose(): void {");
    expect(body).toContain("this.view = null");
    expect(body).toContain("this.navReady = false");
  });
});

describe("normal paging is not weakened to hide the exception", () => {
  it("nothing wraps a page turn in a bare try/catch", () => {
    for (const sig of ["forward(): void {", "backward(): void {"]) {
      expect(methodBody(SRC, sig)).not.toContain("try");
    }
  });

  it("handleNavKey still routes to forward/backward — the key path is unchanged", () => {
    const body = methodBody(SRC, "handleNavKey(key: string): boolean {");
    expect(body).toContain("this.forward()");
    expect(body).toContain("this.backward()");
  });
});
