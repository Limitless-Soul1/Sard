// THE PER-BOOK COLOUR ROW — Default + presets + the app's own picker.
//
// MOVED HERE FROM `ReadingSettings`, unchanged. It was local to that module and used four times
// inside it; the reference controls beside it are now shared with the هيئة editor, and a shared
// component cannot import a private one out of a 1000-line panel without dragging the panel with it
// (and, since the panel imports the controls back, without a cycle). One definition, two importers.

import { InkCustom } from "../../components/InkCustom";
import { BG_NO_OVERLAY, bgOverlayOf } from "../../lib/background";
import type { TKey } from "../../i18n/locales/en";

// RAWY-201: a per-book colour row (Default + presets + native picker), reusing the exact rs-ink swatch
// markup the text-colour control uses — NO new design. `value` is the stored override (null = follow the
// theme); the Default swatch shows the theme's own value and clears the override.
export function ColorRow({
  label,
  value,
  themeValue,
  presets,
  onPick,
  t,
  offerNone = false,
}: {
  label: string;
  value: string | null;
  themeValue: string;
  presets: string[];
  onPick: (v: string | null) => void;
  t: (k: TKey) => string;
  /**
   * Offer "no colour at all" as a third state. TRUE ONLY FOR THE BACKGROUND.
   *
   * The page has no such state and must not be offered one: a book page is a surface text is read
   * on, and "no paper" is not a reading surface — it would put the words straight onto whatever
   * happens to be behind them. The background is the opposite case: there IS something behind it,
   * the reader chose it, and they are entitled to see it untouched.
   */
  offerNone?: boolean;
}) {
  const overlay = bgOverlayOf(value);
  return (
    <>
      <div className="rs-sec-head">
        <span className="rs-label">{label}</span>
      </div>
      <div className="rs-inks">
        <button
          className={`rs-ink${overlay.kind === "theme" ? " on" : ""}`}
          style={{ background: themeValue }}
          onClick={() => onPick(null)}
          title={t("color.default")}
          aria-label={t("color.default")}
        />
        {offerNone && (
          /* NO COLOUR. Drawn as a hollow swatch rather than a filled one, because it is the absence
             of a colour and a filled chip would be a colour standing for no colour. */
          <button
            className={`rs-ink rs-ink-none${overlay.kind === "none" ? " on" : ""}`}
            onClick={() => onPick(BG_NO_OVERLAY)}
            title={t("color.none")}
            aria-label={t("color.none")}
          >
            <span aria-hidden />
          </button>
        )}
        {presets.map((hex) => (
          <button
            key={hex}
            className={`rs-ink${overlay.kind === "colour" && overlay.hex.toLowerCase() === hex.toLowerCase() ? " on" : ""}`}
            style={{ background: hex }}
            onClick={() => onPick(hex)}
            title={hex}
            aria-label={hex}
          />
        ))}
        <InkCustom
          value={value}
          fallback={themeValue}
          onPick={onPick}
          presets={presets}
          title={t("color.custom")}
        />
      </div>
    </>
  );
}
