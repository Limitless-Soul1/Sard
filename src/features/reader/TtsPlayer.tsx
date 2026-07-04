// TTS player pill (RAWY-105, Phase 1 — minimal functional player to the on-disk design). Floats
// above the reading area while listening. Collapsed: play/pause + chapter line + progress + dot +
// expand + close. Expanded: skip ±sentence + play + speed chip. The voice picker is Stage 2.
// The position indicator is intentionally SUBTLE (dot + counter) — no in-text karaoke highlight yet.

import { useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import { TTS_MAX_SPEED, TTS_MIN_SPEED, TTS_SPEED_STEP, useTts } from "../../lib/tts";

export function TtsPlayer() {
  const { active, status, index, total, speed, chapterLabel, error, toggle, skip, setSpeed, stop } = useTts();
  const { t, lang, dir } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!active) return null;

  const playing = status === "playing";
  const preparing = status === "preparing";
  const pct = total > 1 ? (index / (total - 1)) * 100 : 0;
  const cycleSpeed = () => {
    const next = speed + TTS_SPEED_STEP;
    setSpeed(next > TTS_MAX_SPEED ? TTS_MIN_SPEED : next);
  };
  const sub =
    status === "error" ? ` · ${t("tts.error")}` :
    preparing ? ` · ${t("tts.preparing")}` :
    status === "paused" ? ` · ${t("tts.paused")}` : "";

  return (
    <div className={`tts-pill${expanded ? " expanded" : ""}`} dir={dir} role="group" aria-label={t("tts.player")}>
      {expanded && (
        <button className="tts-skip" onClick={() => skip(-1)} disabled={preparing} aria-label={t("tts.skipBack")} title={t("tts.skipBack")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 10 12l8 6M6 5v14" /></svg>
        </button>
      )}
      <button className="tts-play" onClick={toggle} disabled={preparing || status === "error"} aria-label={playing ? t("tts.pause") : t("tts.play")}>
        {preparing ? (
          <span className="tts-spin" aria-hidden />
        ) : playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.4" height="16" rx="1.4" /><rect x="13.6" y="4" width="4.4" height="16" rx="1.4" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
        )}
      </button>
      {expanded && (
        <button className="tts-skip" onClick={() => skip(1)} disabled={preparing} aria-label={t("tts.skipFwd")} title={t("tts.skipFwd")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l8 6-8 6M18 5v14" /></svg>
        </button>
      )}

      <div className="tts-mid" onClick={() => setExpanded((e) => !e)} role="button" aria-label={expanded ? t("tts.collapse") : t("tts.expand")}>
        <div className="tts-meta">
          <span className="tts-chapter">{chapterLabel || t("panel.contents")}{sub}</span>
          <span className="tts-pos">{error ? "" : t("tts.pos", { n: localeNum(index + 1, lang), m: localeNum(total, lang) })}</span>
        </div>
        <div className="tts-track">
          <div className="tts-fill" style={{ width: `${pct}%` }} />
          <div className="tts-dot" style={{ insetInlineStart: `${pct}%` }} />
        </div>
      </div>

      {expanded && (
        <button className="tts-chip tts-speed" onClick={cycleSpeed} aria-label={t("tts.speed")} title={t("tts.speed")}>
          {localeDigits(speed.toFixed(2).replace(/0$/, "").replace(/\.$/, ""), lang)}×
        </button>
      )}
      <button className="tts-ghost tts-expand" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? t("tts.collapse") : t("tts.expand")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          {expanded ? <path d="m6 10 6 6 6-6" /> : <path d="m6 14 6-6 6 6" />}
        </svg>
      </button>
      <button className="tts-ghost tts-x" onClick={stop} aria-label={t("tts.close")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}
