// Update-check logic shared by the Settings → About row (RAWY-168) and the Library rosette (RAWY-170).
//
// `runUpdateCheck` maps the raw `check_for_update` Rust command (RAWY-168) to a small terminal state —
// it NEVER throws: offline, an unreachable feed, a bad manifest, or the not-yet-configured placeholder
// URL all resolve to a quiet "unavailable". The network happens in Rust; nothing here fetches.
//
// `useUpdater` is a module-level store (same pattern as `useTts`) so the rosette's state survives the
// Library unmounting/remounting when a book is opened and closed — without persisting anything beyond
// the single `updater_last_check` timestamp the daily auto-check gate needs.

import { create } from "zustand";

import { checkForUpdate, settingsGet, settingsSet } from "./ipc";

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "updater_last_check"; // key/value settings row (RAWY-162 pattern)

export type UpdResult =
  | { k: "uptodate"; ver: string }
  | { k: "available"; ver: string; url: string; notes: string }
  | { k: "unavailable" };

export async function runUpdateCheck(): Promise<UpdResult> {
  try {
    const r = await checkForUpdate();
    if (!r.configured) return { k: "unavailable" }; // no public feed yet (placeholder URL) → quiet
    if (r.isNewer) return { k: "available", ver: r.latest, url: r.url, notes: r.notes };
    return { k: "uptodate", ver: r.current };
  } catch {
    return { k: "unavailable" }; // offline / unreachable / bad manifest → quiet
  }
}

// The rosette's visible state. `checking` drives the spin, `available` shows the badge, `uptodate`
// shows the settle-with-check, `unavailable` is quiet (used only briefly after a manual tap).
export type RosetteState = "idle" | "checking" | "uptodate" | "available" | "unavailable";

interface UpdaterStore {
  state: RosetteState;
  ver: string;
  url: string;
  notes: string;
  autoDone: boolean;
  /** Once-per-session, gated to ≤1/day via `updater_last_check`. Silent unless an update is found. */
  auto: () => Promise<void>;
  /** Explicit tap — always checks (ignores the daily gate) and shows the outcome. */
  manual: () => Promise<void>;
  /** Return to the quiet idle rosette (clears any badge/card data). */
  dismiss: () => void;
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  state: "idle",
  ver: "",
  url: "",
  notes: "",
  autoDone: false,

  auto: async () => {
    if (get().autoDone) return; // run at most once per app session (survives Library remounts)
    set({ autoDone: true });
    const last = await settingsGet(LAST_CHECK_KEY).catch(() => null);
    if (last && Date.now() - Number(last) < DAY_MS) return; // gated: already checked within 24h
    const r = await runUpdateCheck();
    settingsSet(LAST_CHECK_KEY, String(Date.now())).catch(() => {});
    // Silent: show the badge only if there's genuinely a newer version; otherwise stay idle.
    if (r.k === "available") set({ state: "available", ver: r.ver, url: r.url, notes: r.notes });
  },

  manual: async () => {
    if (get().state === "checking") return;
    set({ state: "checking" });
    const r = await runUpdateCheck();
    settingsSet(LAST_CHECK_KEY, String(Date.now())).catch(() => {});
    if (r.k === "available") set({ state: "available", ver: r.ver, url: r.url, notes: r.notes });
    else if (r.k === "uptodate") set({ state: "uptodate", ver: r.ver });
    else set({ state: "unavailable" });
  },

  dismiss: () => set({ state: "idle", ver: "", url: "", notes: "" }),
}));
