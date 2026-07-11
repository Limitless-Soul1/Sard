// TTS minimized player (RAWY-156; locked to RIBBON in RAWY-157) — a silk-bookmark ribbon that hangs
// from the TOP EDGE of the screen and stands in for the full pill while audio keeps playing, so it no
// longer covers the reading text. The owner tried four shape directions and chose the ribbon; the
// others were removed. On-brand via var(--accent) (the pill's own token — gold in Moonlit, terracotta
// elsewhere), so it never recolours; RTL-aware.
//
// TWO clear hit-areas (RAWY-157, owner feedback): the round wax-SEAL toggles play/pause (without
// expanding); tapping the ribbon BODY (or its ⌄ cue) expands back to the full pill.
//
// It docks at the very top of the VIEWPORT (position:fixed; top:0), INDEPENDENT of the reader's
// auto-hiding top bar, so it stays visible whether that bar is shown or hidden, and it DRAGS
// HORIZONTALLY ONLY — sliding left⇄right along the top edge, clamped to the viewport (vertical is
// fixed at the top).
//
// EVENT ISOLATION (LESSON #1): the reader auto-hides its chrome on window `pointerdown`→wake and
// `mousemove`→signalMove, plus book text-selection + wheel scroll. So grabbing/dragging is scoped to
// the ribbon ONLY: onPointerDown stopPropagation()s (never wakes the chrome), the drag adds a
// CAPTURE-phase window `mousemove` stopper (fires before the chrome hook's bubble listener → it never
// sees drag moves), and onWheel stopPropagation()s (no scroll-through). It sits over the foliate
// iframe so pointers never reach the book (no selection); user-select/touch-action are none.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { useTts } from "../../lib/tts";

// The ribbon's box (must match the `.tts-mini--ribbon` CSS) — used for the horizontal clamp.
const RIB = { w: 56, h: 170 };
const defaultLeft = (): number => Math.round((window.innerWidth - RIB.w) / 2); // top-centre, clear of the corner controls

export function TtsMini({ onExpand }: { onExpand: () => void }) {
  const { t, dir } = useI18n();
  const status = useTts((s) => s.status);
  const toggle = useTts((s) => s.toggle);
  const playing = status === "playing";

  // Horizontal position only; the ribbon is pinned to the top edge (y fixed by CSS `top:0`).
  const [x, setX] = useState(defaultLeft);
  const xRef = useRef(x);
  xRef.current = x;

  // Keep it on-screen if the window resizes (clamp the horizontal position).
  useEffect(() => {
    const onResize = () => setX((v) => Math.max(0, Math.min(v, window.innerWidth - RIB.w)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- horizontal-only drag, isolated from the reader chrome / selection / scroll ----
  // Stable handler refs so add/removeEventListener use the SAME references across re-renders.
  const drag = useRef<{ dx: number; sx: number; moved: boolean } | null>(null);
  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;
  const h = useRef<{ move: (e: PointerEvent) => void; end: () => void; kill: (e: Event) => void } | null>(null);
  if (!h.current) {
    h.current = {
      move: (e: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.sx) > 4) d.moved = true;
        setX(Math.max(0, Math.min(window.innerWidth - RIB.w, e.clientX - d.dx))); // x only
      },
      end: () => {
        const d = drag.current;
        drag.current = null;
        const hh = h.current!;
        window.removeEventListener("pointermove", hh.move);
        window.removeEventListener("pointerup", hh.end);
        window.removeEventListener("mousemove", hh.kill, true);
        if (d && !d.moved) onExpandRef.current(); // a tap (no drag) expands back to the pill
      },
      kill: (e: Event) => e.stopPropagation(), // capture-phase → beats the chrome hook's window mousemove
    };
  }

  const onGrab = (e: React.PointerEvent) => {
    e.stopPropagation(); // do NOT wake the reader chrome (window pointerdown → wake)
    e.preventDefault(); // no text-selection / focus start
    drag.current = { dx: e.clientX - xRef.current, sx: e.clientX, moved: false };
    const hh = h.current!;
    window.addEventListener("pointermove", hh.move);
    window.addEventListener("pointerup", hh.end);
    window.addEventListener("mousemove", hh.kill, true);
  };
  useEffect(() => () => h.current?.end(), []); // tidy up a live drag on unmount

  const stopP = (e: React.SyntheticEvent) => e.stopPropagation();
  const onPlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggle();
  };
  const playLabel = playing ? t("tts.pause") : t("tts.play");

  return (
    <div
      className={`tts-mini tts-mini--ribbon${playing ? " playing" : ""}`}
      style={{ left: x, width: RIB.w, height: RIB.h }}
      dir={dir}
      role="group"
      aria-label={t("tts.player")}
      title={t("tts.expand")}
      onPointerDown={onGrab}
      onWheel={stopP}
    >
      <div className="tts-rib" aria-hidden>
        <div className="tts-rib-body"><span className="tts-rib-sheen" /></div>
      </div>
      {/* the round seal = play/pause (does NOT expand) */}
      <button className="tts-mini-play tts-rib-seal" onClick={onPlay} onPointerDown={stopP} aria-label={playLabel} title={playLabel}>
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.4" height="16" rx="1.4" /><rect x="13.6" y="4" width="4.4" height="16" rx="1.4" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
        )}
      </button>
      {/* the ⌄ cue = expand back to the full pill (tapping the body does the same) */}
      <span className="tts-mini-cue" aria-hidden title={t("tts.expand")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </span>
    </div>
  );
}
