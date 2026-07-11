// TTS minimized player (RAWY-156) — a small, freely-draggable read-aloud token that stands in for
// the full pill while audio keeps playing, so it no longer covers the reading text. FOUR shape
// directions from `docs/design/Sard TTS Player - Minimized.html`, chosen live by a TEMPORARY
// switcher in TtsPlayer (the losing shapes get deleted in a later task once the owner picks one):
//   • ribbon (رِباط)  — a silk bookmark hanging from the top edge; the seal is play/pause
//   • hoopoe (هدهد)  — Sard's mascot in the corner, song-notes drifting while it reads
//   • reed  (مِسطرة) — a margin rule with a glowing bead at the current sentence = progress
//   • dogear (ثنية)  — a folded page corner that breathes; the fold face is play/pause
// On-brand via var(--accent) (the pill's own token — gold in Moonlit, terracotta elsewhere), so it
// never recolours. RTL-aware default docking (leading edge = right in RTL, left in LTR).
//
// EVENT ISOLATION (LESSON #1): the reader auto-hides its chrome on window `pointerdown`→wake and
// `mousemove`→signalMove, plus book text-selection + wheel scroll. So grabbing/dragging the shape is
// scoped to the shape ONLY: onPointerDown stopPropagation()s (never wakes the chrome), the drag adds
// a CAPTURE-phase window `mousemove` stopper (fires before the chrome hook's bubble listener → it
// never sees drag moves), and onWheel stopPropagation()s (no scroll-through). The shape sits over the
// foliate iframe so pointers never reach the book (no selection); user-select/touch-action are none.
// Tap (no drag) = expand back to the pill; the play/pause button toggles without expanding.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { useTts } from "../../lib/tts";

export type MiniShape = "ribbon" | "hoopoe" | "reed" | "dogear";
export const MINI_SHAPES: MiniShape[] = ["ribbon", "hoopoe", "reed", "dogear"];

// Container box per shape — used for the default dock position + the on-screen clamp.
const SIZE: Record<MiniShape, { w: number; h: number }> = {
  ribbon: { w: 40, h: 132 },
  hoopoe: { w: 100, h: 96 },
  reed: { w: 66, h: 132 },
  dogear: { w: 78, h: 78 },
};

function defaultPos(shape: MiniShape, rtl: boolean): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = 14;
  const s = SIZE[shape];
  const lead = rtl ? vw - s.w - m : m; // the reading-start edge
  switch (shape) {
    case "ribbon":
      return { x: lead, y: 6 }; // hangs from the top, leading side
    case "hoopoe":
      return { x: lead, y: vh - s.h - 22 }; // bottom-leading corner
    case "reed":
      return { x: lead, y: Math.round(vh * 0.26) }; // leading margin
    case "dogear":
      return { x: rtl ? vw - s.w : 0, y: vh - s.h }; // bottom-leading corner, flush
  }
}

export function TtsMini({ shape, onExpand }: { shape: MiniShape; onExpand: () => void }) {
  const { t, dir } = useI18n();
  const rtl = dir === "rtl";
  const status = useTts((s) => s.status);
  const index = useTts((s) => s.index);
  const total = useTts((s) => s.total);
  const toggle = useTts((s) => s.toggle);
  const playing = status === "playing";
  const trackPct = total > 1 ? Math.max(0, Math.min(100, (index / (total - 1)) * 100)) : 0;

  const [pos, setPos] = useState(() => defaultPos(shape, rtl));
  const posRef = useRef(pos);
  posRef.current = pos;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  // Re-dock to the shape's default edge when the shape or direction changes.
  useEffect(() => {
    setPos(defaultPos(shape, rtl));
  }, [shape, rtl]);

  // Keep it on-screen if the window resizes (clamp both axes).
  useEffect(() => {
    const onResize = () => {
      const s = SIZE[shapeRef.current];
      setPos((p) => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - s.w)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - s.h)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- free drag (isolated from the reader chrome / selection / scroll) ----
  // Stable handler refs so add/removeEventListener use the SAME references across re-renders.
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const h = useRef<{ move: (e: PointerEvent) => void; end: () => void; kill: (e: Event) => void } | null>(null);
  if (!h.current) {
    h.current = {
      move: (e: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
        const s = SIZE[shapeRef.current];
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - s.w, e.clientX - d.dx)),
          y: Math.max(0, Math.min(window.innerHeight - s.h, e.clientY - d.dy)),
        });
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
  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;

  const onGrab = (e: React.PointerEvent) => {
    e.stopPropagation(); // do NOT wake the reader chrome (window pointerdown → wake)
    e.preventDefault(); // no text-selection / focus start
    drag.current = { dx: e.clientX - posRef.current.x, dy: e.clientY - posRef.current.y, sx: e.clientX, sy: e.clientY, moved: false };
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
  const playIco = playing ? (
    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.4" height="16" rx="1.4" /><rect x="13.6" y="4" width="4.4" height="16" rx="1.4" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
  );
  const playBtn = (cls: string) => (
    <button className={`tts-mini-play ${cls}`} onClick={onPlay} onPointerDown={stopP} aria-label={playLabel} title={playLabel}>
      {playIco}
    </button>
  );

  return (
    <div
      className={`tts-mini tts-mini--${shape}${playing ? " playing" : ""}`}
      style={{ left: pos.x, top: pos.y, width: SIZE[shape].w, height: SIZE[shape].h }}
      dir={dir}
      role="group"
      aria-label={t("tts.player")}
      title={t("tts.expand")}
      onPointerDown={onGrab}
      onWheel={stopP}
    >
      {shape === "ribbon" && (
        <>
          <div className="tts-rib" aria-hidden>
            <div className="tts-rib-body"><span className="tts-rib-sheen" /></div>
          </div>
          {playBtn("tts-rib-seal")}
          <span className="tts-mini-cue" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></span>
        </>
      )}

      {shape === "hoopoe" && (
        <>
          <span className="tts-hp-shadow" aria-hidden />
          <span className="tts-hp-song" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M7 18 Q18 12 7 6" /></svg>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M7 18 Q18 12 7 6" /></svg>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M7 18 Q18 12 7 6" /></svg>
          </span>
          <span className="tts-hp-bird-wrap"><img className="tts-hp-bird" src="/assets/sard-bird.png" alt="" draggable={false} /></span>
          {playBtn("tts-hp-play")}
        </>
      )}

      {shape === "reed" && (
        <>
          <div className="tts-reed-rule" aria-hidden>
            <div className="tts-reed-read" style={{ height: `${trackPct}%` }} />
          </div>
          <div className="tts-reed-bead" style={{ top: `${trackPct}%` }}>
            <span className="tts-reed-halo" aria-hidden />
            {playBtn("tts-reed-btn")}
          </div>
        </>
      )}

      {shape === "dogear" && (
        <>
          <div className="tts-dog-fold" aria-hidden>
            <span className="tts-dog-hi" />
          </div>
          {playBtn("tts-dog-btn")}
        </>
      )}
    </div>
  );
}
