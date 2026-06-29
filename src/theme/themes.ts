// The four paper themes from the Sard design (Band A). Ivory + the dark frames are
// specified exactly; surfaceBg/chromeBg for Sepia/Slate are sensibly derived (see
// DESIGN-SPEC.md §9 / PROJECT.md §9 risks).

import type { HighlightSlot, Theme, ThemeId } from "./tokens";

// The 8 highlight inks (RAWY-22, design band D toolbar). Shared across themes — the on-page
// "wick" adapts to the paper via per-theme blend mode + opacity (injectedCss), and the swatch
// dots read cleanly on every paper. A custom highlight stores its own #hex instead of a slot.
const PALETTE: Record<HighlightSlot, string> = {
  amber: "#E8C36A",
  marigold: "#E7A867",
  coral: "#E2978D",
  rose: "#D285A4",
  purple: "#BFA8D6",
  sky: "#9DC0D6",
  teal: "#8DC3BA",
  green: "#AEC798",
};

export const THEMES: Record<ThemeId, Theme> = {
  ivory: {
    id: "ivory",
    name: "Ivory",
    dark: false,
    colors: {
      paperBg: "#F5EEDD",
      surfaceBg: "#E7DCC4",
      chromeBg: "#EAE0CA",
      chromeBorder: "rgba(43,37,33,.10)",
      text: "#2B2521",
      muted: "#8A7E6E",
      accent: "#9C5A3C",
      selection: "rgba(156,90,60,.20)",
      highlight: PALETTE,
    },
  },
  sepia: {
    id: "sepia",
    name: "Sepia",
    dark: false,
    colors: {
      paperBg: "#E8D9BC",
      surfaceBg: "#DECBA8",
      chromeBg: "#EFE3C9",
      chromeBorder: "rgba(69,56,42,.12)",
      text: "#45382A",
      muted: "#8C7A5E",
      accent: "#97582F",
      selection: "rgba(151,88,47,.20)",
      highlight: PALETTE,
    },
  },
  slate: {
    id: "slate",
    name: "Slate",
    dark: true,
    colors: {
      paperBg: "#222A31",
      surfaceBg: "#1A2127",
      chromeBg: "#2A333B",
      chromeBorder: "rgba(255,255,255,.08)",
      text: "#CBD3D9",
      muted: "#7E8A93",
      accent: "#C98A5E",
      selection: "rgba(201,138,94,.28)",
      highlight: PALETTE,
    },
  },
  trueblack: {
    id: "trueblack",
    name: "True-Black",
    dark: true,
    colors: {
      paperBg: "#000000",
      surfaceBg: "#000000",
      chromeBg: "#0E0E0E",
      chromeBorder: "rgba(255,255,255,.10)",
      text: "#CFC8BA",
      muted: "#6E6A62",
      accent: "#C98A5E",
      selection: "rgba(201,138,94,.30)",
      highlight: PALETTE,
    },
  },
};

export const THEME_ORDER: ThemeId[] = ["ivory", "sepia", "slate", "trueblack"];
export const DEFAULT_LIGHT: ThemeId = "ivory";
export const DEFAULT_DARK: ThemeId = "trueblack";
export const isThemeId = (v: unknown): v is ThemeId =>
  typeof v === "string" && v in THEMES;
