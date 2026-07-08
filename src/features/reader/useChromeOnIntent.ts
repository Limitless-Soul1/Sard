import { useCallback, useEffect, useRef, useState } from "react";

// Chrome-on-intent (RAWY-14, band C; hardened RAWY-72): the reading chrome is shown while there is
// pointer/keyboard activity and auto-hides after a quiet period, for immersive reading. It fades/
// slides via CSS (see `.reader-chrome` transitions), so this hook only decides show vs hide.
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

export function useChromeOnIntent(): {
  visible: boolean;
  wake: () => void;
  signalMove: (x: number, y: number) => void;
  signalScroll: (down: boolean) => void;
  setHold: (v: boolean) => void;
} {
  const [visible, setVisible] = useState(true); // visible on entry, then settles
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
    timer.current = window.setTimeout(() => setVisible(false), AUTO_HIDE_MS);
  }, []);

  // A tap / key / programmatic wake — always intent. Clears the anchor so the NEXT move re-anchors
  // (and thus wakes) from wherever the pointer then is.
  const wake = useCallback(() => {
    anchor.current = null;
    setVisible(true);
    arm();
  }, [arm]);

  // A pointer MOVE (from the window OR the forwarded content frame, both in parent-viewport coords).
  // Ignored when it stays within the jitter box of the last wake — this is what makes the bar hide
  // reliably despite synthetic/jitter moves. A genuine move re-anchors and keeps the bar awake.
  const signalMove = useCallback(
    (x: number, y: number) => {
      lastPos.current = { x, y }; // remember the true cursor even for a jitter move (RAWY-117)
      const a = anchor.current;
      if (a && Math.abs(x - a.x) <= JITTER_PX && Math.abs(y - a.y) <= JITTER_PX) return;
      anchor.current = { x, y };
      setVisible(true);
      arm();
    },
    [arm],
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
        setVisible(false);
      } else {
        anchor.current = lastPos.current;
        setVisible(true);
        arm();
      }
    },
    [arm],
  );

  const setHold = useCallback(
    (v: boolean) => {
      holdRef.current = v;
      if (v) setVisible(true);
      else arm();
    },
    [arm],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => signalMove(e.clientX, e.clientY);
    const onTap = () => wake();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("pointerdown", onTap, { passive: true });
    window.addEventListener("keydown", onTap);
    arm(); // start the initial auto-hide countdown
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerdown", onTap);
      window.removeEventListener("keydown", onTap);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [signalMove, wake]);

  return { visible, wake, signalMove, signalScroll, setHold };
}
