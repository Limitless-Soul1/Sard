// RAWY-200: the read-aloud text-tracking controls — colour, opacity and on/off, INDEPENDENTLY for the
// sentence SPOTLIGHT (RAWY-126) and the word KARAOKE pill (RAWY-127). Rendered in BOTH settings surfaces
// (the in-book reading panel + Global reading defaults) from the same component, so they can never
// drift. Reuses the EXISTING settings visual language (rs-ink swatches, rs-slider, rs-toggle) — no new
// design. Colour/opacity default to `null` = "the theme's built-in look", so an untouched control is
// byte-identical to the pre-RAWY-200 spotlight/pill in both light and dark.

import type { ReadingStyle } from "../../reader-engine/injectedCss";
import { resolveSpotlight, resolvePill } from "../../reader-engine/ttsTrack";
import { compositeOver, contrastIsReadable } from "../../lib/contrast";
import { useI18n } from "../../i18n";

// Calm terracotta-adjacent presets, per theme polarity (mirrors the text-colour presets' structure).
const TRACK_PRESETS_LIGHT = ["#9C5A3C", "#B08968", "#6E7F5B", "#7E6A9E"];
const TRACK_PRESETS_DARK = ["#C98A5E", "#D8B08C", "#9FB07E", "#B6A6D0"];

interface Props {
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  dark: boolean; // the ACTIVE theme's polarity — drives which per-theme base + presets are shown
  paperBg: string; // the theme paper — the band composites over it for the contrast check
  themeInk: string; // the theme text ink — what the band must stay readable behind
}

// One effect's block: on/off toggle, a Default+presets+custom colour row, an opacity slider, and a
// contrast warning (WARN, never block). `kind` selects spotlight vs karaoke fields + resolver.
function EffectBlock({
  kind,
  style,
  update,
  dark,
  paperBg,
  themeInk,
  hint,
}: Props & { kind: "spotlight" | "karaoke"; hint?: string }) {
  const { t } = useI18n();
  const isSpot = kind === "spotlight";
  const on = isSpot ? style.ttsSpotlightOn : style.ttsKaraokeOn;
  const color = isSpot ? style.ttsSpotlightColor : style.ttsKaraokeColor;
  const presets = dark ? TRACK_PRESETS_DARK : TRACK_PRESETS_LIGHT;

  // The resolved look the reader will actually draw (base when null). Used for the "Default" swatch
  // colour, the slider's shown value, and the contrast composite.
  const resolved = isSpot ? resolveSpotlight(style, dark) : resolvePill(style, dark);
  const effColor = resolved.fill;
  const effOpacity = isSpot ? (resolved as { band: number }).band : (resolved as { op: number }).op;

  // Contrast guard — SPOTLIGHT ONLY. The band sits BEHIND the text with no blend, so compositing the
  // band colour over the paper and checking the book ink against it is exact. The KARAOKE pill uses a
  // mix-blend-mode (multiply/screen) that keeps the glyphs legible BY DESIGN (RAWY-127), so a naive
  // alpha-composite mis-reads it and false-warns on the shipping default (0.9). Warning on a value that
  // renders fine is its own small lie (RAWY-193), so we don't guard the pill. (Caught in RAWY-200 live
  // verification: the default karaoke opacity was tripping the warning.)
  const composited = compositeOver(effColor, effOpacity, paperBg);
  const readable = !isSpot || contrastIsReadable(themeInk, composited);

  const setOn = (v: boolean) => update(isSpot ? { ttsSpotlightOn: v } : { ttsKaraokeOn: v });
  const setColor = (v: string | null) => update(isSpot ? { ttsSpotlightColor: v } : { ttsKaraokeColor: v });
  const setOpacity = (v: number | null) => update(isSpot ? { ttsSpotlightOpacity: v } : { ttsKaraokeOpacity: v });
  // RAWY-200: the spotlight's baseline UNDERLINE has its own on/off (band with no rule, or rule off).
  // Spotlight only. Default true = the underline draws today, so an untouched profile is unchanged.
  const ruleOn = style.ttsSpotlightRule;

  return (
    <div className="rs-track-effect">
      <button className="rs-toggle-row" onClick={() => setOn(!on)} aria-pressed={on}>
        <span className="rs-toggle-text">
          <span className="rs-toggle-label">{t(isSpot ? "track.spotlight" : "track.karaoke")}</span>
          {hint && <span className="rs-toggle-hint">{hint}</span>}
        </span>
        <span className={`rs-switch${on ? " on" : ""}`} aria-hidden>
          <span className="rs-knob" />
        </span>
      </button>

      {/* The colour + opacity are only meaningful while the effect is ON. */}
      {on && (
        <>
          <div className="rs-inks">
            {/* Default = the theme's built-in terracotta; resets BOTH colour and opacity to null so the
                effect returns to the exact per-theme default (recoverably byte-identical). */}
            <button
              className={`rs-ink${color == null ? " on" : ""}`}
              style={{ background: effColor }}
              onClick={() => { setColor(null); setOpacity(null); }}
              title={t("color.default")}
              aria-label={t("color.default")}
            />
            {presets.map((hex) => (
              <button
                key={hex}
                className={`rs-ink${color?.toLowerCase() === hex.toLowerCase() ? " on" : ""}`}
                style={{ background: hex }}
                onClick={() => setColor(hex)}
                title={hex}
                aria-label={hex}
              />
            ))}
            <label className="rs-ink rs-ink-custom" title={t("color.custom")}>
              <span className="rs-ink-plus" aria-hidden>+</span>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(color ?? "") ? (color as string) : "#9C5A3C"}
                onChange={(e) => setColor(e.target.value)}
              />
            </label>
          </div>

          <div className="rs-slider-row rs-track-opacity">
            <span className="rs-slider-cap" style={{ fontSize: 12 }}>{t("track.opacity")}</span>
            <input
              className="rs-slider"
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={effOpacity}
              onChange={(e) => setOpacity(Math.round(Number(e.target.value) * 100) / 100)}
            />
            <span className="rs-slider-cap" style={{ fontSize: 12, minWidth: "2.5em", textAlign: "end" }}>
              {Math.round(effOpacity * 100)}%
            </span>
          </div>

          {/* RAWY-200: the baseline-rule (underline) toggle — part of the spotlight group, next to its
              colour/opacity. Karaoke has no rule, so this is spotlight-only. */}
          {isSpot && (
            <button
              className="rs-toggle-row rs-track-subtoggle"
              onClick={() => update({ ttsSpotlightRule: !ruleOn })}
              aria-pressed={ruleOn}
            >
              <span className="rs-toggle-label">{t("track.baselineRule")}</span>
              <span className={`rs-switch${ruleOn ? " on" : ""}`} aria-hidden>
                <span className="rs-knob" />
              </span>
            </button>
          )}

          {!readable && (
            <div className="rs-contrast warn">
              <span aria-hidden>⚠</span>
              <span>{t("track.contrastWarn")}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TtsTrackingControls(props: Props) {
  const { t } = useI18n();
  return (
    <div className="rs-track">
      <div className="rs-sec-head">
        <span className="rs-label">{t("track.heading")}</span>
      </div>
      <EffectBlock {...props} kind="spotlight" />
      {/* Karaoke is Edge-only (Piper has no word timing). The hint states that plainly so the control
          never implies it works with Piper — it IS a real, persisted preference that applies whenever
          Edge is the engine; it just cannot render under Piper. (RAWY-193 lesson: no silent lie.) */}
      <EffectBlock {...props} kind="karaoke" hint={t("track.karaokeEdgeOnly")} />
    </div>
  );
}
