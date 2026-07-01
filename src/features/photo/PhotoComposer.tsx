// Photo Mode composer (RAWY-49, design Band I) — turns a selected passage into a beautiful,
// theme-matched "photo card" the user can Save or Copy. Left = a stage previewing the card
// (scaled to fit); right = controls (card theme "PAPER", FORMAT, SHOW-ON-CARD toggles). The card
// renders at its NATURAL size (export ÷ 2) and rasterises with html-to-image at pixelRatio 2 →
// exact export px; the same node the user sees is the node exported (WYSIWYG). Save writes the
// PNG via the dialog + a tiny Rust command; Copy puts an image/png on the clipboard.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toBlob } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import { photocardSave } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import { THEMES, THEME_ORDER, type ThemeId } from "../../theme";
import {
  DEFAULT_META,
  EXPORT_RATIO,
  FORMATS,
  formatCardDate,
  formatDims,
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
  const lineH = arabic ? 1.85 : 1.55;

  // The credit "chapter — author" line + the footer row (date + brand). The credit + footer are
  // NATURAL-height siblings of the flex:1 quote area, and the quote area is min-height:0 +
  // overflow:hidden — so the footer details are ALWAYS reserved (RAWY-50 fix: a long quote can no
  // longer push them off the card in Square/Portrait; it's the QUOTE that fits, never the footer).
  const subtitle = [meta.chapter && data.chapterLabel, meta.author && data.author]
    .filter(Boolean)
    .join("  —  ");
  const dateStr = meta.date ? formatCardDate(data.date, lang) : "";
  const hasCredit = (meta.title && data.bookTitle) || subtitle;
  const hasFooter = dateStr || meta.brand;

  // Fit-to-box: pick the LARGEST quote font (within bounds) whose text fits the reserved quote
  // area — short quotes grow large, long quotes shrink to fit (never clipping the footer). Set
  // imperatively so it survives theme re-renders (fontSize is never in the JSX style prop).
  const wrapRef = useRef<HTMLDivElement>(null);
  const pRef = useRef<HTMLParagraphElement>(null);
  const base = s(0.066);
  const metaKey = `${meta.title}${meta.author}${meta.chapter}${meta.date}${meta.brand}`;
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const p = pRef.current;
    if (!wrap || !p) return;
    let lo = base * 0.3; // extreme quotes shrink hard so the footer always survives
    let hi = base * 1.7; // short quotes grow large
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      p.style.fontSize = `${mid}px`;
      if (p.scrollHeight <= wrap.clientHeight) lo = mid;
      else hi = mid;
    }
    p.style.fontSize = `${lo}px`;
    // If it STILL can't fit at the floor (an extreme passage for a small format), read from the
    // TOP so it clips only the tail — never both ends — and the footer stays put.
    wrap.style.alignItems = p.scrollHeight > wrap.clientHeight + 1 ? "flex-start" : "center";
  }, [data.quote, format, metaKey, W, H, arabic, base]);

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
      <div
        className="pc-quotemark"
        style={{ fontFamily: bookFont, fontWeight: arabic ? 700 : 600, fontSize: s(0.15), lineHeight: 0, height: s(0.055), color: c.accent }}
      >
        {arabic ? "”" : "“"}
      </div>

      <div ref={wrapRef} className="pc-quote-wrap">
        <p
          ref={pRef}
          className="pc-quote"
          style={{ fontFamily: bookFont, fontWeight: 400, lineHeight: lineH, color: c.text, textAlign: arabic ? "center" : "start" }}
        >
          {data.quote}
        </p>
      </div>

      {hasCredit && (
        <div className="pc-credit" style={{ textAlign: arabic ? "right" : "left", marginTop: s(0.03) }}>
          <div className="pc-rule" style={{ width: s(0.12), height: Math.max(2, s(0.006)), background: c.accent, marginBottom: s(0.028) }} />
          {meta.title && data.bookTitle && (
            <div className="pc-title" style={{ fontFamily: bookFont, fontWeight: 700, fontSize: s(0.052), color: c.text }}>
              {data.bookTitle}
            </div>
          )}
          {subtitle && (
            <div
              className="pc-subtitle"
              style={{ fontFamily: metaFont, fontWeight: 600, fontSize: s(0.036), color: c.muted, marginTop: s(0.012) }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}

      {hasFooter && (
        <div className="pc-footrow" style={{ marginTop: s(0.038) }}>
          <span style={{ fontFamily: metaFont, fontWeight: 500, fontSize: s(0.03), color: c.muted, letterSpacing: arabic ? 0 : ".02em" }}>
            {dateStr}
          </span>
          {meta.brand ? (
            <div className="pc-brand" style={{ gap: s(0.016) }}>
              <img
                src="/assets/sard-bird.png"
                alt=""
                style={{ height: s(0.052), width: "auto", objectFit: "contain", transform: arabic ? "scaleX(-1)" : undefined, opacity: 0.9 }}
              />
              {arabic ? (
                <>
                  <span style={{ font: `700 ${s(0.044)}px 'Amiri', serif`, color: c.muted }}>سَرْد</span>
                  <span className="pc-brand-div" style={{ background: c.muted, height: s(0.036) }} />
                  <span style={{ font: `700 ${s(0.036)}px 'Literata', serif`, color: c.muted }}>Sard</span>
                </>
              ) : (
                <>
                  <span style={{ font: `700 ${s(0.04)}px 'Literata', serif`, color: c.muted }}>Sard</span>
                  <span className="pc-brand-div" style={{ background: c.muted, height: s(0.036) }} />
                  <span style={{ font: `700 ${s(0.044)}px 'Amiri', serif`, color: c.muted }}>سَرْد</span>
                </>
              )}
            </div>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}

export function PhotoComposer({
  data,
  initialThemeId,
  initialFormat,
  initialMeta,
  editId,
  lang,
  onClose,
}: {
  data: CardData;
  initialThemeId: ThemeId;
  initialFormat?: CardFormat; // RAWY-57: reopen a saved card in the same format…
  initialMeta?: CardMeta;
  editId?: string; // …and re-save over the same card (Edit) instead of creating a new one
  lang: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [themeId, setThemeId] = useState<ThemeId>(initialThemeId);
  const [format, setFormat] = useState<CardFormat>(initialFormat ?? "portrait");
  const [meta, setMeta] = useState<CardMeta>(initialMeta ?? DEFAULT_META);
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

  // Save in app (RAWY-52): rasterise → store the PNG + a photo_cards row so it appears in the
  // Library "Cards" gallery, with its book / chapter / date.
  const onSaveInApp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await rasterize();
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      // Edit (RAWY-57): re-save over the same id (upsert), keeping the original save time; a
      // fresh card gets a new id + now.
      await photocardSave({
        id: editId ?? crypto.randomUUID(),
        bookId: data.bookId ?? null,
        bookTitle: data.bookTitle ?? null,
        author: data.author ?? null,
        chapterLabel: data.chapterLabel ?? null,
        cfi: data.cfi ?? null,
        format,
        themeId,
        quote: data.quote,
        createdAt: editId ? Math.floor(data.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
        data: bytes,
      });
      flash(editId ? t("photo.updatedInApp") : t("photo.savedInApp"));
    } catch (e) {
      console.error(e);
      flash(t("photo.saveFail"));
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

          </div>

          {/* Export actions pinned as a footer (RAWY-56) — always visible, outside the scroll
              body, so Copy · Save · "Save in app" are all reachable without scrolling. */}
          <div className="pc-panel-foot">
            <div className="pc-actions">
              <button className="pc-save" onClick={onSave} disabled={busy}>{t("photo.save")}</button>
              <button className="pc-copy" onClick={onCopy} disabled={busy} title={t("photo.copy")}>{t("photo.copy")}</button>
            </div>
            <button className="pc-saveinapp" onClick={onSaveInApp} disabled={busy}>
              <span className="pc-saveinapp-ico" aria-hidden />
              {t("photo.saveInApp")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
