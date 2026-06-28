// The four paper themes from the Sard design (Band A). Ivory + the dark frames are
// specified exactly; surfaceBg/chromeBg for Sepia/Slate are sensibly derived (see
// DESIGN-SPEC.md §9 / PROJECT.md §9 risks).

import type { Theme, ThemeId } from "./tokens";

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
      highlight: { amber: "#E8C36A", rose: "#E0A6A0", sky: "#A8C4D6", green: "#B6C9A6", purple: "#C7B6D6" },
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
      highlight: { amber: "#D9AE54", rose: "#CE8E73", sky: "#8FA9B5", green: "#9DAE83", purple: "#AD96B8" },
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
      highlight: { amber: "#C7A24E", rose: "#C28A82", sky: "#7FA0B3", green: "#8DA37F", purple: "#A892B6" },
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
      highlight: { amber: "#B89348", rose: "#B07F77", sky: "#6F90A3", green: "#7E946F", purple: "#9783A5" },
    },
  },
};

export const THEME_ORDER: ThemeId[] = ["ivory", "sepia", "slate", "trueblack"];
export const DEFAULT_LIGHT: ThemeId = "ivory";
export const DEFAULT_DARK: ThemeId = "trueblack";
export const isThemeId = (v: unknown): v is ThemeId =>
  typeof v === "string" && v in THEMES;
