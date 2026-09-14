// Reading settings — the calm, sectioned slide-over body (RAWY-24), rebuilt to the live
// design's band-D panel. Every control is wired to EXISTING logic (the injectedCss funnel /
// ReadingStyle from RAWY-10/23, the theme store from RAWY-13, i18n from RAWY-12). It is UI
// chrome → inherits the UI direction and uses theme tokens. Replaces the old cramped
// TypographyBar wall-of-buttons; the dev page-turn / book-switcher / status controls are gone.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState,
  type CSSProperties, type ReactNode, useRef, useId } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { InkCustom } from "../../components/InkCustom";
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
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type DiacriticsMode,
  type FlowMode,
  type LatinFont,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { useReader } from "../../reader-engine/store";
import type { TKey } from "../../i18n/locales/en";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, THEME_ORDER, isBuiltinThemeId, resolveTheme, useTheme, type ThemeId } from "../../theme";
import { contrastIsReadable, effectivePaper } from "../../lib/contrast";
import { TtsTrackingControls } from "./TtsTrackingControls"; // RAWY-200
// RAWY-281: the reference twin rule's controls. They live in their own module now, so the هيئة editor
// can render THE READER'S OWN group rather than a copy of it — the arrangement `TtsTrackingControls`
// already has. The colour row went with them, for the same reason.
import { ColorRow } from "./ColorRow";
import { RefRuleControls } from "./RefRuleControls";
import { useTts } from "../../lib/tts"; // RAWY-257 (Phase 1 / RAWY-255): the read-aloud diagnostic toggle
import { familiesOnce, useFonts } from "../../lib/fonts";
// RAWY-265 (Phase 2): the reading DESK background. Constants, store and the presence→scrim mapping
// all live in the module and are shared with the library surface — only the markup differs here.
import {
  BG_BLUR_MAX,
  PAGE_OPACITY_MIN,
  bgOverlayOf,
  bgSrcUrl,
  currentDeskScrim,
  effectivePageOpacity,
  imageLabel,
  presenceMaxFor,
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
  /**
   * THIS BOOK's answer about pronouncing decorative marks, and the هيئة's, so the row can show which
   * one is actually in force. `null` = the book has not been asked and follows the هيئة.
   *
   * Three values rather than a boolean because "no" and "not asked" are different answers: a reader
   * who silences the marks for one book must still be able to hand that book back to their هيئة.
   */
  speakSymbolsOverride?: boolean | null;
  speakSymbolsAppearance?: boolean;
  onSpeakSymbols?: (v: boolean | null) => void;
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
// Two, since «تعتيم» was withdrawn. It goes from HERE as well as from the هيئة editor, and it has to:
// this control writes the same `reading_style` row a هيئة captures, so leaving the third chip in the
// reader would have left the retired answer one gesture away from being saved into a هيئة again.
const DIA: { key: DiacriticsMode; label: TKey }[] = [
  { key: "show", label: "diacritics.show" },
  { key: "hide", label: "diacritics.hide" },
];
const WEIGHT_KEY: Record<number, TKey> = { 400: "weight.normal", 500: "weight.medium", 700: "weight.bold" };

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
  const deskGround = resolveTheme(bookThemeId).colors.surfaceBg;
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
  // The overlay lives in the reading STYLE, not in the background params, so this section has to
  // subscribe to it — the same value the editor reads, through the same function.
  const overlayOff = useReader((st) => bgOverlayOf(st.style?.backgroundColor).kind === "none");
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
            <span className="bg-ctl-name" dir="auto" title={imageLabel(reading.source_name).full}>
              {imageLabel(reading.source_name).label}
            </span>
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
          {/* THE SAME RULE THE EDITOR APPLIES, from the same function. Presence is the strength of
              the colour layer, and «بلا لون» removes that layer — so with no overlay there is
              nothing for this to be the strength OF. Both surfaces read `bgOverlayOf`, so the two
              cannot come to different conclusions about the same stored value. */}
          <Section label={t("gs.bg.presence")} value={localeDigits(String(readingParams.presence), lang)}>
            <Slider
              value={readingParams.presence}
              min={0}
              max={presenceMaxFor("reading")}
              step={1}
              disabled={overlayOff}
              onInput={(v) => setParams("reading", { presence: v })}
            />
          </Section>
          <div className="rs-sec-hint">
            {t(overlayOff ? "gs.bg.presenceNoOverlay" : "gs.bg.presenceHintReading")}
          </div>

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

/**
 * THE NEAREST BOX THAT CAN HOLD A POPOVER WITHOUT CUTTING IT.
 *
 * An absolutely positioned box is clipped by — and counts toward the scrollable height of — any
 * ancestor that both scrolls and is in its containing-block chain. The font list was anchored to its
 * own row, and that row sits inside `.sp-body`, the settings drawer's `overflow-y: auto` scroller.
 * So the drawer cut the list off AND grew its own scroll range by exactly the amount the list hung
 * past the edge — one overflow, seen twice. Walking past every clipping ancestor to the first one
 * that positions but does not clip is what takes the list out of that chain: the drawer is then not
 * in its containing-block chain at all, so it can neither clip it nor count it.
 *
 * Returning null means nothing between here and the body qualified, and the caller falls back to
 * the viewport — correct in this app, where the page itself never scrolls.
 */
function popoverHost(from: HTMLElement | null): HTMLElement | null {
  let n = from?.parentElement ?? null;
  // PAST THE CLIPPER, NOT UP TO IT. The control's own wrapper is positioned and clips nothing, so a
  // walk that takes the first such ancestor stops one step from the trigger and escapes nothing —
  // measured: the list was hung from an 18px-tall box, so it had no room to size itself against and
  // came out at its floor every time, pointing down off the window. Only an ancestor OUTSIDE every
  // clipping box between here and there is out of the chain, so the walk has to pass one first.
  let escaped = false;
  while (n && n !== document.body && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) escaped = true;
    else if (escaped && cs.position !== "static") return n;
    n = n.parentElement;
  }
  return null;
}

/** The scroller the control is riding in, so an open list can follow it or step aside. */
function nearestScroller(from: HTMLElement | null): HTMLElement | null {
  let n = from?.parentElement ?? null;
  while (n && n !== document.documentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
    n = n.parentElement;
  }
  return null;
}

/**
 * A CHOICE, ON SARD'S OWN SURFACE.
 *
 * This was a native `<select>`, and both faults the reader reported came from that one fact.
 *
 * THE OPEN LIST WAS WINDOWS'. `appearance: none` restyles the closed control and nothing else — the
 * popup is drawn by WebView2 in an OS layer no stylesheet reaches. The stylesheet admitted as much:
 * `.rs-select option { color: #1a1a1a }` existed only to keep that white popup legible, which is
 * the single lever CSS has over it. So a reader opening the font list left Sard and stood in a
 * Windows menu, on every theme, over the glass.
 *
 * THE CLOSED CONTROL OVERFLOWED because a `<select>` sizes itself to its LONGEST OPTION rather than
 * to the value it is showing, and as a flex item it defaults to `min-width: auto` — it refuses to
 * shrink below that content. «IBM Plex Sans Arabic» therefore pushed straight through the field's
 * rounded edge. That is why the fix is not a smaller type size: the box was never asked to fit.
 *
 * What replaces it is a button and a list, which is all a select is. The list is `--pap` on a
 * hairline with the panel's own radius and the quiet scrollbar the rest of the chrome uses, so it
 * belongs to the surface that opened it. The value truncates because it is now ordinary text in a
 * box that is allowed to be smaller than it.
 */
function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string; note?: string }[];
  onChange: (k: T) => void;
}) {
  const [open, setOpen] = useState(false);
  /** Where the list fits, measured when it opens rather than assumed. */
  const [place, setPlace] = useState<{ up: boolean; style: CSSProperties }>({ up: false, style: {} });
  /** The box it hangs from — resolved from the tree rather than named. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const id = useId();

  const at = Math.max(0, options.findIndex((o) => o.key === value));
  const current = options[at]?.label ?? String(value);

  /**
   * WHERE IT FITS, MEASURED AGAINST THE BOX IT IS ACTUALLY IN.
   *
   * It used to ask the WINDOW how much room it had, while living inside a 436px scroll box — which
   * is why it sized itself to 268px wherever it stood, and why the drawer then cut it off. Measured
   * at every window size tried: the list hung 48px below `.sp-body` and was sliced there by a hard
   * edge, and that same scroller's `scrollHeight` grew by the same 48px.
   *
   * So it hangs from `popoverHost` — the first ancestor that positions without clipping — and every
   * figure below is read off THAT box. It leaves the scroller's containing-block chain, so it stops
   * being clipped by it and stops enlarging it, and it is sized to the room the drawer really has.
   *
   * `position: fixed` is not the escape it looks like: the drawer carries a `backdrop-filter` AND a
   * `transform`, and either one alone makes it the containing block for its fixed descendants —
   * measured on the running app rather than assumed. A fixed list would resolve against the drawer
   * regardless, while reading as though it resolved against the window. Saying `absolute` against a
   * host we actually looked up says the same thing, truthfully.
   */
  const measure = useCallback(() => {
    const t = trigger.current;
    if (!t) return;
    const h = popoverHost(t);
    const view = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    // TWO BOXES, TWO QUESTIONS, and they are deliberately not the same box.
    //
    // `origin` is the CONTAINING BLOCK — what the offsets below are counted from. It is the drawer,
    // because that is the first thing outside the scroller that can hold the list whole.
    //
    // `room` is where the list is ALLOWED TO BE, and that is the band the rows themselves occupy:
    // escaping the scroller's clipping is the fix, but a list free to cover the drawer's title and
    // tabs would read as having escaped the panel too. Bounded by the rows and clipped by nobody is
    // both of the things this needs to be. Intersected with the window so a drawer that hangs off
    // the screen can never size the list to room it does not have.
    const origin = h ? h.getBoundingClientRect() : view;
    const bounds = nearestScroller(t)?.getBoundingClientRect() ?? origin;
    const top = Math.max(bounds.top, view.top), bottom = Math.min(bounds.bottom, view.bottom);
    const left = Math.max(bounds.left, view.left), right = Math.min(bounds.right, view.right);
    const r = t.getBoundingClientRect();
    const EDGE = 14;   // breathing room off the edge of that room
    const GAP = 7;     // the list's own offset from the trigger
    const WANT = 268;  // the height it would like, if the room is there
    const below = bottom - r.bottom - GAP - EDGE;
    const above = r.top - top - GAP - EDGE;
    const up = below < Math.min(WANT, 200) && above > below;
    // THE LIST IS THE CONTROL'S OWN RECTANGLE, CONTINUED. `r` is the whole selector — the label,
    // the value and the caret — so taking its width and its leading edge makes the two boxes line up
    // exactly, above or below, and makes the popover read as the same control opened rather than a
    // menu that happened to appear near it. Both edges are physical and both come from the same
    // rectangle, so there is no direction to get wrong.
    const style: CSSProperties = {
      position: h ? "absolute" : "fixed",
      maxHeight: Math.max(120, Math.round(Math.min(WANT, up ? above : below))),
      left: Math.round(r.left - origin.left),
      width: Math.round(Math.min(r.width, right - left)),
    };
    if (up) style.bottom = Math.round(origin.bottom - r.top + GAP);
    else style.top = Math.round(r.bottom - origin.top + GAP);
    setHost(h);
    setPlace({ up, style });
  }, []);

  useLayoutEffect(() => { if (open) measure(); }, [open, at, measure]);

  // IT NO LONGER MOVES WITH THE PANEL, because it is no longer inside it — so it is told when the
  // panel moves. And if the row it belongs to scrolls out of the drawer's window there is nothing
  // left to hang from, so the list goes too rather than floating over the panel unattached.
  useEffect(() => {
    if (!open) return;
    const scroller = nearestScroller(trigger.current);
    const again = () => {
      const t = trigger.current;
      if (t && scroller) {
        const r = t.getBoundingClientRect(), b = scroller.getBoundingClientRect();
        if (r.bottom < b.top + 2 || r.top > b.bottom - 2) { setOpen(false); return; }
      }
      measure();
    };
    window.addEventListener("resize", again);
    document.addEventListener("scroll", again, true);
    return () => {
      window.removeEventListener("resize", again);
      document.removeEventListener("scroll", again, true);
    };
  }, [open, measure]);

  // OPENING STARTS AT THE CURRENT CHOICE, which is what a select does and what makes Arrow keys
  // feel like a continuation rather than a reset.
  const show = () => {
    setActive(at);
    // IN THE SAME BATCH AS THE OPEN. Resolving the host in the layout effect instead would paint one
    // frame against the fallback and then move it, which is a flinch on every open.
    setHost(popoverHost(trigger.current));
    setOpen(true);
    // AND TAKE FOCUS. The keys are read on the trigger, so a list opened by a press the button did
    // not receive focus from is a list the keyboard cannot reach — measured: Arrow and Enter went
    // to the document and the selection never moved. Focusing here makes the two ways of opening
    // it arrive in the same state.
    trigger.current?.focus();
  };
  const hide = (refocus = true) => {
    setOpen(false);
    // AFTER THE LIST HAS GONE. Focusing in the same turn as the state change races the unmount —
    // measured on the Escape path, which closed correctly and left focus on the body, so the next
    // key went to the drawer instead of the control the reader was standing in.
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const choose = (k: T) => { onChange(k); hide(); };

  // A press anywhere else closes it. Armed on the next frame so the press that OPENED it — still
  // travelling toward the document — is not read as a press outside.
  useEffect(() => {
    if (!open) return;
    let armed = false;
    const f = requestAnimationFrame(() => { armed = true; });
    const away = (e: PointerEvent) => {
      if (!armed) return;
      const n = e.target as Node;
      // THE LIST IS NOT INSIDE THE CONTROL ANY MORE — it hangs from the drawer — so containment has
      // to be asked of both, or choosing a font reads as a press outside and closes before it lands.
      if (trigger.current?.contains(n) || list.current?.contains(n)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => { cancelAnimationFrame(f); document.removeEventListener("pointerdown", away, true); };
  }, [open]);

  /**
   * Keep the highlighted row in view when the keys walk past the edge of a long list.
   *
   * BY MOVING THE LIST, NOT WHAT IS BEHIND IT. `scrollIntoView` walks every scrollable ancestor, so
   * revealing the current font also scrolled the settings drawer — measured at 1440x900: opening the
   * chooser took the drawer from scrollTop 0 to 179 in the same frame, which is the lurch the reader
   * saw. The list is the only thing that should move here, so it is the only thing moved.
   */
  useEffect(() => {
    if (!open) return;
    const l = list.current;
    const el = l?.querySelector<HTMLElement>(`[data-at="${active}"]`);
    if (!l || !el) return;
    const top = el.offsetTop - l.clientTop;
    const bottom = top + el.offsetHeight;
    if (top < l.scrollTop) l.scrollTop = top;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
  }, [open, active]);

  /**
   * THE SEMANTICS A NATIVE SELECT GAVE FOR FREE, written out.
   *
   * Focus stays on the button and `aria-activedescendant` names the row being walked, rather than
   * moving focus into the list — a listbox that takes focus has to give it back on every exit, and
   * every path that forgets is a trap. There is nothing here to escape from.
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const pick = options[active];
      if (pick) choose(pick.key);
      return;
    }
    if (e.key === "Tab") { setOpen(false); return; }
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      setActive((i) => (i + step + options.length) % options.length);
      return;
    }
    if (e.key === "Home") { e.preventDefault(); setActive(0); }
    if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
  };

  /**
   * ONE SURFACE, NOT A BUTTON SITTING IN A BOX THAT LOOKS LIKE ONE.
   *
   * The rounded rectangle a reader sees IS this row, but only the value inside it used to take the
   * press — so the label, the gap and the caret all looked pressable and did nothing, and the
   * hotspot was visibly smaller than the control. The row carries nothing but this selector's own
   * label and value, so the row is the control: it takes the press, the focus and the keys, and it
   * is the rectangle the list is measured and aligned against.
   */
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="rs-select-row"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-labelledby={`${id}-label`}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={onKey}
      >
        <span className="rs-select-label" id={`${id}-label`}>{label}</span>
        <span className="rs-sel">
          <span className="rs-sel-value">{current}</span>
          {options[at]?.note && <span className="rs-sel-note">{options[at].note}</span>}
          <span className="rs-sel-caret" aria-hidden>▾</span>
        </span>
      </button>
      {/* RENDERED INTO THE HOST, NOT HERE. In the tree it stays the trigger's sibling — React
          keeps events, focus order and `aria-controls` intact across a portal — but in layout it
          becomes a child of the drawer, which is the whole point: out of the scroller's
          containing-block chain, so the scroller can neither cut it nor grow around it. */}
      {open && createPortal(
        <ul
          className={`rs-sel-list${place.up ? " is-up" : ""}`}
          id={`${id}-list`}
          role="listbox"
          ref={list}
          aria-labelledby={`${id}-label`}
          style={place.style}
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${id}-opt-${i}`}
              data-at={i}
              role="option"
              aria-selected={o.key === value}
              className={`rs-sel-opt${o.key === value ? " is-on" : ""}${i === active ? " is-at" : ""}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(o.key)}
            >
              <span className="rs-sel-name">{o.label}</span>
              {/* «مستورد» ON EVERY ROW WAS THE LOUDEST THING IN THE LIST. It was part of the
                  label string, so it sat in the same ink and the same size as the name it
                  qualified and repeated down the whole column — and it rode into the closed
                  control too, where it ate the width the name needed. It says something worth
                  keeping (this face came from the reader's own files, not Sard's), so it stays —
                  as a mark beside the name rather than more of the name. */}
              {o.note && <span className="rs-sel-note">{o.note}</span>}
            </li>
          ))}
        </ul>,
        host ?? document.body,
      )}
    </>
  );
}

export function ReadingSettings({
  style, update, isRtlBook, section = "typography", bookThemeId, onPickTheme,
  speakSymbolsOverride = null, speakSymbolsAppearance = false, onSpeakSymbols,
}: Props) {
  const { t, lang } = useI18n();
  // THE SCOPE SUFFIXES ARE GONE WITH THE SCOPE. They existed to say which of two models a control
  // was writing under — "this book" or "all books" — and there is only one model now: every reading
  // setting is the reader's, once, for every book. A suffix that can only ever say the same thing is
  // not information, and one that still said "this book" would be false.
  // Override-book-colour + hide-chapter-title + hide-first-line stay GLOBAL flags (RAWY-40); the
  // THEME is per-book. RAWY-69 split hide-chapter-title/hide-first-line into two independent flags.
  const { overrideBookColor, hideChapterTitles, hideFirstLine, immersive, setOverride, setHideTitles, setHideFirstLine, setImmersive } = useTheme();
  const customFonts = useFonts((s) => s.custom); // RAWY-44 — imported fonts for the book pickers
  const theme = resolveTheme(bookThemeId);
  // The theme's DISPLAYED name. The sixteen Sard ships are localised (`theme.<id>`); a
  // reader-authored theme carries text the reader typed, which is not translatable and is shown as
  // written — the same rule a Profile's own name follows.
  const themeName = isBuiltinThemeId(theme.id) ? t(`theme.${theme.id}`) : theme.name;
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
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
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
      <div className="rs-sec-title">{t("type.font")}</div>
      <SelectRow<string>
        label={t("type.latin")}
        value={style.latinFont}
        onChange={(k) => update({ latinFont: k })}
        options={[
          ...(Object.keys(LATIN_FONTS) as LatinFont[]).map((k) => ({ key: k, label: LATIN_FONTS[k].label })),
          ...familiesOnce(customFonts).map((c) => ({ key: c.family_name, label: c.family_name, note: t("gs.imported") })),
        ]}
      />
      <SelectRow<string>
        label={t("type.arabic")}
        value={style.arabicFont}
        onChange={(k) => update({ arabicFont: k })}
        options={[
          ...(Object.keys(ARABIC_FONTS) as ArabicFont[]).map((k) => ({ key: k, label: ARABIC_FONTS[k].label })),
          ...familiesOnce(customFonts).map((c) => ({ key: c.family_name, label: c.family_name, note: t("gs.imported") })),
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
            <span className="rs-swatch-name">{t(`theme.${id}`)}</span>
          </button>
        ))}
      </div>

      <div className="rs-divider" />

      {/* ---- TEXT COLOUR (RAWY-40, Band I) — per-book ink within the active theme ---- */}
      <div className="rs-sec-head">
        <span className="rs-label">{t("color.text")}</span>
        <span className="rs-value rs-na">{t("color.within", { theme: themeName })}</span>
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
        <InkCustom
            value={style.textColor}
            fallback={theme.colors.text}
            onPick={(hex) => update({ textColor: hex })}
            presets={presets}
            contrastAgainst={paper}
            title={t("color.custom")}
          />
      </div>
      <div className={`rs-contrast${readable ? "" : " warn"}`}>
        <span aria-hidden>{readable ? "✓" : "⚠"}</span>
        <span>{readable ? t("color.contrastOk") : t("color.contrastWarn", { theme: themeName })}</span>
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
        offerNone
        value={style.backgroundColor}
        themeValue={theme.colors.surfaceBg}
        presets={dark ? BG_PRESETS_DARK : BG_PRESETS_LIGHT}
        onPick={(v) => update({ backgroundColor: v })}
        t={t}
      />

      {/* ---- NUMBER COLOUR — the digits in the book, on their own.
           THE SAME FIELD A PROFILE CARRIES. `numberColor` is a `ReadingStyle` value, so this row and
           the profile editor's «الأرقام» chip are two doors onto one setting rather than two settings
           that have to be kept in step. The reader could already be given one by activating a profile
           and had no way to see or change it here, which is the whole of the gap this closes.
           `null` = the digits inherit the text ink, which is what an untouched book has always done —
           and the paint is a CSS Custom Highlight over ranges the engine registers, so nothing in the
           book's DOM changes and every CFI, highlight, note and read-aloud range is untouched. ---- */}
      <ColorRow
        label={t("color.numbers")}
        value={style.numberColor}
        themeValue={ink}
        presets={presets}
        onPick={(v) => update({ numberColor: v })}
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

      {/* THIS BOOK'S OWN ANSWER, under the هيئة's. The toggle above belongs to the worn هيئة and moves
          every book with it; this row is where ONE book departs from that, and it names which of the
          two is actually in force so the reader is never guessing. Three choices rather than a switch,
          because «لا» and «حسب الهيئة» are different answers and a switch cannot express the way back. */}
      {onSpeakSymbols && (
        <div className="rs-sec">
          <div className="rs-sec-head">
            <span className="rs-label">{t("track.speakSymbolsBook")}</span>
            <span className="rs-value">
              {speakSymbolsOverride == null
                ? t(speakSymbolsAppearance ? "track.speakSymbols.onViaProfile" : "track.speakSymbols.offViaProfile")
                : t(speakSymbolsOverride ? "track.speakSymbols.on" : "track.speakSymbols.off")}
            </span>
          </div>
          <div className="rs-seg">
            {([[null, "track.speakSymbols.follow"], [true, "track.speakSymbols.on"], [false, "track.speakSymbols.off"]] as const)
              .map(([v, key]) => (
                <button
                  key={key}
                  className={`rs-seg-item${speakSymbolsOverride === v ? " on" : ""}`}
                  onClick={() => onSpeakSymbols(v)}
                  aria-pressed={speakSymbolsOverride === v}
                >
                  {t(key)}
                </button>
              ))}
          </div>
          <div className="rs-sec-hint">{t("track.speakSymbolsBookHint")}</div>
        </div>
      )}

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
          hide-title toggles), not typography, so it is NOT wired through `update`. It stays in Layout
          because its two children are functionally inseparable from it; the "all books" suffix it used
          to carry is gone with the scope that made it worth saying. */}
      <ToggleRow
        label={t("type.immersive")}
        hint={t("type.immersiveHint")}
        on={immersive}
        onToggle={() => setImmersive(!immersive)}
      />
      {/* RAWY-212: two sub-toggles gating each element's hide-on-scroll-away independently; dimmed +
          inert while the master is off. The resume hint is intentionally NOT a toggle — it always
          shows in immersive mode (owner revision). */}
      <ToggleRow sub disabled={!immersive} label={t("type.immHidePill")} on={style.immHidePill} onToggle={() => update({ immHidePill: !style.immHidePill })} />
      <ToggleRow sub disabled={!immersive} label={t("type.immHideScrollbar")} on={style.immHideScrollbar} onToggle={() => update({ immHideScrollbar: !style.immHideScrollbar })} />
      {!immersive && <div className="rs-inert">{t("inert.immersiveOff")}</div>}

      </>
      )}

      {section === "allbooks" && (
      <>
      {/* ---- The three flags that act on the book's own content, plus the reading background. They
           are stored outside `ReadingStyle` and were grouped here when the drawer still had two
           scopes, to keep a reader from flipping one while reading "this book only". That contrast is
           gone: every reading setting applies to every book now, so the group's old subtitle — "these
           always apply to every book, not just this one" — would be saying something about a
           distinction that no longer exists. The grouping is kept; the claim is not. ---- */}
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
