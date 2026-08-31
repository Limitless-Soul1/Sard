// THE MEASURE — a profile's optional opinion about how the words are set.
//
// EVERY CONTROL IS THREE-STATE, and that is the whole design rather than a detail. A profile may say
// "line spacing 2.0", or it may say nothing at all — and saying nothing must be reachable, because
// it is what every profile written before this chapter existed says, and what keeps a profile switch
// from quietly resizing someone's book. So each row carries a value AND a way back to «as it is»,
// and a row with no opinion shows the reader's own current value greyed, so the reader can see what
// they would be overriding before they override it.
//
// THE STRINGS ARE THE READER'S OWN. `type.size`, `type.lineSpacing`, `diacritics.show` and the rest
// already exist for the reading drawer; reusing them means the same control is called the same thing
// in both places, and there is one wording to keep right instead of two.

import type { ReactNode } from "react";

import { useI18n } from "../../../i18n";
import { localeDigits } from "../../../lib/format";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  type Align,
  type DiacriticsMode,
} from "../../../reader-engine/injectedCss";
import type { TKey } from "../../../i18n/locales/en";
import type { ProfileTypography } from "../model/profile";

const WEIGHTS: { key: number; label: TKey }[] = [
  { key: 400, label: "weight.normal" },
  { key: 500, label: "weight.medium" },
  { key: 700, label: "weight.bold" },
];
const ALIGNS: { key: Align; label: TKey }[] = [
  { key: "justify", label: "type.alignJustify" },
  { key: "start", label: "type.alignStart" },
  { key: "center", label: "type.alignCenter" },
  { key: "end", label: "type.alignEnd" },
];
const DIA: { key: DiacriticsMode; label: TKey }[] = [
  { key: "show", label: "diacritics.show" },
  { key: "dim", label: "diacritics.dim" },
  { key: "hide", label: "diacritics.hide" },
];

/** One row: its name, what it currently says, and the way back to saying nothing. */
function Row({
  label,
  set,
  shown,
  onClear,
  hint,
  children,
}: {
  label: string;
  set: boolean;
  shown: string;
  onClear: () => void;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={`pf-ms-row${set ? " on" : ""}`}>
      <div className="pf-ms-head">
        <span className="pf-ms-label">{label}</span>
        <span className={`pf-ms-value${set ? "" : " off"}`}>{shown}</span>
        {set && (
          <button className="pf-ms-clear" onClick={onClear} title={t("profiles.measure.clear")}>
            {t("profiles.measure.follows")}
          </button>
        )}
      </div>
      {children}
      {hint}
    </div>
  );
}

function Slide({
  value,
  min,
  max,
  step,
  onInput,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <input
      className="pf-ms-slider"
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      // `dir="ltr"`: a range input's own geometry is physical. Mirroring it would put the maximum
      // where the reader expects the minimum in Arabic, and the value would run backwards.
      dir="ltr"
      onChange={(e) => onInput(Number(e.target.value))}
    />
  );
}

function Choice<T extends string | number>({
  value,
  options,
  onPick,
}: {
  value: T;
  options: { key: T; label: ReactNode }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="pf-ms-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.key)}
          className={`pf-ms-segbtn${value === o.key ? " on" : ""}`}
          role="radio"
          aria-checked={value === o.key}
          onClick={() => onPick(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function MeasureSection({
  value,
  fallback,
  onChange,
}: {
  value: ProfileTypography;
  /** The reader's own live values, shown greyed where the profile has no opinion. */
  fallback: {
    zoom: number; marginPx: number; lineHeight: number;
    letterSpacing: number; paragraphSpacing: number; fontWeight: number;
    firstLineIndent: boolean; align: Align; diacritics: DiacriticsMode;
  };
  onChange: (patch: Partial<ProfileTypography>) => void;
}) {
  const { t, lang } = useI18n();
  const n = (s: string) => localeDigits(s, lang);
  /** The value a control should sit at: the profile's, or the reader's while it has no opinion. */
  const v = <K extends keyof ProfileTypography>(k: K): NonNullable<ProfileTypography[K]> =>
    (value[k] ?? fallback[k]) as NonNullable<ProfileTypography[K]>;
  const set = (k: keyof ProfileTypography) => value[k] !== null;
  const clear = (k: keyof ProfileTypography) => onChange({ [k]: null } as Partial<ProfileTypography>);

  return (
    <div className="pf-ms">
      <div className="pf-ms-hint">{t("profiles.measure.hint")}</div>

      <div className="pf-ms-group">{t("profiles.measure.groupType")}</div>

      <Row
        label={t("type.size")}
        set={set("zoom")}
        shown={set("zoom") ? n(`${Math.round(v("zoom") * 100)}%`) : t("profiles.measure.follows")}
        onClear={() => clear("zoom")}
      >
        <Slide value={v("zoom")} min={ZOOM_MIN} max={ZOOM_MAX} step={0.05}
          onInput={(x) => onChange({ zoom: Math.round(x * 100) / 100 })} />
      </Row>

      <Row
        label={t("type.weight")}
        set={set("fontWeight")}
        shown={set("fontWeight") ? String(v("fontWeight")) : t("profiles.measure.follows")}
        onClear={() => clear("fontWeight")}
      >
        <Choice<number>
          value={v("fontWeight")}
          onPick={(w) => onChange({ fontWeight: w })}
          options={WEIGHTS.map((w) => ({ key: w.key, label: <span style={{ fontWeight: w.key }}>{t(w.label)}</span> }))}
        />
      </Row>

      {/* TRACKING, AND WHY IT DOES NOT REACH ARABIC. The reading engine withholds letter-spacing from
          RTL text because Arabic is cursive — spacing its glyphs does not open the line, it severs
          the joins. The control is offered because a profile's Latin books will use it, and the note
          says plainly which of the two specimens in the preview will move. */}
      <Row
        label={t("type.tracking")}
        set={set("letterSpacing")}
        shown={set("letterSpacing") ? n(`${v("letterSpacing")} px`) : t("profiles.measure.follows")}
        onClear={() => clear("letterSpacing")}
        hint={<div className="pf-ms-note">{t("profiles.measure.trackingArabic")}</div>}
      >
        <Slide value={v("letterSpacing")} min={0} max={3} step={0.25}
          onInput={(x) => onChange({ letterSpacing: Math.round(x * 100) / 100 })} />
      </Row>

      <div className="pf-ms-group">{t("profiles.measure.groupRhythm")}</div>

      <Row
        label={t("type.lineSpacing")}
        set={set("lineHeight")}
        shown={set("lineHeight") ? n(v("lineHeight").toFixed(2)) : t("profiles.measure.follows")}
        onClear={() => clear("lineHeight")}
      >
        <Slide value={v("lineHeight")} min={1.2} max={2.6} step={0.05}
          onInput={(x) => onChange({ lineHeight: Math.round(x * 100) / 100 })} />
      </Row>

      <Row
        label={t("type.paraSpacing")}
        set={set("paragraphSpacing")}
        shown={set("paragraphSpacing") ? n(`${v("paragraphSpacing")} px`) : t("profiles.measure.follows")}
        onClear={() => clear("paragraphSpacing")}
      >
        <Slide value={v("paragraphSpacing")} min={0} max={28} step={2}
          onInput={(x) => onChange({ paragraphSpacing: x })} />
      </Row>

      <Row
        label={t("type.indent")}
        set={set("firstLineIndent")}
        shown={set("firstLineIndent")
          ? t(v("firstLineIndent") ? "profiles.measure.indentOn" : "profiles.measure.indentOff")
          : t("profiles.measure.follows")}
        onClear={() => clear("firstLineIndent")}
      >
        <Choice<string>
          value={v("firstLineIndent") ? "on" : "off"}
          onPick={(k) => onChange({ firstLineIndent: k === "on" })}
          options={[
            { key: "on", label: t("profiles.measure.indentOn") },
            { key: "off", label: t("profiles.measure.indentOff") },
          ]}
        />
      </Row>

      <Row
        label={t("type.align")}
        set={set("align")}
        shown={set("align") ? t(ALIGNS.find((a) => a.key === v("align"))!.label) : t("profiles.measure.follows")}
        onClear={() => clear("align")}
      >
        <Choice<Align>
          value={v("align")}
          onPick={(a) => onChange({ align: a })}
          options={ALIGNS.map((a) => ({ key: a.key, label: t(a.label) }))}
        />
      </Row>

      <Row
        label={t("type.diacritics")}
        set={set("diacritics")}
        shown={set("diacritics") ? t(DIA.find((d) => d.key === v("diacritics"))!.label) : t("profiles.measure.follows")}
        onClear={() => clear("diacritics")}
      >
        <Choice<DiacriticsMode>
          value={v("diacritics")}
          onPick={(d) => onChange({ diacritics: d })}
          options={DIA.map((d) => ({ key: d.key, label: t(d.label) }))}
        />
      </Row>

      <div className="pf-ms-group">{t("profiles.measure.groupPage")}</div>

      

      <Row
        label={t("type.margins")}
        set={set("marginPx")}
        shown={set("marginPx") ? n(`${v("marginPx")} px`) : t("profiles.measure.follows")}
        onClear={() => clear("marginPx")}
      >
        <Slide value={v("marginPx")} min={0} max={160} step={8}
          onInput={(x) => onChange({ marginPx: x })} />
      </Row>
    </div>
  );
}
