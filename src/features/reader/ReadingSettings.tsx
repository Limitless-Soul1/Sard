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
import { TtsTrackingControls } from "./TtsTrackingControls"; // RAWY-200
import { useTts } from "../../lib/tts"; // RAWY-257 (Phase 1 / RAWY-255): the read-aloud diagnostic toggle
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
// RAWY-201: per-book PAGE (paper) and BACKGROUND (behind the page) presets, keyed by polarity. Calm
// paper tones + deep desk tones; the "Default" swatch (null) follows the active theme's own value.
const PAGE_PRESETS_LIGHT = ["#F5EEDD", "#EAE3CF", "#F0F2E8", "#FBF1F1"];
const PAGE_PRESETS_DARK = ["#222A31", "#1B2130", "#121A2E", "#1C1C1E"];
const BG_PRESETS_LIGHT = ["#E6DEC8", "#D9D0B8", "#DCE0D2", "#E7DADA"];
const BG_PRESETS_DARK = ["#0B1021", "#0E1526", "#14100E", "#101418"];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DIA: { key: DiacriticsMode; label: TKey }[] = [
  { key: "show", label: "diacritics.show" },
  { key: "dim", label: "diacritics.dim" },
  { key: "hide", label: "diacritics.hide" },
];
const WEIGHT_KEY: Record<number, TKey> = { 400: "weight.normal", 500: "weight.medium", 700: "weight.bold" };

// RAWY-201: a per-book colour row (Default + presets + native picker), reusing the exact rs-ink swatch
// markup the text-colour control uses — NO new design. `value` is the stored override (null = follow the
// theme); the Default swatch shows the theme's own value and clears the override.
function ColorRow({
  label,
  value,
  themeValue,
  presets,
  onPick,
  t,
}: {
  label: string;
  value: string | null;
  themeValue: string;
  presets: string[];
  onPick: (v: string | null) => void;
  t: (k: TKey) => string;
}) {
  return (
    <>
      <div className="rs-sec-head">
        <span className="rs-label">{label}</span>
      </div>
      <div className="rs-inks">
        <button
          className={`rs-ink${value == null ? " on" : ""}`}
          style={{ background: themeValue }}
          onClick={() => onPick(null)}
          title={t("color.default")}
          aria-label={t("color.default")}
        />
        {presets.map((hex) => (
          <button
            key={hex}
            className={`rs-ink${value?.toLowerCase() === hex.toLowerCase() ? " on" : ""}`}
            style={{ background: hex }}
            onClick={() => onPick(hex)}
            title={hex}
            aria-label={hex}
          />
        ))}
        <label className="rs-ink rs-ink-custom" title={t("color.custom")}>
          <span className="rs-ink-plus" aria-hidden>+</span>
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(value ?? "") ? (value as string) : themeValue}
            onChange={(e) => onPick(e.target.value)}
          />
        </label>
      </div>
    </>
  );
}

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

// RAWY-212: `sub` = the inset/muted sub-toggle style (reused from RAWY-200's `rs-track-subtoggle`);
// `disabled` dims it and blocks interaction (native <button disabled>) when its master is off.
// RAWY-216: `scope` appends the shared scope suffix for the ONE row whose scope differs from its tab.
function ToggleRow({ label, scope, hint, on, onToggle, sub, disabled }: { label: string; scope?: string; hint?: string; on: boolean; onToggle: () => void; sub?: boolean; disabled?: boolean }) {
  return (
    <button className={`rs-toggle-row${sub ? " rs-track-subtoggle" : ""}`} onClick={onToggle} aria-pressed={on} disabled={disabled}>
      <span className="rs-toggle-text">
        <span className="rs-toggle-label">{label}{scope && <> <span className="rs-scope">{scope}</span></>}</span>
        {hint && <span className="rs-toggle-hint">{hint}</span>}
      </span>
      <span className={`rs-switch${on ? " on" : ""}`} aria-hidden>
        <span className="rs-knob" />
      </span>
    </button>
  );
}

/** RAWY-257 (Phase 1, item 1) / RAWY-255 — the read-aloud DIAGNOSTIC toggle.
 *
 *  WHY THIS EXISTS: D62 (RAWY-247) built a synth-failure classifier and recorded it as "readable without
 *  devtools" via the pill readout — but that readout is gated on `localStorage.sardTtsDebug`, NOTHING in the
 *  app ever WROTE that key, and DevTools is off in release builds. So the one instrument built for this exact
 *  class of bug could not be switched on by the owner at all, and that was discovered at the worst possible
 *  moment: the first real read-aloud regression (RAWY-254), with him waiting. An instrument is part of the
 *  feature, not a note about it.
 *
 *  It is its OWN component so the hook lives here — toggling the diagnostic must not re-render the whole
 *  settings panel, and the rest of ReadingSettings stays untouched. It writes `localStorage`, NOT the DB: this
 *  is a diagnostic switch, not a reading preference, so it is deliberately not a `ReadingStyle` field (D43). */
function TtsDebugRow({ label, hint }: { label: string; hint: string }) {
  const on = useTts((s) => s.debug);
  const setDebug = useTts((s) => s.setDebug);
  return <ToggleRow label={label} hint={hint} on={on} onToggle={() => setDebug(!on)} />;
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

export function ReadingSettings({ style, update, isRtlBook, section = "typography", bookThemeId, onPickTheme, unified }: Props) {
  const { t, lang } = useI18n();
  // RAWY-216: ONE scope wording for the whole drawer. Three phrasings used to say the same thing; the
  // scope NOUN now lives in a single pair of keys, shared with the panel's banner, and a section
  // heading appends it after an em dash. The noun is chosen by the ACTIVE book-style model (D43):
  // unified writes the global row, per-book writes this book's override.
  const scopeSuffix = `— ${unified ? t("scope.allBooks") : t("scope.thisBook")}`;
  // The one row whose scope differs from its tab's (see the immersive master in Layout) states it
  // explicitly, using the same noun rather than a fourth phrasing.
  const scopeAllSuffix = `— ${t("scope.allBooks")}`;
  // Override-book-colour + hide-chapter-title + hide-first-line stay GLOBAL flags (RAWY-40); the
  // THEME is per-book. RAWY-69 split hide-chapter-title/hide-first-line into two independent flags.
  const { overrideBookColor, hideChapterTitles, hideFirstLine, immersive, setOverride, setHideTitles, setHideFirstLine, setImmersive } = useTheme();
  const customFonts = useFonts((s) => s.custom); // RAWY-44 — imported fonts for the book pickers
  const theme = THEMES[bookThemeId];
  const dark = theme.dark;
  // RAWY-201: the EFFECTIVE page colour (custom, else the theme's) — the contrast guard checks the ink
  // against the surface the text ACTUALLY sits on, so a custom page colour is what an unreadable pair is
  // measured against (not the theme paper it may have replaced).
  const paper = style.pageColor ?? theme.colors.paperBg;
  // Effective ink for the contrast check + which preset is "active".
  const ink = style.textColor ?? theme.colors.text;
  const presets = dark ? INK_PRESETS_DARK : INK_PRESETS_LIGHT;
  const readable = contrastIsReadable(ink, paper);

  // RAWY-34: render only the active tab's controls (Text · Page · Theme — the design's band I),
  // so the chrome's Text/Layout/Theme buttons each land on a DISTINCT view (not one scrolled panel).
  return (
    <div className="rs">
      {section === "typography" && (
      <>
      {/* ---- TYPOGRAPHY (RAWY-216): letterforms + spacing only. Colour moved to the Colour tab and the
           read-aloud highlights to the Read-aloud tab — this tab used to carry all three. ---- */}
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

      {/* RAWY-216: a SPACE before the unit. Arabic-Indic zero (U+0660) is a dot-shaped glyph, so at this
          readout's size "0px" localised to "٠px" fused into something the owner read as "-px" — the value
          looked like a dash instead of a number. Separating the unit keeps the digit its own token. */}
      <Section label={t("type.paraSpacing")} value={localeDigits(`${style.paragraphSpacing} px`, lang)}>
        <Slider value={style.paragraphSpacing} min={0} max={28} step={2} onInput={(v) => update({ paragraphSpacing: v })} />
      </Section>

      {/* RAWY-216: this used to be the odd one out — an "N/A" chip in the value slot, which said WHAT but
          never WHY, and only on this one control. It now uses the drawer's single inert-reason line, the
          same treatment every other greyed control gets. */}
      <Section label={t("type.tracking")} value={isRtlBook ? undefined : localeDigits(String(style.letterSpacing), lang)}>
        <Slider
          value={style.letterSpacing}
          min={0}
          max={3}
          step={0.25}
          disabled={isRtlBook}
          onInput={(v) => update({ letterSpacing: r2(v) })}
        />
      </Section>
      {isRtlBook && <div className="rs-inert">{t("inert.latinOnly")}</div>}

      <Section label={t("type.align")}>
        <Segmented<Align>
          value={style.align}
          onPick={(a) => update({ align: a })}
          options={[
            { key: "justify", label: t("type.alignJustify") },
            { key: "start", label: t("type.alignStart") },
            { key: "center", label: t("type.alignCenter") },
            { key: "end", label: t("type.alignEnd") },
          ]}
        />
      </Section>

      <ToggleRow label={t("type.indent")} on={style.firstLineIndent} onToggle={() => update({ firstLineIndent: !style.firstLineIndent })} />

      <div className="rs-divider" />

      {/* ---- BOOK TEXT FONT (RAWY-45); imported fonts listed too (RAWY-44). RAWY-216: the heading no
           longer rewords itself by scope — it is one stable title plus the shared scope suffix. ---- */}
      <div className="rs-sec-title">{t("type.font")} <span className="rs-scope">{scopeSuffix}</span></div>
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

      {/* RAWY-216: diacritics are Arabic vowel marks — on a Latin-direction book the control still works
           and still saves, but there is nothing on the page for it to affect. Say so instead of leaving it
           silently inert (it stays operable; the line is a reason, not a disable). */}
      <Section label={t("type.diacritics")}>
        <Segmented<DiacriticsMode>
          value={style.diacritics}
          onPick={(d) => update({ diacritics: d })}
          options={DIA.map((d) => ({ key: d.key, label: t(d.label) }))}
        />
      </Section>
      {!isRtlBook && <div className="rs-inert">{t("inert.arabicOnly")}</div>}

      </>
      )}

      {section === "colour" && (
      <>
      {/* ---- COLOUR (RAWY-216): the theme AND the three per-book colour overrides it feeds, together.
           They used to be two tabs apart (theme here, ink/page/background in the old Text tab). ---- */}
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

      {/* ---- PAGE COLOUR (RAWY-201) — the reading surface, per-book; null = the theme's own paper ---- */}
      <ColorRow
        label={t("color.page")}
        value={style.pageColor}
        themeValue={theme.colors.paperBg}
        presets={dark ? PAGE_PRESETS_DARK : PAGE_PRESETS_LIGHT}
        onPick={(v) => update({ pageColor: v })}
        t={t}
      />

      {/* ---- BACKGROUND COLOUR (RAWY-201) — behind the page (replaces Moonlit decorations); null = theme ---- */}
      <ColorRow
        label={t("color.background")}
        value={style.backgroundColor}
        themeValue={theme.colors.surfaceBg}
        presets={dark ? BG_PRESETS_DARK : BG_PRESETS_LIGHT}
        onPick={(v) => update({ backgroundColor: v })}
        t={t}
      />

      </>
      )}

      {section === "readaloud" && (
      <>
      {/* ---- READ-ALOUD (RAWY-216): the tracking highlights get their own tab. Voice/engine/speed are
           NOT here — they live in the floating player while listening; the note says so plainly rather
           than leaving the reader hunting for them (RAWY-200 controls are unchanged). ---- */}
      <div className="rs-sec-hint">{t("settings.voiceNote")}</div>
      <TtsTrackingControls
        style={style}
        update={update}
        dark={dark}
        paperBg={paper}
        themeInk={theme.colors.text}
      />

      {/* RAWY-257 (Phase 1) / RAWY-255: the diagnostic switch. Last in the tab, under a divider — it is a
          troubleshooting aid, not a reading control, and must not compete with the tracking highlights above. */}
      <div className="rs-divider" />
      <TtsDebugRow label={t("tts.diagnostics")} hint={t("tts.diagnosticsHint")} />

      </>
      )}

      {section === "layout" && (
      <>
      {/* ---- LAYOUT (RAWY-216) ---- */}
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

      {/* RAWY-216: the MASTER now precedes the control it disables (page width used to come first, so the
          slider greyed out for a reason stated below it). */}
      <ToggleRow label={t("type.matchWindow")} on={style.pageFitWindow} onToggle={() => update({ pageFitWindow: !style.pageFitWindow })} />

      <Section label={t("type.pageWidth")}>
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
      {style.pageFitWindow && <div className="rs-inert">{t("inert.matchWindow")}</div>}

      {/* RAWY-216: see the paragraph-spacing note — this is the row that actually showed "-px" live, because
          the owner's saved margin is 0. */}
      <Section label={t("type.margins")} value={localeDigits(`${style.marginPx} px`, lang)}>
        <Slider value={style.marginPx} min={0} max={160} step={8} onInput={(v) => update({ marginPx: clamp(v, 0, 160) })} />
      </Section>

      <div className="rs-divider" />

      {/* RAWY-210: immersive hide-on-scroll MASTER — a GLOBAL reading-behaviour flag (via useTheme, like the
          hide-title toggles), not per-book typography, so it is NOT wired through `update`. RAWY-216: it is the
          ONE deliberate exception to "scope is structural" — it stays in Layout because its two children are
          per-book and functionally inseparable from it, so it carries the quiet "all books" suffix instead. */}
      <ToggleRow
        label={t("type.immersive")}
        scope={scopeAllSuffix}
        hint={t("type.immersiveHint")}
        on={immersive}
        onToggle={() => setImmersive(!immersive)}
      />
      {/* RAWY-212: two PER-BOOK sub-toggles (D43 — written via `update`, so unified writes the global default
          and per-book writes this book's override). They gate each element's hide-on-scroll-away independently;
          dimmed + inert while the master is off. The resume hint is intentionally NOT a toggle — it always
          shows in immersive mode (owner revision). */}
      <ToggleRow sub disabled={!immersive} label={t("type.immHidePill")} on={style.immHidePill} onToggle={() => update({ immHidePill: !style.immHidePill })} />
      <ToggleRow sub disabled={!immersive} label={t("type.immHideScrollbar")} on={style.immHideScrollbar} onToggle={() => update({ immHideScrollbar: !style.immHideScrollbar })} />
      {!immersive && <div className="rs-inert">{t("inert.immersiveOff")}</div>}

      </>
      )}

      {section === "allbooks" && (
      <>
      {/* ---- ALL BOOKS (RAWY-216) — the three GLOBAL flags (RAWY-40/69) that ignore the per-book/unified
           scope. They used to sit at the bottom of the Theme tab under an "applies to all books" heading,
           inside a drawer whose banner said "this book" (RAWY-80, audit #8). Now the TAB is the scope
           signal, so a reader cannot flip one while reading "this book only" and silently change every
           book. Hide chapter title / Hide first line ALSO lived in the Contents panel — that duplicate is
           removed, and this is now their single home. ---- */}
      <div className="rs-sec-hint">{t("settings.allbooksSub")}</div>
      <ToggleRow label={t("theme.override")} on={overrideBookColor} onToggle={() => setOverride(!overrideBookColor)} />
      <ToggleRow label={t("theme.hideTitles")} on={hideChapterTitles} onToggle={() => setHideTitles(!hideChapterTitles)} />
      <ToggleRow
        label={t("panel.hideFirstLine")}
        hint={t("panel.hideFirstLineHint")}
        on={hideFirstLine}
        onToggle={() => setHideFirstLine(!hideFirstLine)}
      />
      </>
      )}
    </div>
  );
}
