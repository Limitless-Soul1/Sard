// Reading settings — the calm, sectioned slide-over body (RAWY-24), rebuilt to the live
// design's band-D panel. Every control is wired to EXISTING logic (the injectedCss funnel /
// ReadingStyle from RAWY-10/23, the theme store from RAWY-13, i18n from RAWY-12). It is UI
// chrome → inherits the UI direction and uses theme tokens. Replaces the old cramped
// TypographyBar wall-of-buttons; the dev page-turn / book-switcher / status controls are gone.

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { listeningOutcomes, type OutcomeSummary } from "../../lib/listeningOutcomes"; // RAWY-263
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
import { contrastIsReadable, effectivePaper } from "../../lib/contrast";
import { TtsTrackingControls } from "./TtsTrackingControls"; // RAWY-200
// RAWY-281: the reference twin rule's geometry — the SAME resolver FoliateController draws with, so the
// panel's preview and the mark on the page are one computation rather than two matched sets of numbers.
import {
  resolveRefRule,
  refRuleBars,
  REF_WEIGHT_MIN,
  REF_WEIGHT_MAX,
  REF_OFFSET_MIN,
  REF_OFFSET_MAX,
} from "../../reader-engine/refRule";
import { useTts } from "../../lib/tts"; // RAWY-257 (Phase 1 / RAWY-255): the read-aloud diagnostic toggle
import { useFonts } from "../../lib/fonts";
// RAWY-265 (Phase 2): the reading DESK background. Constants, store and the presence→scrim mapping
// all live in the module and are shared with the library surface — only the markup differs here.
import {
  BG_BLUR_MAX,
  presenceMaxFor,
  PAGE_OPACITY_MIN,
  bgSrcUrl,
  currentDeskScrim,
  effectivePageOpacity,
  useBackground,
} from "../../lib/background";

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

function RefRuleControls({
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
    <>
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
    </>
  );
}

// ---- RAWY-265 (Phase 2): the READING DESK background ----
//
// LIVES IN THE "ALL BOOKS" TAB, and that placement is the scope signal. The background is app-wide,
// and this tab already opens with "These always apply to every book, not just this one" — so
// constraint B2 (a reader must always be able to tell what a change affects) is satisfied BY
// STRUCTURE rather than by adding a per-control suffix to a drawer whose banner says "this book".
// It also avoids a sixth tab: RAWY-217 measured that five is the practical ceiling for this width.
//
// PROGRESSIVE DISCLOSURE, as in Global Settings: one row until an image exists.
//
// The measured constants, the store and the presence→scrim mapping all live in `lib/background.ts`
// and are SHARED with the library surface — only the markup differs here, in the drawer's own visual
// language (rs-*). Nothing that could drift is duplicated.
function ReadingBackgroundSection() {
  const { t, lang } = useI18n();
  // The DESK's own colour is the theme's `surfaceBg` — that is what the scrim tints toward, so it is
  // also the ground the "arrive correct" presence is solved against (a desk-coloured image can be
  // shown boldly; one that fights the desk arrives restrained).
  const bookThemeId = useTheme((s) => s.bookThemeId);
  const deskGround = THEMES[bookThemeId].colors.surfaceBg;
  // RAWY-278: the immersive blur step only exists while immersive mode is on, so its toggle follows
  // the same disabled + inert-note treatment the other immersive sub-options already use.
  const immersive = useTheme((s) => s.immersive);

  // RAWY-278 (fix) — make the boost OBSERVABLE while it is being set.
  // Opening this drawer clears `scrolledAway` (Reader.tsx:589 → setHold → setVis → setScrolledAway),
  // and that is the only state the boost renders in — so the control looked dead. Raising this
  // attribute while the row is hovered or focused reproduces the receded FILTER only; the scrim step
  // and every transition are untouched, and the selector cannot match once the attribute is gone.
  // The cleanup is not optional: the section unmounts when the drawer closes, and a leaked attribute
  // would leave the desk previewing forever (Memory Rules — cleanup must always exist).
  const previewImmersiveBlur = (on: boolean) => {
    const r = document.documentElement;
    if (on) r.dataset.bgImmPreview = "1";
    else delete r.dataset.bgImmPreview;
  };
  useEffect(() => () => { delete document.documentElement.dataset.bgImmPreview; }, []);
  const { reading, readingParams, setParams, choose, clear, resetParams } = useBackground();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await choose("reading", picked, deskGround);
    } catch (e) {
      // Rust returns a stable `bg.err.*` CODE, never a sentence, so user-facing copy stays inside
      // the i18n system. An unmapped code shows itself rather than an empty message.
      const code = String(e);
      setError(code.startsWith("bg.err.") ? t(code as TKey) : code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rs-sec-head" style={{ marginTop: 14 }}>
        <span className="rs-label">{t("gs.bgReading")}</span>
      </div>
      <div className="rs-sec-hint">{t("gs.bgReadingHint")}</div>

      {!reading ? (
        <>
          {/* RAWY-278: the button states the REAL in-flight state rather than only greying out. */}
          <button className="bg-ctl-act" disabled={busy} aria-busy={busy} onClick={pick}>
            {busy && <span className="bg-ctl-spin" aria-hidden />}
            {busy ? t("gs.bg.preparing") : t("gs.bg.choose")}
          </button>
          <div className="rs-sec-hint">{busy ? t("gs.bg.preparingHint") : t("gs.bg.formats")}</div>
        </>
      ) : (
        <>
          <div className="bg-ctl-row">
            <span
              className="bg-ctl-thumb"
              style={{
                backgroundImage: `url("${bgSrcUrl(reading)}")`,
                transform: `scaleX(${readingParams.flip ? -1 : 1})`,
              }}
              aria-hidden
            />
            <span className="bg-ctl-name" dir="auto">{reading.source_name ?? ""}</span>
            <button className="bg-ctl-act" disabled={busy} aria-busy={busy} onClick={pick}>
              {busy && <span className="bg-ctl-spin" aria-hidden />}
              {busy ? t("gs.bg.preparing") : t("gs.bg.replace")}
            </button>
            <button
              className="bg-ctl-act danger"
              disabled={busy}
              onClick={() => { setError(null); clear("reading").catch((e) => setError(String(e))); }}
            >
              {t("gs.bg.remove")}
            </button>
          </div>

          {/* RAWY-278 — see the library half in GlobalSettings.tsx. Gated on `derivative_path` so the
              note is never shown for an under-ceiling image, where the original itself is rendered. */}
          {busy && <div className="rs-sec-hint">{t("gs.bg.preparingHint")}</div>}
          {!busy && reading.derivative_path && (
            <div className="rs-sec-hint">{t("gs.bg.displayCopy")}</div>
          )}

          {/* RAWY-279: the READING presence may travel past 100, down to a fully transparent overlay.
              The LIBRARY's may not — its scrim is a measured WCAG AA floor (see `presenceMaxFor`).
              0..100 is unchanged on both surfaces, so every existing profile renders identically. */}
          <Section label={t("gs.bg.presence")} value={localeDigits(String(readingParams.presence), lang)}>
            <Slider
              value={readingParams.presence}
              min={0}
              max={presenceMaxFor("reading")}
              step={1}
              onInput={(v) => setParams("reading", { presence: v })}
            />
          </Section>
          <div className="rs-sec-hint">{t("gs.bg.presenceHintReading")}</div>

          <Section label={t("gs.bg.blur")} value={localeDigits(String(readingParams.blur), lang)}>
            <Slider
              value={readingParams.blur}
              min={0}
              max={BG_BLUR_MAX}
              step={1}
              onInput={(v) => setParams("reading", { blur: v })}
            />
          </Section>

          {/* RAWY-278 — the immersive blur STEP. Placed directly under the Blur slider because it
              modifies that exact control; separating them would hide the relationship. Reading-only,
              like `pageOpacity` — the library surface has no immersive mode, so this row is
              deliberately absent from GlobalSettings.
              `disabled` + the EXISTING `inert.immersiveOff` string reproduce the treatment the other
              two immersive sub-options already use, so the row is honest about when it applies rather
              than silently doing nothing. (Those siblings are equally inert in paged flow and in PDF,
              where no scroll-intent is emitted; matching them is the consistent choice.) */}
          <ToggleRow
            label={t("gs.bg.immBlur")}
            hint={t("gs.bg.immBlurHint")}
            on={readingParams.immersiveBlur}
            onToggle={() => setParams("reading", { immersiveBlur: !readingParams.immersiveBlur })}
            disabled={!immersive}
            onPreview={previewImmersiveBlur}
          />
          {!immersive && <div className="rs-inert">{t("inert.immersiveOff")}</div>}

          {/* RAWY-265 (Phase 3) — PAGE OPACITY. The slider's MINIMUM is the measured AAA floor, not
              zero: below PAGE_OPACITY_MIN body text would stop clearing 7:1 against the worst image
              this desk can show. The range is therefore unreachable-into-unreadable BY CONSTRUCTION,
              which is why no warning is needed here (unlike the colour guards, which a reader can
              legitimately push into a low-contrast pair). 100% is the default and reproduces today's
              solid paper exactly. */}
          <Section
            label={t("gs.bg.pageOpacity")}
            value={localeDigits(String(Math.round(readingParams.pageOpacity * 100)), lang)}
          >
            <Slider
              value={Math.round(readingParams.pageOpacity * 100)}
              min={Math.round(PAGE_OPACITY_MIN * 100)}
              max={100}
              step={1}
              onInput={(v) => setParams("reading", { pageOpacity: v / 100 })}
            />
          </Section>
          <div className="rs-sec-hint">{t("gs.bg.pageOpacityHint")}</div>

          {/* `cover` always crops; this chooses what survives. A click sets the centre directly. */}
          <div className="rs-sec-head"><span className="rs-label">{t("gs.bg.focal")}</span></div>
          <button
            className="bg-ctl-focal"
            style={{
              backgroundImage: `url("${bgSrcUrl(reading)}")`,
              backgroundPosition: `${readingParams.focalX}% ${readingParams.focalY}%`,
            }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setParams("reading", {
                focalX: Math.round(((e.clientX - r.left) / r.width) * 100),
                focalY: Math.round(((e.clientY - r.top) / r.height) * 100),
              });
            }}
          >
            <span
              className="bg-ctl-focal-dot"
              style={{ left: `${readingParams.focalX}%`, top: `${readingParams.focalY}%` }}
            />
          </button>
          <div className="rs-sec-hint">{t("gs.bg.focalHint")}</div>

          <ToggleRow
            label={t("gs.bg.flip")}
            on={readingParams.flip}
            onToggle={() => setParams("reading", { flip: !readingParams.flip })}
          />

          {readingParams.presence === 0 && <div className="rs-sec-hint">{t("gs.bg.hidden")}</div>}
          <button className="bg-ctl-act" onClick={() => resetParams("reading", deskGround)}>
            {t("gs.bg.reset")}
          </button>
        </>
      )}
      {error && <div className="rs-sec-hint bg-ctl-err">{error}</div>}
    </>
  );
}

// ---- small, reusable, theme-tokened controls ----

/**
 * RAWY-288: the enclosing `Section`'s label, so a control inside it can carry an ACCESSIBLE NAME
 * without every call site remembering to pass one.
 *
 * MEASURED (CDP Accessibility domain — the computed name a screen reader actually resolves, not an
 * attribute guess): with the settings drawer open, all 4 `slider` nodes had an EMPTY accessible name,
 * while all 38 buttons and both comboboxes were correctly named. A slider announced only as "slider,
 * 1.95" gives a screen-reader user no way to know which reading setting they are changing.
 *
 * The name is taken from the section heading that is ALREADY on screen above the control, so the
 * spoken name matches the visible one by construction. Wiring it through context rather than through
 * a prop is deliberate: it means a slider added later cannot ship unnamed by omission.
 */
const SectionLabel = createContext<string | undefined>(undefined);

function Section({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="rs-sec">
      <div className="rs-sec-head">
        <span className="rs-label">{label}</span>
        {value != null && <span className="rs-value">{value}</span>}
      </div>
      <SectionLabel.Provider value={label}>{children}</SectionLabel.Provider>
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
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  disabled?: boolean;
  lead?: ReactNode;
  trail?: ReactNode;
  /** RAWY-288: only for a slider that is NOT inside a `Section` (it inherits the section label
   *  otherwise — see `SectionLabel`). Never leave both unset: that is what shipped unnamed. */
  ariaLabel?: string;
}) {
  const sectionLabel = useContext(SectionLabel);
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
        aria-label={ariaLabel ?? sectionLabel}
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
// RAWY-278 (fix): `onPreview` is OPTIONAL and only the immersive-boost row passes it. Where it is
// undefined React attaches no handler at all, so every other ToggleRow in this file is byte-identical
// to before — no listener, no cost. It exists because that one control governs an effect that is only
// visible in a state the open drawer cancels (see the CSS note on `[data-bg-imm-preview]`).
function ToggleRow({ label, scope, hint, on, onToggle, sub, disabled, onPreview }: { label: string; scope?: string; hint?: string; on: boolean; onToggle: () => void; sub?: boolean; disabled?: boolean; onPreview?: (v: boolean) => void }) {
  return (
    <button
      className={`rs-toggle-row${sub ? " rs-track-subtoggle" : ""}`}
      onClick={onToggle}
      aria-pressed={on}
      disabled={disabled}
      onPointerEnter={onPreview && (() => onPreview(true))}
      onPointerLeave={onPreview && (() => onPreview(false))}
      onFocus={onPreview && (() => onPreview(true))}
      onBlur={onPreview && (() => onPreview(false))}
    >
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

// RAWY-263 (Layer 1 §6): the owner-facing projection of the local listening record. READ-ONLY, loaded on
// mount only (never during playback — the panel is not open while listening), and gated behind the existing
// diagnostics toggle so it costs nothing in normal reading.
function TtsOutcomesRow() {
  const { t } = useI18n();
  const on = useTts((s) => s.debug);
  const [sum, setSum] = useState<OutcomeSummary | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void listeningOutcomes().then((r) => { if (alive) setSum(r.summary); }).catch(() => {});
    return () => { alive = false; };
  }, [on]);
  if (!on) return null;
  const n = (v: number | null, suffix = "") => (v === null ? "—" : `${v}${suffix}`);
  const rows: [string, string][] = sum
    ? [
        [t("outcomes.sessions"), `${sum.sessions} · ${sum.listeningHours} h`],
        [t("outcomes.continuity"), n(sum.continuityPct, "%")],
        [t("outcomes.interruptions"), `${n(sum.failuresPerHour)} /h · ${n(sum.failureSecPerHour, " s")} /h`],
        [t("outcomes.longest"), sum.longestFailureMs === null ? "—" : `${(sum.longestFailureMs / 1000).toFixed(1)} s`],
        [t("outcomes.expected"), `${sum.expected.count} · ${sum.expected.sec} s`],
        [t("outcomes.unclassified"), `${sum.unclassified.count} · ${sum.unclassified.sec} s`],
        [t("outcomes.firstAudio"), `${n(sum.firstAudioP50Ms, " ms")} · max ${n(sum.firstAudioMaxMs, " ms")}`],
        [t("outcomes.userAction"), `${n(sum.neededActionPer100, "%")} · ${n(sum.endedAcknowledgedPer100, "%")}`],
        [t("outcomes.productionEvents"), n(sum.productionEventsPerHour, " /h")],
      ]
    : [];
  return (
    <div className="rs-outcomes">
      <div className="rs-outcomes-title">{t("outcomes.title")}</div>
      {!sum || sum.sessions === 0 ? (
        <div className="rs-outcomes-empty">{t("outcomes.empty")}</div>
      ) : (
        <>
          {rows.map(([k, v]) => (
            <div className="rs-outcomes-row" key={k}>
              <span className="rs-outcomes-k">{k}</span>
              <span className="rs-outcomes-v">{v}</span>
            </div>
          ))}
          <div className="rs-outcomes-note">{t("outcomes.note")}</div>
        </>
      )}
    </div>
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
  // RAWY-265 (Phase 3) — THE FIFTH AFFECTED GUARD, found during implementation and not in the spec's
  // §6 list of four. It has exactly the same defect as the spotlight and reference-underline guards:
  // it composites the ink against `paper`, and once the page can be translucent that is no longer the
  // surface the text sits on. Left alone it would keep reporting a pair as readable using a ground
  // that is not there. `effectivePaper` returns `paper` UNCHANGED at full opacity, so the default
  // profile's warning behaviour is bit-for-bit what it was.
  const pageOpacity = useBackground((s) => effectivePageOpacity(s));
  const deskScrim = useBackground((s) => currentDeskScrim(s));
  const groundForGuard = effectivePaper(paper, pageOpacity, theme.colors.surfaceBg, deskScrim, ink);
  const readable = contrastIsReadable(ink, groundForGuard);

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
      {/* RAWY-271: discoverability only. Imported fonts already appear in both lists above (RAWY-44),
           but nothing in the book told the reader WHERE they come from. One muted line in the panel's
           existing hint style — deliberately NOT a button and NOT a second import path, so the Fonts
           panel stays the single place a font enters the app. */}
      <div className="rs-sec-hint">{t("type.fontsImportHint")}</div>

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

      {/* ---- REFERENCE INDICATOR (RAWY-281) — the twin rule under a referenced word ---- */}
      <div className="rs-divider" />
      <RefRuleControls style={style} update={update} accent={theme.colors.accent} dark={dark} t={t} />

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
        deskBg={theme.colors.surfaceBg}
      />

      {/* RAWY-257 (Phase 1) / RAWY-255: the diagnostic switch. Last in the tab, under a divider — it is a
          troubleshooting aid, not a reading control, and must not compete with the tracking highlights above. */}
      <div className="rs-divider" />
      <TtsDebugRow label={t("tts.diagnostics")} hint={t("tts.diagnosticsHint")} />
      {/* RAWY-263 (Layer 1 §6): the outcome record must be readable in a NORMAL build — a diagnostic that
          needs developer tooling is not an instrument (the RAWY-255 lesson). Shown only when diagnostics are
          on, so it adds no surface for ordinary reading. */}
      <TtsOutcomesRow />

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
      <ReadingBackgroundSection />
      </>
      )}
    </div>
  );
}
