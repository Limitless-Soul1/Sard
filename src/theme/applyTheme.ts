// applyTheme — the ONE place tokens become :root CSS vars for the UI chrome. The book
// gets the same colours through the injectedCss funnel (see Reader). One source → both.

import type { Theme } from "./tokens";

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
}
