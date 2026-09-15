// The back stack as the mobile chrome uses it, plus the two things that make it real on a device:
// Android's Back button, and surviving a process death.
//
// The store is deliberately thin. All the decisions live in `navigation.ts` as pure functions, so the
// rules are testable without React, without a device, and without mounting anything.

import { useEffect, useRef } from "react";
import { create } from "zustand";

import {
  activePlace,
  deserialise,
  drawerOpen,
  initialNav,
  openDrawer,
  openPlace,
  openSheet,
  openSheetEntry,
  pop,
  push,
  readerBeneath,
  replace,
  serialise,
  top,
  type NavState,
  type Place,
  type Screen,
  type SheetKind,
} from "./navigation";

const RESTORE_KEY = "mobile_nav_stack";

interface NavStore extends NavState {
  push: (s: Screen) => void;
  /** Pops one entry. Returns false when nothing was left to pop — Back was not consumed. */
  back: () => boolean;
  openDrawer: () => void;
  openPlace: (p: Place) => void;
  openSheet: (s: SheetKind) => void;
  replace: (s: Screen) => void;
  restore: (raw: string | null) => void;
}

export const useNav = create<NavStore>((set, get) => ({
  ...initialNav(),
  push: (s) => set(push(get(), s)),
  back: () => {
    const next = pop(get());
    if (!next) return false;
    set(next);
    return true;
  },
  openDrawer: () => set(openDrawer(get())),
  openPlace: (p) => set(openPlace(get(), p)),
  openSheet: (s) => set(openSheetEntry(get(), s)),
  replace: (s) => set(replace(get(), s)),
  restore: (raw) => set(deserialise(raw)),
}));

export const useTop = (): Screen => useNav((s) => top(s));
export const useActivePlace = (): Place => useNav((s) => activePlace(s));
export const useDrawerOpen = (): boolean => useNav((s) => drawerOpen(s));
export const useOpenSheet = (): SheetKind | null => useNav((s) => openSheet(s));
/** The reader entry, whether it is the top screen or sits beneath an open sheet. Rule 1: popping a
 *  sheet must return to the SAME reader entry, so the shell must keep rendering it underneath. */
export const useReaderScreen = (): Extract<Screen, { kind: "reader" }> | null =>
  useNav((s) => (top(s).kind === "reader" ? (top(s) as Extract<Screen, { kind: "reader" }>) : readerBeneath(s)));

/**
 * Wire the stack to the platform.
 *
 * ANDROID BACK. The system button reaches the web view as a `popstate`, so the browser's history has
 * to be kept the same DEPTH as Sard's stack — one history entry per screen above the root, and none
 * at the root.
 *
 * WHY DEPTH-MATCHING RATHER THAN ONE SENTINEL. The obvious design keeps a single spare history entry
 * around to absorb Back and re-pushes it after each one. MEASURED ON A DEVICE, that is wrong at the
 * root: the spare entry swallows the first press silently, the reader taps Back on the Library and
 * nothing happens, and only the second press leaves the app. Matching depth removes the spare
 * entirely, so Back at the root reaches the platform on the first press, which is what a reader
 * expects and what Android's own guidance describes.
 *
 * PROGRAMMATIC POPS. Choosing a place from the drawer resets the stack to `[library]` or
 * `[library, place]`, which means unwinding several history entries at once. `history.go(-n)` fires
 * `popstate` once per entry, so those are counted and ignored — otherwise the stack would pop itself
 * a second time for each one.
 *
 * PERSISTENCE. Written on every change and read once at mount. `sessionStorage` rather than the
 * database: this is where the reader WAS, not what they own, and it should not outlive the process by
 * more than the restore that follows it.
 */
export function useNavPlatformBridge(): void {
  const stack = useNav((s) => s.stack);
  /** History entries we have pushed above the base entry. Mirrors `stack.length - 1`. */
  const pushed = useRef(0);
  /** `popstate` events we caused ourselves and must not act on. */
  const selfInflicted = useRef(0);

  useEffect(() => {
    try {
      useNav.getState().restore(sessionStorage.getItem(RESTORE_KEY));
    } catch {
      /* a refused storage read must not cost the reader their library */
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(RESTORE_KEY, serialise({ stack }));
    } catch {
      /* persistence is a convenience, never a precondition */
    }
  }, [stack]);

  // Keep the browser's history depth equal to the stack's depth above the root.
  useEffect(() => {
    const want = stack.length - 1;
    const have = pushed.current;
    if (want === have) return;
    try {
      if (want > have) {
        for (let i = have; i < want; i++) history.pushState({ sard: i + 1 }, "");
      } else {
        // Unwinding: each entry dropped will deliver a popstate we must ignore.
        selfInflicted.current += have - want;
        history.go(want - have);
      }
      pushed.current = want;
    } catch {
      /* history is unavailable in some embeddings; Back then falls through to the platform */
    }
  }, [stack.length]);

  useEffect(() => {
    const onPop = () => {
      if (selfInflicted.current > 0) {
        selfInflicted.current -= 1;
        return;
      }
      // A real Back. The browser has already dropped one entry, so account for it before asking the
      // stack — otherwise the effect above would try to unwind an entry that is already gone.
      pushed.current = Math.max(0, pushed.current - 1);
      const consumed = useNav.getState().back();
      if (!consumed) {
        // Nothing left to pop. There is no spare entry to protect the root, so this press has already
        // reached the end of history and the platform will leave the application — which is correct.
      }
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
}
