// TTS player pill (RAWY-105). Floats above the reading area while listening. Collapsed: play/pause +
// chapter line + progress + dot + expand + close. Expanded: skip ±sentence + play + VOICE + speed.
// RAWY-111: the Voice button opens the picker (Piper + Edge neural voices, grouped by language); a
// transient notice line shows the Edge→Piper fallback. The position dot is intentionally subtle.

import { useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import { TTS_EMPTY, TTS_MAX_SPEED, TTS_MIN_SPEED, TTS_SPEED_STEP, useTts } from "../../lib/tts";
import { TtsVoicePicker } from "./TtsVoicePicker";

export function TtsPlayer() {
  const { active, status, index, total, speed, progress, chapterLabel, error, notice, toggle, skip, setSpeed, retry, stop } = useTts();
  const { t, lang, dir } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  if (!active) return null;

  const playing = status === "playing";
  const downloading = status === "downloading";
  const preparing = status === "preparing";
  const errored = status === "error";
  const busy = preparing || downloading; // spinner shown, transport disabled
  const dlPct = Math.round(progress * 100);
  // The track doubles as a download bar while fetching the voice, then the reading position (RAWY-106).
  const trackPct = downloading ? progress * 100 : total > 1 ? (index / (total - 1)) * 100 : 0;
  const cycleSpeed = () => {
    const next = speed + TTS_SPEED_STEP;
    setSpeed(next > TTS_MAX_SPEED ? TTS_MIN_SPEED : next);
  };
  const noticeText = notice === "tts.fellBack" ? t("tts.fellBack") : notice;
  const sub =
    errored ? ` · ${t("tts.error")}` :
    noticeText ? ` · ${noticeText}` :
    downloading ? ` · ${t("tts.downloading", { pct: localeNum(dlPct, lang) })}` :
    preparing ? ` · ${t("tts.preparing")}` :
    status === "paused" ? ` · ${t("tts.paused")}` : "";
  // Surface the REAL failure (swallowed before) so the owner sees WHY, not just "couldn't play";
  // the empty-chapter sentinel gets a localized message (RAWY-107), raw engine errors show verbatim.
  const errText = error === TTS_EMPTY ? t("tts.emptyChapter") : (error || t("tts.error"));
  const metaText = errored ? errText : `${chapterLabel || t("panel.contents")}${sub}`;

  return (
    <>
      {picking && <TtsVoicePicker onClose={() => setPicking(false)} />}
    <div className={`tts-pill${expanded ? " expanded" : ""}${errored ? " errored" : ""}`} dir={dir} role="group" aria-label={t("tts.player")}>
      {expanded && (
        <button className="tts-skip" onClick={() => skip(-1)} disabled={busy || errored} aria-label={t("tts.skipBack")} title={t("tts.skipBack")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 10 12l8 6M6 5v14" /></svg>
        </button>
      )}
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
      {expanded && (
        <button className="tts-skip" onClick={() => skip(1)} disabled={busy || errored} aria-label={t("tts.skipFwd")} title={t("tts.skipFwd")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l8 6-8 6M18 5v14" /></svg>
        </button>
      )}

      <div className="tts-mid" onClick={() => setExpanded((e) => !e)} role="button" aria-label={expanded ? t("tts.collapse") : t("tts.expand")}>
        <div className="tts-meta">
          <span className="tts-chapter" title={errored ? errText : undefined}>{metaText}</span>
          <span className="tts-pos">{errored || downloading ? "" : t("tts.pos", { n: localeNum(index + 1, lang), m: localeNum(total, lang) })}</span>
        </div>
        <div className="tts-track">
          <div className="tts-fill" style={{ width: `${trackPct}%` }} />
          {!errored && <div className="tts-dot" style={{ insetInlineStart: `${trackPct}%` }} />}
        </div>
      </div>

      {expanded && (
        <button className={`tts-ghost tts-voicebtn${picking ? " on" : ""}`} onClick={() => setPicking((p) => !p)} aria-label={t("tts.voices")} title={t("tts.voices")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M8 7v10M16 7v10M4 10v4M20 10v4" /></svg>
        </button>
      )}
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
    </>
  );
}
