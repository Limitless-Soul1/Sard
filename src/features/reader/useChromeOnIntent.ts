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
// Panels still PIN the bar: while a panel/drawer is open the reader calls setHold(true), which keeps
// it shown and suppresses the timer until everything closes. Honors prefers-reduced-motion at the CSS
// layer (transitions disabled there).
const AUTO_HIDE_MS = 2600;
// A pointer move within this many px of the last wake position is treated as jitter (or a synthetic
// same-position move) and ignored — small enough that any deliberate move escapes it immediately,
// large enough to absorb a resting hand's tremor and the browser's zero-distance synthetic moves.
const JITTER_PX = 4;

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
      if (down) {
        if (holdRef.current) return; // a pinned drawer stays; don't hide under it
        if (timer.current) clearTimeout(timer.current);
        anchor.current = null;
        setVisible(false);
      } else {
        anchor.current = null;
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
