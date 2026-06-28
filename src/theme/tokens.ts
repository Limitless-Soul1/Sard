// Semantic theme tokens (RAWY-13), extracted from the Sard design (docs/design/DESIGN-SPEC.md).
// One token set feeds BOTH the UI chrome (via :root CSS vars, applyTheme.ts) and the book
// (via the injectedCss funnel). Colours are literal values because the book renders in a
// separate iframe that can't read the parent's CSS vars.

export type ThemeId = "ivory" | "sepia" | "slate" | "trueblack";

export interface ThemeColors {
  paperBg: string; // page / card surface
  surfaceBg: string; // app desk / window background
  chromeBg: string; // toolbars / panels
  chromeBorder: string;
  text: string; // primary ink
  muted: string;
  accent: string;
  selection: string; // text-selection background
  highlight: { amber: string; rose: string; sky: string; green: string; purple: string };
}

export interface Theme {
  id: ThemeId;
  name: string;
  dark: boolean;
  colors: ThemeColors;
}
