// The passages tray (RAWY-60, Photo Mode part 2b, design Band I-IV frame 2) — a floating panel,
// opened from the top-bar basket button, listing every collected passage with its chapter label.
// Reorder by drag, remove any, then "Create card · N" composes them all into one multi-passage
// photo card (or Clear the basket). Pinned to the FIXED physical side of the top-bar cluster (D21):
// its position never flips with the UI language; only its labels translate.

import { useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { usePhotoBasket } from "./photoBasket";

export function PhotoBasketTray({
  open,
  onClose,
  onCompose,
}: {
  open: boolean;
  onClose: () => void;
  onCompose: () => void;
}) {
  const { t, lang } = useI18n();
  const passages = usePhotoBasket((s) => s.passages);
  const remove = usePhotoBasket((s) => s.remove);
  const reorder = usePhotoBasket((s) => s.reorder);
  const clear = usePhotoBasket((s) => s.clear);
  const dragFrom = useRef<number | null>(null);
  const [dropTo, setDropTo] = useState<number | null>(null);
  const dir = lang === "ar" ? "rtl" : "ltr";

  if (!open) return null;

  const onDrop = (to: number) => {
    if (dragFrom.current != null) reorder(dragFrom.current, to);
    dragFrom.current = null;
    setDropTo(null);
  };

  return (
    <div className="pc-basket-tray" dir={dir} onPointerDown={(e) => e.stopPropagation()}>
      <div className="pbt-head">
        <div className="pbt-titles">
          <div className="pbt-title">{t("basket.title")}</div>
          <div className="pbt-count">{t("basket.count", { n: localeNum(passages.length, lang) })}</div>
        </div>
        <button className="pbt-close" onClick={onClose} aria-label={t("photo.close")}>✕</button>
      </div>

      <div className="pbt-list">
        {passages.length === 0 && <div className="pbt-empty">{t("basket.empty")}</div>}
        {passages.map((p, i) => (
          <div
            key={p.id}
            className={`pbt-row${dropTo === i ? " drop" : ""}`}
            draggable
            onDragStart={() => (dragFrom.current = i)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dropTo !== i) setDropTo(i);
            }}
            onDragEnd={() => {
              dragFrom.current = null;
              setDropTo(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(i);
            }}
          >
            <span className="pbt-grip" aria-hidden>⠿</span>
            <div className="pbt-body">
              <div className="pbt-text" dir="auto">{p.text}</div>
              {p.chapterLabel && <div className="pbt-chapter" dir="auto">{p.chapterLabel}</div>}
            </div>
            <button className="pbt-remove" onClick={() => remove(p.id)} aria-label={t("basket.remove")}>×</button>
          </div>
        ))}
      </div>

      <div className="pbt-foot">
        <button className="pbt-create" onClick={onCompose} disabled={passages.length === 0}>
          {t("basket.create", { n: localeNum(passages.length, lang) })}
        </button>
        <button className="pbt-clear" onClick={clear} disabled={passages.length === 0}>
          {t("basket.clear")}
        </button>
      </div>
    </div>
  );
}
