// src/reader-engine/discordPresence.ts
//
// Watches the reader store AND the Discord settings store, and mirrors the
// result to Discord Rich Presence via the Rust `discord_set_reading` /
// `discord_clear` commands. Kept as a separate subscriber rather than baked
// into store.ts, since the store itself has no other IPC side effects - this
// stays opt-in and easy to rip out.
//
// Two subscriptions feed one `push()`: reader-store changes (page turns,
// chapter changes, the throttled progress tick) AND settings-store changes
// (flipping a toggle in the Sharing tab) both need to update Discord - the
// second one specifically so a toggle takes effect immediately rather than
// waiting for the next natural reading event.
//
// Call initDiscordPresence() once at app startup (e.g. in App.tsx).

import { useReader } from "./store";
import { discordSetReading, discordClear, discordSetBrowsing } from "../lib/ipc";
import { useDiscordSettings } from "../lib/discordSettings";

const FRACTION_CHANGE_THRESHOLD = 0.01; // only push on >=1% progress change
const MIN_UPDATE_INTERVAL_MS = 30_000; // don't spam Discord more than every 30s

let lastBookId: string | null = null;
let lastFractionSent: number | null = null;
let lastChapterSent: string | null = null;
let lastSentAt = 0;

/**
 * Sends (or clears) presence based on the CURRENT reader + settings state.
 * `force` bypasses the throttle - used when a settings toggle changes, since
 * that should take effect immediately rather than waiting for the next
 * natural reading event.
 */
function push(force: boolean): void {
  const { bookId, bookTitle, chapterLabel, status, fraction } = useReader.getState();

  if (!bookId || status === "idle") {
    if (lastBookId !== null) {
      lastBookId = null;
      lastFractionSent = null;
      lastChapterSent = null;
      void discordClear().catch(() => {
        /* Discord not running - safe to ignore */
      });
    }
    return;
  }

  if (status !== "ready" || !bookTitle) return;

  const now = Date.now();
  const bookChanged = bookId !== lastBookId;
  const chapterChanged = chapterLabel !== lastChapterSent;
  const fractionMoved =
    lastFractionSent === null ||
    Math.abs(fraction - lastFractionSent) >= FRACTION_CHANGE_THRESHOLD;
  const enoughTimePassed = now - lastSentAt >= MIN_UPDATE_INTERVAL_MS;

  if (!force && !bookChanged && !chapterChanged && !(fractionMoved && enoughTimePassed)) return;

  lastBookId = bookId;
  lastFractionSent = fraction;
  lastChapterSent = chapterLabel;
  lastSentAt = now;

  const { showTitle, showChapter, showProgress } = useDiscordSettings.getState();

  const title = showTitle ? bookTitle : "a book";
  const chapter = showChapter ? chapterLabel : null;
  const progressPct = showProgress ? Math.round(fraction * 100) : null;

  void discordSetReading(title, null, chapter, progressPct).catch(() => {
    /* Discord not running - safe to ignore */
  });
}

export function initDiscordPresence(): () => void {
  const unsubReader = useReader.subscribe(() => push(false));

  // Any Sharing-tab toggle change re-sends immediately (force=true), so
  // turning "Show progress" off, for example, clears the stale "0%" right
  // away instead of waiting for the next page turn or the 30s throttle.
  const unsubSettings = useDiscordSettings.subscribe(() => push(true));

  return () => {
    unsubReader();
    unsubSettings();
  };
}

/**
 * Call at the definite moment a book is closed (e.g. Reader's onExit).
 * Shows "Browsing the library" instead of going fully blank, but respects
 * the master switch - if presence sharing is off, this is a no-op.
 * Also resets the internal dedup trackers so re-opening the same book is
 * treated as a fresh session rather than a no-op.
 */
export function showBrowsingPresence(): void {
  lastBookId = null;
  lastFractionSent = null;
  lastChapterSent = null;

  if (!useDiscordSettings.getState().enabled) return;

  void discordSetBrowsing().catch(() => {
    /* Discord not running - safe to ignore */
  });
}