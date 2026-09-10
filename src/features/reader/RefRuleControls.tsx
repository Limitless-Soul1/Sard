// THE REFERENCE TWIN RULE'S CONTROLS — one component, three surfaces.
//
// MOVED HERE FROM `ReadingSettings` so the هيئة editor can render THE READER'S OWN CONTROLS rather
// than a copy of them, which is exactly the arrangement `TtsTrackingControls` already has for the
// read-aloud marks: same swatches, same sliders, same wording, same live sample. A second
// implementation of this group would drift from the one the reader configures, and the drift would
// show up as a هيئة whose reference mark was not quite the mark the reader had set.
//
// Nothing below is changed from the version that lived in the panel.

import type { CSSProperties } from "react";

import { ColorRow } from "./ColorRow";
import type { ReadingStyle } from "../../reader-engine/injectedCss";
import type { TKey } from "../../i18n/locales/en";
import {
  REF_OFFSET_MAX,
  REF_OFFSET_MIN,
  REF_WEIGHT_MAX,
  REF_WEIGHT_MIN,
  refRuleBars,
  resolveRefRule,
} from "../../reader-engine/refRule";

/** Two decimals — the step the sliders move in, kept off the stored value's tail. */
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---- RAWY-281: THE REFERENCE INDICATOR (the twin rule) ----
//
// Three per-book controls over the mark under a referenced word — colour, thickness, distance from the
// text. They live in the COLOUR tab because that is where every other per-book override of a reading
// SURFACE already is (ink · page · background), and because RAWY-217 measured five tabs as this width's
// ceiling: a sixth for one mark is not available. The group deliberately adds no tab, no toggle and no
// new visual language — it is the existing `ColorRow` plus two `rs-slider-row`s, the same two primitives
// `TtsTrackingControls` uses for the same job.
//
// The presets are SARD'S OWN THEME ACCENTS rather than invented colours (ivory · sepia · ink · sage on
// light; slate · espresso · dusk · forest-night on dark), so every preset is a colour the app already
// ships and has already been judged against these papers.
const REF_PRESETS_LIGHT = ["#9C5A3C", "#97582F", "#7A2E1E", "#5E7A52"];
const REF_PRESETS_DARK = ["#C98A5E", "#D49A6A", "#8FA6D8", "#82B08C"];
// The preview draws at a fixed 20px because that is the size the design file specifies its flagship case
// at ("20PX · 2PX RULES · 3PX GAP"), so an untouched control previews the design's own reference figure.
const REF_PREVIEW_PX = 20;

// Both size controls are a MULTIPLE of the design value and are shown as a percentage, where 100% is the
// design exactly. A percentage is the right unit for both: the underlying quantities are em-based (they
// track the reader's zoom and the book's font), so there is no px number that would stay true — and
// "100% = the design" is a claim the reader can act on, unlike "0.30em".
const refPct = (v: number | null) => Math.round((v ?? 1) * 100);

export function RefRuleControls({
  style,
  update,
  accent,
  dark,
  t,
}: {
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  accent: string;
  dark: boolean; // the active theme's polarity — which preset column to offer, as everywhere else here
  t: (k: TKey) => string;
}) {
  // The SAME resolver the page draws with (`reader-engine/refRule`), at the preview's own font size — so
  // the preview cannot drift from the mark. This is the RAWY-259 lesson applied ahead of time: two
  // surfaces showing one mark must share the computation, not a pair of matched constants.
  const d = resolveRefRule(style, accent, REF_PREVIEW_PX);
  // …and the SAME bar geometry, run against a unit box. `refRuleBars` returns the strokes measured DOWN
  // from the content box (the SVG convention the overlayer needs); CSS `bottom` measures UP, so the sign
  // flips and nothing else does. Deriving the preview from the shared function rather than re-deriving
  // `-offset` / `-(offset + thickness + gap)` here is the point: there is exactly one place where the
  // design's geometry can be wrong.
  const bars = refRuleBars({ left: 0, width: 0, bottom: 0 }, d);
  const bar = (b: { y: number; height: number; rx: number }): CSSProperties => ({
    position: "absolute",
    insetInline: 0,
    bottom: -(b.y + b.height), // SVG top-down → CSS bottom-up, on the stroke's BOTTOM edge
    height: b.height,
    borderRadius: b.rx,
    background: d.color,
  });

  return (
    // ONE GROUP, SO IT CAN CARRY ITS OWN RHYTHM. The three controls used to be a bare fragment, which
    // left every gap inside them to whatever leading the panel around them happened to give: measured
    // in the هيئة editor at 1440x900, the colour label, its swatches and both sliders sat 2px apart —
    // one dense block. A wrapper is what lets the group state its own spacing without touching the
    // `.rs-slider-row`s that other sections use for other jobs.
    <div className="rs-ref">
      <ColorRow
        label={t("ref.color")}
        value={style.refRuleColor}
        themeValue={accent}
        presets={dark ? REF_PRESETS_DARK : REF_PRESETS_LIGHT}
        onPick={(v) => update({ refRuleColor: v })}
        t={t}
      />

      <div className="rs-slider-row">
        <span className="rs-slider-cap" style={{ fontSize: 12 }}>{t("ref.thickness")}</span>
        <input
          className="rs-slider"
          type="range"
          min={REF_WEIGHT_MIN}
          max={REF_WEIGHT_MAX}
          step={0.05}
          aria-label={t("ref.thickness")}
          value={style.refRuleWeight ?? 1}
          onChange={(e) => update({ refRuleWeight: r2(Number(e.target.value)) })}
        />
        <span className="rs-slider-cap" style={{ fontSize: 12, minWidth: "2.5em", textAlign: "end" }}>
          {refPct(style.refRuleWeight)}%
        </span>
      </div>

      <div className="rs-slider-row">
        <span className="rs-slider-cap" style={{ fontSize: 12 }}>{t("ref.offset")}</span>
        <input
          className="rs-slider"
          type="range"
          min={REF_OFFSET_MIN}
          max={REF_OFFSET_MAX}
          step={0.05}
          aria-label={t("ref.offset")}
          value={style.refRuleOffset ?? 1}
          onChange={(e) => update({ refRuleOffset: r2(Number(e.target.value)) })}
        />
        <span className="rs-slider-cap" style={{ fontSize: 12, minWidth: "2.5em", textAlign: "end" }}>
          {refPct(style.refRuleOffset)}%
        </span>
      </div>

      {/* A live sample. Without it the two sliders are unreadable from inside the panel — the marked word
          is very often not on screen, and neither quantity has a familiar unit. It is drawn from the
          resolver above, so it is the mark, not a picture of it. Extra bottom padding leaves room for the
          pair at the top of the offset range. */}
      <div className="rs-ref-preview" aria-hidden>
        <span style={{ position: "relative", fontSize: REF_PREVIEW_PX }}>
          {t("ref.sample")}
          <span style={bar(bars[0])} />
          <span style={bar(bars[1])} />
        </span>
      </div>
    </div>
  );
}
