// The paper themes — 15 total. The original 4 (Ivory/Sepia/Slate/True-Black, RAWY-13, design
// Band A) + 11 added in RAWY-29 from docs/design/themes.json — the canonical token export,
// because the design editing project ≠ the read-only MCP project (d39e130b) we read, so the
// new tokens never reached the live MCP file. The 11: Sage, Rose Quartz, Parchment, Dusk, Ink,
// Espresso, Forest Night, Mulberry, Charcoal, Nocturne, Linen. One token system drives chrome
// (applyTheme) + book (injectedCss) + the 8-slot highlights — adding a preset is enough.

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
      // RAWY-130 (C2): the DESK/app-bg was pure #000, so the reading margins + the strip below the
      // Contents panel (which reserves space for the now-hidden bottom bar during TTS) showed an
      // out-of-theme black corner against the #0E0E0E chrome/panels. Match the chrome so the desk is
      // theme-consistent everywhere; the READING PAPER stays true #000 (the OLED win). This is the
      // root fix that retires RAWY-129's per-spot `.reader-desk::after` fade.
      surfaceBg: "#0E0E0E",
      chromeBg: "#0E0E0E",
      chromeBorder: "rgba(255,255,255,.10)",
      text: "#CFC8BA",
      muted: "#6E6A62",
      accent: "#C98A5E",
      selection: "rgba(201,138,94,.30)",
      highlight: PALETTE,
    },
  },

  // ---- RAWY-29: 5 new themes from docs/design/themes.json (the canonical token export) ----
  // Each carries its OWN highlight palette (the design tunes the inks to the paper) + a
  // highlightAlpha. The JSON slot names map to our RAWY-22 keys by position/colour:
  //   gold→amber · apricot→marigold · rose→coral · berry→rose · lilac→purple · sky→sky ·
  //   teal→teal · sage→green — so existing stored highlights (which use OUR keys) still resolve.
  sage: {
    id: "sage",
    name: "Sage",
    dark: false,
    highlightAlpha: 1,
    colors: {
      paperBg: "#F0F2E8",
      surfaceBg: "#DCE0D0",
      chromeBg: "#E9ECE0",
      chromeBorder: "rgba(46,52,43,.12)",
      text: "#2E342B",
      muted: "#7C8473",
      accent: "#5E7A52",
      selection: "rgba(199,212,158,.55)",
      highlight: {
        amber: "#D9C36A", marigold: "#D9A867", coral: "#D98F86", rose: "#C886A2",
        purple: "#B79CC4", sky: "#7FA6C0", teal: "#7FB6A8", green: "#9BB089",
      },
    },
  },
  rosequartz: {
    id: "rosequartz",
    name: "Rose Quartz",
    dark: false,
    highlightAlpha: 1,
    colors: {
      paperBg: "#FBF1F1",
      surfaceBg: "#EEDEDE",
      chromeBg: "#F5EAEA",
      chromeBorder: "rgba(58,47,48,.12)",
      text: "#3A2F30",
      muted: "#9B7E80",
      accent: "#B5727B",
      selection: "rgba(239,194,182,.55)",
      highlight: {
        amber: "#E0BC6E", marigold: "#DD9088", coral: "#DD9088", rose: "#C77E96",
        purple: "#B8A0C8", sky: "#9FB8C2", teal: "#86BBA8", green: "#A8BC8E",
      },
    },
  },
  parchment: {
    id: "parchment",
    name: "Parchment",
    dark: false,
    highlightAlpha: 1,
    colors: {
      paperBg: "#F0E2BE",
      surfaceBg: "#DFCEA3",
      chromeBg: "#E7D7B0",
      chromeBorder: "rgba(58,46,24,.14)",
      text: "#3A2E14",
      muted: "#8A7448",
      accent: "#9A7B3F",
      selection: "rgba(224,184,92,.50)",
      highlight: {
        amber: "#D4AF52", marigold: "#CC8C6A", coral: "#C58379", rose: "#B5736A",
        purple: "#A98FB0", sky: "#8FA5B0", teal: "#80A893", green: "#8FA07A",
      },
    },
  },
  dusk: {
    id: "dusk",
    name: "Dusk",
    dark: true,
    highlightAlpha: 0.34,
    colors: {
      paperBg: "#1B2130",
      surfaceBg: "#11141D",
      chromeBg: "#181D29",
      chromeBorder: "rgba(255,255,255,.08)",
      text: "#D8DEEC",
      muted: "#7E8AA6",
      accent: "#8FA6D8",
      selection: "rgba(143,166,216,.32)",
      highlight: {
        amber: "#D9C36A", marigold: "#D9A867", coral: "#D98F86", rose: "#C886A2",
        purple: "#AE9CD0", sky: "#8FA6D8", teal: "#86BBA8", green: "#9BB089",
      },
    },
  },
  ink: {
    id: "ink",
    name: "Ink",
    dark: false, // light, high-contrast
    highlightAlpha: 1,
    colors: {
      paperBg: "#FFFFFF",
      surfaceBg: "#F1EFE6",
      chromeBg: "#FBFAF5",
      chromeBorder: "rgba(0,0,0,.30)",
      text: "#0E0D0A",
      muted: "#444038",
      accent: "#7A2E1E",
      selection: "rgba(244,196,48,.60)",
      highlight: {
        amber: "#F4C430", marigold: "#E0A92E", coral: "#C9603F", rose: "#B23A6B",
        purple: "#7A5BA8", sky: "#2E6E8A", teal: "#1F7A6E", green: "#3E7A4A",
      },
    },
  },

  // ---- RAWY-29 (resumed): 6 more themes from the updated themes.json (5 dark + 1 light) ----
  espresso: {
    id: "espresso",
    name: "Espresso",
    dark: true,
    highlightAlpha: 0.33,
    colors: {
      paperBg: "#221912",
      surfaceBg: "#1A130D",
      chromeBg: "#1B130C",
      chromeBorder: "rgba(255,255,255,.07)",
      text: "#EADCC6",
      muted: "#998771",
      accent: "#D49A6A",
      selection: "rgba(212,154,106,.30)",
      highlight: {
        amber: "#E8C36A", marigold: "#E7A867", coral: "#E2978D", rose: "#D285A4",
        purple: "#BFA8D6", sky: "#9DC0D6", teal: "#8DC3BA", green: "#AEC798",
      },
    },
  },
  forestnight: {
    id: "forestnight",
    name: "Forest Night",
    dark: true,
    highlightAlpha: 0.32,
    colors: {
      paperBg: "#15201A",
      surfaceBg: "#101813",
      chromeBg: "#131D17",
      chromeBorder: "rgba(255,255,255,.07)",
      text: "#D6E2D4",
      muted: "#7C9381",
      accent: "#82B08C",
      selection: "rgba(130,176,140,.30)",
      highlight: {
        amber: "#D9C36A", marigold: "#D9A867", coral: "#D98F86", rose: "#C886A2",
        purple: "#B79CC4", sky: "#8FB6CC", teal: "#86C3B2", green: "#9BC089",
      },
    },
  },
  mulberry: {
    id: "mulberry",
    name: "Mulberry",
    dark: true,
    highlightAlpha: 0.33,
    colors: {
      paperBg: "#221620",
      surfaceBg: "#1A1119",
      chromeBg: "#1C131A",
      chromeBorder: "rgba(255,255,255,.07)",
      text: "#E6D8E2",
      muted: "#A98FA3",
      accent: "#C189B0",
      selection: "rgba(193,137,176,.30)",
      highlight: {
        amber: "#E8C36A", marigold: "#E7A867", coral: "#E2978D", rose: "#D285A4",
        purple: "#C7A6E0", sky: "#9DC0D6", teal: "#8DC3BA", green: "#AEC798",
      },
    },
  },
  charcoal: {
    id: "charcoal",
    name: "Charcoal",
    dark: true,
    highlightAlpha: 0.34,
    colors: {
      paperBg: "#1C1C1E",
      surfaceBg: "#161617",
      chromeBg: "#161617",
      chromeBorder: "rgba(255,255,255,.07)",
      text: "#DCD9D2",
      muted: "#8A8881",
      accent: "#C98A5E",
      selection: "rgba(201,138,94,.28)",
      highlight: {
        amber: "#E8C36A", marigold: "#E7A867", coral: "#E2978D", rose: "#D285A4",
        purple: "#BFA8D6", sky: "#9DC0D6", teal: "#8DC3BA", green: "#AEC798",
      },
    },
  },
  nocturne: {
    id: "nocturne",
    name: "Nocturne",
    dark: true,
    highlightAlpha: 0.32,
    colors: {
      paperBg: "#122023",
      surfaceBg: "#0E1719",
      chromeBg: "#101C1F",
      chromeBorder: "rgba(255,255,255,.07)",
      text: "#CFE0E0",
      muted: "#6E8A8C",
      accent: "#5FA8A8",
      selection: "rgba(95,168,168,.30)",
      highlight: {
        amber: "#D9C36A", marigold: "#D9A867", coral: "#D98F86", rose: "#C886A2",
        purple: "#B79CC4", sky: "#86C0D9", teal: "#6FC3BE", green: "#9BC089",
      },
    },
  },
  linen: {
    id: "linen",
    name: "Linen",
    dark: false,
    highlightAlpha: 1,
    colors: {
      paperBg: "#F4F2EA",
      surfaceBg: "#E6E4DC",
      chromeBg: "#ECEAE1",
      chromeBorder: "rgba(42,41,37,.10)",
      text: "#2A2925",
      muted: "#8E8B82",
      accent: "#5E6B7A",
      selection: "rgba(94,107,122,.18)",
      highlight: {
        amber: "#E8C36A", marigold: "#E7A867", coral: "#E2978D", rose: "#D285A4",
        purple: "#BFA8D6", sky: "#9DC0D6", teal: "#8DC3BA", green: "#AEC798",
      },
    },
  },

  // ---- RAWY-145: Moonlit Sky — Phase 1 (COLOUR TOKENS only; Phase 2 adds the decorative SVG layer:
  // crescent/stars/clouds/glow). A gold-on-night theme from the Claude Design handoff
  // (docs/design/Moonlit Sky Library and Reader (standalone).html). Its richer token block (bg-app/base,
  // surface primary/secondary/elevated/chrome/input/glass, text primary/secondary/muted/faint, gold
  // accent ×3, borders ×4, gradients, shadow/glow) MAPS onto Sard's compact schema — no new machinery,
  // no component redesign, purely a 16th preset:
  //   • paperBg  ← the reader-paper gradient `linear-gradient(180deg,#0E1730,#121A2E 42%)` settles to
  //     surface-primary #121A2E (a solid page/card surface); the cream ink reads crisply on it.
  //   • surfaceBg ← --bg-base #0B1021 (the "library = solid" app background), kept CLOSE to the chrome
  //     #0E1526 so the desk shows NO out-of-theme seam next to the panels (RAWY-130 True-Black lesson;
  //     no pure #000 anywhere here).
  //   • chromeBg ← --surface-chrome #0E1526 · chromeBorder ← --border-hairline · accent ← gold #E6C77A
  //   • text ← --text-primary cream #F5E8C8 · muted ← --text-muted #8FA6C8 · selection ← --selection.
  // The 8 highlight inks (gold/apricot/rose/berry/lilac/sky/teal/sage) equal the shared PALETTE; ink
  // alpha 0.34 (dark-paper "wick", lightens not blots). Deferred to Phase 2 (no slot in this schema):
  // --bg-app, surface secondary/elevated/input/glass, text secondary/faint, accent-deep/pale, the extra
  // borders, the gradients, and shadow/glow — those drive the decorations, not the flat colour layer.
  moonlit: {
    id: "moonlit",
    name: "Moonlit Sky",
    dark: true,
    highlightAlpha: 0.34,
    colors: {
      paperBg: "#121A2E",
      surfaceBg: "#0B1021",
      chromeBg: "#0E1526",
      chromeBorder: "rgba(143,166,200,.14)",
      text: "#F5E8C8",
      muted: "#8FA6C8",
      accent: "#E6C77A",
      selection: "rgba(230,199,122,.26)",
      highlight: PALETTE,
    },
  },
};

export const THEME_ORDER: ThemeId[] = [
  "ivory", "sepia", "slate", "trueblack", "sage", "rosequartz", "parchment", "dusk", "ink",
  "espresso", "forestnight", "mulberry", "charcoal", "nocturne", "linen", "moonlit",
];
export const DEFAULT_LIGHT: ThemeId = "ivory";
export const DEFAULT_DARK: ThemeId = "trueblack";
export const isThemeId = (v: unknown): v is ThemeId =>
  typeof v === "string" && v in THEMES;
