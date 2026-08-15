// resolveTheme — THE ONE PLACE a theme id becomes a theme.
//
// WHY THIS EXISTS. `ThemeId` used to be a closed union of the sixteen shipped ids, so `THEMES[id]`
// was total: the type system guaranteed a hit. Profiles let a reader author a theme, so an id is no
// longer proof that `THEMES` holds it, and every bare `THEMES[id]` becomes a possible `undefined`
// flowing into `applyTheme(theme)` — which dereferences `theme.colors` and throws.
//
// That is not hypothetical. `perBookSettings.ts` carries a guard written for exactly this class of
// event, and its comment records the consequence: an id that is not a key of THEMES turns into a
// reader error overlay whose only actions are Retry (which repeats the failure) and Back — and
// because the bad value is PERSISTED, that book could never be opened again. One unguarded
// dereference is enough. There are thirty-seven of them.
//
// So the substitution is `THEMES[id]` → `resolveTheme(id)`, and the fallback lives here, once.
//
// WHAT IT IS NOT. This is not a store and it does not fetch. It reads a registry the Profiles layer
// fills, so the theme module keeps no dependency on Profiles and this file stays synchronous —
// `applyTheme` runs inside render and layout paths that cannot await.

import { DEFAULT_LIGHT, THEMES, isBuiltinThemeId } from "./themes";
import type { CustomThemeId, Theme, ThemeId } from "./tokens";

/**
 * Reader-authored themes, by id. EMPTY until a Profile registers one.
 *
 * A plain module-level Map rather than a store: the only operations are replace-all and lookup,
 * lookup happens on hot paths (every `applyTheme`), and a reactive store here would invert the
 * dependency — the theme layer would import Profiles, which imports the theme layer.
 */
let custom: ReadonlyMap<CustomThemeId, Theme> = new Map();

/**
 * Replace the reader-authored theme registry.
 *
 * Called by the Profiles layer whenever the set of custom themes changes. Replaces wholesale rather
 * than mutating, so a caller cannot hold a stale half-updated view, and callers that already hold a
 * resolved `Theme` object keep rendering the object they were given — a theme is applied by value.
 */
export function setCustomThemes(themes: ReadonlyMap<CustomThemeId, Theme>): void {
  custom = themes;
}

/** Every registered custom theme id. For the Profiles layer's own bookkeeping. */
export function customThemeIds(): CustomThemeId[] {
  return [...custom.keys()];
}

/**
 * The theme for an id — shipped, authored, or neither.
 *
 * THE FALLBACK IS THE WHOLE POINT. `null`, `undefined`, an id from a Profile that has since been
 * deleted, a value hand-edited into the database, or one written by a future version all resolve to
 * the default light theme rather than throwing. That is the same resolution "Reset to app default"
 * produces, so the failure mode is a recognisable look rather than a dead book.
 */
export function resolveTheme(id: ThemeId | null | undefined): Theme {
  if (isBuiltinThemeId(id)) return THEMES[id];
  if (typeof id === "string") {
    const t = custom.get(id as CustomThemeId);
    if (t) return t;
  }
  return THEMES[DEFAULT_LIGHT];
}

/**
 * Whether an id resolves to something real — i.e. `resolveTheme` will NOT fall back.
 *
 * Distinct from `isThemeId`, which is a shape test. Use this where the answer changes behaviour
 * (offering "this Profile's theme is missing", say) rather than where a theme is merely needed.
 */
export function themeExists(id: ThemeId | null | undefined): boolean {
  return isBuiltinThemeId(id) || (typeof id === "string" && custom.has(id as CustomThemeId));
}
