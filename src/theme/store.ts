// Theme state (RAWY-13): active theme, override-book-color, hide-chapter-titles, and the
// app-wide light/dark MODE (RAWY-39: Day · Night · Follow OS). Setters persist via the settings
// IPC and apply CSS vars immediately. Book re-theming is driven by the Reader subscribing here.

import { create } from "zustand";

import { settingsGet, settingsSet } from "../lib/ipc";
import { applyTheme } from "./applyTheme";
import { DEFAULT_DARK, DEFAULT_LIGHT, isBuiltinThemeId } from "./themes";
import { resolveTheme } from "./resolve";
import type { ThemeId } from "./tokens";

const K_THEME = "theme_id"; // the LIBRARY (app chrome) theme — independent of books (RAWY-48/D29)
const K_BOOK_THEME = "book_theme_id"; // the shared/default BOOK theme (unified + per-book fallback)
const K_OVERRIDE = "override_book_color";
const K_HIDE = "hide_chapter_titles";
// RAWY-69: independent from K_HIDE — hides the section's detected leading "first line" (RAWY-68)
// without touching the semantic chapter heading. Either, both, or neither can be on.
const K_HIDE_FIRST_LINE = "hide_first_line";
// RAWY-210: immersive hide-on-scroll. When ON, scrolling down hides not just the toolbar (the
// existing RAWY-73 behaviour) but ALSO the floating TTS control pill / kashida bead and the reading
// scrollbar — everything returns together on scroll-up / top-edge reach. The TTS overlayer highlight
// (spotlight/karaoke, D49) is deliberately NOT bound to this and keeps tracking. A GLOBAL flag (like
// hide-first-line): one reading-behaviour preference, not per-book typography.
const K_IMMERSIVE = "immersive_scroll";
const K_MODE = "theme_mode"; // "manual" | "auto" (RAWY-39 — Follow OS)

/** Band-H MODE control value: derived from the active theme + auto flag. */
export type ThemeMode = "day" | "night" | "auto";

const osPrefersDark = (): boolean =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;

interface ThemeState {
  themeId: ThemeId; // the LIBRARY (app chrome) theme — what :root shows outside reading (D29)
  bookThemeId: ThemeId; // the shared/default BOOK theme — unified mode + per-book fallback (D29)
  autoMode: boolean; // follow the OS light/dark scheme (RAWY-39)
  overrideBookColor: boolean;
  hideChapterTitles: boolean;
  hideFirstLine: boolean;
  immersive: boolean; // RAWY-210: immersive hide-on-scroll (hide pill + scrollbar with the bars)
  ready: boolean;
  /** Apply a specific LIBRARY theme. An explicit theme choice exits Follow-OS mode. */
  setTheme: (id: ThemeId) => void;
  /** Set the shared/default BOOK theme (RAWY-48/D29). Persists only — does NOT touch :root; the
   *  Reader applies it to the reading surface while a book is open, never to the Library. */
  setBookTheme: (id: ThemeId) => void;
  toggleDayNight: () => void;
  /** Band-H app mode: Day → default light, Night → default dark, Follow OS → track the system. */
  setMode: (m: ThemeMode) => void;
  setOverride: (v: boolean) => void;
  setHideTitles: (v: boolean) => void;
  setHideFirstLine: (v: boolean) => void;
  setImmersive: (v: boolean) => void; // RAWY-210
}

// Apply + persist a theme id WITHOUT touching the auto flag (used by Follow-OS too).
function applyThemeId(set: (p: Partial<ThemeState>) => void, id: ThemeId): void {
  applyTheme(resolveTheme(id));
  set({ themeId: id });
  settingsSet(K_THEME, id).catch(console.error);
}

export const useTheme = create<ThemeState>((set, get) => ({
  themeId: DEFAULT_LIGHT,
  bookThemeId: DEFAULT_LIGHT,
  autoMode: false,
  // Default ON (RAWY-37, decision D25): the page follows the active theme on every book, so
  // Day/Night flips ALL books (incl. ones that hard-code their own colours) and the reading
  // surface stays theme-consistent. Turning it OFF reveals the book's own authored colours.
  overrideBookColor: true,
  hideChapterTitles: false,
  hideFirstLine: false,
  // RAWY-210: default OFF — an untouched profile keeps today's exact behaviour (the TTS pill floats
  // visible while the chrome is auto-hidden). The owner decides live whether to flip the default ON.
  immersive: false,
  ready: false,
  setTheme: (id) => {
    if (get().autoMode) {
      set({ autoMode: false });
      settingsSet(K_MODE, "manual").catch(console.error);
    }
    applyThemeId(set, id);
  },
  setBookTheme: (id) => {
    // BOOK theme only (D29): persist + store. The Library (:root) is NOT touched — the Reader
    // applies this to the reading surface while a book is open. This is what makes choosing a
    // book/unified theme leave the Library's own theme alone (the RAWY-48 decouple).
    set({ bookThemeId: id });
    settingsSet(K_BOOK_THEME, id).catch(console.error);
  },
  toggleDayNight: () => {
    const next = resolveTheme(get().themeId).dark ? DEFAULT_LIGHT : DEFAULT_DARK;
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
  setHideFirstLine: (v) => {
    set({ hideFirstLine: v });
    settingsSet(K_HIDE_FIRST_LINE, v ? "1" : "0").catch(console.error);
  },
  setImmersive: (v) => {
    set({ immersive: v });
    settingsSet(K_IMMERSIVE, v ? "1" : "0").catch(console.error);
  },
}));

/** The Band-H MODE value for the current state. */
export function currentMode(s: Pick<ThemeState, "autoMode" | "themeId">): ThemeMode {
  if (s.autoMode) return "auto";
  return resolveTheme(s.themeId).dark ? "night" : "day";
}

/** Load persisted theme settings and apply them. Call once at startup. */
export async function initTheme(): Promise<void> {
  const [tid, btid, ov, ht, hfl, imm, mode] = await Promise.all([
    settingsGet(K_THEME).catch(() => null),
    settingsGet(K_BOOK_THEME).catch(() => null),
    settingsGet(K_OVERRIDE).catch(() => null),
    settingsGet(K_HIDE).catch(() => null),
    settingsGet(K_HIDE_FIRST_LINE).catch(() => null),
    settingsGet(K_IMMERSIVE).catch(() => null),
    settingsGet(K_MODE).catch(() => null),
  ]);
  const auto = mode === "auto";
  // The LIBRARY theme drives the app chrome (and is what Follow-OS swaps). It is NOT affected by
  // any book theme (RAWY-48/D29) — only Global Settings → Appearance changes it.
  const libraryTheme = isBuiltinThemeId(tid) ? tid : DEFAULT_LIGHT;
  const themeId = auto ? (osPrefersDark() ? DEFAULT_DARK : DEFAULT_LIGHT) : libraryTheme;
  // The shared/default BOOK theme (unified + per-book fallback). Migration: a missing key inherits
  // the library theme so existing books keep their look; thereafter the two move independently.
  const bookThemeId = isBuiltinThemeId(btid) ? btid : libraryTheme;
  applyTheme(resolveTheme(themeId));
  useTheme.setState({
    themeId,
    bookThemeId,
    autoMode: auto,
    // Default ON unless the user has explicitly turned it OFF (D25) — a missing key reads as ON.
    overrideBookColor: ov !== "0",
    hideChapterTitles: ht === "1",
    hideFirstLine: hfl === "1",
    immersive: imm === "1", // RAWY-210: default OFF unless explicitly turned on
    ready: true,
  });
  // Track the OS scheme while in Follow-OS mode (RAWY-39).
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => {
      if (!useTheme.getState().autoMode) return;
      const id = e.matches ? DEFAULT_DARK : DEFAULT_LIGHT;
      applyTheme(resolveTheme(id));
      useTheme.setState({ themeId: id });
      settingsSet(K_THEME, id).catch(console.error);
    });
  }
}
