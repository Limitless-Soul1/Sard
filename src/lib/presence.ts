// Discord Rich Presence (feature: disc/rpc) — what the Reader shows on your Discord profile.
//
// Owns the on/off setting and the ONE reading session the app may have (the Reader is reused
// across books, so a session belongs to a book-open, not to a mount). The Rust side enforces the
// same setting again in `presence_update`; this store is the UI's copy of the switch.
//
// WHAT GETS SENT is deliberately small and deliberately shaped by the reader: details = the book
// title, state = the chapter label (or "NN%"), plus the book-open timestamp. No highlights, no
// notes, no search terms, no file paths ever leave the machine. Discord shows it only while a
// book is open and only when the Discord desktop app is running.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { settingsGet, settingsSet } from "./ipc";

const K_ENABLED = "discord_rpc_enabled";

export interface PresenceState {
  ready: boolean;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export const usePresence = create<PresenceState>((set) => ({
  ready: false,
  enabled: true,
  setEnabled: (v) => {
    set({ enabled: v });
    settingsSet(K_ENABLED, v ? "1" : "0").catch(console.error);
    if (v) {
      // Turning it back ON mid-book: re-send the live session instead of waiting for the next
      // page turn (which, in a long chapter, may be minutes away).
      refreshSession();
    } else {
      presenceClear().catch(() => {});
    }
  },
}));

/** Load the persisted switch at startup, alongside every other `init*` (App.tsx). */
export async function initPresence() {
  const raw = await settingsGet(K_ENABLED).catch(() => null);
  usePresence.setState({ enabled: raw !== "0", ready: true });
}

// ---- the reading session --------------------------------------------------

interface Session {
  details: string;
  state: string | null;
  startedAt: number;
}

let session: Session | null = null;
let lastSentAt = 0;
let lastChapter: string | null = null;
let lastPct = -1;

// Discord rate-limits SET_ACTIVITY (~5 per 20 s); a chapter change or a 1 % step is plenty of
// resolution for a reading status, and both are re-checked before every send (see push()).
const THROTTLE_MS = 10_000;

/** The book opened: start the session, with the clock running from right now. */
export function startReadingSession(details: string) {
  session = { details, state: null, startedAt: Date.now() };
  lastChapter = null;
  lastPct = -1;
  push();
}

/** A relocate arrived: refresh the position line (chapter label, else whole-book percent). */
export function updateReadingSession(chapterLabel: string | null, fraction: number) {
  if (!session) return;
  const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)));
  const chapter = chapterLabel?.trim() || null;
  if (chapter === lastChapter && pct === lastPct) return; // nothing a viewer would notice changed
  lastChapter = chapter;
  lastPct = pct;
  session.state = chapter ?? `${pct}%`;
  push();
}

/** The book closed (Back to Library, another book, window close): the activity must disappear. */
export function endReadingSession() {
  session = null;
  presenceClear().catch(() => {});
}

function push() {
  const s = session;
  if (!s) return;
  if (!usePresence.getState().enabled) return;
  const now = Date.now();
  if (now - lastSentAt < THROTTLE_MS) return;
  lastSentAt = now;
  presenceUpdate(s).catch(() => {});
}

function refreshSession() {
  if (!session) return;
  lastSentAt = 0; // bypass the throttle: this is a deliberate re-send, not a stream
  push();
}

const presenceUpdate = (s: Session): Promise<void> =>
  invoke<void>("presence_update", {
    activity: { details: s.details, state: s.state, startedAt: s.startedAt },
  });

const presenceClear = (): Promise<void> => invoke<void>("presence_clear");
