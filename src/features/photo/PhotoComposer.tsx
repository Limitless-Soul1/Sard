// Photo Mode composer (RAWY-49, design Band I) — turns a selected passage into a beautiful,
// theme-matched "photo card" the user can Save or Copy. Left = a stage previewing the card
// (scaled to fit); right = controls (card theme "PAPER", FORMAT, SHOW-ON-CARD toggles). The card
// renders at its NATURAL size (export ÷ 2) and rasterises with html-to-image at pixelRatio 2 →
// exact export px; the same node the user sees is the node exported (WYSIWYG). Save writes the
// PNG via the dialog + a tiny Rust command; Copy puts an image/png on the clipboard.

import { useMemo, useRef, useState } from "react";
import { toBlob } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import { useI18n } from "../../i18n";
import { THEMES, THEME_ORDER, type ThemeId } from "../../theme";
import {
  DEFAULT_META,
  EXPORT_RATIO,
  FORMATS,
  formatCardDate,
  formatDims,
  quoteScale,
  type CardData,
  type CardFormat,
  type CardMeta,
} from "./photo";

const STAGE_MAX_W = 520;
const STAGE_MAX_H = 468;

// ---- the card itself (shared by the preview + the export; rendered at natural px) ----
function PhotoCard({
  data,
  meta,
  themeId,
  format,
  lang,
  cardRef,
}: {
  data: CardData;
  meta: CardMeta;
  themeId: ThemeId;
  format: CardFormat;
  lang: string;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const dim = formatDims(format);
  const W = dim.w / EXPORT_RATIO;
  const H = dim.h / EXPORT_RATIO;
  const c = THEMES[themeId].colors;
  const arabic = data.dir === "rtl";
  const bookFont = arabic ? "'Amiri', serif" : "'Literata', serif";
  const metaFont = arabic ? "'Amiri', serif" : "'Inter', sans-serif";
  const s = (n: number) => W * n; // proportional px from the card width
  const qs = quoteScale(data.quote.length);

  const metaBits: string[] = [];
  if (meta.chapter && data.chapterLabel) metaBits.push(data.chapterLabel);
  if (meta.date) metaBits.push(formatCardDate(data.date, lang));

  return (
    <div
      ref={cardRef}
      className="pc-card"
      dir={data.dir}
      style={{
        width: W,
        height: H,
        background: c.paperBg,
        color: c.text,
        padding: `${s(0.11)}px ${s(0.1)}px`,
      }}
    >
      <div className="pc-quotemark" style={{ font: `${arabic ? 700 : 600} ${s(0.15)}px/0 ${bookFont}`, color: c.accent }}>
        {arabic ? "”" : "“"}
      </div>

      <div className="pc-quote-wrap">
        <p
          className="pc-quote"
          style={{
            font: `400 ${s(0.062) * qs}px/${arabic ? 1.9 : 1.6} ${bookFont}`,
            color: c.text,
            textAlign: arabic ? "center" : "start",
          }}
        >
          {data.quote}
        </p>
      </div>

      <div className="pc-foot" style={{ gap: s(0.05) }}>
        <div className="pc-credit" style={{ textAlign: arabic ? "right" : "left" }}>
          <div className="pc-rule" style={{ width: s(0.11), height: Math.max(2, s(0.005)), background: c.accent }} />
          {meta.title && data.bookTitle && (
            <div className="pc-title" style={{ font: `600 ${s(0.041)}px ${bookFont}`, color: c.text }}>
              {data.bookTitle}
            </div>
          )}
          {meta.author && data.author && (
            <div className="pc-author" style={{ font: `400 ${s(0.032)}px ${metaFont}`, color: c.muted, marginTop: s(0.008) }}>
              {data.author}
            </div>
          )}
          {metaBits.length > 0 && (
            <div
              className="pc-meta"
              style={{ font: `500 ${s(0.026)}px ${metaFont}`, color: c.muted, marginTop: s(0.016), letterSpacing: arabic ? 0 : ".06em" }}
            >
              {metaBits.join(" · ")}
            </div>
          )}
        </div>

        {meta.brand && (
          <div className="pc-brand" style={{ gap: s(0.015) }}>
            <img
              src="/assets/sard-bird.png"
              alt=""
              style={{ height: s(0.05), width: "auto", transform: arabic ? "scaleX(-1)" : undefined, opacity: 0.9 }}
            />
            {arabic ? (
              <>
                <span style={{ font: `700 ${s(0.038)}px 'Amiri', serif`, color: c.muted }}>سَرْد</span>
                <span className="pc-brand-div" style={{ background: c.muted, height: s(0.03) }} />
                <span style={{ font: `600 ${s(0.03)}px 'Literata', serif`, color: c.muted }}>Sard</span>
              </>
            ) : (
              <>
                <span style={{ font: `600 ${s(0.032)}px 'Literata', serif`, color: c.muted }}>Sard</span>
                <span className="pc-brand-div" style={{ background: c.muted, height: s(0.03) }} />
                <span style={{ font: `700 ${s(0.038)}px 'Amiri', serif`, color: c.muted }}>سَرْد</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function PhotoComposer({
  data,
  initialThemeId,
  lang,
  onClose,
}: {
  data: CardData;
  initialThemeId: ThemeId;
  lang: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [themeId, setThemeId] = useState<ThemeId>(initialThemeId);
  const [format, setFormat] = useState<CardFormat>("portrait");
  const [meta, setMeta] = useState<CardMeta>(DEFAULT_META);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const dim = formatDims(format);
  const natW = dim.w / EXPORT_RATIO;
  const natH = dim.h / EXPORT_RATIO;
  const scale = useMemo(() => Math.min(STAGE_MAX_W / natW, STAGE_MAX_H / natH), [natW, natH]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1900);
  };

  // WYSIWYG raster: the on-screen card node → PNG bytes at export resolution.
  const rasterize = async (): Promise<Blob> => {
    const node = cardRef.current!;
    await document.fonts.ready;
    const blob = await toBlob(node, {
      pixelRatio: EXPORT_RATIO,
      cacheBust: true,
      backgroundColor: THEMES[themeId].colors.paperBg,
    });
    if (!blob) throw new Error("render produced no image");
    return blob;
  };

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await rasterize();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = await save({ defaultPath: `sard-quote-${stamp}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
      if (path) {
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        await invoke("save_photo_card", { path, data: bytes });
        flash(t("photo.saved"));
      }
    } catch (e) {
      console.error(e);
      flash(t("photo.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await rasterize();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash(t("photo.copied"));
    } catch (e) {
      console.error(e);
      flash(t("photo.copyFail"));
    } finally {
      setBusy(false);
    }
  };

  const dark = THEMES[themeId].dark;

  return (
    <div className="pc-overlay" onPointerDown={onClose}>
      <div className={`pc-modal${dark ? " dark" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
        {/* stage / preview */}
        <div className="pc-stage">
          <div className="pc-stage-label">{FORMATS.find((f) => f.key === format)!.label} · {dim.w}×{dim.h}</div>
          <div className="pc-scale" style={{ width: natW * scale, height: natH * scale }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: natW, height: natH }}>
              <PhotoCard data={data} meta={meta} themeId={themeId} format={format} lang={lang} cardRef={cardRef} />
            </div>
          </div>
          {toast && <div className="pc-toast">{toast}</div>}
        </div>

        {/* controls */}
        <div className="pc-panel">
          <div className="pc-panel-head">
            <button className="pc-close" onClick={onClose} aria-label={t("photo.close")}>✕</button>
          </div>
          <div className="pc-panel-body">
            <div className="pc-panel-title">
              <div className="pc-panel-name">{t("photo.title")}</div>
              <div className="pc-panel-sub">{t("photo.subtitle")}</div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.paper")}</div>
              <div className="pc-swatches">
                {THEME_ORDER.map((id) => (
                  <button
                    key={id}
                    className={`pc-swatch${themeId === id ? " on" : ""}`}
                    style={{ background: THEMES[id].colors.paperBg, color: THEMES[id].colors.text }}
                    onClick={() => setThemeId(id)}
                    title={THEMES[id].name}
                    aria-label={THEMES[id].name}
                  >
                    Aa
                  </button>
                ))}
              </div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.format")}</div>
              <div className="pc-formats">
                {FORMATS.map((f) => (
                  <button key={f.key} className={`pc-format${format === f.key ? " on" : ""}`} onClick={() => setFormat(f.key)}>
                    <span className="pc-format-ico" style={{ aspectRatio: `${f.w} / ${f.h}` }} />
                    <span className="pc-format-label">{t(`fmt.${f.key}`)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.show")}</div>
              <div className="pc-toggles">
                {(["title", "author", "chapter", "date", "brand"] as const).map((k) => (
                  <label key={k} className="pc-toggle">
                    <span>{t(`photo.meta.${k}`)}</span>
                    <button
                      className={`pc-switch${meta[k] ? " on" : ""}`}
                      role="switch"
                      aria-checked={meta[k]}
                      onClick={() => setMeta((m) => ({ ...m, [k]: !m[k] }))}
                    >
                      <span className="pc-knob" />
                    </button>
                  </label>
                ))}
              </div>
            </div>

            <div className="pc-actions">
              <button className="pc-save" onClick={onSave} disabled={busy}>{t("photo.save")}</button>
              <button className="pc-copy" onClick={onCopy} disabled={busy} title={t("photo.copy")}>{t("photo.copy")}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
