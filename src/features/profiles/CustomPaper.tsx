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

import { useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { SardMini } from "./SardMini";
import { bookFaceCss, miniGlyph } from "./mini";
import { HARMONY_IDS, harmonies, isHex, suggestsDark, type HarmonyId } from "./model/palette";
import { judgePalette } from "./model/guidance";
import { ColorPicker } from "../../components/ColorPicker";
import type { ProfileTheme } from "./model/profile";
import type { ThemeColors } from "../../theme/tokens";
import { useDialog } from "../../components/useDialog";

/** The design's own paper swatches (`paperSw`), plus a dark row so a night paper is reachable. */
export const PAPERS_LIGHT = ["#F5EEDD", "#F2E9D8", "#F4E3C8", "#F0F2E8", "#FBF1F1", "#F4F2EA", "#FFFFFF", "#F0E2BE"];
export const PAPERS_DARK = ["#222A31", "#1B2130", "#221912", "#15201A", "#221620", "#1C1C1E", "#122023", "#121A2E"];
/** The design's own accent swatches (`accentSw`). */
export const ACCENTS = ["#9C5A3C", "#B06A2C", "#4E7A72", "#5E6B7A", "#7A2E1E", "#9A7B3F", "#5E7A52", "#B5727B"];

/**
 * A labelled row: the curated swatches as PRESETS, and the whole colour space under them.
 *
 * WHAT THIS REPLACED. The row used to be swatches plus a hue strip whose output went through
 * `paperFromHue`/`accentFromHue` — functions that pin saturation and lightness to constants. Sweeping
 * it moved the hue and nothing else, so the reachable set was 8 swatches and one ring of tints, and
 * the hex beside it was a read-only `<div>`: a reader who wanted `#5E7A52` had no way to say so. The
 * swatches are still here and still one tap, which is what the design wanted them for; they are now
 * a starting point rather than the boundary.
 */
function ColourRow({
  label,
  swatches,
  value,
  onPick,
  contrastAgainst,
}: {
  label: string;
  swatches: string[];
  value: string;
  onPick: (hex: string) => void;
  contrastAgainst?: string;
}) {
  return (
    <div className="pf-cp-row">
      <div className="pf-field-label">{label}</div>
      <ColorPicker
        value={value}
        onChange={onPick}
        presets={swatches}
        contrastAgainst={contrastAgainst}
      />
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

  const dlg = useDialog({ onDismiss: onCancel });

  return (
    <div className="pf-dialog-scrim" onClick={onCancel}>
      <div className="pf-dialog pf-cp" onClick={(e) => e.stopPropagation()} ref={dlg.ref} {...dlg.props}>
        <div className="pf-dialog-title" id={dlg.titleId}>{t("profiles.theme.custom")}</div>
        {startFrom && <div className="pf-cp-from">{startFrom}</div>}

        <ColourRow
          label={t("profiles.theme.paper")}
          swatches={dark ? PAPERS_DARK : PAPERS_LIGHT}
          value={paper}
          onPick={setPaper}
          contrastAgainst={selected.colors.text}
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
          contrastAgainst={paper}
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
