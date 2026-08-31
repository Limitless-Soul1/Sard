// Photo Mode composer (RAWY-49, design Band I) — turns a selected passage into a beautiful,
// theme-matched "photo card" the user can Save or Copy. Left = a stage previewing the card
// (scaled to fit); right = controls (card STYLE, PAPER, FORMAT, TEXT SIZE, quote font, SHOW-ON-CARD
// toggles). The card renders at its NATURAL size (export ÷ 2) and rasterises with html-to-image at
// pixelRatio 2 → exact export px; the same node the user sees is the node exported (WYSIWYG). Save
// writes the PNG via the dialog + a tiny Rust command; Copy puts an image/png on the clipboard.
//
// RAWY-150 rebuilt the card ADDITIVELY: the original card is the "minimal" style (unchanged); four
// new styles (Moonlit / Gilded / Manuscript / Editorial) ADD alongside it, each recolouring from the
// selected theme's tokens so any style pairs with any of the 16 papers. A TEXT SIZE control adds a
// manual override (XS–XL) beside the original auto-fit — a long passage GROWS the canvas instead of
// being trimmed. DATE and TIME are two independent switches. Everything the editor had is kept.

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toBlob } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";

import { photocardSave, savePhotoCardFile } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { useFonts } from "../../lib/fonts";
import { THEMES, THEME_ORDER, resolveTheme, type ThemeId } from "../../theme";
import { BRAND_ARABIC, BRAND_LATIN, CHROME, displayFace } from "../../lib/typography";

import {
  cardSeparator,
  CARD_STYLES,
  DEFAULT_META,
  EXPORT_RATIO,
  FORMATS,
  formatCardDate,
  formatCardTime,
  formatDims,
  QUOTE_ALIGN_OPTS,
  QUOTE_SPACINGS,
  QUOTE_WEIGHTS,
  spacingLineHeight,
  TEXT_SIZE_FRACTIONS,
  TEXT_SIZE_STEPS,
  type CardData,
  type CardFormat,
  type CardMeta,
  type CardPassage,
  type CardStyle,
  type QuoteAlign,
  type QuoteSpacing,
  type QuoteWeight,
  type TextSize,
} from "./photo";

const STAGE_MAX_W = 520;
const STAGE_MAX_H = 468;

// RAWY-81 (#1): the quote's own font, chosen independently of the book. Keys map to the
// app-document @font-face families (global.css) — the card lives in the app document, not the
// reader iframe. `null` = follow the book's script font (the prior behaviour). Imported fonts
// (RAWY-44) are appended at render time; they're registered as app-document faces by lib/fonts.
const CARD_FONTS: { key: string; label: string; family: string }[] = [
  { key: "literata", label: "Literata", family: "'Literata', serif" },
  { key: "sourceSerif", label: "Source Serif", family: "'SourceSerif4', serif" },
  { key: "amiri", label: "Amiri", family: "'Amiri', serif" },
  { key: "arefRuqaa", label: "Aref Ruqaa", family: "'ArefRuqaa', serif" },
  { key: "inter", label: "Inter", family: "'Inter', sans-serif" },
];

function resolveCardFont(key: string | null, arabic: boolean, custom: { family_name: string }[]): string {
  const bookFont = displayFace(arabic);
  if (!key) return bookFont; // default → the book's script font (unchanged look)
  const builtin = CARD_FONTS.find((f) => f.key === key);
  if (builtin) return builtin.family;
  if (custom.some((c) => c.family_name === key)) return `'${key}', serif`; // an imported family
  return bookFont; // an unknown/removed key → safe fallback
}

// ---- the card itself (shared by the preview + the export; rendered at natural px) ----
function PhotoCard({
  data,
  meta,
  themeId,
  format,
  style,
  textSize,
  quoteWeight,
  quoteSpacing,
  quoteAlign,
  lang,
  quoteFont,
  cardRef,
}: {
  data: CardData;
  meta: CardMeta;
  themeId: ThemeId;
  format: CardFormat;
  style: CardStyle; // RAWY-150: the layout/ornament treatment (recolours from the theme tokens)
  textSize: TextSize; // RAWY-150/154: "auto" fills the fixed card; a preset CAPS the auto-fit size
  quoteWeight: QuoteWeight; // RAWY-154: the quote's font weight (light 300 / regular 400 / bold 700)
  quoteSpacing: QuoteSpacing; // RAWY-154: the quote's line spacing (tight / normal / relaxed)
  quoteAlign: QuoteAlign; // RAWY-154: the quote's alignment ("auto" = the style's built-in default)
  lang: string;
  quoteFont: string; // RAWY-81 (#1): the quote's own resolved CSS font-family (book font by default)
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const dim = formatDims(format);
  const W = dim.w / EXPORT_RATIO;
  const H = dim.h / EXPORT_RATIO;
  const c = resolveTheme(themeId).colors;
  const dark = resolveTheme(themeId).dark; // RAWY-152: the Moonlit style's night ornaments only make sense on dark papers
  const crescentId = `pc-crescent-${useId().replace(/[^a-zA-Z0-9]/g, "")}`; // RAWY-152: unique mask id for the SVG crescent
  const arabic = data.dir === "rtl";
  // A quote card is composed as printed matter, so the QUOTE is display scale. The credit under it
  // is not the book speaking; it is Sard saying where the words came from, which is the chrome face
  // — the same split the reference makes on a typeset cover, whose title is art and whose author
  // line is `var(--ui)`. The credit used to name `Inter`, a SELECTABLE READING face with no role.
  const bookFont = displayFace(arabic);
  const metaFont = CHROME;
  const s = (n: number) => W * n; // proportional px from the card width
  const lineH = spacingLineHeight(quoteSpacing, arabic); // RAWY-154: "normal" = the prior 1.85/1.55
  // A tint of the theme accent — every ornament (rules, borders, glow, stars) rides on this so the
  // whole style recolours with the paper. color-mix is native in the WebView (Chromium).
  const tint = (pct: number) => `color-mix(in srgb, ${c.accent} ${pct}%, transparent)`;

  // Manual size = a preset; the canvas grows to fit rather than shrinking the text (design). Auto
  // (default) keeps the original fit-to-box: the card height is fixed and the QUOTE fits inside it.
  const manual = textSize !== "auto";
  const manualPx = manual ? s(TEXT_SIZE_FRACTIONS[textSize as Exclude<TextSize, "auto">]) : 0;
  const topAlign = style === "editorial"; // Editorial's flush column reads from the top

  // Multi-passage collection (RAWY-60): normalise to a passages list (a single-passage card is one
  // entry — it renders EXACTLY as before). When passages span >1 chapter we drop the footer chapter
  // and give each passage its own small label; when they share a chapter (or there's just one) the
  // book+chapter shows once in the footer (design Band I-IV "metadata rule of thumb").
  const passages: CardPassage[] = data.passages && data.passages.length
    ? data.passages
    : [{ text: data.quote, chapterLabel: data.chapterLabel }];
  const multi = passages.length > 1;
  const chaptersDiffer = multi && new Set(passages.map((p) => (p.chapterLabel ?? "").trim())).size > 1;
  const sep = cardSeparator(themeId);
  const footChapter = chaptersDiffer ? undefined : passages[0]?.chapterLabel ?? data.chapterLabel;

  // The credit "chapter — author" line + the footer row (date + time + brand). RAWY-150 added TIME
  // as a second switch beside DATE; the two combine into one metadata line ("date · time").
  const subtitle = [meta.chapter && footChapter, meta.author && data.author]
    .filter(Boolean)
    .join("  —  ");
  const dateStr = meta.date ? formatCardDate(data.date, lang) : "";
  const timeStr = meta.time ? formatCardTime(data.date, lang) : "";
  const datetime = [dateStr, timeStr].filter(Boolean).join("  ·  ");
  const hasCredit = (meta.title && data.bookTitle) || subtitle;
  const hasFooter = datetime || meta.brand;

  // RAWY-154: AUTO-FIT to the FIXED card. The card ALWAYS keeps its format's aspect ratio (it never
  // grows), and the quote is sized by a binary search to the LARGEST font that fills the reserved
  // quote area without overflow. A manual XS–XL size is a CAP on that fit ("auto" fills maximally up
  // to `base·1.7`); a long passage shrinks toward a low floor so ALL text stays — fixed aspect +
  // keep-all-text via shrinking, never growing the card or trimming. fontSize is set imperatively so
  // it survives theme re-renders (it is never in the JSX style prop).
  const wrapRef = useRef<HTMLDivElement>(null);
  const pRef = useRef<HTMLElement>(null); // the <p> (single) or the collection container (multi)
  const base = s(multi ? 0.06 : 0.066); // a collection starts a touch smaller (more to fit)
  const cap = manual ? manualPx : base * 1.7; // manual = the maximum; auto fills up to this ceiling
  const floor = s(0.012); // a low floor so even a long passage fits (kept, just small — pick a taller format)
  const metaKey = `${meta.title}${meta.author}${meta.chapter}${meta.date}${meta.time}${meta.brand}`;
  const passagesKey = passages.map((p) => `${p.text}|${p.chapterLabel ?? ""}`).join("¶");
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const p = pRef.current;
    if (!wrap || !p) return;
    let lo = floor;
    let hi = Math.max(cap, floor + 1);
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      p.style.fontSize = `${mid}px`;
      if (p.scrollHeight <= wrap.clientHeight) lo = mid;
      else hi = mid;
    }
    p.style.fontSize = `${lo}px`;
    // Absolute last resort — a passage too long to fit even at the floor (essentially unreachable for
    // a selected quote): read from the TOP so it clips only the tail, never both ends.
    const clip = p.scrollHeight > wrap.clientHeight + 1;
    wrap.style.alignItems = topAlign || clip ? "flex-start" : "center";
  }, [passagesKey, format, metaKey, chaptersDiffer, W, H, arabic, cap, floor, style, topAlign, quoteWeight, quoteSpacing, quoteAlign]);

  // The quote block (single <p> or the multi-passage stack), refs attached. `align` is the STYLE's
  // built-in alignment; RAWY-154 lets the user's WEIGHT / LINE-SPACING / ALIGNMENT overrides ride on
  // top (alignment "auto" keeps the style default). The card is fixed-size, so the wrap always
  // clips-guards (overflow:hidden) while the auto-fit keeps everything inside.
  const renderQuote = (align: "center" | "start") => {
    // "auto" alignment follows the style's built-in default; otherwise the user's choice wins.
    const ta: React.CSSProperties["textAlign"] = quoteAlign === "auto" ? align : quoteAlign;
    return (
    <div
      ref={wrapRef}
      className="pc-quote-wrap"
      style={{ overflow: "hidden", alignItems: topAlign ? "flex-start" : "center" }}
    >
      {multi ? (
        <div
          ref={pRef as React.RefObject<HTMLDivElement>}
          className="pc-quote pc-quote-multi"
          style={{ fontFamily: quoteFont, fontWeight: quoteWeight, lineHeight: lineH, color: c.text, textAlign: ta }}
        >
          {passages.map((p, i) => (
            <div key={i} className="pc-passage-block">
              {i > 0 && (
                <div className="pc-sep" style={{ color: c.accent }} aria-hidden>
                  {sep}
                </div>
              )}
              <p className="pc-passage" style={{ fontWeight: quoteWeight }}>
                {p.text}
              </p>
              {chaptersDiffer && meta.chapter && p.chapterLabel && (
                <div
                  className="pc-passage-chapter"
                  style={{
                    fontFamily: metaFont,
                    fontWeight: 600,
                    color: c.muted,
                    letterSpacing: arabic ? 0 : ".1em",
                    textTransform: arabic ? "none" : "uppercase",
                  }}
                >
                  {p.chapterLabel}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p
          ref={pRef as React.RefObject<HTMLParagraphElement>}
          className="pc-quote"
          style={{ fontFamily: quoteFont, fontWeight: quoteWeight, lineHeight: lineH, color: c.text, textAlign: ta }}
        >
          {passages[0].text}
        </p>
      )}
    </div>
    );
  };

  // The Sard brand mark (hoopoe + wordmark), coloured to taste per style.
  const brandRow = (color: string) => (
    <div className="pc-brand" style={{ gap: s(0.016) }}>
      <img
        src="/assets/sard-bird.png"
        alt=""
        style={{ height: s(0.052), width: "auto", objectFit: "contain", transform: arabic ? "scaleX(-1)" : undefined, opacity: 0.9 }}
      />
      {arabic ? (
        <>
          <span style={{ font: `700 ${s(0.044)}px ${BRAND_ARABIC}`, color }}>سَرْد</span>
          <span className="pc-brand-div" style={{ background: color, height: s(0.036) }} />
          <span style={{ font: `700 ${s(0.036)}px ${BRAND_LATIN}`, color }}>Sard</span>
        </>
      ) : (
        <>
          <span style={{ font: `700 ${s(0.04)}px ${BRAND_LATIN}`, color }}>Sard</span>
          <span className="pc-brand-div" style={{ background: color, height: s(0.036) }} />
          <span style={{ font: `700 ${s(0.044)}px ${BRAND_ARABIC}`, color }}>سَرْد</span>
        </>
      )}
    </div>
  );

  const titleEl = (color: string, align: React.CSSProperties["textAlign"]) =>
    meta.title && data.bookTitle ? (
      <div className="pc-title" style={{ fontFamily: bookFont, fontWeight: 700, fontSize: s(0.052), color, textAlign: align }}>
        {data.bookTitle}
      </div>
    ) : null;

  const subtitleEl = (align: React.CSSProperties["textAlign"]) =>
    subtitle ? (
      <div className="pc-subtitle" style={{ fontFamily: metaFont, fontWeight: 600, fontSize: s(0.036), color: c.muted, marginTop: s(0.012), textAlign: align }}>
        {subtitle}
      </div>
    ) : null;

  const datetimeEl = (align: React.CSSProperties["textAlign"]) =>
    datetime ? (
      <span style={{ fontFamily: metaFont, fontWeight: 500, fontSize: s(0.03), color: c.muted, letterSpacing: arabic ? 0 : ".02em", textAlign: align }}>
        {datetime}
      </span>
    ) : null;

  // ---- per-style inner content + padding (the card root + growth behaviour is shared) ----
  let pad = `${s(0.11)}px ${s(0.1)}px`;
  let inner: React.ReactNode;

  if (style === "minimal") {
    // The original card, unchanged — only DATE now shares its footer line with TIME.
    inner = (
      <>
        <div
          className="pc-quotemark"
          style={{ fontFamily: bookFont, fontWeight: arabic ? 700 : 600, fontSize: s(0.15), lineHeight: 0, height: s(0.055), color: c.accent }}
        >
          {arabic ? "”" : "“"}
        </div>
        {renderQuote(arabic ? "center" : "start")}
        {hasCredit && (
          <div className="pc-credit" style={{ textAlign: arabic ? "right" : "left", marginTop: s(0.03) }}>
            <div className="pc-rule" style={{ width: s(0.12), height: Math.max(2, s(0.006)), background: c.accent, marginBottom: s(0.028) }} />
            {titleEl(c.text, arabic ? "right" : "left")}
            {subtitleEl(arabic ? "right" : "left")}
          </div>
        )}
        {hasFooter && (
          <div className="pc-footrow" style={{ marginTop: s(0.038) }}>
            {datetimeEl(undefined) ?? <span />}
            {meta.brand ? brandRow(c.muted) : <span />}
          </div>
        )}
      </>
    );
  } else if (style === "moonlit") {
    // Night sky (RAWY-152): the crescent + glow + stars are the Moonlit style's signature, but they
    // only read as a night sky on a DARK paper — on a light paper they'd be an out-of-place terracotta
    // constellation, so they're GATED to dark papers. A light paper gets the same clean centred layout
    // (gilt rule + centred credit) with no night ornaments, so it never looks broken. The gilt
    // gradient rule (below) stays on every paper.
    const stars = [
      { x: 15, y: 18, r: 0.008, o: 0.9 },
      { x: 27, y: 11, r: 0.005, o: 0.55 },
      { x: 71, y: 12, r: 0.006, o: 0.7 },
      { x: 12, y: 33, r: 0.005, o: 0.5 },
      { x: 88, y: 30, r: 0.007, o: 0.65 },
      { x: 14, y: 72, r: 0.006, o: 0.6 },
      { x: 86, y: 70, r: 0.007, o: 0.7 },
      { x: 24, y: 87, r: 0.005, o: 0.5 },
      { x: 76, y: 88, r: 0.006, o: 0.6 },
    ];
    const d = s(0.15); // crescent size
    inner = (
      <>
        {dark && (
          <>
            <div
              className="pc-deco"
              aria-hidden
              style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 82% 14%, ${tint(26)}, transparent 55%)` }}
            />
            {stars.map((st, i) => (
              <span
                key={i}
                aria-hidden
                style={{ position: "absolute", left: `${st.x}%`, top: `${st.y}%`, width: s(st.r) * 2, height: s(st.r) * 2, borderRadius: "50%", background: c.accent, opacity: st.o }}
              />
            ))}
            {/* RAWY-152: a clean SVG crescent — a TRUE transparent bite (the mask's black circle) so
                the glow shows through the concave side, filled with the theme accent, a soft
                drop-shadow halo. Replaces the RAWY-150 CSS punch-out whose paper-filled disc showed
                as a hard blob over the glow. */}
            <svg
              viewBox="0 0 100 100"
              width={d}
              height={d}
              aria-hidden
              style={{ position: "absolute", top: s(0.075), right: s(0.09), overflow: "visible", filter: `drop-shadow(0 0 ${s(0.03)}px ${tint(60)})` }}
            >
              <defs>
                <mask id={crescentId}>
                  <rect width="100" height="100" fill="#000" />
                  <circle cx="48" cy="52" r="46" fill="#fff" />
                  <circle cx="64" cy="40" r="41" fill="#000" />
                </mask>
              </defs>
              <rect width="100" height="100" fill={c.accent} mask={`url(#${crescentId})`} />
            </svg>
          </>
        )}
        <div className="pc-col">
          <div
            className="pc-quotemark"
            style={{ fontFamily: bookFont, fontWeight: arabic ? 700 : 600, fontSize: s(0.15), lineHeight: 0, height: s(0.055), color: c.accent, textAlign: "center" }}
          >
            {arabic ? "”" : "“"}
          </div>
          {renderQuote("center")}
          {hasCredit && (
            <div className="pc-credit" style={{ textAlign: "center", marginTop: s(0.03) }}>
              <div className="pc-rule" style={{ width: s(0.17), height: Math.max(2, s(0.006)), background: `linear-gradient(90deg, transparent, ${c.accent}, transparent)`, margin: `0 auto ${s(0.028)}px` }} />
              {titleEl(c.text, "center")}
              {subtitleEl("center")}
            </div>
          )}
          {hasFooter && (
            <div className="pc-footcol" style={{ marginTop: s(0.034) }}>
              {datetimeEl("center")}
              {meta.brand && brandRow(c.muted)}
            </div>
          )}
        </div>
      </>
    );
  } else if (style === "gilded") {
    // A double gold frame with four corner marks and a rule-dot-rule divider; the title is gilt.
    pad = `${s(0.14)}px ${s(0.12)}px`;
    const corner = (v: React.CSSProperties): React.CSSProperties => ({ position: "absolute", width: s(0.035), height: s(0.035), ...v });
    inner = (
      <>
        <div aria-hidden style={{ position: "absolute", inset: s(0.05), border: `1.5px solid ${tint(55)}`, borderRadius: s(0.01) }} />
        <div aria-hidden style={{ position: "absolute", inset: s(0.068), border: `1px solid ${tint(30)}`, borderRadius: s(0.008) }} />
        <span aria-hidden style={corner({ top: s(0.052), left: s(0.052), borderTop: `2px solid ${c.accent}`, borderLeft: `2px solid ${c.accent}` })} />
        <span aria-hidden style={corner({ top: s(0.052), right: s(0.052), borderTop: `2px solid ${c.accent}`, borderRight: `2px solid ${c.accent}` })} />
        <span aria-hidden style={corner({ bottom: s(0.052), left: s(0.052), borderBottom: `2px solid ${c.accent}`, borderLeft: `2px solid ${c.accent}` })} />
        <span aria-hidden style={corner({ bottom: s(0.052), right: s(0.052), borderBottom: `2px solid ${c.accent}`, borderRight: `2px solid ${c.accent}` })} />
        <div className="pc-col">
          <div aria-hidden style={{ width: s(0.022), height: s(0.022), background: c.accent, transform: "rotate(45deg)", margin: `0 auto ${s(0.03)}px` }} />
          {renderQuote("center")}
          <div className="pc-divider" style={{ marginTop: s(0.032) }} aria-hidden>
            <span style={{ width: s(0.07), height: 1, background: c.accent }} />
            <span style={{ width: s(0.014), height: s(0.014), borderRadius: "50%", background: c.accent }} />
            <span style={{ width: s(0.07), height: 1, background: c.accent }} />
          </div>
          {hasCredit && (
            <div className="pc-credit" style={{ textAlign: "center", marginTop: s(0.028) }}>
              {titleEl(c.accent, "center")}
              {subtitleEl("center")}
            </div>
          )}
          {hasFooter && (
            <div className="pc-footcol" style={{ marginTop: s(0.03) }}>
              {datetimeEl("center")}
              {meta.brand && brandRow(c.muted)}
            </div>
          )}
        </div>
      </>
    );
  } else if (style === "manuscript") {
    // A double terracotta border, the book title set in a cartouche at the head, and a leaf-finial
    // divider before the colophon — a hand-set, illuminated feel.
    pad = `${s(0.13)}px ${s(0.11)}px`;
    inner = (
      <>
        <div aria-hidden style={{ position: "absolute", inset: s(0.045), border: `1.5px solid ${tint(55)}` }} />
        <div aria-hidden style={{ position: "absolute", inset: s(0.062), border: `1px solid ${tint(30)}` }} />
        <div className="pc-col">
          {meta.title && data.bookTitle && (
            <div className="pc-cartouche-row" aria-hidden={false}>
              <span className="pc-hair" style={{ background: tint(45) }} />
              <span className="pc-cartouche" style={{ background: c.accent, color: c.paperBg, fontFamily: bookFont, fontWeight: 700, fontSize: s(0.04), padding: `${s(0.012)}px ${s(0.03)}px`, borderRadius: s(0.006) }}>
                {data.bookTitle}
              </span>
              <span className="pc-hair" style={{ background: tint(45) }} />
            </div>
          )}
          {renderQuote("center")}
          <div className="pc-divider" style={{ marginTop: s(0.03) }} aria-hidden>
            <span style={{ width: s(0.08), height: 1, background: tint(60) }} />
            <span style={{ width: s(0.02), height: s(0.02), background: c.accent, borderRadius: "0 50% 0 50%", transform: "rotate(45deg)" }} />
            <span style={{ width: s(0.08), height: 1, background: tint(60) }} />
          </div>
          {(subtitle || hasFooter) && (
            <div className="pc-footcol" style={{ marginTop: s(0.026) }}>
              {subtitleEl("center")}
              {datetimeEl("center")}
              {meta.brand && brandRow(c.muted)}
            </div>
          )}
        </div>
      </>
    );
  } else {
    // Editorial: an oversized opening quotation mark, a strong flush column, and the attribution
    // split from the mark along a baseline rule — the most contemporary option.
    inner = (
      <>
        <div
          aria-hidden
          style={{ position: "absolute", top: s(0.02), insetInlineStart: s(0.055), fontFamily: bookFont, fontWeight: 700, fontSize: s(0.34), lineHeight: 0.8, color: tint(22) }}
        >
          {arabic ? "”" : "“"}
        </div>
        <div className="pc-col" style={{ paddingTop: s(0.13) }}>
          {renderQuote("start")}
          {(hasCredit || hasFooter) && (
            <div style={{ marginTop: s(0.03) }}>
              <div className="pc-rule" style={{ width: "100%", height: Math.max(1.5, s(0.004)), background: tint(60), marginBottom: s(0.024) }} />
              <div className="pc-ed-foot">
                <div style={{ textAlign: arabic ? "right" : "left" }}>
                  {titleEl(c.text, arabic ? "right" : "left")}
                  {subtitleEl(arabic ? "right" : "left")}
                </div>
                <div className="pc-ed-meta">
                  {datetimeEl(arabic ? "left" : "right")}
                  {meta.brand && brandRow(c.muted)}
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div
      ref={cardRef}
      className={`pc-card pc-card--${style}`}
      dir={data.dir}
      style={{
        width: W,
        height: H, // RAWY-154: the card ALWAYS keeps its format's fixed size — the quote auto-fits to it
        background: c.paperBg,
        color: c.text,
        padding: pad,
      }}
    >
      {inner}
    </div>
  );
}

export function PhotoComposer({
  data,
  initialThemeId,
  initialFormat,
  initialMeta,
  initialQuoteFont,
  initialCardStyle,
  initialTextSize,
  editId,
  lang,
  onClose,
}: {
  data: CardData;
  initialThemeId: ThemeId;
  initialFormat?: CardFormat; // RAWY-57: reopen a saved card in the same format…
  initialMeta?: CardMeta;
  initialQuoteFont?: string | null; // RAWY-81 (#1): reopen with the card's saved quote font
  initialCardStyle?: CardStyle; // RAWY-150: reopen with the card's style (defaults to minimal)
  initialTextSize?: TextSize; // RAWY-150: reopen with the card's text size (defaults to auto-fit)
  editId?: string; // …and re-save over the same card (Edit) instead of creating a new one
  lang: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [themeId, setThemeId] = useState<ThemeId>(initialThemeId);
  const [format, setFormat] = useState<CardFormat>(initialFormat ?? "portrait");
  const [meta, setMeta] = useState<CardMeta>(initialMeta ?? DEFAULT_META);
  // RAWY-150: the card style + text size, independent of the paper (theme) and the quote font.
  const [cardStyle, setCardStyle] = useState<CardStyle>(initialCardStyle ?? "minimal");
  const [textSize, setTextSize] = useState<TextSize>(initialTextSize ?? "auto");
  // RAWY-154: the quote's own text controls (weight / line spacing / alignment). Defaults reproduce
  // the pre-RAWY-154 look — 400 weight, "normal" spacing, "auto" alignment (each style's default).
  const [quoteWeight, setQuoteWeight] = useState<QuoteWeight>(400);
  const [quoteSpacing, setQuoteSpacing] = useState<QuoteSpacing>("normal");
  const [quoteAlign, setQuoteAlign] = useState<QuoteAlign>("auto");
  // RAWY-81 (#1): the quote's own font key — null means "follow the book font" (unchanged look).
  const [quoteFont, setQuoteFont] = useState<string | null>(initialQuoteFont ?? null);
  const customFonts = useFonts((s) => s.custom);
  const resolvedQuoteFont = resolveCardFont(quoteFont, data.dir === "rtl", customFonts);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const dim = formatDims(format);
  const natW = dim.w / EXPORT_RATIO;
  const natH = dim.h / EXPORT_RATIO;
  // RAWY-152: the preview SCALE is derived from the FORMAT dimensions ONLY (not the measured height).
  // RAWY-150 divided by the measured grown height, which (a) MASKED the text-size change — a bigger
  // font grew the card, so the scale shrank to cancel it, making the CARD (not the text) appear to
  // change [issue 2] — and (b) made two formats that share a width + a content-driven height render
  // identically [issue 4, the "stuck" resize]. A format-based scale gives each format a distinct,
  // stable scale, so a text-size change visibly changes the TEXT and a format change always visibly
  // resizes. `naturalH` (measured) still sizes the scaled WRAPPER so a card that GROWS past its format
  // height gets its full height allocated and the stage scrolls to it (offsetHeight ignores the
  // scale() transform → the true layout height after the fit/grow settles).
  const [naturalH, setNaturalH] = useState(natH);
  const measureKey = `${themeId}|${format}|${cardStyle}|${textSize}|${quoteWeight}|${quoteSpacing}|${quoteAlign}|${JSON.stringify(meta)}|${resolvedQuoteFont}|${data.quote.length}|${(data.passages ?? []).length}`;
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el) setNaturalH(el.offsetHeight);
  }, [measureKey]);
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
      backgroundColor: resolveTheme(themeId).colors.paperBg,
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
        await savePhotoCardFile(path, await blob.arrayBuffer());
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
        // A multi-passage card (RAWY-60) persists its passages so "Edit" restores the full
        // collection; a single-passage card leaves this null and rides on `quote` as before.
        passages: data.passages && data.passages.length > 1 ? JSON.stringify(data.passages) : null,
        quoteFont, // RAWY-81 (#1): persist the chosen quote font so Edit restores it
        createdAt: editId ? Math.floor(data.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
        png: await blob.arrayBuffer(),
      });
      flash(editId ? t("photo.updatedInApp") : t("photo.savedInApp"));
    } catch (e) {
      console.error(e);
      flash(t("photo.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  const dark = resolveTheme(themeId).dark;
  // RAWY-154: which alignment the current style uses by default — so the ALIGNMENT control shows the
  // effective selection while `quoteAlign` is "auto" (mirrors PhotoCard's per-style `align`: Editorial
  // and LTR-Minimal read from the start, every other style centres).
  const styleNaturalAlign: Exclude<QuoteAlign, "auto"> =
    cardStyle === "editorial" || (cardStyle === "minimal" && data.dir !== "rtl") ? "start" : "center";

  // TEXT SIZE stepper: −/+ move through the five presets; either exits auto-fit (starting at M).
  const step = (dir: -1 | 1) => {
    setTextSize((ts) => {
      if (ts === "auto") return "m";
      const i = TEXT_SIZE_STEPS.indexOf(ts as Exclude<TextSize, "auto">);
      const j = Math.min(TEXT_SIZE_STEPS.length - 1, Math.max(0, i + dir));
      return TEXT_SIZE_STEPS[j];
    });
  };

  return (
    <div className="pc-overlay" onPointerDown={onClose}>
      <div className={`pc-modal${dark ? " dark" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
        {/* stage / preview */}
        <div className="pc-stage">
          {/* RAWY-153: show the ACTUAL export size, not the nominal format size. The card WIDTH is
              fixed (dim.w) but its HEIGHT grows to keep all text (RAWY-150/152), so the export is
              dim.w × (naturalH·EXPORT_RATIO); the label now matches what actually exports. */}
          <div className="pc-stage-label">{FORMATS.find((f) => f.key === format)!.label} · {dim.w}×{Math.round(naturalH * EXPORT_RATIO)}</div>
          <div className="pc-scale" style={{ width: natW * scale, height: naturalH * scale }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: natW, height: naturalH }}>
              <PhotoCard
                data={data}
                meta={meta}
                themeId={themeId}
                format={format}
                style={cardStyle}
                textSize={textSize}
                quoteWeight={quoteWeight}
                quoteSpacing={quoteSpacing}
                quoteAlign={quoteAlign}
                lang={lang}
                quoteFont={resolvedQuoteFont}
                cardRef={cardRef}
              />
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
              <div className="pc-panel-sub">
                {data.passages && data.passages.length > 1
                  ? t("photo.subtitleMulti", { n: localeDigits(String(data.passages.length), lang) })
                  : t("photo.subtitle")}
              </div>
            </div>

            {/* RAWY-150: CARD STYLE — the layout treatment, independent of the paper below. */}
            <div className="pc-group">
              <div className="pc-group-label">{t("photo.style")}</div>
              <div className="pc-styles">
                {CARD_STYLES.map((k) => (
                  <button key={k} className={`pc-style${cardStyle === k ? " on" : ""}`} onClick={() => setCardStyle(k)}>
                    {t(`photo.style.${k}`)}
                  </button>
                ))}
              </div>
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
                    title={t(`theme.${id}`)}
                    aria-label={t(`theme.${id}`)}
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

            {/* RAWY-150/154: TEXT SIZE — Auto-fit fills the fixed-aspect card with the largest text
                that fits; an XS–XL preset CAPS that size (smaller/airier) and still shrinks to fit a
                long passage. The card never grows out of aspect and text is never trimmed. */}
            <div className="pc-group">
              <div className="pc-group-label">{t("photo.textSize")}</div>
              <label className="pc-toggle" style={{ marginBottom: 13 }}>
                <span>{t("photo.textSize.auto")}</span>
                <button
                  className={`pc-switch${textSize === "auto" ? " on" : ""}`}
                  role="switch"
                  aria-checked={textSize === "auto"}
                  onClick={() => setTextSize((ts) => (ts === "auto" ? "m" : "auto"))}
                >
                  <span className="pc-knob" />
                </button>
              </label>
              <div className="pc-sizerow">
                <button className="pc-size-step" onClick={() => step(-1)} aria-label={t("photo.textSize.smaller")}>−</button>
                <div className="pc-size-presets">
                  {TEXT_SIZE_STEPS.map((k) => (
                    <button key={k} className={`pc-size-preset${textSize === k ? " on" : ""}`} onClick={() => setTextSize(k)}>
                      {t(`photo.textSize.${k}`)}
                    </button>
                  ))}
                </div>
                <button className="pc-size-step" onClick={() => step(1)} aria-label={t("photo.textSize.larger")}>+</button>
              </div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.quoteFont")}</div>
              <div className="pc-select-wrap">
                <select
                  className="pc-select"
                  value={quoteFont ?? ""}
                  onChange={(e) => setQuoteFont(e.target.value || null)}
                >
                  <option value="">{t("photo.quoteFontDefault")}</option>
                  {CARD_FONTS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                  {customFonts.map((c) => (
                    <option key={c.family_name} value={c.family_name}>
                      {c.family_name} · {t("gs.imported")}
                    </option>
                  ))}
                </select>
                <span className="pc-select-caret" aria-hidden>▾</span>
              </div>
            </div>

            {/* RAWY-154: quote text controls — weight, line spacing, alignment (applied live to the
                quote text, RTL-aware; alignment defaults to each style's built-in look). */}
            <div className="pc-group">
              <div className="pc-group-label">{t("photo.weight")}</div>
              <div className="pc-seg">
                {QUOTE_WEIGHTS.map((w) => (
                  <button
                    key={w}
                    className={`pc-seg-btn${quoteWeight === w ? " on" : ""}`}
                    style={{ fontWeight: w }}
                    onClick={() => setQuoteWeight(w)}
                  >
                    {t(`photo.weight.${w}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.spacing")}</div>
              <div className="pc-seg">
                {QUOTE_SPACINGS.map((sp) => (
                  <button key={sp} className={`pc-seg-btn${quoteSpacing === sp ? " on" : ""}`} onClick={() => setQuoteSpacing(sp)}>
                    {t(`photo.spacing.${sp}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.align")}</div>
              <div className="pc-seg">
                {QUOTE_ALIGN_OPTS.map((a) => (
                  <button
                    key={a}
                    className={`pc-seg-btn${quoteAlign === a || (quoteAlign === "auto" && styleNaturalAlign === a) ? " on" : ""}`}
                    onClick={() => setQuoteAlign(a)}
                  >
                    {t(`photo.align.${a}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="pc-group">
              <div className="pc-group-label">{t("photo.show")}</div>
              <div className="pc-toggles">
                {(["title", "author", "chapter", "date", "time", "brand"] as const).map((k) => (
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
