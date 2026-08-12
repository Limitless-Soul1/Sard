// Discord Rich Presence (feature: disc/rpc) — what the Reader shows on your Discord profile.
//
// Owns the on/off setting and the ONE reading session the app may have (the Reader is reused
// across books, so a session belongs to a book-open, not to a mount). The Rust side enforces the
// same setting again in `presence_update`; this store is the UI's copy of the switch.
//
// WHAT GETS SENT is deliberately small and deliberately shaped by the app: while no book is open,
// details = the app name with the browsing line; the moment a book opens, details = "Reading
// {book title}" and state = the chapter label + whole-book percent, plus the book-open timestamp.
// Closing the book returns the activity to the browsing line. No highlights, no notes, no search
// terms, no file paths ever leave the machine. Discord shows it only while the app is open and
// only when the Discord desktop app is running.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { translate, LANG_KEY, type Lang } from "../i18n";
import { settingsGet, settingsSet } from "./ipc";

const K_ENABLED = "discord_rpc_enabled";
// The presentation sub-switches, same convention (absent = on). The core re-checks them in
// `presence_update`; these copies drive the toggle UI and the live re-send when a flag flips.
const K_SHOW_BOOK = "discord_rpc_show_book";
const K_SHOW_POSITION = "discord_rpc_show_position";
const K_SHOW_BROWSING = "discord_rpc_show_browsing";
// The percent is wrapped in an LTR isolate (\u2066 … \u2069) because Discord typesets the state
// line with the UI paragraph direction: for an Arabic book the line is RTL, and a bare "45%" then
// renders as "%45" — the percent sign jumping to the left of the digits. The isolate pins the
// number's internal order regardless of the surrounding direction.
const LTR_ISOLATE = "\u2066";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

export interface PresenceState {
  ready: boolean;
  enabled: boolean;
  showBook: boolean;
  showPosition: boolean;
  showBrowsing: boolean;
  setEnabled: (v: boolean) => void;
  setShowBook: (v: boolean) => void;
  setShowPosition: (v: boolean) => void;
  setShowBrowsing: (v: boolean) => void;
}

export const usePresence = create<PresenceState>((set) => ({
  ready: false,
  enabled: true,
  showBook: true,
  showPosition: true,
  showBrowsing: true,
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
  setShowBook: (v) => {
    set({ showBook: v });
    settingsSet(K_SHOW_BOOK, v ? "1" : "0").catch(console.error);
    if (session?.kind === "reading") refreshSession(); // the core strips it NOW, not next page turn
  },
  setShowPosition: (v) => {
    set({ showPosition: v });
    settingsSet(K_SHOW_POSITION, v ? "1" : "0").catch(console.error);
    if (session?.kind === "reading") refreshSession();
  },
  setShowBrowsing: (v) => {
    set({ showBrowsing: v });
    settingsSet(K_SHOW_BROWSING, v ? "1" : "0").catch(console.error);
    if (v) {
      if (!session) beginBrowsingSession();
      else refreshSession();
    } else if (session?.kind === "browsing") {
      session = null;
      presenceClear().catch(() => {});
    }
  },
}));

/** Load the persisted switch and presentation flags at startup, alongside every other `init*`. */
export async function initPresence() {
  const raw = await settingsGet(K_ENABLED).catch(() => null);
  const [showBook, showPosition, showBrowsing] = await Promise.all([
    settingsGet(K_SHOW_BOOK).catch(() => null),
    settingsGet(K_SHOW_POSITION).catch(() => null),
    settingsGet(K_SHOW_BROWSING).catch(() => null),
  ]);
  usePresence.setState({
    enabled: raw !== "0",
    showBook: showBook !== "0",
    showPosition: showPosition !== "0",
    showBrowsing: showBrowsing !== "0",
    ready: true,
  });
  // DISC/RPC: the app is open with no book — Discord shows the browsing activity until a book
  // replaces it (startReadingSession) or the switch is flipped off (setEnabled clears).
  if (raw !== "0") beginBrowsingSession();
}

// ---- the reading session --------------------------------------------------

type SessionKind = "browsing" | "reading";

interface Session {
  kind: SessionKind;
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
  session = { kind: "reading", details: `Reading ${details}`, state: null, startedAt: Date.now() };
  lastChapter = null;
  lastPct = -1;
  push();
}

/** A relocate arrived: refresh the position line (chapter label + whole-book percent). */
export function updateReadingSession(chapterLabel: string | null, fraction: number) {
  if (!session) return;
  const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)));
  const chapter = chapterLabel?.trim() || null;
  if (chapter === lastChapter && pct === lastPct) return; // nothing a viewer would notice changed
  lastChapter = chapter;
  lastPct = pct;
  const pctLine = `${LTR_ISOLATE}${pct}%${POP_DIRECTIONAL_ISOLATE}`;
  const firstPosition = session.state === null;
  session.state = chapter ? `${chapter} · ${pctLine}` : pctLine;
  // The first position line (null → value) must go out NOW, not after the throttle: the session
  // start just sent the details-only activity, and the position belongs to the same book-open.
  if (firstPosition) lastSentAt = 0;
  push();
}

/** The book closed (Back to Library, another book, window close): back to the browsing activity. */
export function endReadingSession() {
  session = null;
  beginBrowsingSession();
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

/** The app is open, no book: the browsing activity, localized by the persisted UI language. */
async function beginBrowsingSession() {
  if (!usePresence.getState().showBrowsing) {
    // The browsing line is switched off: show nothing while no book is open. A later book-open
    // still replaces this (startReadingSession works regardless of the flag).
    session = null;
    presenceClear().catch(() => {});
    return;
  }
  const saved = await settingsGet(LANG_KEY).catch(() => "en");
  const lang: Lang = saved === "ar" ? "ar" : "en";
  session = {
    kind: "browsing",
    details: translate(lang, "app.name"),
    state: translate(lang, "presence.browsing"),
    startedAt: Date.now(),
  };
  lastSentAt = 0; // the first activity of a run goes out immediately, throttle or not
  push();
}

function refreshSession() {
  if (!session) return;
  lastSentAt = 0; // bypass the throttle: this is a deliberate re-send, not a stream
  push();
}

const presenceUpdate = (s: Session): Promise<void> =>
  invoke<void>("presence_update", {
    activity: { kind: s.kind, details: s.details, state: s.state, startedAt: s.startedAt },
  });

const presenceClear = (): Promise<void> => invoke<void>("presence_clear");
