// Reading settings — the calm, sectioned slide-over body (RAWY-24), rebuilt to the live
// design's band-D panel. Every control is wired to EXISTING logic (the injectedCss funnel /
// ReadingStyle from RAWY-10/23, the theme store from RAWY-13, i18n from RAWY-12). It is UI
// chrome → inherits the UI direction and uses theme tokens. Replaces the old cramped
// TypographyBar wall-of-buttons; the dev page-turn / book-switcher / status controls are gone.

import type { ReactNode } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import type { SettingsSection } from "./ReaderChrome";
import {
  ARABIC_FONTS,
  FONT_WEIGHTS,
  LATIN_FONTS,
  PAGE_WIDTH_MAX,
  PAGE_WIDTH_MIN,
  type Align,
  type ArabicFont,
  type DiacriticsMode,
  type FlowMode,
  type LatinFont,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import type { TKey } from "../../i18n/locales/en";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, THEME_ORDER, useTheme, type ThemeId } from "../../theme";
import { contrastIsReadable } from "../../lib/contrast";
import { useFonts } from "../../lib/fonts";

interface Props {
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  isRtlBook: boolean;
  // Which tab to render (RAWY-34): Text · Page · Theme — the chrome's Text/Layout/Theme buttons.
  section?: SettingsSection;
  // Per-book THEME (RAWY-40): the Theme tab + text-colour presets operate on the BOOK's theme
  // (not the global store), so changing them affects only this book.
  bookThemeId: ThemeId;
  onPickTheme: (id: ThemeId) => void;
  unified: boolean; // RAWY-45 — the font label reflects the active scope (this book vs all books)
}

// Per-book text-colour presets, keyed by theme polarity (RAWY-40, Band I). The first is "Default"
// (null → follow the theme ink); the rest are calm inks that read well on the paper.
const INK_PRESETS_LIGHT = ["#4A4036", "#5A4632", "#3A4048", "#5B4B6E"];
const INK_PRESETS_DARK = ["#E4DED2", "#B8B0A0", "#C9BFA8", "#AFC1D6"];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DIA: { key: DiacriticsMode; label: TKey }[] = [
  { key: "show", label: "diacritics.show" },
  { key: "dim", label: "diacritics.dim" },
  { key: "hide", label: "diacritics.hide" },
];
const WEIGHT_KEY: Record<number, TKey> = { 400: "weight.normal", 500: "weight.medium", 700: "weight.bold" };

// ---- small, reusable, theme-tokened controls ----
function Section({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="rs-sec">
      <div className="rs-sec-head">
        <span className="rs-label">{label}</span>
        {value != null && <span className="rs-value">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onInput,
  disabled,
  lead,
  trail,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  disabled?: boolean;
  lead?: ReactNode;
  trail?: ReactNode;
}) {
  // RAWY-65: an audit flagged native <input type=range> as a well-known browser quirk that
  // doesn't mirror for RTL. Investigated live on the release build (WebView2/Chromium) before
  // touching anything — a CSS transform and a JS value-complement were both tried and both made
  // it WORSE (the transform looked mirrored but broke click/drag-to-value math; the complement
  // then double-flipped an already-correct native mapping). An empirical click-position sweep
  // (`docs/shots/rawy65-slider-*.png`) proved this specific runtime already auto-mirrors BOTH the
  // paint (low value's thumb sits at the physical right, next to the `lead` label the RTL flex-
  // row already puts there; high value's thumb sits at physical left, next to `trail`) AND the
  // click/drag-to-value math correctly, with zero code involved. No fix needed — left as plain
  // passthrough, deliberately, not merely unedited.
  return (
    <div className="rs-slider-row">
      {lead != null && <span className="rs-slider-cap">{lead}</span>}
      <input
        className="rs-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onInput(Number(e.target.value))}
      />
      {trail != null && <span className="rs-slider-cap rs-slider-cap-lg">{trail}</span>}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onPick,
}: {
  options: { key: T; label: ReactNode }[];
  value: T;
  onPick: (k: T) => void;
}) {
  return (
    <div className="rs-seg" role="group">
      {options.map((o) => (
        <button key={String(o.key)} className={`rs-seg-item${value === o.key ? " on" : ""}`} onClick={() => onPick(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({ label, hint, on, onToggle }: { label: string; hint?: string; on: boolean; onToggle: () => void }) {
  return (
    <button className="rs-toggle-row" onClick={onToggle} aria-pressed={on}>
      <span className="rs-toggle-text">
        <span className="rs-toggle-label">{label}</span>
        {hint && <span className="rs-toggle-hint">{hint}</span>}
      </span>
      <span className={`rs-switch${on ? " on" : ""}`} aria-hidden>
        <span className="rs-knob" />
      </span>
    </button>
  );
}

function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (k: T) => void;
}) {
  return (
    <label className="rs-select-row">
      <span className="rs-select-label">{label}</span>
      <span className="rs-select-wrap">
        <select className="rs-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="rs-select-caret" aria-hidden>▾</span>
      </span>
    </label>
  );
}

export function ReadingSettings({ style, update, isRtlBook, section = "text", bookThemeId, onPickTheme, unified }: Props) {
  const { t, lang } = useI18n();
  // Override-book-colour + hide-chapter-titles stay GLOBAL flags (RAWY-40); the THEME is per-book.
  const { overrideBookColor, hideChapterTitles, setOverride, setHideTitles } = useTheme();
  const customFonts = useFonts((s) => s.custom); // RAWY-44 — imported fonts for the book pickers
  const theme = THEMES[bookThemeId];
  const dark = theme.dark;
  const paper = theme.colors.paperBg;
  // Effective ink for the contrast check + which preset is "active".
  const ink = style.textColor ?? theme.colors.text;
  const presets = dark ? INK_PRESETS_DARK : INK_PRESETS_LIGHT;
  const readable = contrastIsReadable(ink, paper);

  // RAWY-34: render only the active tab's controls (Text · Page · Theme — the design's band I),
  // so the chrome's Text/Layout/Theme buttons each land on a DISTINCT view (not one scrolled panel).
  return (
    <div className="rs">
      {section === "text" && (
      <>
      {/* ---- TEXT ---- */}
      <Section label={t("type.size")} value={localeDigits(`${Math.round(style.zoom * 100)}%`, lang)}>
        <Slider
          value={style.zoom}
          min={0.8}
          max={2.5}
          step={0.05}
          onInput={(v) => update({ zoom: r2(v) })}
          lead={<span style={{ fontSize: 13 }}>A</span>}
          trail={<span style={{ fontSize: 21 }}>A</span>}
        />
      </Section>

      <Section label={t("type.weight")}>
        <Segmented
          value={style.fontWeight}
          onPick={(w) => update({ fontWeight: w })}
          options={FONT_WEIGHTS.map((w) => ({ key: w, label: <span style={{ fontWeight: w }}>{t(WEIGHT_KEY[w])}</span> }))}
        />
      </Section>

      <Section label={t("type.lineSpacing")} value={localeDigits(style.lineHeight.toFixed(2), lang)}>
        <Slider value={style.lineHeight} min={1.2} max={2.6} step={0.05} onInput={(v) => update({ lineHeight: r2(v) })} />
      </Section>

      <Section label={t("type.paraSpacing")} value={localeDigits(`${style.paragraphSpacing}px`, lang)}>
        <Slider value={style.paragraphSpacing} min={0} max={28} step={2} onInput={(v) => update({ paragraphSpacing: v })} />
      </Section>

      <Section label={t("type.tracking")} value={isRtlBook ? <span className="rs-na">{t("type.latinOnly")}</span> : localeDigits(String(style.letterSpacing), lang)}>
        <Slider
          value={style.letterSpacing}
          min={0}
          max={3}
          step={0.25}
          disabled={isRtlBook}
          onInput={(v) => update({ letterSpacing: r2(v) })}
        />
      </Section>

      <Section label={t("type.align")}>
        <Segmented<Align>
          value={style.align}
          onPick={(a) => update({ align: a })}
          options={[
            { key: "justify", label: t("type.alignJustify") },
            { key: "start", label: t("type.alignStart") },
          ]}
        />
      </Section>

      <ToggleRow label={t("type.indent")} on={style.firstLineIndent} onToggle={() => update({ firstLineIndent: !style.firstLineIndent })} />

      <div className="rs-divider" />

      {/* ---- BOOK TEXT FONT — scoped to THIS book (RAWY-45); imported fonts listed too (RAWY-44) ---- */}
      <div className="rs-sec-title">{unified ? t("type.fontAllBooks") : t("type.fontThisBook")}</div>
      <div className="rs-sec-hint">{unified ? t("type.fontAllBooksHint") : t("type.fontThisBookHint")}</div>
      <SelectRow<string>
        label={t("type.latin")}
        value={style.latinFont}
        onChange={(k) => update({ latinFont: k })}
        options={[
          ...(Object.keys(LATIN_FONTS) as LatinFont[]).map((k) => ({ key: k, label: LATIN_FONTS[k].label })),
          ...customFonts.map((c) => ({ key: c.family_name, label: `${c.family_name} · ${t("gs.imported")}` })),
        ]}
      />
      <SelectRow<string>
        label={t("type.arabic")}
        value={style.arabicFont}
        onChange={(k) => update({ arabicFont: k })}
        options={[
          ...(Object.keys(ARABIC_FONTS) as ArabicFont[]).map((k) => ({ key: k, label: ARABIC_FONTS[k].label })),
          ...customFonts.map((c) => ({ key: c.family_name, label: `${c.family_name} · ${t("gs.imported")}` })),
        ]}
      />

      <Section label={t("type.diacritics")}>
        <Segmented<DiacriticsMode>
          value={style.diacritics}
          onPick={(d) => update({ diacritics: d })}
          options={DIA.map((d) => ({ key: d.key, label: t(d.label) }))}
        />
      </Section>

      <div className="rs-divider" />

      {/* ---- TEXT COLOUR (RAWY-40, Band I) — per-book ink within the active theme ---- */}
      <div className="rs-sec-head">
        <span className="rs-label">{t("color.text")}</span>
        <span className="rs-value rs-na">{t("color.within", { theme: theme.name })}</span>
      </div>
      <div className="rs-inks">
        {/* Default = follow the theme ink (textColor null) */}
        <button
          className={`rs-ink${style.textColor == null ? " on" : ""}`}
          style={{ background: theme.colors.text }}
          onClick={() => update({ textColor: null })}
          title={t("color.default")}
          aria-label={t("color.default")}
        />
        {presets.map((hex) => (
          <button
            key={hex}
            className={`rs-ink${style.textColor?.toLowerCase() === hex.toLowerCase() ? " on" : ""}`}
            style={{ background: hex }}
            onClick={() => update({ textColor: hex })}
            title={hex}
            aria-label={hex}
          />
        ))}
        {/* Custom colour via the native picker */}
        <label className="rs-ink rs-ink-custom" title={t("color.custom")}>
          <span className="rs-ink-plus" aria-hidden>+</span>
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(style.textColor ?? "") ? (style.textColor as string) : theme.colors.text}
            onChange={(e) => update({ textColor: e.target.value })}
          />
        </label>
      </div>
      <div className={`rs-contrast${readable ? "" : " warn"}`}>
        <span aria-hidden>{readable ? "✓" : "⚠"}</span>
        <span>{readable ? t("color.contrastOk") : t("color.contrastWarn", { theme: theme.name })}</span>
      </div>

      </>
      )}

      {section === "page" && (
      <>
      {/* ---- PAGE ---- */}
      <Section label={t("mode.label")}>
        <Segmented<FlowMode>
          value={style.flowMode}
          onPick={(m) => update({ flowMode: m })}
          options={[
            { key: "scrolled", label: t("mode.scrolled") },
            { key: "paged", label: t("mode.paged") },
          ]}
        />
      </Section>

      <Section
        label={t("type.pageWidth")}
        value={style.pageFitWindow ? <span className="rs-na">{t("type.matchWindow")}</span> : undefined}
      >
        <Slider
          value={style.pageWidth}
          min={PAGE_WIDTH_MIN}
          max={PAGE_WIDTH_MAX}
          step={0.05}
          disabled={style.pageFitWindow}
          onInput={(v) => update({ pageWidth: r2(v) })}
          lead={<span className="rs-tiny">{t("type.narrow")}</span>}
          trail={<span className="rs-tiny">{t("type.wide")}</span>}
        />
      </Section>
      <ToggleRow label={t("type.matchWindow")} on={style.pageFitWindow} onToggle={() => update({ pageFitWindow: !style.pageFitWindow })} />

      <Section label={t("type.margins")} value={localeDigits(`${style.marginPx}px`, lang)}>
        <Slider value={style.marginPx} min={0} max={160} step={8} onInput={(v) => update({ marginPx: clamp(v, 0, 160) })} />
      </Section>

      </>
      )}

      {section === "theme" && (
      <>
      {/* ---- PAPER / THEME (RAWY-40: PER-BOOK — onPickTheme affects only this book) ---- */}
      <div className="rs-sec-head">
        <span className="rs-label">{t("type.paper")}</span>
        {/* Day/Night = an explicit light↔dark switch for THIS book. "Day" selects the default
            light theme, "Night" the default dark; clicking the active side is a no-op. */}
        <Segmented
          value={dark ? "night" : "day"}
          onPick={(k) => {
            if (k === "night" && !dark) onPickTheme(DEFAULT_DARK);
            else if (k === "day" && dark) onPickTheme(DEFAULT_LIGHT);
          }}
          options={[
            { key: "day", label: t("theme.day") },
            { key: "night", label: t("theme.night") },
          ]}
        />
      </div>
      <div className="rs-swatches">
        {THEME_ORDER.map((id) => (
          <button key={id} className="rs-swatch-cell" onClick={() => onPickTheme(id)}>
            <span className={`rs-swatch${bookThemeId === id ? " on" : ""}`} style={{ background: THEMES[id].colors.paperBg }} />
            <span className="rs-swatch-name">{THEMES[id].name}</span>
          </button>
        ))}
      </div>
      <ToggleRow label={t("theme.override")} on={overrideBookColor} onToggle={() => setOverride(!overrideBookColor)} />
      <ToggleRow label={t("theme.hideTitles")} on={hideChapterTitles} onToggle={() => setHideTitles(!hideChapterTitles)} />
      {/* Theme + text colour are per-book (RAWY-40); override-colour + hide-titles remain global. */}
      </>
      )}
    </div>
  );
}
