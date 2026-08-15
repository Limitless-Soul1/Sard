// Semantic theme tokens (RAWY-13), extracted from the Sard design (docs/design/DESIGN-SPEC.md).
// One token set feeds BOTH the UI chrome (via :root CSS vars, applyTheme.ts) and the book
// (via the injectedCss funnel). Colours are literal values because the book renders in a
// separate iframe that can't read the parent's CSS vars.

// The original 4 (RAWY-13) + 11 added in RAWY-29 (from docs/design/themes.json — the canonical
// token export, since the design editing project ≠ the read-only MCP project). 15 total.
// RAWY-145: + Moonlit Sky (gold-on-night, from the design handoff) = 16.
//
// These sixteen are the ones Sard SHIPS, and they stay a closed union: `THEMES` is keyed by this
// type, so a typo in a preset is a compile error and `THEME_ORDER` cannot silently drop one.
export type BuiltinThemeId =
  | "ivory"
  | "sepia"
  | "slate"
  | "trueblack"
  | "sage"
  | "rosequartz"
  | "parchment"
  | "dusk"
  | "ink"
  | "espresso"
  | "forestnight"
  | "mulberry"
  | "charcoal"
  | "nocturne"
  | "linen"
  | "moonlit";

/**
 * A theme authored by the reader, carried by a Profile rather than by `THEMES`.
 *
 * The `u:` prefix is load-bearing three ways: it keeps `isThemeId` DECIDABLE without consulting any
 * store, it makes the sixteen built-in ids unambiguous forever (no future preset can collide with a
 * user id), and it makes a stray id obvious in a database dump. Everything after the prefix is
 * opaque to this module.
 */
export type CustomThemeId = `u:${string}`;

/**
 * Any theme id Sard can be asked to render — shipped or authored.
 *
 * WIDENED, not replaced: every existing type position keeps working, and `THEMES` stays keyed by
 * `BuiltinThemeId` so the preset table is still exhaustively checked. What changes is that an id is
 * no longer PROOF that `THEMES` holds it — which is why `THEMES[id]` is no longer the way to get a
 * theme. Use `resolveTheme(id)` (theme/resolve.ts); it is the one place an unknown id is handled.
 */
export type ThemeId = BuiltinThemeId | CustomThemeId;

// Highlight palette (RAWY-22): 8 semantic slots (was 5). Stored colours are EITHER one of
// these slot names (adapts per theme) OR a literal #hex (a custom colour) — resolveColor
// handles both. Order = the on-screen swatch order from the design (band D).
export const HIGHLIGHT_SLOTS = ["amber", "marigold", "coral", "rose", "purple", "sky", "teal", "green"] as const;
export type HighlightSlot = (typeof HIGHLIGHT_SLOTS)[number];

export interface ThemeColors {
  paperBg: string; // page / card surface
  surfaceBg: string; // app desk / window background
  chromeBg: string; // toolbars / panels
  chromeBorder: string;
  text: string; // primary ink
  muted: string;
  accent: string;
  selection: string; // text-selection background
  highlight: Record<HighlightSlot, string>;
}

export interface Theme {
  id: ThemeId;
  name: string;
  dark: boolean;
  colors: ThemeColors;
  // On-page highlight ink opacity (RAWY-29, design themes.json). Light themes ink at
  // multiply / full alpha (1); dark themes at a low alpha so the ink lightens, not blots.
  // Optional: the original 4 omit it and keep their RAWY-22 intensities (0.62 / 0.5).
  highlightAlpha?: number;
}
