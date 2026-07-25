// applyTheme — the ONE place tokens become :root CSS vars for the UI chrome. The book
// gets the same colours through the injectedCss funnel (see Reader). One source → both.

import { invoke } from "@tauri-apps/api/core";
import { contrastRatio } from "../lib/contrast";
import type { Theme } from "./tokens";

// RAWY-256 — `--read-marker` / `--read-marker-quiet`: the FIRST token in Sard guaranteed LEGIBLE against
// the chrome ground. `--accent` is NOT that token in every theme — MEASURED across all 16: accent vs
// `--chrome-bg` is only 2.79:1 in Parchment, and `--muted` is 2.83:1 in Linen, both under the 3:1 floor
// (WCAG 1.4.11, non-text UI). Alpha cannot rescue either: a colour composited at partial alpha over the
// ground always lands BETWEEN the ground and the colour, so full strength IS the ceiling (verified over 816
// composites — zero counterexamples). They are TOKEN-CEILING failures, not alpha failures.
// RESOLUTION: keep the source colour when it already clears the floor; otherwise BLEND IT TOWARD `--text`
// in 5% steps and stop at the FIRST step that clears — so each theme keeps as much of Sard's terracotta
// identity as it can, instead of the marker turning flatly grey. Computed ONCE per theme change (not per
// row), so a future theme is correct on arrival and any later feature needing a legible mark on chrome can
// reuse the token. Per-theme override tables were rejected: unmaintainable AND arithmetically insufficient.
// MEASURED RESULT: 30 of 32 cells need NO blend; only Parchment/accent (10% → 3.14) and Linen/quiet
// (5% → 3.02) blend at all.
const READ_MARKER_FLOOR = 3.0; // WCAG 1.4.11 non-text contrast. NOT negotiable (D44 names accessibility).
const READ_MARKER_STEP = 0.05;

const parseHex = (c: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const toHex = (rgb: number[]): string => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Blend `source` toward `text` until it clears the floor against `ground`; returns the source unchanged
 *  when it already does. Falls back to the source if a colour can't be parsed (never throws on a theme). */
function resolveReadMarker(source: string, ground: string, text: string): string {
  const s = parseHex(source);
  const g = parseHex(ground);
  const t = parseHex(text);
  if (!s || !g || !t) return source;
  if (contrastRatio(source, ground) >= READ_MARKER_FLOOR) return source;
  for (let k = READ_MARKER_STEP; k <= 1.0001; k += READ_MARKER_STEP) {
    const c = toHex(s.map((v, i) => v + (t[i] - v) * k));
    if (contrastRatio(c, ground) >= READ_MARKER_FLOOR) return c;
  }
  return text; // unreachable for the shipped themes (all 32 cells clear well before k=1)
}

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
  // RAWY-256: the guaranteed-legible marker colours (see the note above). Two registers: the NOTICEABLE
  // one (five variants, from `accent`) and the QUIET one (Reading Trail, from `muted`) — quiet means lower
  // visual weight (thinner, softer hue), never below-threshold contrast.
  set("--read-marker", resolveReadMarker(c.accent, c.chromeBg, c.text));
  set("--read-marker-quiet", resolveReadMarker(c.muted, c.chromeBg, c.text));
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
