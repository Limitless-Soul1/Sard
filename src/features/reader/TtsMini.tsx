// TTS minimized player (RAWY-158; polished RAWY-160) — the KASHIDA STROKE (كشيدة). A tapered
// calligraphic elongation line in the BOTTOM MARGIN, below the text column, anchored at a screen
// CORNER. Its fill shows playback progress; the round BEAD at the leading end is play/pause; tapping
// the stroke BODY "stretches" it back into the full pill. It stands in for the pill while audio keeps
// playing, so it no longer covers the reading text.
//
// On-brand via var(--accent) (the pill's own token — gold in Moonlit, terracotta elsewhere), so it
// never recolours.
//
// THREE clear hit-areas: the BEAD toggles play/pause (WITHOUT expanding); the small SWAP button
// (RAWY-160) toggles which side the stroke sits on; tapping the BODY (the stroke) expands back to the
// full pill.
//
// SIDE + MIRROR (RAWY-160): the stroke sits on a physical side (right/left). The default is the UI's
// LEADING side (RTL → right, LTR → left); the swap button flips the *desired* side. The whole shape
// then HORIZONTALLY MIRRORS to match its side — the tapered end, the bead position and the progress
// fill all flip (a true mirror image, via `.orient-right`/`.orient-left`), never reversed.
// PANEL-CLEAR (RAWY-169): the explicit SWAP always wins — a tap moves the stroke to the other side even
// when a panel is open there, because the kashida is stacked above the panels (z-index) so it stays
// visible. Panel-clear only auto-nudges the UNSWAPPED default off an open panel (so a fresh minimize
// lands clear) and centres+shortens when both sides are blocked with no explicit swap. `panelLeft`/
// `panelRight` are the same physical Contents/Search (left) + Notes (right) booleans that drive the
// pill's `--reading-shift`. (Before, panel-clear gated the swap too, so with Contents open by default
// one side was always blocked and the swap looked dead.)
//
// EVENT ISOLATION (LESSON #1): the reader auto-hides its chrome on window `pointerdown`→wake. A tap on
// the stroke must NOT wake the chrome or select book text, so onPointerDown stopPropagation()s (its
// bubble reaches the React root below `window` → never reaches the window wake listener) and onWheel
// stopPropagation()s; user-select/touch-action are none. It is not draggable — no window listeners.

import { useState } from "react";

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

  // Which physical side the stroke sits on (right/left/center) and which way it mirrors.
  // `sideOverride` is the user's explicit swap choice (null until they tap swap).
  const [sideOverride, setSideOverride] = useState<"right" | "left" | null>(null);
  const rtl = dir === "rtl";
  const leadingSide: "right" | "left" = rtl ? "right" : "left";
  // The AUTO default (used until the user swaps): the leading side, panel-cleared — a panel on that side
  // nudges it to the other corner; both sides blocked → centre + shorten.
  let autoSide: "right" | "left" | "center";
  if (panelRight && panelLeft) autoSide = "center";
  else if (leadingSide === "right" && panelRight) autoSide = "left";
  else if (leadingSide === "left" && panelLeft) autoSide = "right";
  else autoSide = leadingSide;
  // RAWY-169: an explicit swap WINS and simply flips the currently-shown side, so a tap always moves the
  // stroke to the other margin — regardless of dir or which panels are open. The kashida is stacked
  // ABOVE the panels (see its z-index), so a swapped side stays visible instead of hiding behind a
  // panel. (Before, the panel-clear rule also gated the swap: with Contents open by default one side was
  // always blocked, so both swap states collapsed to the one clear side and the swap looked dead.)
  const side: "right" | "left" | "center" = sideOverride ?? autoSide;
  // Mirror to match the side it ACTUALLY sits on (so a panel-forced move never looks reversed).
  const orient: "right" | "left" = side === "center" ? leadingSide : side;

  const stopP = (e: React.SyntheticEvent) => e.stopPropagation();
  const onBody = (e: React.MouseEvent) => {
    e.stopPropagation();
    onExpand(); // tap the body = stretch back to the full pill
  };
  const onPlay = (e: React.MouseEvent) => {
    e.stopPropagation(); // the bead toggles playback WITHOUT expanding
    toggle();
  };
  const onSwap = (e: React.MouseEvent) => {
    e.stopPropagation(); // the swap button flips the side WITHOUT expanding
    // Flip whatever side is currently shown (the auto default, or a prior override) to the other side.
    setSideOverride((prev) => {
      const cur = prev ?? autoSide;
      return (cur === "center" ? leadingSide : cur) === "right" ? "left" : "right";
    });
  };
  const playLabel = playing ? t("tts.pause") : t("tts.play");

  return (
    <div
      className={`tts-mini tts-mini--kashida side-${side} orient-${orient}${playing ? " playing" : ""}`}
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
      {/* the tapered elongation stroke — a faint track with an accent fill = progress (tap = expand) */}
      <div className="tts-kash-stroke" aria-hidden>
        <div className="tts-kash-track" />
        <div className="tts-kash-fill" style={{ width: `${pct}%` }} />
      </div>
      {/* the swap button = flip the stroke to the other side (mirrored). Does NOT expand or play. */}
      <button className="tts-kash-swap" onClick={onSwap} aria-label={t("tts.swapSide")} title={t("tts.swapSide")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 9h16l-3.5-3.5M20 15H4l3.5 3.5" />
        </svg>
      </button>
    </div>
  );
}
