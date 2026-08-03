// The in-app updater, on Tauri's OFFICIAL updater plugin (RAWY-290 — supersedes the RAWY-168
// check-only path, which is gone: there is exactly one update system in Sard now).
//
// WHAT THE PLUGIN DOES, so the shape of this file makes sense: `check()` fetches the signed manifest
// from GitHub Releases, verifies its minisign signature against the public key compiled into the app,
// and resolves to an `Update` handle (or null when we are current). `update.download()` streams the
// NSIS installer, verifying its signature too; `update.install()` runs it with `/UPDATE` and exits
// this process. Nothing here fetches, hashes or verifies anything by hand — doing so would be exactly
// the custom updater this replaced.
//
// EVERY failure resolves to a state, never a throw. Offline, GitHub down, a corrupt body, a bad
// signature, a refused install — each has its own message, because "something went wrong" for six
// different causes is what made the old updater impossible to support.

import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";

import { settingsGet, settingsSet } from "./ipc";

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "updater_last_check"; // key/value settings row (RAWY-162 pattern)

/** Why a check or a download failed. The UI maps each to its own sentence. */
export type UpdErrorKind = "offline" | "server" | "signature" | "download" | "install" | "unknown";

/**
 * Classify a plugin error. The plugin surfaces strings from reqwest/minisign rather than typed
 * variants, so this reads them — deliberately conservatively: anything unrecognised stays "unknown"
 * and gets the generic sentence, instead of being force-fitted into a category that would tell the
 * reader something untrue about their own machine.
 */
export function classifyError(e: unknown): UpdErrorKind {
  const s = String((e as { message?: string })?.message ?? e ?? "").toLowerCase();
  if (/signature|minisign|verify|untrusted|corrupt/.test(s)) return "signature";
  if (/dns|connect|connection|timed out|timeout|network|unreachable|offline/.test(s)) return "offline";
  if (/404|403|5\d\d|status|not found|server/.test(s)) return "server";
  if (/download|body|stream|eof|incomplete/.test(s)) return "download";
  if (/install|exec|spawn|permission|denied/.test(s)) return "install";
  return "unknown";
}

export type UpdState =
  | { k: "idle" }
  | { k: "checking" }
  | { k: "uptodate"; current: string }
  /** A newer version exists. `update` is the live handle — held so the dialog can act on it. */
  | { k: "available"; current: string; version: string; notes: string; update: Update }
  | { k: "downloading"; version: string; received: number; total: number | null }
  | { k: "installing"; version: string }
  | { k: "error"; kind: UpdErrorKind };

interface UpdaterStore {
  state: UpdState;
  /** True once a check has run this session — the daily auto-check is at most once per launch. */
  autoDone: boolean;
  /** Set while a download is in flight so the dialog can offer to abandon it. */
  cancelRequested: boolean;

  /** Once per session, gated to ≤1/day. Silent unless an update is genuinely found. */
  auto: () => Promise<void>;
  /** An explicit tap: always checks, always shows the outcome — including "you're up to date". */
  manual: () => Promise<void>;
  /** Accept the update: download with progress, then install and restart. */
  install: () => Promise<void>;
  /** Abandon a download in progress. See the note on `cancelRequested`. */
  cancel: () => void;
  /** Back to the quiet rosette. */
  dismiss: () => void;
}

/** Run a check and normalise it into a terminal state. Never throws. */
async function runCheck(): Promise<UpdState> {
  const current = await getVersion().catch(() => "");
  try {
    // 30 s is generous for a small JSON manifest but tolerant of a slow connection; without it the
    // default can leave the rosette spinning for a long time on a captive-portal network.
    const update = await check({ timeout: 30_000 });
    if (!update) return { k: "uptodate", current };
    return {
      k: "available",
      current: current || update.currentVersion,
      version: update.version,
      notes: (update.body ?? "").trim(),
      update,
    };
  } catch (e) {
    return { k: "error", kind: classifyError(e) };
  }
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  state: { k: "idle" },
  autoDone: false,
  cancelRequested: false,

  auto: async () => {
    if (get().autoDone) return; // at most once per session (survives Library remounts)
    set({ autoDone: true });
    const last = await settingsGet(LAST_CHECK_KEY).catch(() => null);
    if (last && Date.now() - Number(last) < DAY_MS) return; // already checked within 24h
    const next = await runCheck();
    settingsSet(LAST_CHECK_KEY, String(Date.now())).catch(() => {});
    // Silent unless there is genuinely something to offer: an automatic check must never interrupt
    // a reader to tell them nothing happened.
    if (next.k === "available") set({ state: next });
  },

  manual: async () => {
    const s = get().state.k;
    if (s === "checking" || s === "downloading" || s === "installing") return;
    set({ state: { k: "checking" } });
    // Hold the spin briefly. A cached/near check can resolve in a few ms, and a tap that produces no
    // visible motion reads as a dead button — the exact complaint the old rosette drew.
    const [next] = await Promise.all([
      runCheck(),
      new Promise((r) => setTimeout(r, 650)),
    ]);
    settingsSet(LAST_CHECK_KEY, String(Date.now())).catch(() => {});
    set({ state: next });
  },

  install: async () => {
    const st = get().state;
    if (st.k !== "available") return;
    const { update, version } = st;
    set({ state: { k: "downloading", version, received: 0, total: null }, cancelRequested: false });

    try {
      // download() and install() are kept SEPARATE rather than using downloadAndInstall(), so there
      // is a real moment between "bytes are on disk" and "the installer runs" — that is the only
      // point a cancel can be honoured, and it is also where the signature has already been checked.
      await update.download((ev: DownloadEvent) => {
        if (ev.event === "Started") {
          set({ state: { k: "downloading", version, received: 0, total: ev.data.contentLength ?? null } });
        } else if (ev.event === "Progress") {
          const cur = get().state;
          if (cur.k !== "downloading") return;
          set({ state: { ...cur, received: cur.received + ev.data.chunkLength } });
        }
      });

      if (get().cancelRequested) {
        // The bytes are already verified and cached by the plugin; we simply do not install them.
        set({ state: { k: "idle" }, cancelRequested: false });
        return;
      }

      set({ state: { k: "installing", version } });
      // On Windows this hands off to the NSIS installer with `/UPDATE` and terminates this process,
      // so nothing after it runs. relaunch() is the documented path for the platforms where install()
      // returns; calling it unconditionally keeps one correct restart call for all of them.
      await update.install();
      await relaunch();
    } catch (e) {
      set({ state: { k: "error", kind: classifyError(e) }, cancelRequested: false });
    }
  },

  cancel: () => {
    const st = get().state;
    if (st.k === "downloading") set({ cancelRequested: true });
    else set({ state: { k: "idle" }, cancelRequested: false });
  },

  dismiss: () => set({ state: { k: "idle" }, cancelRequested: false }),
}));
