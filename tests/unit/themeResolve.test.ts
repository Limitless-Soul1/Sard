// PROFILES (stage 1) — `resolveTheme` is the one place an unknown theme id is handled.
//
// WHAT THESE PROTECT. `ThemeId` used to be a closed union, so `THEMES[id]` was total and the type
// system carried the guarantee. Profiles widen it, so an id is no longer proof the table holds one,
// and every bare lookup becomes a possible `undefined` reaching `applyTheme` — which dereferences
// `theme.colors` and throws. `perBookSettings.ts` records what that costs: the reader error overlay
// offers only Retry (which repeats the failure) and Back, and because the bad value is PERSISTED,
// that book can never be opened again.
//
// So the fallback is not a nicety. These tests hold it in place.

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LIGHT,
  THEMES,
  THEME_ORDER,
  isBuiltinThemeId,
  isThemeId,
} from "../../src/theme/themes";
import { customThemeIds, resolveTheme, setCustomThemes, themeExists } from "../../src/theme/resolve";
import type { CustomThemeId, Theme } from "../../src/theme/tokens";

const custom = (id: CustomThemeId, name: string): Theme => ({
  id,
  name,
  dark: true,
  colors: {
    paperBg: "#101010",
    surfaceBg: "#080808",
    chromeBg: "#141414",
    chromeBorder: "rgba(255,255,255,.08)",
    text: "#EDEDED",
    muted: "#8A8A8A",
    accent: "#C98A5E",
    selection: "rgba(201,138,94,.28)",
    highlight: THEMES[DEFAULT_LIGHT].colors.highlight,
  },
});

describe("resolveTheme — the shipped sixteen", () => {
  beforeEach(() => setCustomThemes(new Map()));

  it("returns each built-in theme by its own id", () => {
    for (const id of THEME_ORDER) {
      expect(resolveTheme(id)).toBe(THEMES[id]);
    }
  });

  it("covers every theme in the table, so none can be added without an order entry", () => {
    expect(THEME_ORDER.length).toBe(Object.keys(THEMES).length);
  });
});

describe("resolveTheme — the fallback", () => {
  beforeEach(() => setCustomThemes(new Map()));

  it("falls back for null and undefined rather than throwing", () => {
    expect(resolveTheme(null)).toBe(THEMES[DEFAULT_LIGHT]);
    expect(resolveTheme(undefined)).toBe(THEMES[DEFAULT_LIGHT]);
  });

  it("falls back for a custom id that names nothing — a deleted profile's theme", () => {
    expect(resolveTheme("u:gone" as CustomThemeId)).toBe(THEMES[DEFAULT_LIGHT]);
  });

  it("falls back for a value hand-edited into the database", () => {
    expect(resolveTheme("not-a-theme" as never)).toBe(THEMES[DEFAULT_LIGHT]);
    expect(resolveTheme("" as never)).toBe(THEMES[DEFAULT_LIGHT]);
  });

  it("always yields a usable theme — every fallback has the colours applyTheme dereferences", () => {
    for (const bad of [null, undefined, "u:gone", "nonsense", ""]) {
      const t = resolveTheme(bad as never);
      expect(t.colors.paperBg).toBeTruthy();
      expect(t.colors.text).toBeTruthy();
      expect(t.colors.accent).toBeTruthy();
      expect(typeof t.dark).toBe("boolean");
    }
  });
});

describe("resolveTheme — reader-authored themes", () => {
  beforeEach(() => setCustomThemes(new Map()));

  it("returns a registered custom theme", () => {
    const mine = custom("u:masaa", "مَساء");
    setCustomThemes(new Map([["u:masaa" as CustomThemeId, mine]]));
    expect(resolveTheme("u:masaa" as CustomThemeId)).toBe(mine);
  });

  it("never lets a custom id shadow one of the sixteen", () => {
    // The `u:` prefix is what makes this impossible to express, not a rule anyone has to remember.
    const mine = custom("u:ivory" as CustomThemeId, "not Ivory");
    setCustomThemes(new Map([["u:ivory" as CustomThemeId, mine]]));
    expect(resolveTheme("ivory")).toBe(THEMES.ivory);
  });

  it("drops a theme when the registry is replaced, and falls back again", () => {
    setCustomThemes(new Map([["u:masaa" as CustomThemeId, custom("u:masaa", "مَساء")]]));
    expect(themeExists("u:masaa" as CustomThemeId)).toBe(true);
    setCustomThemes(new Map());
    expect(themeExists("u:masaa" as CustomThemeId)).toBe(false);
    expect(resolveTheme("u:masaa" as CustomThemeId)).toBe(THEMES[DEFAULT_LIGHT]);
  });

  it("reports its registered ids", () => {
    setCustomThemes(
      new Map([
        ["u:a" as CustomThemeId, custom("u:a", "A")],
        ["u:b" as CustomThemeId, custom("u:b", "B")],
      ]),
    );
    expect(customThemeIds().sort()).toEqual(["u:a", "u:b"]);
  });
});

describe("themeExists — distinct from resolving", () => {
  beforeEach(() => setCustomThemes(new Map()));

  it("is true for the sixteen and false for anything unregistered", () => {
    expect(themeExists("moonlit")).toBe(true);
    expect(themeExists("u:gone" as CustomThemeId)).toBe(false);
    expect(themeExists(null)).toBe(false);
  });
});

describe("the two predicates mean different things", () => {
  it("isBuiltinThemeId accepts only the shipped sixteen", () => {
    expect(isBuiltinThemeId("ivory")).toBe(true);
    expect(isBuiltinThemeId("u:masaa")).toBe(false);
    expect(isBuiltinThemeId("nonsense")).toBe(false);
    expect(isBuiltinThemeId(null)).toBe(false);
  });

  it("isThemeId is a SHAPE test — it accepts a `u:` id that names nothing", () => {
    // Deliberate: it is decidable without consulting any store. Existence is `themeExists`.
    expect(isThemeId("ivory")).toBe(true);
    expect(isThemeId("u:anything")).toBe(true);
    expect(isThemeId("u:")).toBe(false); // a prefix with no id is not an id
    expect(isThemeId("nonsense")).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  it("persisted-id guards use the BUILTIN predicate, so stage 1 admits no custom ids", () => {
    // `theme/store.ts` (initTheme) and `perBookSettings.ts` both validate with
    // `isBuiltinThemeId`. That is what makes this stage inert: no stored value can start
    // resolving to something it did not resolve to before.
    expect(isBuiltinThemeId("u:masaa")).toBe(false);
  });
});
