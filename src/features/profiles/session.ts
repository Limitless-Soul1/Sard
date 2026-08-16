// THE SESSION LAYER — what a profile looks like right now, when that is not what it was saved as.
//
// A profile owns four values that can be changed from OUTSIDE its editor: the app theme, the book
// theme, and the two book faces. Changing one of them while a profile is active poses a question
// only the reader can answer — does this belong to the profile, to a new one, or to this sitting
// alone? — and the design answers it by asking rather than guessing (frame 21).
//
// THIS SLICE IS THE "ASKING" PART. It records that a value has drifted from the profile that owns
// it. It persists nothing: a drift lives in memory, and the settings write that produced it was done
// by the ordinary setter, which is deliberately left alone — a reader with no profiles must keep the
// behaviour they have always had.
//
// SESSION-ONLY IS GUARANTEED AT STARTUP, NOT AT SHUTDOWN. `initProfiles` re-applies the active
// profile's own values on every launch, so a drift the reader chose to keep for the session simply
// is not there next time. That direction matters: a shutdown hook cannot survive a crash or a kill,
// and a guarantee that holds only on a clean exit is not a guarantee.

import { create } from "zustand";

import { useReader } from "../../reader-engine/store";
import { useTheme } from "../../theme/store";
import type { Profile } from "./model/profile";

/** The four profile-owned values reachable from outside the editor. */
export type SessionKey = "theme_id" | "book_theme_id" | "arabicFont" | "latinFont";

export const SESSION_KEYS: readonly SessionKey[] = [
  "theme_id",
  "book_theme_id",
  "arabicFont",
  "latinFont",
] as const;

/** What the profile says each of the four should be. */
export function profileValues(p: Profile): Record<SessionKey, string> {
  return {
    // A profile IS its theme, under its own id — that is what the resolver registers.
    theme_id: p.id,
    book_theme_id: p.id,
    arabicFont: p.data.type.arabic,
    latinFont: p.data.type.latin,
  };
}

/** What Sard is actually showing right now. */
export function liveValues(): Record<SessionKey, string> {
  const t = useTheme.getState();
  const s = useReader.getState().style;
  return {
    theme_id: String(t.themeId),
    book_theme_id: String(t.bookThemeId),
    arabicFont: String(s?.arabicFont ?? ""),
    latinFont: String(s?.latinFont ?? ""),
  };
}

/**
 * Which of the four differ from what the profile saved.
 *
 * An empty face reads as "no drift" rather than as a change to nothing: the reading style fills
 * absent fields from the per-script defaults at render time, and an absent field is not a value the
 * reader chose.
 */
export function driftOf(p: Profile): SessionKey[] {
  const want = profileValues(p);
  const have = liveValues();
  return SESSION_KEYS.filter((k) => {
    if (k === "arabicFont" || k === "latinFont") {
      return have[k] !== "" && have[k] !== want[k];
    }
    return have[k] !== want[k];
  });
}

interface SessionState {
  /** The keys the reader has explicitly chosen to keep for this session only. */
  accepted: SessionKey[];
  /** The drift currently awaiting an answer, or null when there is nothing to ask about. */
  pending: SessionKey[] | null;
  ask: (keys: SessionKey[]) => void;
  dismiss: () => void;
  keepForSession: (keys: SessionKey[]) => void;
  reset: () => void;
}

export const useSession = create<SessionState>((set) => ({
  accepted: [],
  pending: null,
  ask: (keys) => set({ pending: keys.length ? keys : null }),
  dismiss: () => set({ pending: null }),
  // Accepting is the whole of "session only": nothing is written anywhere, and the key is remembered
  // so the reader is not asked about the same drift again this sitting.
  keepForSession: (keys) =>
    set((s) => ({ accepted: [...new Set([...s.accepted, ...keys])], pending: null })),
  reset: () => set({ accepted: [], pending: null }),
}));
