// TTS player — the design-5a COMPACT FLOATING PILL (RAWY-114). A ~330px pill centred ~26px above the
// page bottom, floating over the reading page (NOT a full-width bar — that overlapped the Contents
// panel; RAWY-113). Two calm rows: transport + a progress hairline with a position dot; then a
// segmented Engine toggle (Piper | Edge, Edge carrying the teal online dot) + a Voices chip (current
// voice) + a tap-to-cycle Speed chip. Logic is reused from RAWY-105–113 (engine dispatch, Edge
// default, both synth paths, the voices picker, per-language persistence, the non-destructive
// per-sentence fallback); this is the pill's markup/CSS, re-binding the same controls. Mirrors RTL.

import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import { TTS_EMPTY, TTS_MAX_SPEED, TTS_MIN_SPEED, TTS_SPEED_STEP, useTts, voiceLabel } from "../../lib/tts";
import { TtsMini } from "./TtsMini";
import { TtsVoicePicker } from "./TtsVoicePicker";

const CHEV_UP = "m6 14 6-6 6 6";
const CHEV_DOWN = "m6 10 6 6 6-6";

export function TtsPlayer() {
  const { active, status, engine, voice, index, total, speed, progress, chapterLabel, error, notice, toggle, skip, setSpeed, setEngine, retry, stop } = useTts();
  const { t, lang, dir } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [picking, setPicking] = useState(false);
  // RAWY-156/157: minimize the pill to the RIBBON (a top-edge silk bookmark) while audio keeps
  // playing. UI-only state — never persisted to the settings DB.
  const [minimized, setMinimized] = useState(false);
  // A fresh Listen (active flips true) should start on the full pill, not a stale minimized state.
  useEffect(() => {
    if (!active) {
      setMinimized(false);
      setExpanded(true);
    }
  }, [active]);
  if (!active) return null;

  const playing = status === "playing";
  const downloading = status === "downloading";
  const preparing = status === "preparing";
  const errored = status === "error";
  const busy = preparing || downloading;
  const dlPct = Math.round(progress * 100);
  const trackPct = downloading ? progress * 100 : total > 1 ? (index / (total - 1)) * 100 : 0;
  const cycleSpeed = () => {
    const next = speed + TTS_SPEED_STEP;
    setSpeed(next > TTS_MAX_SPEED ? TTS_MIN_SPEED : next);
  };
  const noticeText = notice === "tts.edgeHiccup" ? t("tts.edgeHiccup") : notice;
  const sub =
    errored ? ` · ${t("tts.error")}` :
    noticeText ? ` · ${noticeText}` :
    downloading ? ` · ${t("tts.downloading", { pct: localeNum(dlPct, lang) })}` :
    preparing ? ` · ${t("tts.preparing")}` :
    status === "paused" ? ` · ${t("tts.paused")}` : "";
  const errText = error === TTS_EMPTY ? t("tts.emptyChapter") : (error || t("tts.error"));
  const metaText = errored ? errText : `${chapterLabel || t("panel.contents")}${sub}`;

  return (
    <>
      {minimized ? (
        <TtsMini onExpand={() => setMinimized(false)} />
      ) : (
      <>
      {picking && <TtsVoicePicker onClose={() => setPicking(false)} />}
      <div className={`tts-pill${expanded ? " expanded" : ""}${errored ? " errored" : ""}`} dir={dir} role="group" aria-label={t("tts.player")}>
        {/* row 1 — transport */}
        <div className="tts-pill-transport">
          <button className="tts-ghost" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? t("tts.collapse") : t("tts.expand")} title={expanded ? t("tts.collapse") : t("tts.expand")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={expanded ? CHEV_DOWN : CHEV_UP} /></svg>
          </button>
          <div className="tts-transport-mid">
            <button className="tts-skip" onClick={() => skip(-1)} disabled={busy || errored} aria-label={t("tts.skipBack")} title={t("tts.skipBack")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 10 12l8 6M6 5v14" /></svg>
            </button>
            {errored ? (
              <button className="tts-play tts-retry" onClick={retry} aria-label={t("tts.retry")} title={t("tts.retry")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 1-2.3-5.6M20 4v6h-6" /></svg>
              </button>
            ) : (
              <button className="tts-play" onClick={toggle} disabled={busy} aria-label={playing ? t("tts.pause") : t("tts.play")}>
                {busy ? (
                  <span className="tts-spin" aria-hidden />
                ) : playing ? (
                  <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.4" height="16" rx="1.4" /><rect x="13.6" y="4" width="4.4" height="16" rx="1.4" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
                )}
              </button>
            )}
            <button className="tts-skip" onClick={() => skip(1)} disabled={busy || errored} aria-label={t("tts.skipFwd")} title={t("tts.skipFwd")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l8 6-8 6M18 5v14" /></svg>
            </button>
          </div>
          <div className="tts-pill-right">
            {/* RAWY-157: minimize to the ribbon (audio keeps playing) — a clear "send up to the top
                edge" icon, distinct from the ⌄ collapse chevron, with a labelled tooltip. */}
            <button className="tts-ghost tts-minimize" onClick={() => setMinimized(true)} aria-label={t("tts.minimize")} title={t("tts.minimize")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5h14M12 19v-9M8.5 13.5 12 10l3.5 3.5" /></svg>
            </button>
            <button className="tts-ghost tts-x" onClick={stop} aria-label={t("tts.close")} title={t("tts.close")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </div>

        {/* progress hairline + position dot, then a compact meta line for status/chapter */}
        <div className="tts-pill-progress">
          <div className="tts-pill-track">
            <div className="tts-pill-fill" style={{ width: `${trackPct}%` }} />
            {!errored && <div className="tts-pill-dot" style={{ insetInlineStart: `${trackPct}%` }} />}
          </div>
          <div className="tts-pill-meta">
            <span className="tts-pill-chapter" title={errored ? errText : undefined}>{metaText}</span>
            <span className="tts-pill-pos">{errored || downloading ? "" : t("tts.pos", { n: localeNum(index + 1, lang), m: localeNum(total, lang) })}</span>
          </div>
        </div>

        {/* row 2 — Engine toggle (Piper | Edge) + Voices + Speed */}
        {expanded && (
          <div className="tts-pill-controls">
            <div className="tts-engine-toggle" role="group" aria-label={t("tts.engine")}>
              <button className={`tts-eng-seg${engine === "piper" ? " on" : ""}`} onClick={() => engine !== "piper" && setEngine("piper")} aria-pressed={engine === "piper"}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></svg>
                <span>Piper</span>
              </button>
              <button className={`tts-eng-seg${engine === "edge" ? " on" : ""}`} onClick={() => engine !== "edge" && setEngine("edge")} aria-pressed={engine === "edge"}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6-1.6A4 4 0 0 0 6 19z" /></svg>
                <span>Edge</span>
                {engine === "edge" && <span className="tts-teal-dot" aria-hidden />}
              </button>
            </div>
            <div className="tts-voices-speed">
              <button className={`tts-voices-chip${picking ? " on" : ""}`} onClick={() => setPicking((p) => !p)} aria-label={t("tts.voices")} title={t("tts.voices")}>
                <svg className="tts-voices-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v18M8 7v10M16 7v10M4 10v4M20 10v4" /></svg>
                <span className="tts-voices-name">{voiceLabel(engine, voice)}</span>
                <svg className="tts-voices-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={picking ? CHEV_DOWN : CHEV_UP} /></svg>
              </button>
              <button className="tts-speed-chip" onClick={cycleSpeed} aria-label={t("tts.speed")} title={t("tts.speed")}>
                {localeDigits(speed.toFixed(2).replace(/0$/, "").replace(/\.$/, ""), lang)}×
              </button>
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </>
  );
}
