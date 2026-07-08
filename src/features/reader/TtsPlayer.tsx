// TTS player — the design-6 CLEAN BOTTOM BAR (RAWY-113). A full-width shelf docked to the bottom of
// the reading area (not a floating pill): a 3px hairline progress along the top edge, transport on
// the leading side, chapter + position centred, and Engine / Voices / Speed / close trailing. Two
// clear labelled chips: ENGINE (name + trait + teal dot for Edge) and VOICES (current voice name),
// each opening its menu. Mirrors wholesale under RTL. Logic is reused from RAWY-105–112 (engine
// dispatch, per-language persistence, the voice list, the queue); this is the bar's markup/CSS.

import { useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import { TTS_EMPTY, TTS_MAX_SPEED, TTS_MIN_SPEED, TTS_SPEED_STEP, useTts, voiceLabel } from "../../lib/tts";
import { TtsEngineMenu } from "./TtsEngineMenu";
import { TtsVoicePicker } from "./TtsVoicePicker";

const CHEV_UP = "m6 14 6-6 6 6";
const CHEV_DOWN = "m6 10 6 6 6-6";

export function TtsPlayer() {
  const { active, status, engine, voice, index, total, speed, progress, chapterLabel, error, notice, toggle, skip, setSpeed, retry, stop } = useTts();
  const { t, lang, dir } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [menu, setMenu] = useState<null | "engine" | "voices">(null);
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
  const closeMenu = () => setMenu(null);

  return (
    <>
      {menu === "engine" && <TtsEngineMenu onClose={closeMenu} />}
      {menu === "voices" && <TtsVoicePicker onClose={closeMenu} />}
      <div className={`tts-bar${expanded ? " expanded" : ""}${errored ? " errored" : ""}`} dir={dir} role="group" aria-label={t("tts.player")}>
        <div className="tts-bar-progress" aria-hidden>
          <div className="tts-bar-fill" style={{ width: `${trackPct}%` }} />
        </div>
        <div className="tts-bar-inner">
          {/* transport (leading) */}
          <div className="tts-transport">
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
          </div>

          {/* chapter + position (centre) — tap to toggle expand/collapse */}
          <div className="tts-bar-mid" onClick={() => setExpanded((e) => !e)} role="button" aria-label={expanded ? t("tts.collapse") : t("tts.expand")}>
            <span className="tts-bar-chapter" title={errored ? errText : undefined}>{metaText}</span>
            <span className="tts-bar-pos">{errored || downloading ? "" : t("tts.pos", { n: localeNum(index + 1, lang), m: localeNum(total, lang) })}</span>
          </div>

          {/* trailing controls */}
          <div className="tts-bar-trailing">
            {expanded ? (
              <>
                <button className={`tts-echip tts-engine-chip${menu === "engine" ? " on" : ""}`} onClick={() => setMenu((m) => (m === "engine" ? null : "engine"))} aria-label={t("tts.engine")}>
                  <span className="tts-echip-cap">{t("tts.engine")}</span>
                  <span className="tts-echip-val">
                    <span className="tts-echip-name">{engine === "edge" ? "Edge" : "Piper"}</span>
                    <span className={`tts-echip-trait${engine === "edge" ? " online" : ""}`}>
                      {engine === "edge" && <span className="tts-teal-dot" aria-hidden />}
                      {engine === "edge" ? t("tts.online") : t("tts.offline")}
                    </span>
                  </span>
                  <svg className="tts-echip-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={menu === "engine" ? CHEV_DOWN : CHEV_UP} /></svg>
                </button>

                <button className={`tts-echip tts-voices-chip${menu === "voices" ? " on" : ""}`} onClick={() => setMenu((m) => (m === "voices" ? null : "voices"))} aria-label={t("tts.voices")}>
                  <span className="tts-echip-cap">{t("tts.voices")}</span>
                  <span className="tts-echip-name">{voiceLabel(engine, voice)}</span>
                  <svg className="tts-echip-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={menu === "voices" ? CHEV_DOWN : CHEV_UP} /></svg>
                </button>

                <button className="tts-chip tts-speed" onClick={cycleSpeed} aria-label={t("tts.speed")} title={t("tts.speed")}>
                  {localeDigits(speed.toFixed(2).replace(/0$/, "").replace(/\.$/, ""), lang)}×
                </button>

                <button className="tts-ghost" onClick={() => setExpanded(false)} aria-label={t("tts.collapse")} title={t("tts.collapse")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={CHEV_DOWN} /></svg>
                </button>
              </>
            ) : (
              <button className="tts-ghost" onClick={() => setExpanded(true)} aria-label={t("tts.expand")} title={t("tts.expand")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={CHEV_UP} /></svg>
              </button>
            )}
            <button className="tts-ghost tts-x" onClick={stop} aria-label={t("tts.close")} title={t("tts.close")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
