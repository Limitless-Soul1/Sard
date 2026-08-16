// A paper of your own — two colours, four whole Sards, chosen by eye.
//
// THE DESIGN'S OWN SHAPE (frame 08): a paper, a touch, then "أربعة سَرْدٍ كاملة من هذين اللونين.
// اختر بعينك" — four complete Sards from these two colours, choose by eye.
//
// WHY FOUR AND NOT ONE. Measured across the sixteen shipped themes, the GROUND is derivable from the
// paper (desk sits 0.071 L below it on a light theme, sd 0.011; chrome nearer; both hold its hue to
// within 2.4°) but the INK is not: its hue against the paper varies by 73° of standard deviation and
// spans nearly half the wheel. Moonlit reads warm gold on blue, Espresso cream on brown. So the four
// harmonies are not decoration — they are how the reader supplies the one value no function of the
// paper can produce. See `model/palette.ts` for the full measurement.
//
// NO FREE COLOUR WHEEL, per the design: "Sard's own custom step is a curated grid with a hue strip,
// because the platform picker is unreliable." That is the RAWY-123 pattern the highlight picker
// already uses, and this reuses its shape rather than inventing a second one.

import { useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { SardMini } from "./SardMini";
import { bookFaceCss, miniGlyph } from "./mini";
import { HARMONY_IDS, harmonies, isHex, suggestsDark, type HarmonyId } from "./model/palette";
import { judgePalette } from "./model/guidance";
import type { ProfileTheme } from "./model/profile";
import type { ThemeColors } from "../../theme/tokens";

/** The design's own paper swatches (`paperSw`), plus a dark row so a night paper is reachable. */
const PAPERS_LIGHT = ["#F5EEDD", "#F2E9D8", "#F4E3C8", "#F0F2E8", "#FBF1F1", "#F4F2EA", "#FFFFFF", "#F0E2BE"];
const PAPERS_DARK = ["#222A31", "#1B2130", "#221912", "#15201A", "#221620", "#1C1C1E", "#122023", "#121A2E"];
/** The design's own accent swatches (`accentSw`). */
const ACCENTS = ["#9C5A3C", "#B06A2C", "#4E7A72", "#5E6B7A", "#7A2E1E", "#9A7B3F", "#5E7A52", "#B5727B"];

/** A hue → a paper. Fixed lightness and saturation per polarity, so the strip only moves the hue. */
function paperFromHue(h: number, dark: boolean): string {
  return hsl(h, dark ? 0.2 : 0.28, dark ? 0.11 : 0.93);
}
/** A hue → an accent, at the mid lightness the shipped accents sit around. */
function accentFromHue(h: number): string {
  return hsl(h, 0.45, 0.42);
}

function hsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hx = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** A curated row with a hue strip beneath it — the RAWY-123 shape. */
function ColourRow({
  label,
  swatches,
  value,
  onPick,
  fromHue,
}: {
  label: string;
  swatches: string[];
  value: string;
  onPick: (hex: string) => void;
  fromHue: (h: number) => string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const hueAt = (clientX: number): number => {
    const el = bar.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    // The strip is laid out in the writing direction; read it from its own start edge so it means
    // the same thing in Arabic and English.
    const rtl = getComputedStyle(el).direction === "rtl";
    const t = rtl ? (r.right - clientX) / r.width : (clientX - r.left) / r.width;
    return Math.max(0, Math.min(360, t * 360));
  };

  return (
    <div className="pf-cp-row">
      <div className="pf-field-label">{label}</div>
      <div className="pf-cp-swatches">
        {swatches.map((hex) => (
          <button
            key={hex}
            className={`pf-cp-swatch${value.toLowerCase() === hex.toLowerCase() ? " on" : ""}`}
            style={{ background: hex }}
            onClick={() => onPick(hex)}
            title={hex}
            aria-label={hex}
          />
        ))}
      </div>
      <div
        ref={bar}
        className="pf-cp-hue"
        onPointerDown={(e) => {
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          dragging.current = true;
          onPick(fromHue(hueAt(e.clientX)));
        }}
        onPointerMove={(e) => dragging.current && onPick(fromHue(hueAt(e.clientX)))}
        onPointerUp={(e) => {
          dragging.current = false;
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }}
      />
      <div className="pf-cp-hex" dir="ltr">{value.toUpperCase()}</div>
    </div>
  );
}

export function CustomPaper({
  startFrom,
  initialPaper,
  initialAccent,
  arabicFace,
  name,
  onCancel,
  onApply,
}: {
  /** The name of the theme this started from, shown as "starts from X" per the design. */
  startFrom: string;
  initialPaper: string;
  initialAccent: string;
  arabicFace: string;
  name: string | null;
  onCancel: () => void;
  onApply: (theme: Pick<ProfileTheme, "dark" | "colors">) => void;
}) {
  const { t, lang } = useI18n();
  const [paper, setPaper] = useState(isHex(initialPaper) ? initialPaper : "#F5EEDD");
  const [accent, setAccent] = useState(isHex(initialAccent) ? initialAccent : "#9C5A3C");
  const [chosen, setChosen] = useState<HarmonyId>("calm");

  // Polarity follows the paper. `dark` is still an authored value on the profile — this only
  // SUGGESTS it, which is exactly what `suggestsDark` is for, and it classifies all sixteen shipped
  // papers correctly.
  const dark = suggestsDark(paper);
  const options = harmonies(paper, accent, dark);
  const selected = options.find((h) => h.id === chosen) ?? options[0];
  const verdict = judgePalette(selected.colors);

  const miniFor = (colors: ThemeColors) => ({
    paper: colors.paperBg,
    desk: colors.surfaceBg,
    chrome: colors.chromeBg,
    border: colors.chromeBorder,
    text: colors.text,
    muted: colors.muted,
    accent: colors.accent,
    ink: colors.accent,
    bgImg: "none",
    bgOn: 0,
    scrim: 0,
    blur: "0px",
    trans: 1,
    face: bookFaceCss(arabicFace),
    glyph: miniGlyph(name),
  });

  return (
    <div className="pf-dialog-scrim" onClick={onCancel}>
      <div className="pf-dialog pf-cp" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pf-dialog-title">{t("profiles.theme.custom")}</div>
        {startFrom && <div className="pf-cp-from">{startFrom}</div>}

        <ColourRow
          label={t("profiles.theme.paper")}
          swatches={dark ? PAPERS_DARK : PAPERS_LIGHT}
          value={paper}
          onPick={setPaper}
          fromHue={(h) => paperFromHue(h, dark)}
        />
        {/* Both polarities are reachable: the grid shows one, and the other is one tap away. The
            design's own swatch set is all light; a night paper has to be reachable too. */}
        <button
          className="pf-cp-flip"
          onClick={() => setPaper(dark ? PAPERS_LIGHT[0] : PAPERS_DARK[0])}
        >
          {dark ? t("theme.day") : t("theme.night")}
        </button>

        <ColourRow
          label={t("profiles.theme.touch")}
          swatches={ACCENTS}
          value={accent}
          onPick={setAccent}
          fromHue={accentFromHue}
        />

        <div className="pf-field-label pf-cp-harmony-label">{t("profiles.theme.harmony")}</div>
        <div className="pf-hint pf-cp-harmony-hint">{t("profiles.theme.harmonyHint")}</div>
        <div className="pf-cp-harmonies">
          {HARMONY_IDS.map((id) => {
            const h = options.find((o) => o.id === id)!;
            return (
              <button
                key={id}
                className={`pf-cp-harmony${chosen === id ? " on" : ""}`}
                onClick={() => setChosen(id)}
                aria-pressed={chosen === id}
              >
                <span className="pf-cp-harmony-mini">
                  <SardMini p={miniFor(h.colors)} />
                </span>
                <span className="pf-cp-harmony-name">{t(`profiles.harmony.${id}`)}</span>
                <span className="pf-cp-harmony-note">{t(`profiles.harmony.${id}Note`)}</span>
              </button>
            );
          })}
        </div>

        {/* The measured verdict for the chosen candidate. Every generated theme clears AAA on its own
            page by construction, so this reassures rather than warns — but it is shown as a real
            number, because that is the house rule: report, never merely badge. */}
        <div className={`pf-contrast${verdict.textOnPaper.passes ? "" : " warn"}`}>
          {t(verdict.textOnPaper.passes ? "profiles.contrast.ok" : "profiles.contrast.low", {
            // Through `localeDigits`, which is the project's one funnel for an already-composed
            // numeric string. It normalises to WESTERN digits — `lib/format.ts` pins the UI
            // numbering system to `latn` deliberately, because CLDR's default for `ar` moves
            // between ICU versions and Sard runs on whatever WebView2 is installed.
            ratio: localeDigits(verdict.textOnPaper.ratio.toFixed(1), lang),
          })}
        </div>

        <div className="pf-dialog-actions">
          <button className="pf-btn" onClick={onCancel}>
            {t("profiles.theme.cancel")}
          </button>
          <button
            className="pf-btn primary"
            onClick={() => onApply({ dark, colors: selected.colors })}
          >
            {t("profiles.theme.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
