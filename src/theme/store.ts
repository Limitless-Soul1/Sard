// Theme state (RAWY-13): active theme, override-book-color, hide-chapter-titles, and the
// app-wide light/dark MODE (RAWY-39: Day · Night · Follow OS). Setters persist via the settings
// IPC and apply CSS vars immediately. Book re-theming is driven by the Reader subscribing here.

import { create } from "zustand";

import { settingsGet, settingsSet } from "../lib/ipc";
import { applyTheme } from "./applyTheme";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, isThemeId } from "./themes";
import type { ThemeId } from "./tokens";

const K_THEME = "theme_id";
const K_OVERRIDE = "override_book_color";
const K_HIDE = "hide_chapter_titles";
const K_MODE = "theme_mode"; // "manual" | "auto" (RAWY-39 — Follow OS)

/** Band-H MODE control value: derived from the active theme + auto flag. */
export type ThemeMode = "day" | "night" | "auto";

const osPrefersDark = (): boolean =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;

interface ThemeState {
  themeId: ThemeId;
  autoMode: boolean; // follow the OS light/dark scheme (RAWY-39)
  overrideBookColor: boolean;
  hideChapterTitles: boolean;
  ready: boolean;
  /** Apply a specific theme. An explicit theme choice exits Follow-OS mode. */
  setTheme: (id: ThemeId) => void;
  toggleDayNight: () => void;
  /** Band-H app mode: Day → default light, Night → default dark, Follow OS → track the system. */
  setMode: (m: ThemeMode) => void;
  setOverride: (v: boolean) => void;
  setHideTitles: (v: boolean) => void;
}

// Apply + persist a theme id WITHOUT touching the auto flag (used by Follow-OS too).
function applyThemeId(set: (p: Partial<ThemeState>) => void, id: ThemeId): void {
  applyTheme(THEMES[id]);
  set({ themeId: id });
  settingsSet(K_THEME, id).catch(console.error);
}

export const useTheme = create<ThemeState>((set, get) => ({
  themeId: DEFAULT_LIGHT,
  autoMode: false,
  // Default ON (RAWY-37, decision D25): the page follows the active theme on every book, so
  // Day/Night flips ALL books (incl. ones that hard-code their own colours) and the reading
  // surface stays theme-consistent. Turning it OFF reveals the book's own authored colours.
  overrideBookColor: true,
  hideChapterTitles: false,
  ready: false,
  setTheme: (id) => {
    if (get().autoMode) {
      set({ autoMode: false });
      settingsSet(K_MODE, "manual").catch(console.error);
    }
    applyThemeId(set, id);
  },
  toggleDayNight: () => {
    const next = THEMES[get().themeId].dark ? DEFAULT_LIGHT : DEFAULT_DARK;
    get().setTheme(next);
  },
  setMode: (m) => {
    if (m === "auto") {
      set({ autoMode: true });
      settingsSet(K_MODE, "auto").catch(console.error);
      applyThemeId(set, osPrefersDark() ? DEFAULT_DARK : DEFAULT_LIGHT);
    } else {
      set({ autoMode: false });
      settingsSet(K_MODE, "manual").catch(console.error);
      applyThemeId(set, m === "night" ? DEFAULT_DARK : DEFAULT_LIGHT);
    }
  },
  setOverride: (v) => {
    set({ overrideBookColor: v });
    settingsSet(K_OVERRIDE, v ? "1" : "0").catch(console.error);
  },
  setHideTitles: (v) => {
    set({ hideChapterTitles: v });
    settingsSet(K_HIDE, v ? "1" : "0").catch(console.error);
  },
}));

/** The Band-H MODE value for the current state. */
export function currentMode(s: Pick<ThemeState, "autoMode" | "themeId">): ThemeMode {
  if (s.autoMode) return "auto";
  return THEMES[s.themeId].dark ? "night" : "day";
}

/** Load persisted theme settings and apply them. Call once at startup. */
export async function initTheme(): Promise<void> {
  const [tid, ov, ht, mode] = await Promise.all([
    settingsGet(K_THEME).catch(() => null),
    settingsGet(K_OVERRIDE).catch(() => null),
    settingsGet(K_HIDE).catch(() => null),
    settingsGet(K_MODE).catch(() => null),
  ]);
  const auto = mode === "auto";
  const themeId = auto
    ? osPrefersDark()
      ? DEFAULT_DARK
      : DEFAULT_LIGHT
    : isThemeId(tid)
      ? tid
      : DEFAULT_LIGHT;
  applyTheme(THEMES[themeId]);
  useTheme.setState({
    themeId,
    autoMode: auto,
    // Default ON unless the user has explicitly turned it OFF (D25) — a missing key reads as ON.
    overrideBookColor: ov !== "0",
    hideChapterTitles: ht === "1",
    ready: true,
  });
  // Track the OS scheme while in Follow-OS mode (RAWY-39).
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => {
      if (!useTheme.getState().autoMode) return;
      const id = e.matches ? DEFAULT_DARK : DEFAULT_LIGHT;
      applyTheme(THEMES[id]);
      useTheme.setState({ themeId: id });
      settingsSet(K_THEME, id).catch(console.error);
    });
  }
}
