// BACKGROUND DIMMING IS ITS OWN PREFERENCE — independent of Immersive Mode, and of the هيئة.
//
// WHAT CHANGED. The immersive recede (+14% scrim, +4px blur on the reading wallpaper) used to be
// unconditional: entering the receded state applied it, and the only say anyone had over it was the
// active هيئة's `bg.reading.params.immersiveBlur` — which is the coupling the previous commit
// removed. The recede is now gated on a third class, `.im-dim`, which the Reader renders from a
// preference of its own. Immersive Mode and "dim the background" are two things a reader can want
// separately, and the interesting case is the one that was previously unreachable: immersive ON with
// the picture left exactly as it was set.
//
// WHAT THESE TESTS ARE. Two layers, deliberately:
//
//   · REAL CODE where it can run headless — the store's default, its setter, and `initTheme`'s
//     hydration (with only the DOM-touching leaf, `applyTheme`, stubbed). The migration promise
//     "an existing reader keeps the dimming they already had" IS the hydration of a missing key, so
//     it is tested by running the real hydration rather than by reading the line that does it.
//   · SOURCE-LEVEL for the part that is a stylesheet gate and a class name. There is no DOM in this
//     suite (vitest.config.ts: environment `node`, deliberately — a shim would pass while lying
//     about WebView2), so the selector/class contract is asserted the way this repo asserts its
//     other CSS invariants: by reading the sources. The rendered result was verified against the
//     running application in a disposable sandbox.
//
// Every assertion here is a property that is INVISIBLE if it breaks: a selector that loses `.im-dim`
// still compiles, still passes every other test, and simply makes the preference do nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The settings table, faked, and the writes it receives — so persistence can be asserted rather
// than assumed. `importOriginal` keeps every OTHER export of the module real; only the two calls
// that would reach Tauri are replaced.
const { ROWS, WRITES } = vi.hoisted(() => ({
  ROWS: new Map<string, string>(),
  WRITES: [] as Array<[string, string]>,
}));
vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  settingsGet: async (k: string) => ROWS.get(k) ?? null,
  settingsSet: async (k: string, v: string) => { WRITES.push([k, v]); ROWS.set(k, v); return true; },
}));
// `applyTheme` writes custom properties on `document.documentElement`, which does not exist here.
// Stubbing that ONE leaf is what lets the real `initTheme` run; nothing about the preference's
// hydration lives inside it. This is not a DOM shim — no test here claims anything about rendering.
vi.mock("../../src/theme/applyTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/theme/applyTheme")>()),
  applyTheme: vi.fn(),
}));

import { initTheme, useTheme } from "../../src/theme/store";
import { PROFILE_WRITES, parseProfileData, profileSettings, type Profile } from "../../src/features/profiles/model/profile";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";
import type { CustomThemeId } from "../../src/theme/tokens";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const CSS = read("src/styles/global.css");
const READER = read("src/features/reader/Reader.tsx");
const PANEL = read("src/features/reader/ReadingSettings.tsx");
const STORE = read("src/theme/store.ts");
const BG = read("src/lib/background.ts");

const NEWLINE = String.fromCharCode(10);

/** The settings key, named once here so a rename has to be deliberate in both places. */
const KEY = "immersive_dim";

beforeEach(() => { ROWS.clear(); WRITES.length = 0; });

describe("the preference itself", () => {
  it("defaults ON, which is what keeps every existing reader unchanged", () => {
    // The recede WAS unconditional. ON is therefore not a taste: it is the behaviour an existing
    // reader already has, and the only default that makes this release invisible to them.
    expect(useTheme.getState().immersiveDim).toBe(true);
  });

  it("a missing row reads as ON, so nothing has to migrate", async () => {
    // The whole compatibility story, executed rather than described: no `immersive_dim` row exists
    // in any database written before this build.
    expect(ROWS.has(KEY)).toBe(false);
    await initTheme();
    expect(useTheme.getState().immersiveDim).toBe(true);
  });

  it("hydrates both explicit values", async () => {
    ROWS.set(KEY, "0");
    await initTheme();
    expect(useTheme.getState().immersiveDim).toBe(false);
    ROWS.set(KEY, "1");
    await initTheme();
    expect(useTheme.getState().immersiveDim).toBe(true);
  });

  it("persists under its own key, and touches nothing else", () => {
    useTheme.getState().setImmersiveDim(false);
    expect(useTheme.getState().immersiveDim).toBe(false);
    expect(WRITES).toEqual([[KEY, "0"]]);
    useTheme.getState().setImmersiveDim(true);
    expect(WRITES).toEqual([[KEY, "0"], [KEY, "1"]]);
    // Specifically NOT the immersive key. Writing through `immersive_scroll` is how the two would
    // become one preference again.
    expect(WRITES.map(([k]) => k)).not.toContain("immersive_scroll");
  });

  it("is a separate row from Immersive Mode, and the two hydrate independently", async () => {
    // THE CASE THIS TASK EXISTS FOR: immersive on, dimming off. It was previously unreachable.
    ROWS.set("immersive_scroll", "1");
    ROWS.set(KEY, "0");
    await initTheme();
    expect(useTheme.getState().immersive).toBe(true);
    expect(useTheme.getState().immersiveDim).toBe(false);
    // And the mirror image, so neither key is secretly reading the other.
    ROWS.set("immersive_scroll", "0");
    ROWS.set(KEY, "1");
    await initTheme();
    expect(useTheme.getState().immersive).toBe(false);
    expect(useTheme.getState().immersiveDim).toBe(true);
  });

  it("setting one never moves the other, in either direction", () => {
    // EACH CASE STARTS FROM A STATE THE COUPLING WOULD CHANGE. Asserting a value that already
    // equals what a coupled setter would write proves nothing — the first version of this test
    // did exactly that and a mutation walked straight through it.
    useTheme.setState({ immersive: true, immersiveDim: true });
    useTheme.getState().setImmersive(false);
    expect(useTheme.getState().immersiveDim, "immersive OFF must not take the dimming with it").toBe(true);
    useTheme.setState({ immersive: false, immersiveDim: false });
    useTheme.getState().setImmersive(true);
    expect(useTheme.getState().immersiveDim, "immersive ON must not switch the dimming on").toBe(false);
    useTheme.setState({ immersive: true, immersiveDim: true });
    useTheme.getState().setImmersiveDim(false);
    expect(useTheme.getState().immersive, "the dimming OFF must not leave immersive").toBe(true);
    useTheme.setState({ immersive: false, immersiveDim: false });
    useTheme.getState().setImmersiveDim(true);
    expect(useTheme.getState().immersive, "the dimming ON must not enter immersive").toBe(false);
  });
});

describe("no Appearance can reach it", () => {
  const profile = (): Profile => ({
    id: "u:test" as CustomThemeId,
    name: "مَساء",
    description: null,
    author: null,
    iconKind: "seal",
    iconRef: null,
    derivedFrom: "moonlit",
    createdAt: 1,
    updatedAt: 1,
    data: parseProfileData(JSON.stringify({ theme: { base: "moonlit" } })),
  });

  it("the key is not one a هيئة writes", () => {
    // `PROFILE_WRITES` is the authoritative list of settings an apply may touch, and a test
    // elsewhere snapshots the table around a real apply against it. Absence here is therefore the
    // whole proof that wearing a look cannot move this preference.
    expect(PROFILE_WRITES as readonly string[]).not.toContain(KEY);
    expect(profileSettings(profile()).map(([k]) => k)).not.toContain(KEY);
  });

  it("the هيئة's immersiveBlur is still parsed and still stored, so nothing migrates", () => {
    // Compatibility was explicit: existing هيئات and packages keep the field. It governs nothing
    // now — not the recede (previous commit) and not this preference — but it still round-trips.
    expect(typeof parseProfileData("{}").bg.reading.params.immersiveBlur).toBe("boolean");
    const kept = parseProfileData(JSON.stringify({ bg: { reading: { params: { immersiveBlur: false } } } }));
    expect(kept.bg.reading.params.immersiveBlur).toBe(false);
  });

  it("background.ts does not import the theme store", () => {
    // The architectural requirement, stated as an assertion. `applyBackgrounds` runs on every apply
    // and on startup; reading the preference from there would make the look a participant again and
    // would invite an import cycle. It may NAME the store in a comment — the explanation of the
    // previous fix does — so this reads the import lines only.
    const imports = BG.split(NEWLINE).filter((l) => l.startsWith("import ") || l.trim().startsWith("} from "));
    expect(imports.join(NEWLINE)).not.toContain("theme/store");
    expect(imports.join(NEWLINE)).not.toContain("useTheme");
  });

  it("applyBackgrounds still writes neither step property (the previous fix is intact)", () => {
    const from = BG.indexOf("export function applyBackgrounds(");
    expect(from).toBeGreaterThan(-1);
    const to = BG.indexOf(NEWLINE + "export ", from + 10);
    const applyBody = BG.slice(from, to > from ? to : undefined);
    expect(applyBody).not.toContain('setProperty("--bg-rd-immstep"');
    expect(applyBody).not.toContain('setProperty("--bg-rd-immscrim"');
    expect(applyBody).toContain('removeProperty("--bg-rd-immstep")');
    expect(applyBody).toContain('removeProperty("--bg-rd-immscrim")');
    // And no second owner was introduced from this side either.
    expect(applyBody).not.toContain("immersiveDim");
    expect(applyBody).not.toContain("im-dim");
  });

  it("the store writes no CSS, so the gate has exactly one owner", () => {
    // If the setter also poked `:root`, it would race `applyBackgrounds` and the two would disagree
    // on whichever ran last. The gate is a class; the class comes from this flag; that is all.
    // Read as CODE: the prose above the setter legitimately names what it must not do.
    const code = STORE.split(NEWLINE).filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join(NEWLINE);
    expect(code).not.toContain("--bg-rd-imm");
    expect(code).not.toContain("setProperty");
  });
});

// ---- the gate, as a four-case table ------------------------------------------------------------
//
// The CSS selector IS the behaviour, so the cases are decided by matching the classes the Reader
// emits against the classes the selector demands — not by restating the expected outcome in prose.
// A selector that loses `.im-dim` fails rows 2 and 4; one that loses `.immersive` fails row 4.

/** The classes the Reader puts on `.reader-root` for a given state (the three that matter here). */
const emitted = (s: { immersive: boolean; dim: boolean; scrolledAway: boolean }): Set<string> => {
  const out = new Set(["reader-root"]);
  if (s.immersive) out.add("immersive");
  if (s.scrolledAway) out.add("scrolled-away");
  if (s.dim) out.add("im-dim");
  return out;
};

/** The classes a selector's `.reader-root` compound requires, in source order. */
const required = (selector: string): string[] => {
  const compound = selector.trim().split(" ").find((p) => p.includes(".reader-root"));
  expect(compound, selector).toBeDefined();
  return compound!.split(".").filter((c) => c && !c.startsWith(":root"));
};

/** Every recede rule: the two that carry the steps, found by what they do, not by line number. */
const recedeSelectors = (): string[] =>
  CSS.split(NEWLINE).filter((l) => l.startsWith(':root[data-bg-reading="on"] .reader-root.immersive.scrolled-away'));

describe("the stylesheet gate", () => {
  it("mirrors the Reader's own conditionals, so the model below cannot drift", () => {
    // `emitted` is a hand-written mirror of one template literal. These three assertions are what
    // keep it honest: if the Reader stops rendering a class, or renders it from a different flag,
    // the mirror stops matching the source and this fails first.
    expect(READER).toContain('${immersive ? " immersive" : ""}');
    expect(READER).toContain('${immersiveDim ? " im-dim" : ""}');
    expect(READER).toContain('${scrolledAway && !chromeShown ? " scrolled-away" : ""}');
    // And that the flag comes from the theme store, not from the reading style — a per-book
    // typography field would make it an Appearance-adjacent value again.
    expect(READER).toMatch(/const \{[^}]*immersiveDim[^}]*\} = useTheme\(\)/);
    expect(READER).not.toContain("style?.immDim");
  });

  it("exactly two rules carry the recede, and both demand all three classes", () => {
    const rules = recedeSelectors();
    expect(rules.length, rules.join(" | ")).toBe(2);
    for (const r of rules) {
      expect(required(r).sort()).toEqual(["im-dim", "immersive", "reader-root", "scrolled-away"]);
      // Both are additionally gated on a wallpaper actually being bound, which is why an appearance
      // with no reading picture dims nothing regardless of the preference.
      expect(r).toContain('[data-bg-reading="on"]');
    }
    // One is the blur step and one is the scrim step — not two copies of the same half.
    const bodies = rules.map((r) => CSS.slice(CSS.indexOf(r), CSS.indexOf(r) + r.length + 140));
    expect(bodies.some((b) => b.includes("--bg-rd-immstep"))).toBe(true);
    expect(bodies.some((b) => b.includes("--bg-rd-immscrim"))).toBe(true);
  });

  for (const c of [
    { name: "immersive OFF, dimming OFF — nothing recedes", immersive: false, dim: false, dims: false },
    { name: "immersive ON, dimming OFF — the new case: quiet chrome, untouched picture", immersive: true, dim: false, dims: false },
    { name: "immersive ON, dimming ON — today's behaviour, preserved", immersive: true, dim: true, dims: true },
    { name: "immersive OFF, dimming ON — no immersive, so nothing recedes", immersive: false, dim: true, dims: false },
  ]) {
    it(c.name, () => {
      const classes = emitted({ immersive: c.immersive, dim: c.dim, scrolledAway: true });
      const matches = recedeSelectors().map((r) => required(r).every((k) => classes.has(k)));
      // Both halves of the recede answer together — a state where the scrim steps but the blur does
      // not would be a half-applied preference.
      expect(new Set(matches).size, matches.join(",")).toBe(1);
      expect(matches[0]).toBe(c.dims);
    });
  }

  it("and nothing recedes before the reader has deliberately scrolled away", () => {
    // `.scrolled-away` is set only on a deliberate wheel scroll (RAWY-211), never by the ordinary
    // chrome auto-hide. The preference does not relax that.
    const classes = emitted({ immersive: true, dim: true, scrolledAway: false });
    for (const r of recedeSelectors()) expect(required(r).every((k) => classes.has(k))).toBe(false);
  });

  it("the amounts are unchanged — this task moved the decision, not the values", () => {
    expect(CSS).toContain("var(--bg-rd-immstep, 4px)");
    expect(CSS).toContain("var(--bg-rd-immscrim, 14%)");
    expect(CSS).toMatch(/transition:\s*--bg-rd-scrim\s+220ms/);
  });

  it("the transition stays ungated, so turning the preference off eases instead of snapping", () => {
    // Deliberate: the rule describes HOW the filter moves if it moves at all. Gating it would make
    // a mid-session toggle jump, and an unmatched filter change costs nothing to have described.
    const t = ':root[data-bg-reading="on"] .reader-root.immersive .reader-desk::before {';
    expect(CSS).toContain(t);
    expect(CSS.slice(CSS.indexOf(t), CSS.indexOf(t) + 200)).toContain("transition: filter 220ms");
  });

  it("the hover-preview rules went with the retired \"extra blur\" control they belonged to", () => {
    // This test used to pin them in place, because the task that added this preference was not the
    // one to retire that control. It has since been retired (see legacyImmersiveBlurControl.test.ts),
    // and nothing else ever raised `data-bg-imm-preview`, so rules for it would only be dead weight.
    // The recede rules themselves are asserted above and are untouched.
    expect(CSS).not.toContain("data-bg-imm-preview");
  });
});

describe("the control the reader sees", () => {
  it("is a sub-toggle of Immersive Mode, bound to the store and not to the reading style", () => {
    const row = PANEL.split(NEWLINE).find((l) => l.includes('t("type.immDim")'));
    expect(row, "the Background Dimming row should be present").toBeDefined();
    expect(row!).toContain("on={immersiveDim}");
    expect(row!).toContain("setImmersiveDim(!immersiveDim)");
    // Inert while the master is off, in the same treatment its two siblings already use.
    expect(row!).toContain("sub disabled={!immersive}");
    // NOT through `update` — that is the per-book typography channel, and this is a global flag.
    expect(row!).not.toContain("update(");
  });

  it("sits with the other immersive sub-options, after them", () => {
    const master = PANEL.indexOf('t("type.immersive")');
    const scrollbar = PANEL.indexOf('t("type.immHideScrollbar")');
    const dim = PANEL.indexOf('t("type.immDim")');
    const inert = PANEL.indexOf('t("inert.immersiveOff")', scrollbar);
    expect(master).toBeLessThan(scrollbar);
    expect(scrollbar).toBeLessThan(dim);
    expect(dim).toBeLessThan(inert);
  });

  it("the master toggle is untouched", () => {
    expect(PANEL).toContain("on={immersive}");
    expect(PANEL).toContain("setImmersive(!immersive)");
  });

  it("is named in both locales, with the label the owner asked for", () => {
    for (const k of ["type.immDim", "type.immDimHint"] as const) {
      expect(en[k], k).toBeTruthy();
      expect(ar[k], k).toBeTruthy();
      // A key present in one locale and missing in the other is a type error (`ar` is
      // `Record<TKey, string>`), so this guards the weaker failure: an untranslated string.
      expect(ar[k]).not.toBe(en[k]);
    }
    expect(ar["type.immDim"]).toBe("تعتيم الخلفية");
  });

  it("the hint states the precondition the reader cannot see from the panel", () => {
    // The recede needs a reading wallpaper to be showing at all. Saying so is why this row carries a
    // hint where its siblings do not.
    expect(en["type.immDimHint"].toLowerCase()).toContain("background picture");
    expect(ar["type.immDimHint"]).toContain("صورة خلفية");
  });
});
