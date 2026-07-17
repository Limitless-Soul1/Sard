import { useCallback, useEffect, useRef, useState } from "react";

// Chrome-on-intent (RAWY-14, band C; hardened RAWY-72; RAWY-194): the reading chrome is shown on a
// DELIBERATE intent (pointer reach to the top edge, scroll-up, an opened panel, or keyboard focus entering
// the toolbar) and auto-hides after a quiet period, for immersive reading. RAWY-194 removed the old
// wake-on-ANY-keydown (it revealed the bar on every keystroke, incl. TTS transport keys). It fades/slides
// via CSS (see `.reader-chrome` transitions), so this hook only decides show vs hide.
//
// RAWY-72 makes the auto-hide RELIABLE and the wake COMPLETE:
//  • Reliable HIDE — a plain `mousemove → wake` reset the timer on EVERY move event, including the
//    browser's synthetic same-position mousemove (fired when the bar toggles under a resting cursor)
//    and the tiny jitter of a hand resting on the mouse. Those kept re-arming the timer, so the bar
//    "sometimes wouldn't hide". Now a move only counts as intent when the pointer actually LEAVES a
//    small jitter box around the last wake position — synthetic/jitter moves are ignored and the
//    timer runs to completion.
//  • Complete WAKE — pointer events inside the foliate content iframe do NOT reach a `window`
//    listener (a same-origin child frame doesn't bubble events across the boundary), so moving/tapping
//    over the reading TEXT (most of the screen) never woke the bar. The controller now forwards the
//    content frame's pointermove/pointerdown here (already-parent-viewport coords) via `signalMove` /
//    `wake`, so activity anywhere in the reading area brings the bar back.
//
// RAWY-117 kills the SCROLL FLICKER: a hide (scroll-down, and the idle timer) used to `null` the
// jitter anchor, so the very next move of ANY size re-showed the bar. But scrolling under a resting
// cursor FIRES mousemoves (the content, not the pointer, moves — a new element sits under the cursor),
// which the controller forwards here. So each wheel tick hid the bar while its induced move re-showed
// it → a rapid show/hide flicker; likewise any resting-hand tremor re-showed it. Now a hide ANCHORS
// the jitter box on the resting cursor (`lastPos`) instead of clearing it, so those synthetic/same-
// position moves fall inside the box and are ignored — the bar returns only on a DELIBERATE move that
// leaves the (widened) box. Tap/key `wake` stays intent and still re-anchors from wherever the pointer
// lands next.
//
// Panels still PIN the bar: while a panel/drawer is open the reader calls setHold(true), which keeps
// it shown and suppresses the timer until everything closes. Honors prefers-reduced-motion at the CSS
// layer (transitions disabled there).
const AUTO_HIDE_MS = 2600;
// A pointer move within this many px of the anchor is treated as jitter (or a synthetic same-position
// move) and ignored. Widened RAWY-117 from 4 → 12: a deliberate reach still escapes it instantly, but
// a resting hand's tremor and the browser's near-zero-distance synthetic moves (bar toggling / content
// scrolling under the cursor) no longer re-show the bar.
const JITTER_PX = 12;
// RAWY-118: on the owner's machine a widened jitter box still wasn't enough — ANY ordinary reading
// move (well over 12 px) re-showed the bar. So a mouse move now RE-SHOWS a hidden bar only when the
// pointer reaches the top-edge zone (a deliberate reach for the bar, like fullscreen-video controls);
// a move anywhere else in the reading area is ignored while hidden. Tap / key / scroll-up still bring
// it back from anywhere, and while the bar is already shown any move keeps it awake (resets the idle
// timer) so it never hides mid-use. ~ the bar height, so the target is easy without being twitchy.
const TOP_REVEAL_PX = 64;

export function useChromeOnIntent(): {
  visible: boolean;
  // RAWY-211: TRUE only while the chrome is hidden by a DELIBERATE scroll-DOWN — never by the ordinary
  // idle auto-hide. Immersive mode (RAWY-210) hides the TTS pill + scrollbar on THIS, not on `visible`,
  // so an idle-hide of the toolbar no longer drags the transport to pointer-events:none (the RAWY-211 bug:
  // ~2.6s after enabling immersive the pill went dead while the user did nothing). Cleared on every wake.
  scrolledAway: boolean;
  wake: () => void;
  signalMove: (x: number, y: number) => void;
  signalScroll: (down: boolean) => void;
  setHold: (v: boolean) => void;
} {
  const [visible, setVisible] = useState(true); // visible on entry, then settles
  // RAWY-211: the intent flag above. Set true ONLY in signalScroll(down); cleared whenever the chrome
  // becomes visible again (folded into setVis, so every wake path — scroll-up, top-edge reveal, tap wake,
  // panel hold — clears it by construction).
  const [scrolledAway, setScrolledAway] = useState(false);
  // RAWY-118: a ref mirror of `visible` so the move handler can branch on it synchronously (React
  // state is stale inside the stable callback). `setVis` keeps the two in lock-step.
  const visibleRef = useRef(true);
  const setVis = useCallback((v: boolean) => {
    visibleRef.current = v;
    setVisible(v);
    if (v) setScrolledAway(false); // RAWY-211: any path that SHOWS the chrome un-scrolls-away
  }, []);
  const holdRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // The pointer position at the last wake; a move is "real" only if it leaves the jitter box around it.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  // RAWY-117: the latest pointer position seen (updated on every move, before the jitter test). A hide
  // anchors the jitter box HERE — on the resting cursor — so the synthetic same-position move a scroll
  // fires under it is absorbed instead of re-showing the bar (the old `anchor = null` re-showed on it).
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (holdRef.current) return; // pinned open by a panel
    timer.current = window.setTimeout(() => setVis(false), AUTO_HIDE_MS);
  }, [setVis]);

  // A tap / key / programmatic wake — always intent. Clears the anchor so the NEXT move re-anchors
  // (and thus wakes) from wherever the pointer then is.
  const wake = useCallback(() => {
    anchor.current = null;
    setVis(true);
    arm();
  }, [arm, setVis]);

  // A pointer MOVE (from the window OR the forwarded content frame, both in parent-viewport coords).
  // Jitter (a move within the box of the last anchor) is ignored, so the idle timer can still run to
  // completion. For a genuine move (RAWY-118):
  //   • while the bar is SHOWN — keep it awake (re-anchor + reset the idle timer), never hide mid-use;
  //   • while the bar is HIDDEN — re-show ONLY when the pointer reaches the top-edge zone (a deliberate
  //     reach for the bar). An ordinary reading move elsewhere leaves the bar hidden — this is the
  //     twitch fix; JITTER_PX alone was not enough on the owner's machine.
  const signalMove = useCallback(
    (x: number, y: number) => {
      lastPos.current = { x, y }; // remember the true cursor even for a jitter move (RAWY-117)
      const a = anchor.current;
      if (a && Math.abs(x - a.x) <= JITTER_PX && Math.abs(y - a.y) <= JITTER_PX) return;
      anchor.current = { x, y };
      if (visibleRef.current) {
        arm(); // already shown → keep awake, reset the idle timer
        return;
      }
      if (y <= TOP_REVEAL_PX) {
        // hidden → a deliberate reach into the top-edge zone brings the bar back
        setVis(true);
        arm();
      }
      // hidden + move elsewhere → stay hidden (the idle timer is already stopped)
    },
    [arm, setVis],
  );

  // RAWY-73: scroll intent (scrolled mode). Scrolling DOWN is a strong "I'm reading" signal → hide
  // now (and stop the idle timer — the scroll position is the intent). Scrolling UP → show (like a
  // wake). Respects a legitimate pin (a Settings/Notes drawer being open), so it never fights those.
  const signalScroll = useCallback(
    (down: boolean) => {
      // RAWY-117: anchor the jitter box on the resting cursor (not null) so the mousemove a scroll
      // fires under a stationary pointer is absorbed — no scroll flicker. It re-shows only on a
      // deliberate move that leaves the box.
      if (down) {
        if (holdRef.current) return; // a pinned drawer stays; don't hide under it
        if (timer.current) clearTimeout(timer.current);
        anchor.current = lastPos.current;
        setVis(false);
        setScrolledAway(true); // RAWY-211: a DELIBERATE scroll-down — this (not idle) hides the pill/scrollbar
      } else {
        anchor.current = lastPos.current;
        setVis(true);
        arm();
      }
    },
    [arm, setVis],
  );

  const setHold = useCallback(
    (v: boolean) => {
      holdRef.current = v;
      if (v) setVis(true);
      else arm();
    },
    [arm, setVis],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => signalMove(e.clientX, e.clientY);
    const onTap = () => wake();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("pointerdown", onTap, { passive: true });
    // RAWY-194 (C): NO `keydown → wake`. Waking on ANY window keydown revealed the reading chrome on every
    // keystroke — a stray key, Tab, Escape, a modifier, and (the report) Space/arrows, which are TTS
    // transport, not a "show the toolbar" intent. No bare keystroke is a genuine reveal intent; the chrome
    // is revealed by DELIBERATE acts only — a pointer reach to the top edge, scroll-up, an opened panel
    // (setHold), and keyboard FOCUS entering the toolbar (the reader reveals+pins it on chrome focusin).
    arm(); // start the initial auto-hide countdown
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerdown", onTap);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [signalMove, wake]);

  return { visible, scrolledAway, wake, signalMove, signalScroll, setHold };
}
