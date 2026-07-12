// TTS player — the design-5a COMPACT FLOATING PILL (RAWY-114). A ~330px pill centred ~26px above the
// page bottom, floating over the reading page (NOT a full-width bar — that overlapped the Contents
// panel; RAWY-113). Two calm rows: transport + a progress hairline with a position dot; then a
// segmented Engine toggle (Piper | Edge, Edge carrying the teal online dot) + a Voices chip (current
// voice) + a tap-to-cycle Speed chip. Logic is reused from RAWY-105–113 (engine dispatch, Edge
// default, both synth paths, the voices picker, per-language persistence, the non-destructive
// per-sentence fallback); this is the pill's markup/CSS, re-binding the same controls. Mirrors RTL.

import { useEffect, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import { TTS_EMPTY, TTS_MAX_SPEED, TTS_MIN_SPEED, TTS_SPEED_STEP, toggleTtsPlayback, useTts, voiceLabel } from "../../lib/tts";
import { TtsMini } from "./TtsMini";
import { TtsVoicePicker } from "./TtsVoicePicker";

const CHEV_UP = "m6 14 6-6 6 6";
const CHEV_DOWN = "m6 10 6 6 6-6";

// `panelLeft`/`panelRight` are the physical Contents/Search (left) + Notes (right) open flags — the
// same booleans that drive the pill's `--reading-shift`. The minimized kashida stroke uses them to
// flip clear of an open side panel (RAWY-158).
export function TtsPlayer({ panelLeft = false, panelRight = false }: { panelLeft?: boolean; panelRight?: boolean }) {
  // RAWY-181 (BUG 2): subscribe ONLY to the fields the pill uses (via useShallow), NOT the whole store.
  // Previously `useTts()` re-rendered the pill on EVERY store change — including the karaoke `words`/
  // `wordIndex` ticks (several/sec on Edge) it doesn't even read — which made size toggles feel heavy and
  // could swallow a click landing mid-re-render. Actions are stable Zustand refs, so they never re-render.
  const { active, status, engine, voice, index, total, speed, volume, progress, chapterLabel, error, notice, toggle, skip, setSpeed, setVolume, setEngine, retry, stop } = useTts(
    useShallow((s) => ({
      active: s.active, status: s.status, engine: s.engine, voice: s.voice, index: s.index, total: s.total,
      speed: s.speed, volume: s.volume, progress: s.progress, chapterLabel: s.chapterLabel, error: s.error, notice: s.notice,
      toggle: s.toggle, skip: s.skip, setSpeed: s.setSpeed, setVolume: s.setVolume, setEngine: s.setEngine, retry: s.retry, stop: s.stop,
    })),
  );
  const { t, lang, dir } = useI18n();
  const [picking, setPicking] = useState(false);
  // RAWY-164: ONE progressive size state replaces the old two confusable controls (the row-collapse
  // chevron + the download-looking minimize). The single shrink button steps full → collapsed →
  // kashida; tapping the kashida stroke returns straight to full. UI-only — never persisted.
  const [size, setSize] = useState<"full" | "collapsed" | "kashida">("full");
  const expanded = size === "full"; // the engine/voices/speed rows show only when full
  const minimized = size === "kashida";
  const shrink = () => setSize((s) => (s === "full" ? "collapsed" : "kashida")); // one step down
  // A fresh Listen (active flips true) should start on the full pill, not a stale minimized state.
  useEffect(() => {
    if (!active) setSize("full");
  }, [active]);
  // RAWY-180 (Part B): Space toggles read-aloud play/pause when a session is active (from PARENT focus —
  // the reading-frame case is handled by FoliateController.onSpace). Self-gates via `toggleTtsPlayback`
  // (a no-op when inactive), and ignores typing / interactive targets so it never hijacks Space in the
  // search box or a focused control. Registered once; `toggleTtsPlayback` reads the live store.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== " " && e.code !== "Space") || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName) ||
          el.isContentEditable ||
          el.closest?.("[role='button'],[role='slider'],[contenteditable='true']"))
      ) {
        return; // let inputs / buttons / the search box keep their own Space behaviour
      }
      if (toggleTtsPlayback()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
  const volPct = Math.round(volume * 100); // RAWY-180 (Part A): inline volume slider 0–100%
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
        <TtsMini onExpand={() => setSize("full")} panelLeft={panelLeft} panelRight={panelRight} />
      ) : (
      <>
      {picking && <TtsVoicePicker onClose={() => setPicking(false)} />}
      <div className={`tts-pill${expanded ? " expanded" : ""}${errored ? " errored" : ""}`} dir={dir} role="group" aria-label={t("tts.player")}>
        {/* row 1 — transport */}
        <div className="tts-pill-transport">
          {/* RAWY-164: the ONE progressive shrink button. Its icon tells the next step: FULL → a single
              down-chevron (press collapses the extra rows); COLLAPSED → a `.step2` double down-chevron +
              the accent tint (press minimizes to the kashida stroke). Replaces the old row-collapse
              chevron AND the download-looking minimize button; ✕ + transport stay separate. */}
          <button
            className={`tts-ghost tts-shrink${size === "collapsed" ? " step2" : ""}`}
            onClick={shrink}
            aria-label={size === "full" ? t("tts.collapseRows") : t("tts.minimize")}
            title={size === "full" ? t("tts.collapseRows") : t("tts.minimize")}
          >
            {size === "full" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 6 6 6 6-6" /><path d="m6 13 6 6 6-6" /></svg>
            )}
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
            {/* ✕ fully stops read-aloud — it is NOT part of the shrink cycle (RAWY-164). */}
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
            {/* RAWY-180 (Part A): the inline VOLUME slider — a hairline row under Voice/Speed (design
                "approach B"). Speaker glyph (accent; a muted glyph at 0) + a thin accent-fill track +
                round knob + a bold accent %; the "adjusting" accent border is :focus-within (CSS). This
                is the ONLY control taken from the design file — the RAWY-164 shrink button and every
                other pill control are unchanged. A native range → keyboard + drag + RTL auto-mirror. */}
            <div className="tts-volume">
              <span className={`tts-vol-ico${volume === 0 ? " muted" : ""}`} aria-hidden>
                {volume === 0 ? (
                  <svg viewBox="0 0 24 24" fill="none"><path d="M11 5 7 8.5H4v7h3l4 3.5z" fill="currentColor" /><path d="m16 9 5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none"><path d="M11 5 7 8.5H4v7h3l4 3.5z" fill="currentColor" /><path d="M15.5 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /><path d="M18 6.5a8 8 0 0 1 0 11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
                )}
              </span>
              <input
                className="tts-vol-range"
                type="range"
                min={0}
                max={100}
                value={volPct}
                onChange={(e) => setVolume(Number(e.target.value) / 100)}
                aria-label={t("tts.volume")}
                title={t("tts.volume")}
                style={{ "--vol": `${volPct}%` } as CSSProperties}
              />
              <span className="tts-vol-pct">{localeNum(volPct, lang)}{lang === "ar" ? "٪" : "%"}</span>
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </>
  );
}
