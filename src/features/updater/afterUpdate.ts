// AFTER AN UPDATE — the store behind the once-per-version What's New dialog.
//
// The decision is made once per launch: the running version against the version whose notes this
// installation has already been shown (`SEEN_KEY`). The version is recorded only when the reader
// closes the dialog, never on the way to opening it — a read that fails, a launch that never got as
// far as showing it, or a write that does not land all leave the notes to be shown next time.
//
// A fresh install is not an update. The first-run language picker calls `markFirstRun()` before the
// library opens, which both tells this launch not to show the notes and records the installed
// version, so the next launch has nothing to announce either.

import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";

import { settingsGet, settingsSet } from "../../lib/ipc";
import { SEEN_KEY, shouldShowAfterUpdate } from "./whatsNew";

interface AfterUpdateStore {
  /** The dialog is waiting to be shown. */
  open: boolean;
  /** The version the dialog announces — the running one. */
  version: string | null;
  /** Decide, once per launch, whether this version's notes are due. */
  check: () => Promise<void>;
  /** The reader closed the dialog: record the version, so it is not shown again. */
  confirm: () => Promise<void>;
}

/** Set by the first-run picker in this process; a fresh install is never shown "what's new". */
let firstRun = false;
let checked = false;

/** The first-run language picker: this installation starts at the running version. */
export async function markFirstRun(): Promise<void> {
  firstRun = true; // synchronously, before the library mounts and asks
  try {
    const v = await getVersion();
    if (v) await settingsSet(SEEN_KEY, v);
  } catch {
    // Nothing recorded: the next launch would show this version's notes once. Better than never
    // recording anything; the first launch itself is still covered by `firstRun`.
  }
}

export const useAfterUpdate = create<AfterUpdateStore>((set, get) => ({
  open: false,
  version: null,

  check: async () => {
    if (checked) return; // the library remounts whenever a book closes; the question is per launch
    checked = true;
    if (firstRun) return;
    let version: string;
    let seen: string | null;
    try {
      version = await getVersion();
      seen = await settingsGet(SEEN_KEY);
    } catch {
      return; // cannot tell what was shown: show nothing, record nothing
    }
    if (shouldShowAfterUpdate(version, seen)) set({ open: true, version });
  },

  confirm: async () => {
    const { version } = get();
    set({ open: false });
    if (!version) return;
    try {
      await settingsSet(SEEN_KEY, version);
    } catch {
      // Not recorded: shown again next launch, which is the honest outcome of a failed write.
    }
  },
}));
