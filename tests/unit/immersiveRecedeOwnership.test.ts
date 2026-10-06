// WHO OWNS THE IMMERSIVE RECEDE: the Immersive Mode flag, not the worn هيئة.
//
// THE DEFECT. The recede has two steps — +4px of blur and +14% of scrim — and `applyBackgrounds`
// used to neutralise BOTH of them (`--bg-rd-immstep: 0px`, `--bg-rd-immscrim: 0%`) whenever the
// ACTIVE هيئة's `bg.reading.params.immersiveBlur` was false. `applyProfile` writes
// `bg_reading_params` and then re-runs `initBackground` → `applyBackgrounds`, so wearing a هيئة
// re-answered "should immersive dim the page?" for the reader. MEASURED on the rendered desk with
// Immersive ON the whole time: the receded scrim went 54.4% → 68.4% under one هيئة and 24% → 24%
// under the next, and the receded blur 1px → 5px then 1px → 1px.
//
// WHAT THIS GUARDS. There is no DOM environment in this suite (no jsdom), and `applyBackgrounds`
// writes custom properties on `:root` from the live store — so the ownership is guarded the way
// this repo guards its other CSS/DOM invariants, by reading the sources, exactly as
// `readerBackgroundOverlay.test.ts` says it does for the overlay. The behaviour itself was verified
// against the running application in a disposable sandbox.
//
// The point of each assertion is a property that is INVISIBLE if it breaks: a reinstated gate would
// compile, every other test would pass, and the effect would simply start obeying the look again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProfileData } from "../../src/features/profiles/model/profile";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const BG = read("src/lib/background.ts");
const CSS = read("src/styles/global.css");
const PROFILE = read("src/features/profiles/model/profile.ts");

/** The body of `applyBackgrounds`, which is the only place the step properties are written. */
const applyBody = (() => {
  const from = BG.indexOf("export function applyBackgrounds(");
  expect(from, "applyBackgrounds should be present").toBeGreaterThan(-1);
  const to = BG.indexOf("\nexport ", from + 10);
  return BG.slice(from, to > from ? to : undefined);
})();

describe("the immersive recede is gated by Immersive Mode alone", () => {
  it("applyBackgrounds never writes the step properties", () => {
    // Writing either one is how the هيئة used to overrule the reader. Removing them is allowed —
    // that is what clears a stale pair left on :root by a previously-worn هيئة.
    expect(applyBody).not.toContain('setProperty("--bg-rd-immstep"');
    expect(applyBody).not.toContain('setProperty("--bg-rd-immscrim"');
    expect(applyBody).toContain('removeProperty("--bg-rd-immstep")');
    expect(applyBody).toContain('removeProperty("--bg-rd-immscrim")');
  });

  it("the هيئة's immersiveBlur has no say in applyBackgrounds at all", () => {
    // Not merely "not used as a gate": absent from the CODE. The prose above the removals still
    // names the field, to say that it is retained for compatibility — so comments are stripped
    // before asking, or this guard would fail on its own explanation.
    const NL = String.fromCharCode(10);
    const code = applyBody.split(NL).filter((l) => !l.trim().startsWith("//")).join(NL);
    expect(code).not.toContain("immersiveBlur");
  });

  it("both step properties are cleared unconditionally, so nothing leaks between هيئات", () => {
    // Guards the specific regression of making the removal conditional again: the two removals must
    // not sit inside a branch that tests the reading params.
    const step = applyBody.indexOf('removeProperty("--bg-rd-immstep")');
    const before = applyBody.slice(Math.max(0, step - 400), step);
    expect(before).not.toMatch(/if\s*\([^)]*immersive/i);
    expect(before).not.toMatch(/if\s*\([^)]*\bp\.\w*[Bb]lur/);
  });
});

describe("the gate that remains is the global Immersive state", () => {
  it("both recede steps require .reader-root.immersive.scrolled-away", () => {
    // This is what makes "Immersive OFF never dims" true without any JavaScript: the selectors
    // cannot match. If either loses `.immersive`, switching appearance could dim a non-immersive
    // read, which is the opposite failure.
    // FURTHER CLASSES ON THE SAME COMPOUND ARE TOLERATED, deliberately. A later task made the
    // dimming its own preference and added a third gate (`.im-dim`) to both selectors; pinning the
    // exact selector text would fail that change while every property THIS test exists to protect
    // still held. What is asserted here is the REQUIREMENT — immersive, and deliberately scrolled
    // away — not the complete class list. The extra gate has its own cover in
    // `immersiveBackgroundDimming.test.ts`, which pins the full compound and the four-case table.
    const NL2 = String.fromCharCode(10);
    const ruleLine = (ending: string): string => {
      const found = CSS.split(NL2).filter(
        (l) => l.includes(".reader-root.immersive.scrolled-away") && l.trimEnd().endsWith(ending),
      );
      expect(found.length, `exactly one rule should end "${ending}"`).toBe(1);
      return found[0];
    };
    const scrim = ruleLine(".reader-desk {");
    const blur = ruleLine(".reader-desk::before {");
    expect(CSS.slice(CSS.indexOf(scrim), CSS.indexOf(scrim) + scrim.length + 220)).toContain("--bg-rd-scrim: calc(");
    expect(CSS.slice(CSS.indexOf(blur), CSS.indexOf(blur) + blur.length + 220)).toContain("--bg-rd-immstep");

    // And both are additionally gated on a wallpaper actually being bound, which is why an
    // appearance with no reading image still dims nothing.
    expect(scrim).toContain('[data-bg-reading="on"]');
    expect(blur).toContain('[data-bg-reading="on"]');
  });

  it("the amounts and the transition are unchanged", () => {
    // This task moved ownership, not values. The stylesheet fallbacks ARE the shipped defaults now
    // that JavaScript no longer writes the pair.
    expect(CSS).toContain("var(--bg-rd-immstep, 4px)");
    expect(CSS).toContain("var(--bg-rd-immscrim, 14%)");
    expect(CSS).toMatch(/transition:\s*--bg-rd-scrim\s+220ms/);
  });
});

describe("what the هيئة still owns", () => {
  it("the base scrim is still derived from the appearance's presence", () => {
    // The recede composes ON TOP of this. If it stopped being written per-appearance, changing
    // appearance would stop changing the wallpaper's treatment.
    expect(applyBody).toContain('setProperty("--bg-rd-scrim-base"');
    expect(applyBody).toMatch(/scrimAlpha\(\s*p\.presence/);
    for (const v of ["--bg-rd-image", "--bg-rd-blur", "--bg-rd-flip", "--bg-rd-pos"]) {
      expect(applyBody).toContain(`setProperty("${v}"`);
    }
  });

  it("immersiveBlur is still parsed and still stored, so nothing migrates", () => {
    // Compatibility was explicit: existing هيئات and packages keep the field. It simply no longer
    // gates anything. Exercised through the real parser rather than asserted about the source.
    const parsed = parseProfileData("{}");
    expect(typeof parsed.bg.reading.params.immersiveBlur).toBe("boolean");
    const kept = parseProfileData(JSON.stringify({ bg: { reading: { params: { immersiveBlur: false } } } }));
    expect(kept.bg.reading.params.immersiveBlur).toBe(false);
    expect(PROFILE).toContain("immersiveBlur");
  });
});
