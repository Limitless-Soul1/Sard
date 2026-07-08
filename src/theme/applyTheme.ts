// applyTheme — the ONE place tokens become :root CSS vars for the UI chrome. The book
// gets the same colours through the injectedCss funnel (see Reader). One source → both.

import { invoke } from "@tauri-apps/api/core";
import type { Theme } from "./tokens";

// RAWY-118: the dark/light of the last applied theme, remembered so the native title-bar caption can
// be RE-applied (App.tsx does this a moment after startup + on window focus) — WebView2 re-themes the
// caption during its own startup, after our first applyTheme, so a single call at boot doesn't stick.
let lastDark = false;

/** Re-apply the native title-bar caption for the last applied theme (see `applyTheme` for why). */
export function reapplyTitlebarTheme(): void {
  invoke("set_titlebar_theme", { dark: lastDark }).catch(() => {});
}

export function applyTheme(theme: Theme): void {
  const r = document.documentElement;
  const c = theme.colors;
  const set = (k: string, v: string) => r.style.setProperty(k, v);
  set("--app-bg", c.surfaceBg);
  set("--paper-bg", c.paperBg);
  set("--chrome-bg", c.chromeBg);
  set("--chrome-border", c.chromeBorder);
  set("--text", c.text);
  set("--muted", c.muted);
  set("--accent", c.accent);
  set("--selection", c.selection);
  r.dataset.theme = theme.id;
  r.dataset.dark = String(theme.dark);
  // RAWY-118 (fixes ISSUE C — the black band above the top bar): the window uses the native OS
  // decorations, whose title bar follows Windows' own dark-mode caption — a fixed near-black bar that
  // ignores Sard's theme, so it read as an out-of-place black band above the reader's top bar. Match
  // the native caption to the app theme (dark caption for dark themes, light for light) via the Rust
  // `set_titlebar_theme` command (the Tauri JS `setTheme()` does NOT repaint the Win10 caption). This
  // is dark/light, not the exact Ivory/Charcoal (a custom title bar would be needed for that —
  // deferred). No-op outside a Tauri/Windows context. See `reapplyTitlebarTheme` for the startup re-apply.
  // Only fire on an actual light<->dark change: applyTheme also runs on in-reader style tweaks (same
  // dark-ness), and the caption command nudges the window 1px to force a repaint — no need to do that
  // when the caption colour wouldn't change. A light theme at startup (no change vs the default) is
  // caught by `reapplyTitlebarTheme` from App.tsx instead.
  const darkChanged = theme.dark !== lastDark;
  lastDark = theme.dark;
  if (darkChanged) invoke("set_titlebar_theme", { dark: theme.dark }).catch(() => {});
}
