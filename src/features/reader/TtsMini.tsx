// TTS minimized player (RAWY-158) — the KASHIDA STROKE (كشيدة). A tapered calligraphic elongation
// line in the BOTTOM MARGIN, below the text column, anchored at the LEADING corner (RTL: right;
// LTR: left). Its fill shows playback progress; the round BEAD at the leading end is play/pause;
// tapping the stroke BODY "stretches" it back into the full pill. It stands in for the pill while
// audio keeps playing, so it no longer covers the reading text. Replaces the RAWY-157 ribbon (the
// owner preferred the kashida from the 2nd design study).
//
// On-brand via var(--accent) (the pill's own token — gold in Moonlit, terracotta elsewhere), so it
// never recolours; RTL-aware (the taper + fill + cue mirror for an LTR UI).
//
// TWO clear hit-areas: the BEAD toggles play/pause (WITHOUT expanding); tapping the stroke BODY (or
// its cue) expands back to the full pill.
//
// PANEL-CLEAR (reuse the pill's signal): the stroke is NOT draggable — it lives in the bottom margin.
// When a side panel opens on the LEADING side it FLIPS to the trailing corner so it never underlaps
// the panel; when BOTH sides are open it centres + shortens. `panelLeft`/`panelRight` are the same
// physical Contents/Search (left) + Notes (right) booleans that drive the pill's `--reading-shift`.
//
// EVENT ISOLATION (LESSON #1): the reader auto-hides its chrome on window `pointerdown`→wake. A tap
// on the stroke must NOT wake the chrome or select book text, so onPointerDown stopPropagation()s
// (its bubble reaches the React root below `window` → never reaches the window wake listener) and
// onWheel stopPropagation()s; user-select/touch-action are none. Being non-draggable, there are no
// window move listeners to isolate (the ribbon's capture-phase mousemove stopper is gone).

import { useI18n } from "../../i18n";
import { useTts } from "../../lib/tts";

export function TtsMini({
  onExpand,
  panelLeft = false,
  panelRight = false,
}: {
  onExpand: () => void;
  panelLeft?: boolean;
  panelRight?: boolean;
}) {
  const { t, dir } = useI18n();
  const status = useTts((s) => s.status);
  const toggle = useTts((s) => s.toggle);
  const index = useTts((s) => s.index);
  const total = useTts((s) => s.total);
  const playing = status === "playing";
  // Progress fill — same measure the full pill's track uses (index over the last sentence).
  const pct = total > 1 ? Math.max(0, Math.min(100, (index / (total - 1)) * 100)) : 0;

  // Panel-clear: the stroke anchors at the LEADING corner; a panel on that physical side flips it to
  // the trailing corner; both sides blocked → centre + shorten. Leading follows the UI direction.
  const rtl = dir === "rtl";
  const leadBlocked = rtl ? panelRight : panelLeft;
  const trailBlocked = rtl ? panelLeft : panelRight;
  const both = leadBlocked && trailBlocked;
  const flip = leadBlocked && !both; // hop to the trailing corner to clear the panel

  const stopP = (e: React.SyntheticEvent) => e.stopPropagation();
  const onBody = (e: React.MouseEvent) => {
    e.stopPropagation();
    onExpand(); // tap the body = stretch back to the full pill
  };
  const onPlay = (e: React.MouseEvent) => {
    e.stopPropagation(); // the bead toggles playback WITHOUT expanding
    toggle();
  };
  const playLabel = playing ? t("tts.pause") : t("tts.play");

  return (
    <div
      className={`tts-mini tts-mini--kashida${playing ? " playing" : ""}${flip ? " flip" : ""}${both ? " center" : ""}`}
      dir={dir}
      role="group"
      aria-label={t("tts.player")}
      title={t("tts.expand")}
      onPointerDown={stopP} // don't wake the reader chrome / start a text selection
      onClick={onBody} // tapping the body expands back to the pill
      onWheel={stopP} // no scroll-through to the book
    >
      {/* the round bead at the leading end = play/pause (does NOT expand) */}
      <button className="tts-mini-play tts-kash-bead" onClick={onPlay} aria-label={playLabel} title={playLabel}>
        <span className="tts-kash-halo" aria-hidden />
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.4" height="16" rx="1.4" /><rect x="13.6" y="4" width="4.4" height="16" rx="1.4" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
        )}
      </button>
      {/* the tapered elongation stroke — a faint track with an accent fill = progress */}
      <div className="tts-kash-stroke" aria-hidden>
        <div className="tts-kash-track" />
        <div className="tts-kash-fill" style={{ width: `${pct}%` }} />
      </div>
      {/* the cue = "stretch back to the pill" (tapping the body does the same) */}
      <span className="tts-mini-cue" aria-hidden title={t("tts.expand")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </span>
    </div>
  );
}
