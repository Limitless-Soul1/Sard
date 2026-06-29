import { useI18n } from "../../i18n";
import {
  ARABIC_FONTS,
  FONT_WEIGHTS,
  PAGE_WIDTH_DEFAULT,
  PAGE_WIDTH_MAX,
  PAGE_WIDTH_MIN,
  type Align,
  type ArabicFont,
  type DiacriticsMode,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import type { TKey } from "../../i18n/locales/en";
import { THEMES, THEME_ORDER, useTheme } from "../../theme";

interface Props {
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  onPrev: () => void;
  onNext: () => void;
  status: string;
  book: "ar" | "en";
  onBook: (which: "ar" | "en") => void;
  isRtlBook: boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DIA_KEY: Record<DiacriticsMode, TKey> = {
  show: "diacritics.show",
  dim: "diacritics.dim",
  hide: "diacritics.hide",
};
const WEIGHT_KEY: Record<number, TKey> = { 400: "weight.normal", 500: "weight.medium", 700: "weight.bold" };

// Inherits dir from <html> (set by the UI language) — no hard-coded direction.
export function TypographyBar({ style, update, onPrev, onNext, status, book, onBook, isRtlBook }: Props) {
  const { t, lang, setLang } = useI18n();
  const { themeId, overrideBookColor, hideChapterTitles, setTheme, toggleDayNight, setOverride, setHideTitles } =
    useTheme();

  const cycleDiacritics = () => {
    const order: DiacriticsMode[] = ["show", "dim", "hide"];
    update({ diacritics: order[(order.indexOf(style.diacritics) + 1) % order.length] });
  };

  return (
    <div className="tbar">
      <button onClick={onNext} title={t("reader.next")}>◀</button>
      <button onClick={onPrev} title={t("reader.prev")}>▶</button>

      <span className="grp" title={t("type.size")}>
        <button onClick={() => update({ zoom: clamp(r2(style.zoom - 0.1), 0.8, 2.5) })}>A−</button>
        <span className="val">{Math.round(style.zoom * 100)}%</span>
        <button onClick={() => update({ zoom: clamp(r2(style.zoom + 0.1), 0.8, 2.5) })}>A+</button>
      </span>

      <span className="grp">
        <label>{t("type.font")}</label>
        <select value={style.arabicFont} onChange={(e) => update({ arabicFont: e.target.value as ArabicFont })}>
          {(Object.keys(ARABIC_FONTS) as ArabicFont[]).map((k) => (
            <option key={k} value={k}>
              {ARABIC_FONTS[k].label}
            </option>
          ))}
        </select>
      </span>

      <span className="grp" title={t("type.lineSpacing")}>
        <button onClick={() => update({ lineHeight: clamp(r2(style.lineHeight - 0.1), 1.2, 2.6) })}>↕−</button>
        <span className="val">{style.lineHeight.toFixed(1)}</span>
        <button onClick={() => update({ lineHeight: clamp(r2(style.lineHeight + 0.1), 1.2, 2.6) })}>↕+</button>
      </span>

      <span className="grp" title={t("type.margins")}>
        <button onClick={() => update({ marginPx: clamp(style.marginPx - 12, 0, 160) })}>⇥−</button>
        <span className="val">{style.marginPx}</span>
        <button onClick={() => update({ marginPx: clamp(style.marginPx + 12, 0, 160) })}>⇥+</button>
      </span>

      {/* page width / measure (RAWY-21; responsive RAWY-23): a Narrow→Wide fraction */}
      <span className="grp tbar-width" title={t("type.pageWidth")}>
        <label>{t("type.pageWidth")}</label>
        <input
          type="range"
          min={PAGE_WIDTH_MIN}
          max={PAGE_WIDTH_MAX}
          step={0.05}
          value={style.pageWidth ?? PAGE_WIDTH_DEFAULT}
          disabled={style.pageFitWindow ?? false}
          onChange={(e) => update({ pageWidth: Number(e.target.value) })}
          aria-label={t("type.pageWidth")}
        />
        <button
          className={style.pageFitWindow ? "on" : ""}
          onClick={() => update({ pageFitWindow: !style.pageFitWindow })}
          title={t("type.matchWindow")}
        >
          {t("type.matchWindow")}
        </button>
      </span>

      <button
        onClick={() => update({ align: (style.align === "justify" ? "start" : "justify") as Align })}
        title={t("type.align")}
      >
        {style.align === "justify" ? t("type.alignJustify") : t("type.alignStart")}
      </button>

      <button onClick={cycleDiacritics} title={t("type.diacritics")}>
        {t("type.diacritics")}: {t(DIA_KEY[style.diacritics])}
      </button>

      {/* text features (RAWY-23) — weight / paragraph spacing / indent / tracking, via the funnel */}
      <span className="grp" title={t("type.weight")}>
        <label>{t("type.weight")}</label>
        {FONT_WEIGHTS.map((w) => (
          <button
            key={w}
            className={style.fontWeight === w ? "on" : ""}
            style={{ fontWeight: w }}
            onClick={() => update({ fontWeight: w })}
          >
            {t(WEIGHT_KEY[w])}
          </button>
        ))}
      </span>

      <span className="grp" title={t("type.paraSpacing")}>
        <label>{t("type.paraSpacing")}</label>
        <button onClick={() => update({ paragraphSpacing: clamp(style.paragraphSpacing - 4, 0, 28) })}>¶−</button>
        <span className="val">{style.paragraphSpacing}</span>
        <button onClick={() => update({ paragraphSpacing: clamp(style.paragraphSpacing + 4, 0, 28) })}>¶+</button>
      </span>

      <button
        className={style.firstLineIndent ? "on" : ""}
        onClick={() => update({ firstLineIndent: !style.firstLineIndent })}
        title={t("type.indent")}
      >
        {t("type.indent")}
      </button>

      <span className="grp" title={t("type.tracking")}>
        <label>{t("type.tracking")}</label>
        <button disabled={isRtlBook} onClick={() => update({ letterSpacing: clamp(r2(style.letterSpacing - 0.5), 0, 3) })}>A‹›−</button>
        <span className="val">{isRtlBook ? t("type.latinOnly") : style.letterSpacing}</span>
        <button disabled={isRtlBook} onClick={() => update({ letterSpacing: clamp(r2(style.letterSpacing + 0.5), 0, 3) })}>A‹›+</button>
      </span>

      {/* dev-only book switcher (proves UI/book direction independence; not a product feature) */}
      <span className="grp">
        <button className={book === "ar" ? "on" : ""} onClick={() => onBook("ar")} title={t("book.arabicSample")}>ع</button>
        <button className={book === "en" ? "on" : ""} onClick={() => onBook("en")} title={t("book.englishSample")}>EN</button>
      </span>

      {/* theme controls (RAWY-13) — app-wide: swatches + day/night */}
      <span className="grp" title={t("theme.label")}>
        {THEME_ORDER.map((id) => (
          <button
            key={id}
            className={`swatch${themeId === id ? " on" : ""}`}
            style={{ background: THEMES[id].colors.paperBg }}
            onClick={() => setTheme(id)}
            title={THEMES[id].name}
          />
        ))}
        <button onClick={toggleDayNight} title={t("theme.dayNight")}>{THEMES[themeId].dark ? "☀" : "☾"}</button>
      </span>
      <button className={overrideBookColor ? "on" : ""} onClick={() => setOverride(!overrideBookColor)} title={t("theme.override")}>🎨</button>
      <button className={hideChapterTitles ? "on" : ""} onClick={() => setHideTitles(!hideChapterTitles)} title={t("theme.hideTitles")}>Ⓣ</button>

      {/* change the UI language later (scope: a simple settings control) */}
      <button onClick={() => setLang(lang === "ar" ? "en" : "ar")} title={t("settings.language")}>
        🌐 {lang === "ar" ? "English" : "العربية"}
      </button>

      <span className="status">{status}</span>
    </div>
  );
}
