// src/lib/discordSettings.ts
//
// Discord Rich Presence settings — opt-in master switch plus three fine-grained
// visibility toggles. Persisted the same way theme/background settings are:
// a zustand store + settingsGet/settingsSet, loaded once at startup via
// initDiscordSettings() (called from App.tsx alongside initTheme/initBackground).

import { create } from "zustand";
import { settingsGet, settingsSet } from "./ipc";

const KEYS = {
  enabled: "discord_presence_enabled",
  showTitle: "discord_show_title",
  showChapter: "discord_show_chapter",
  showProgress: "discord_show_progress",
} as const;

interface DiscordSettingsState {
  ready: boolean;
  enabled: boolean;
  showTitle: boolean;
  showChapter: boolean;
  showProgress: boolean;
  setEnabled: (v: boolean) => void;
  setShowTitle: (v: boolean) => void;
  setShowChapter: (v: boolean) => void;
  setShowProgress: (v: boolean) => void;
}

export const useDiscordSettings = create<DiscordSettingsState>((set) => ({
  ready: false,
  enabled: false,
  // Sub-toggles default ON: once someone opts in to the master switch, showing
  // title/chapter/progress is the whole point of the feature.
  showTitle: true,
  showChapter: true,
  showProgress: true,
  setEnabled: (v) => {
    set({ enabled: v });
    void settingsSet(KEYS.enabled, v ? "true" : "false");
  },
  setShowTitle: (v) => {
    set({ showTitle: v });
    void settingsSet(KEYS.showTitle, v ? "true" : "false");
  },
  setShowChapter: (v) => {
    set({ showChapter: v });
    void settingsSet(KEYS.showChapter, v ? "true" : "false");
  },
  setShowProgress: (v) => {
    set({ showProgress: v });
    void settingsSet(KEYS.showProgress, v ? "true" : "false");
  },
}));

export async function initDiscordSettings(): Promise<void> {
  const [enabled, showTitle, showChapter, showProgress] = await Promise.all([
    settingsGet(KEYS.enabled),
    settingsGet(KEYS.showTitle),
    settingsGet(KEYS.showChapter),
    settingsGet(KEYS.showProgress),
  ]);
  useDiscordSettings.setState({
    ready: true,
    enabled: enabled === "true",
    showTitle: showTitle !== "false",
    showChapter: showChapter !== "false",
    showProgress: showProgress !== "false",
  });
}