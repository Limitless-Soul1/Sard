// The reading chrome is revealed by a window-level `pointerdown`, and a page turn must not be one of
// them. There is no DOM in this suite, so the rule is pinned the way the window-frame tests pin CSS:
// by reading BOTH halves and asserting they still agree. The half that renders the control and the half
// that decides whether a press reveals the bar are in different files, which is exactly the shape that
// drifts — a renamed class would silently restore the defect with every test still green.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const hook = readFileSync(join(root, "src/features/reader/useChromeOnIntent.ts"), "utf8");
const reader = readFileSync(join(root, "src/features/reader/Reader.tsx"), "utf8");

/** The body of the window `pointerdown` handler — the only place a press can force the bar open. */
const onTap = (() => {
  const at = hook.indexOf("const onTap =");
  expect(at, "useChromeOnIntent no longer defines onTap").toBeGreaterThan(-1);
  return hook.slice(at, hook.indexOf("window.addEventListener", at));
})();

describe("reading chrome · a page turn is not a request for the toolbar", () => {
  it("exempts the page-turn controls from the forced reveal", () => {
    // MEASURED before this guard: in a PDF in Pages mode with the bars parked (top bar at y=-38, bottom
    // at the viewport edge), pressing the next-page chevron put them back on screen (top bar to y=32)
    // on the first press and on every one of a consecutive run, while the page itself turned correctly.
    expect(onTap).toMatch(/closest\?\.\(["'`]\.page-chevron["'`]\)/);
  });

  it("only ARMS on an exempt press, so a visible bar keeps its countdown and a hidden one stays hidden", () => {
    // The exemption must suppress the reveal, not the liveness: `arm()` on the guarded path, `wake()`
    // only on the unguarded one. A guard that called `wake()` would be no guard at all.
    const guarded = onTap.slice(0, onTap.indexOf("}", onTap.indexOf("arm()")));
    expect(guarded).toContain("arm()");
    expect(guarded).not.toContain("wake()");
    expect(onTap).toContain("wake()"); // an ordinary press still reveals
  });

  it("names a class the reader actually renders on both chevrons", () => {
    // The guard is a selector; if the control's class changed, the guard would quietly stop matching.
    const classes = [...reader.matchAll(/className="(page-chevron[^"]*)"/g)].map((m) => m[1]);
    expect(classes.length, "Reader no longer renders page-chevron buttons").toBeGreaterThanOrEqual(2);
    for (const c of classes) expect(c.split(/\s+/)).toContain("page-chevron");
    // …and both directions are covered by the single class the guard names.
    expect(classes.some((c) => c.includes("page-chevron-left"))).toBe(true);
    expect(classes.some((c) => c.includes("page-chevron-right"))).toBe(true);
  });

  it("leaves the Contents exemption and the keyboard rule as they were", () => {
    // Two neighbours of this guard that must not be disturbed: the RAWY-298 Contents exemption, and
    // RAWY-194's removal of wake-on-keydown, which is why keyboard paging already left the bars alone.
    expect(onTap).toContain('.reader-panel.rp-lead:not(.search-panel)');
    expect(hook).not.toMatch(/addEventListener\(\s*["'`]keydown["'`]/);
  });

  it("reveals on a press anywhere else, including the page itself", () => {
    // The guard is an exemption list, not an inversion: anything that is not on it still wakes. Tapping
    // the page is the deliberate "show me the controls" gesture and must keep working.
    expect(onTap).not.toMatch(/\.page-sheet/);
    expect(onTap).not.toMatch(/\.reader-root/);
  });
});
