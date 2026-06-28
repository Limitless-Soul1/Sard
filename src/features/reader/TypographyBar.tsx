import {
  ARABIC_FONTS,
  type Align,
  type ArabicFont,
  type DiacriticsMode,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";

interface Props {
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  onPrev: () => void;
  onNext: () => void;
  status: string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

const DIA_LABEL: Record<DiacriticsMode, string> = {
  show: "إظهار",
  dim: "تعتيم",
  hide: "إخفاء",
};

export function TypographyBar({ style, update, onPrev, onNext, status }: Props) {
  const cycleDiacritics = () => {
    const order: DiacriticsMode[] = ["show", "dim", "hide"];
    update({ diacritics: order[(order.indexOf(style.diacritics) + 1) % order.length] });
  };

  return (
    <div className="tbar" dir="rtl">
      <button onClick={onNext} title="الصفحة التالية">◀</button>
      <button onClick={onPrev} title="الصفحة السابقة">▶</button>

      <span className="grp" title="حجم الخط (zoom)">
        <button onClick={() => update({ zoom: clamp(r2(style.zoom - 0.1), 0.8, 2.5) })}>A−</button>
        <span className="val">{Math.round(style.zoom * 100)}%</span>
        <button onClick={() => update({ zoom: clamp(r2(style.zoom + 0.1), 0.8, 2.5) })}>A+</button>
      </span>

      <span className="grp">
        <label>الخط</label>
        <select
          value={style.arabicFont}
          onChange={(e) => update({ arabicFont: e.target.value as ArabicFont })}
        >
          {(Object.keys(ARABIC_FONTS) as ArabicFont[]).map((k) => (
            <option key={k} value={k}>
              {ARABIC_FONTS[k].label}
            </option>
          ))}
        </select>
      </span>

      <span className="grp" title="تباعد الأسطر">
        <button onClick={() => update({ lineHeight: clamp(r2(style.lineHeight - 0.1), 1.2, 2.6) })}>↕−</button>
        <span className="val">{style.lineHeight.toFixed(1)}</span>
        <button onClick={() => update({ lineHeight: clamp(r2(style.lineHeight + 0.1), 1.2, 2.6) })}>↕+</button>
      </span>

      <span className="grp" title="الهوامش">
        <button onClick={() => update({ marginPx: clamp(style.marginPx - 12, 0, 160) })}>⇥−</button>
        <span className="val">{style.marginPx}</span>
        <button onClick={() => update({ marginPx: clamp(style.marginPx + 12, 0, 160) })}>⇥+</button>
      </span>

      <button
        onClick={() => update({ align: (style.align === "justify" ? "start" : "justify") as Align })}
        title="المحاذاة"
      >
        {style.align === "justify" ? "مضبوط" : "بداية"}
      </button>

      <button onClick={cycleDiacritics} title="التشكيل">
        تشكيل: {DIA_LABEL[style.diacritics]}
      </button>

      <span className="status" dir="ltr">{status}</span>
    </div>
  );
}
