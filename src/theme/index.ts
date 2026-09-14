// theme — semantic token system. One source fans out to (a) :root CSS vars for the UI
// (applyTheme) and (b) injected CSS for the book (via the Reader/injectedCss funnel).
// Themes = day/night = "override book color" all run through these tokens (RAWY-13).

export * from "./tokens";
export * from "./themes";
// RAWY-PROFILES (stage 1): an id is no longer proof that `THEMES` holds it. `resolveTheme` is the
// one place that is handled — prefer it over `THEMES[id]` everywhere.
export { resolveTheme, themeExists, setCustomThemes, customThemeIds } from "./resolve";
export { applyTheme, reapplyTitlebarTheme } from "./applyTheme";
export { useTheme, initTheme, currentMode, type ThemeMode } from "./store";
