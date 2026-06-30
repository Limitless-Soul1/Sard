// Book-style scope (RAWY-43) — a global setting that chooses how reading settings/theme behave:
//   • "perbook"  — each book keeps its own style (the RAWY-40/D27 default behaviour).
//   • "unified"  — all books share ONE style; changing a book's font/theme/size/colour while
//                  reading applies to EVERY book (writes the global row), and opening any book
//                  applies the global style — IGNORING (never deleting) any per-book overrides, so
//                  switching back to "perbook" restores them.
// Persisted as `style_scope`; reactive so the open Reader re-resolves live when it changes.

import { create } from "zustand";

import { settingsGet, settingsSet } from "./ipc";

export type StyleScope = "unified" | "perbook";

const KEY = "style_scope";
const DEFAULT: StyleScope = "perbook"; // current behaviour — no surprise for existing users

interface StyleScopeState {
  scope: StyleScope;
  setScope: (s: StyleScope) => void;
}

export const useStyleScope = create<StyleScopeState>((set) => ({
  scope: DEFAULT,
  setScope: (s) => {
    set({ scope: s });
    settingsSet(KEY, s).catch(console.error);
  },
}));

/** Load the persisted scope. Call once at startup. */
export async function initStyleScope(): Promise<void> {
  const v = await settingsGet(KEY).catch(() => null);
  useStyleScope.setState({ scope: v === "unified" ? "unified" : "perbook" });
}
