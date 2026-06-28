import { useCallback, useEffect, useRef, useState } from "react";

// Chrome-on-intent (RAWY-14, band C): reading chrome is hidden while reading and fades
// in on cursor movement / tap, then auto-hides after a quiet period. Returns the current
// visibility + a `wake()` to force-show (e.g. when a panel opens) and a `hold` setter to
// pin it open. Honors prefers-reduced-motion at the CSS layer (transitions disabled there).
const AUTO_HIDE_MS = 2600;

export function useChromeOnIntent(): {
  visible: boolean;
  wake: () => void;
  setHold: (v: boolean) => void;
} {
  const [visible, setVisible] = useState(true); // visible on entry, then settles
  const holdRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (holdRef.current) return; // pinned open
    timer.current = window.setTimeout(() => setVisible(false), AUTO_HIDE_MS);
  }, []);

  const wake = useCallback(() => {
    setVisible(true);
    arm();
  }, [arm]);

  const setHold = useCallback(
    (v: boolean) => {
      holdRef.current = v;
      if (v) setVisible(true);
      else arm();
    },
    [arm],
  );

  useEffect(() => {
    const onMove = () => wake();
    const onKey = () => wake();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("keydown", onKey);
    arm(); // start the initial auto-hide countdown
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("keydown", onKey);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [wake, arm]);

  return { visible, wake, setHold };
}
