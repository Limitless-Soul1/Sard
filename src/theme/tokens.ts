// Semantic theme tokens (RAWY-13), extracted from the Sard design (docs/design/DESIGN-SPEC.md).
// One token set feeds BOTH the UI chrome (via :root CSS vars, applyTheme.ts) and the book
// (via the injectedCss funnel). Colours are literal values because the book renders in a
// separate iframe that can't read the parent's CSS vars.

export type ThemeId = "ivory" | "sepia" | "slate" | "trueblack";

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
}
