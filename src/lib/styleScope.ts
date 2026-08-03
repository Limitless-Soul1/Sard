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
// RAWY-180 (Part C): the DEFAULT (used only when the user has NOT chosen) is UNIFIED — one shared book
// style is the friendlier default. An explicit stored choice is still respected: `style_scope` is
// written only by `setScope`, so a persisted "perbook" wins (see initStyleScope).
const DEFAULT: StyleScope = "unified";

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

/** Load the persisted scope. Call once at startup. RAWY-180: an explicit stored "perbook" is honoured;
 *  anything else (including no stored value) uses the UNIFIED default. RAWY-271: the fallback now reads
 *  `DEFAULT` instead of repeating the literal, so the default lives in exactly ONE place. The upgrade
 *  contract is unchanged and is what makes this safe: `style_scope` is written ONLY by `setScope`, so a
 *  row exists only where the user chose, and an existing "perbook" choice still wins here. */
export async function initStyleScope(): Promise<void> {
  const v = await settingsGet(KEY).catch(() => null);
  useStyleScope.setState({ scope: v === "perbook" ? "perbook" : DEFAULT });
}
