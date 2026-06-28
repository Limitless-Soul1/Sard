import { useI18n } from "../../i18n";
import {
  ARABIC_FONTS,
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
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DIA_KEY: Record<DiacriticsMode, TKey> = {
  show: "diacritics.show",
  dim: "diacritics.dim",
  hide: "diacritics.hide",
};

// Inherits dir from <html> (set by the UI language) — no hard-coded direction.
export function TypographyBar({ style, update, onPrev, onNext, status, book, onBook }: Props) {
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

      <button
        onClick={() => update({ align: (style.align === "justify" ? "start" : "justify") as Align })}
        title={t("type.align")}
      >
        {style.align === "justify" ? t("type.alignJustify") : t("type.alignStart")}
      </button>

      <button onClick={cycleDiacritics} title={t("type.diacritics")}>
        {t("type.diacritics")}: {t(DIA_KEY[style.diacritics])}
      </button>

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
