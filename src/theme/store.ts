// Theme state (RAWY-13): active theme, override-book-color, hide-chapter-titles.
// Setters persist via the settings IPC and apply CSS vars immediately. Book re-theming
// is driven by the Reader subscribing to this store.

import { create } from "zustand";

import { settingsGet, settingsSet } from "../lib/ipc";
import { applyTheme } from "./applyTheme";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, isThemeId } from "./themes";
import type { ThemeId } from "./tokens";

const K_THEME = "theme_id";
const K_OVERRIDE = "override_book_color";
const K_HIDE = "hide_chapter_titles";

interface ThemeState {
  themeId: ThemeId;
  overrideBookColor: boolean;
  hideChapterTitles: boolean;
  ready: boolean;
  setTheme: (id: ThemeId) => void;
  toggleDayNight: () => void;
  setOverride: (v: boolean) => void;
  setHideTitles: (v: boolean) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  themeId: DEFAULT_LIGHT,
  overrideBookColor: false,
  hideChapterTitles: false,
  ready: false,
  setTheme: (id) => {
    applyTheme(THEMES[id]);
    set({ themeId: id });
    settingsSet(K_THEME, id).catch(console.error);
  },
  toggleDayNight: () => {
    const next = THEMES[get().themeId].dark ? DEFAULT_LIGHT : DEFAULT_DARK;
    get().setTheme(next);
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

/** Load persisted theme settings and apply them. Call once at startup. */
export async function initTheme(): Promise<void> {
  const [tid, ov, ht] = await Promise.all([
    settingsGet(K_THEME).catch(() => null),
    settingsGet(K_OVERRIDE).catch(() => null),
    settingsGet(K_HIDE).catch(() => null),
  ]);
  const themeId = isThemeId(tid) ? tid : DEFAULT_LIGHT;
  applyTheme(THEMES[themeId]);
  useTheme.setState({
    themeId,
    overrideBookColor: ov === "1",
    hideChapterTitles: ht === "1",
    ready: true,
  });
}
