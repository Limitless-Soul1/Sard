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

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toBlob } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";

import { photocardSave, savePhotoCardFile } from "../../lib/ipc";
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { familiesOnce, useFonts } from "../../lib/fonts";
import { THEME_ORDER, resolveTheme, type ThemeId } from "../../theme";
import { BRAND_ARABIC, BRAND_LATIN, CHROME, displayFace } from "../../lib/typography";
import {
  brandBand, COMPOSITION_VERSION, formatSize, GROUND_SCALE_MAX, GROUND_SCALE_MIN, referencedAssets,
  serializeComposition, type Composition, type TextElement,
} from "./composition";
import { OVERLAY_HOST_CLASS } from "../library/design/overlay";
import { useDialog, useScrimDismiss } from "../../components/useDialog";
import { inspectorFits } from "./workspace";
import { ElementsLayer, GroundLayer, type AssetUrl } from "./CardLayers";
import { CardToolbar } from "./CardToolbar";
import { ScrubField } from "./ScrubField";
import { SliderField } from "./SliderField";
import { ObjectsStrip } from "./ObjectsStrip";
import {
  addRoleLaidOut, applyComposition, seedComposition, type CompositionId, type RoleText,
} from "./compositions";
import { defaultRectFor, defaultStyleFor, quoteRegion } from "./autoLayout";
import { CardOverlay } from "./CardOverlay";
import { FlipRow, Inspector } from "./Inspector";
import { Picker } from "./Picker";
import {
  addElement, bringForward, bringToFront, findElement, isText, makeImage, MIN_SIZE, moveBy, removeElement, resizeBy, sendBackward, sendToBack, setHidden, setPlacement, updateImage,
  updateStyle, updateText, type ResizeGrip,
} from "./elements";
import { backgroundsList, photocardStageImage, type BackgroundRow } from "../../lib/ipc";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  liftedParts, newId, presetHidden, type BrandAlign, type BrandVariant,
  type CardElement, type Ground, type PresetPart, type Rect, type TextStyle,
} from "./composition";

import {
  cardSeparator,
  DEFAULT_META,
  EXPORT_RATIO,
  formatCardDate,
  formatCardTime,
  formatDims,
  spacingLineHeight,
  TEXT_SIZE_FRACTIONS,
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

/**
 * THE LITERARY ROLES — the parts a card from a book is made of.
 *
 * They are not a menu of things to create: every one of them is already ON the card, drawn by the
 * preset. The rail's menu ticks them on and off, and ticking one on hands back the element that was
 * already there. A custom card has none of them, and nothing here invents one.
 */
const LITERARY_ROLES = [
  { part: "quote" as const, label: "photo.el.quote" as const, hint: "photo.role.quoteHint" as const },
  { part: "title" as const, label: "photo.add.title" as const, hint: "photo.role.titleHint" as const },
  { part: "chapter" as const, label: "photo.add.chapter" as const, hint: "photo.role.chapterHint" as const },
  { part: "author" as const, label: "photo.add.author" as const, hint: "photo.role.authorHint" as const },
  { part: "attribution" as const, label: "photo.el.attribution" as const, hint: "photo.role.attrHint" as const },
];

/**
 * WHERE THE MARK SITS ALONG THE FOOT — three places, drawn as the alignment they are.
 *
 * Physical, because the user is pointing at a picture: "left" has to mean the left of the card they
 * are looking at, whichever way its words run.
 */
const BRAND_PLACES = [
  { v: "left" as const, label: "photo.brand.left" as const, title: "photo.brand.left" as const, path: "M3 3v12M7 6h11M7 12h7" },
  { v: "center" as const, label: "photo.brand.centre" as const, title: "photo.brand.centre" as const, path: "M12 2v14M5 6h14M8 12h8" },
  { v: "right" as const, label: "photo.brand.right" as const, title: "photo.brand.right" as const, path: "M21 3v12M6 6h11M10 12h7" },
];

/** The three forms the mark takes, in the order the rail offers them. */
const BRAND_FORMS = [
  { v: "lockup" as const, label: "photo.brand.full" as const, title: "photo.brand.fullLong" as const },
  { v: "wordmark" as const, label: "photo.brand.word" as const, title: "photo.brand.wordLong" as const },
  { v: "bird" as const, label: "photo.brand.bird" as const, title: "photo.brand.birdLong" as const },
];

/**
 * A COMPOSITION IS ALSO A SKIN.
 *
 * The four compositions arrange a card's elements; the five preset styles draw the card underneath
 * them — the ornaments, the rules, the cartouche. They are the same four ideas seen from two sides,
 * so choosing a composition chooses both, and a card saved before elements existed (which has no
 * elements to arrange) still visibly changes when one is picked.
 */
const COMP_STYLE: Record<CompositionId, CardStyle> = {
  calm: "minimal",
  manuscript: "manuscript",
  gilded: "gilded",
  night: "moonlit",
};

/** Add a delta and keep it inside ±limit. */
const clamp01 = (base: number, delta: number, limit: number) =>
  Math.min(limit, Math.max(-limit, base + delta));

const STAGE_MAX_W = 700;
const STAGE_MAX_H = 640;


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
  composition,
  onNeedsRoom,
  assetUrl,
  editingId,
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
  /** The document. Its ground draws behind the preset, its elements draw over it. */
  composition: Composition;
  /** Told when a manually sized text needs more room than its box gives it. */
  onNeedsRoom?: (id: string, needed: number) => void;
  assetUrl: AssetUrl;
  /** The element being typed into, which the editor draws instead. */
  editingId?: string | null;
}) {
  // The DOCUMENT's canvas, not the format's: a card whose width and height were typed by hand is
  // still that format, and asking the format for its size would quietly draw the old one.
  const W = composition.canvas.w / EXPORT_RATIO;
  const H = composition.canvas.h / EXPORT_RATIO;
  const c = resolveTheme(themeId).colors;
  // A paper the user typed a colour for beats the theme's. The ink and every ornament still come
  // from the theme, which is what keeps a custom paper a PAPER rather than a whole new palette.
  const paperBg = composition.ground.kind === "theme" && composition.ground.paper
    ? composition.ground.paper
    : c.paperBg;
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
  const lifted = liftedParts(composition);
  const partStyle = (part: PresetPart): React.CSSProperties =>
    presetHidden(lifted, part) ? { visibility: "hidden" } : {};
  /**
   * WHAT THE PRESET STILL HAS TO DRAW.
   *
   * A lifted part is an element now, placed by the composition rather than by flow. The block that
   * framed it — a rule, a diamond, a pair of hairlines — has nothing left to introduce, and leaving
   * it behind is not decoration but debris: it stays where flow put it and lands on top of whatever
   * replaced it. Both of those were photographed on a seeded card before this existed.
   */
  const showTitle = !!(meta.title && data.bookTitle) && !presetHidden(lifted, "title");
  const showSubtitle = !!subtitle && !presetHidden(lifted, "subtitle");
  const hasCredit = showTitle || showSubtitle;
  // The mark is no longer part of the footer FLOW, so it no longer decides whether there is one.
  const hasFooter = !!datetime;

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
  // A LIFTED PART IS HIDDEN, NOT REMOVED.
  //
  // `visibility: hidden` keeps the node's box, so the rule, the credit and the wordmark below it do
  // not slide up the instant the user clicks the quote. The free element is drawn at the measured
  // position of this very node, so the card does not move a pixel — it simply becomes editable.

  const renderQuote = (align: "center" | "start") => {
    // "auto" alignment follows the style's built-in default; otherwise the user's choice wins.
    const ta: React.CSSProperties["textAlign"] = quoteAlign === "auto" ? align : quoteAlign;
    return (
    <div
      ref={wrapRef}
      className="pc-quote-wrap"
      style={{ overflow: "hidden", alignItems: topAlign ? "flex-start" : "center", ...partStyle("quote") }}
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
  /**
   * THE MARK, IN THE CARD'S CORNER.
   *
   * It used to be the last cell of the preset's footer ROW, which meant it moved with the flow: it
   * slid as the credit came and went, and on a card whose credit had been lifted into elements it
   * ended up sharing a band with the author line. A mark is not a paragraph. It sits at one place on
   * the card, at one size, and it is not draggable — the reference states that outright, and it is
   * also what stops it colliding with a composition that knows nothing about it.
   *
   * The lockup keeps its own direction (`ltr`) in both languages: it is a piece of artwork, not a
   * sentence, and reversing it would produce a wordmark nobody drew. Which SIDE it sits on follows
   * the card, because that is the corner the eye leaves from.
   */
  /**
   * The mark's family list: the reader's choice first, Sard's own behind it.
   *
   * The fallback is not politeness — it is what keeps the lockup whole. A Latin-only family chosen
   * for «Sard» has nothing to draw «سَرْد» with, and without Sard's own face behind it the Arabic
   * half would land in whatever the browser reaches for last.
   */
  const brandFamily = (chosen: string | null | undefined, fallback: string) =>
    // VERBATIM, NOT QUOTED. A choice from this list is already a CSS font-family VALUE — the card's
    // own faces arrive as `var(--ar-font)` and the like — so wrapping it in quotes makes it a
    // literal family name that does not exist, and the mark silently keeps the face it had.
    // Measured: choosing «Arabic» set `"var(--ar-font)"` and changed nothing on the card.
    chosen ? `${chosen}, ${fallback}` : fallback;

  const brandMark = (color: string) => {
    if (!meta.brand) return null;
    const p = composition.preset;
    const v = p.brandVariant ?? "lockup";
    const place = p.brandAlign ?? (arabic ? "right" : "left");
    const bs = s(p.brandSize ?? 0.036);
    const inset = s(0.075);
    // A position the user set wins; without one the mark sits in the corner it always did.
    const placed = p.brandPos
      ? { left: `${p.brandPos.x * 100}%`, top: `${p.brandPos.y * 100}%` }
      : {
          bottom: s(0.045),
          ...(place === "center"
            ? { left: "50%", transform: "translateX(-50%)" }
            : place === "right" ? { right: inset } : { left: inset }),
        };
    return (
      <div
        className="pc-brandmark"
        aria-hidden
        style={{
          position: "absolute",
          ...placed,
          gap: bs * 0.42,
          opacity: p.brandOpacity ?? 0.78,
        }}
      >
        {v !== "wordmark" && (
          <img
            src="/assets/sard-bird.png"
            alt=""
            style={{ height: bs * 1.55, width: "auto", objectFit: "contain", flex: "none" }}
          />
        )}
        {v !== "bird" && (
          <>
            {/* THE MARK'S FACE IS A PROPERTY, not a constant baked into this line.
                It was `BRAND_LATIN` and `BRAND_ARABIC` — two hard-coded tokens that resolved to the
                INTERFACE font, so the one piece of type on the card that could not be changed was
                the one belonging to the card's own maker. A chosen family sets both halves and
                falls back to Sard's own; the sizes, the gap and the divider are still measured from
                `brandSize`, so choosing a face moves nothing. */}
            <span style={{ font: `600 ${bs}px ${brandFamily(p.brandFont, BRAND_LATIN)}`, color, letterSpacing: "0.01em" }}>Sard</span>
            <span className="pc-brand-div" style={{ background: color, height: bs * 1.05 }} />
            <span style={{ font: `400 ${bs * 1.24}px ${brandFamily(p.brandFont, BRAND_ARABIC)}`, color, transform: `translateY(${-bs * 0.06}px)` }}>سَرْد</span>
          </>
        )}
      </div>
    );
  };

  const titleEl = (color: string, align: React.CSSProperties["textAlign"]) =>
    meta.title && data.bookTitle ? (
      <div className="pc-title" style={{ fontFamily: bookFont, fontWeight: 700, fontSize: s(0.052), color, textAlign: align, ...partStyle("title") }}>
        {data.bookTitle}
      </div>
    ) : null;

  const subtitleEl = (align: React.CSSProperties["textAlign"]) =>
    subtitle ? (
      <div className="pc-subtitle" style={{ fontFamily: metaFont, fontWeight: 600, fontSize: s(0.036), color: c.muted, marginTop: s(0.012), textAlign: align, ...partStyle("subtitle") }}>
        {subtitle}
      </div>
    ) : null;

  const datetimeEl = (align: React.CSSProperties["textAlign"]) =>
    datetime ? (
      <span style={{ fontFamily: metaFont, fontWeight: 500, fontSize: s(0.03), color: c.muted, letterSpacing: arabic ? 0 : ".02em", textAlign: align }}>
        {datetime}
      </span>
    ) : null;

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

  /**
   * THE STYLE'S OWN ORNAMENT, kept apart from the book's furniture.
   *
   * These are the parts of a composition that belong to the CARD rather than to a quotation:
   * the ruled borders, the night sky. They carry no text and assume no provenance, so they
   * are drawn whether or not there is a book behind the card.
   *
   * They used to live inside each style's content block, which is switched off wholesale for a
   * custom card - so choosing a composition for a blank card changed a class name and nothing
   * else. Measured: pressing all four moved not one pixel of the card.
   */
  // CALM IS THE UNORNAMENTED ONE, which on a card with no book behind it left nothing at all to
  // see: choosing it looked exactly like choosing nothing. Its signature in a book card is the
  // opening quotation mark, drawn in the flow above the passage — so a custom card gets that same
  // mark, set in the corner where the composition would have put it. It is a piece of typography,
  // not a fact about a book: it invents no title, no author and no provenance.
  const calmMark = composition.custom && style === "minimal" ? (
    <div
      className="pc-quotemark"
      aria-hidden
      style={{
        position: "absolute", insetBlockStart: s(0.085), insetInlineStart: s(0.095),
        fontFamily: bookFont, fontWeight: arabic ? 700 : 600, fontSize: s(0.15),
        lineHeight: 0.7, color: c.accent, opacity: 0.9,
      }}
    >
      {arabic ? "”" : "“"}
    </div>
  ) : null;

  const frame: React.ReactNode =
    style === "moonlit" ? (
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
      </>
    ) : style === "gilded" ? (
      <>
          <div aria-hidden style={{ position: "absolute", inset: s(0.05), border: `1.5px solid ${tint(55)}`, borderRadius: s(0.01) }} />
          <div aria-hidden style={{ position: "absolute", inset: s(0.068), border: `1px solid ${tint(30)}`, borderRadius: s(0.008) }} />
      </>
    ) : style === "manuscript" ? (
      <>
          <div aria-hidden style={{ position: "absolute", inset: s(0.045), border: `1.5px solid ${tint(55)}` }} />
          <div aria-hidden style={{ position: "absolute", inset: s(0.062), border: `1px solid ${tint(30)}` }} />
      </>
    ) : null;

  // ---- per-style inner content + padding (the card root + growth behaviour is shared) ----
  let pad = `${s(0.11)}px ${s(0.1)}px`;
  /**
   * THE BAND THE MARK CLAIMS, in this card's pixels — see `brandBand` for the rule.
   *
   * It is applied as the card's block-END padding below, which is what puts the credit block above
   * the mark instead of on it. A card that never had a mark, or whose mark the reader has placed by
   * hand, gets zero and keeps exactly the foot it always had.
   */
  const markBand = brandBand(composition.preset, meta, W, H) * H;
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
          </div>
        )}
      </>
    );
  } else if (style === "moonlit") {
    inner = (
      <>
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
        <span aria-hidden style={corner({ top: s(0.052), left: s(0.052), borderTop: `2px solid ${c.accent}`, borderLeft: `2px solid ${c.accent}` })} />
        <span aria-hidden style={corner({ top: s(0.052), right: s(0.052), borderTop: `2px solid ${c.accent}`, borderRight: `2px solid ${c.accent}` })} />
        <span aria-hidden style={corner({ bottom: s(0.052), left: s(0.052), borderBottom: `2px solid ${c.accent}`, borderLeft: `2px solid ${c.accent}` })} />
        <span aria-hidden style={corner({ bottom: s(0.052), right: s(0.052), borderBottom: `2px solid ${c.accent}`, borderRight: `2px solid ${c.accent}` })} />
        <div className="pc-col">
          <div aria-hidden style={{ width: s(0.022), height: s(0.022), background: c.accent, transform: "rotate(45deg)", margin: `0 auto ${s(0.03)}px` }} />
          {renderQuote("center")}
          {hasCredit && (
            <div className="pc-divider" style={{ marginTop: s(0.032) }} aria-hidden>
              <span style={{ width: s(0.07), height: 1, background: c.accent }} />
              <span style={{ width: s(0.014), height: s(0.014), borderRadius: "50%", background: c.accent }} />
              <span style={{ width: s(0.07), height: 1, background: c.accent }} />
            </div>
          )}
          {hasCredit && (
            <div className="pc-credit" style={{ textAlign: "center", marginTop: s(0.028) }}>
              {titleEl(c.accent, "center")}
              {subtitleEl("center")}
            </div>
          )}
          {hasFooter && (
            <div className="pc-footcol" style={{ marginTop: s(0.03) }}>
              {datetimeEl("center")}
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
        <div className="pc-col">
          {meta.title && data.bookTitle && (
            <div className="pc-cartouche-row" aria-hidden={false} style={partStyle("title")}>
              <span className="pc-hair" style={{ background: tint(45) }} />
              <span className="pc-cartouche" style={{ background: c.accent, color: paperBg, fontFamily: bookFont, fontWeight: 700, fontSize: s(0.04), padding: `${s(0.012)}px ${s(0.03)}px`, borderRadius: s(0.006) }}>
                {data.bookTitle}
              </span>
              <span className="pc-hair" style={{ background: tint(45) }} />
            </div>
          )}
          {renderQuote("center")}
          {/* The rule introduces the CREDIT, not the wordmark. With the credit lifted it separated the
              quote from a colophon that needs no introduction, and — measured — crossed the title
              the composition had placed there. */}
          {hasCredit && (
          <div className="pc-divider" style={{ marginTop: s(0.03) }} aria-hidden>
            <span style={{ width: s(0.08), height: 1, background: tint(60) }} />
            <span style={{ width: s(0.02), height: s(0.02), background: c.accent, borderRadius: "0 50% 0 50%", transform: "rotate(45deg)" }} />
            <span style={{ width: s(0.08), height: 1, background: tint(60) }} />
          </div>
          )}
          {(showSubtitle || hasFooter) && (
            <div className="pc-footcol" style={{ marginTop: s(0.026) }}>
              {subtitleEl("center")}
              {datetimeEl("center")}
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
      /* THE DOCUMENT'S OWN DIRECTION, not the book's.

         Every rect in a composition stores `x` as its INLINE-START edge, so the card's direction
         is the axis those coordinates resolve against - it is a property of the composition, and
         the composition records it. Rendering against the source book's direction instead meant
         the document could say one thing while the card showed another, and it made the Direction
         control inert: measured, pressing it moved nothing at all - not the card, not one element,
         not the mark.

         The book still decides where a NEW card starts (`canvas.dir` is seeded from `data.dir`),
         so every card made before this renders exactly as it did. What changes is that a reader
         who asks for the other direction now gets it.

         This is the card's direction, not the words': each text keeps `dir="auto"` and resolves
         from its own content, so an Arabic passage on a left-to-right card still reads correctly. */
      dir={composition.canvas.dir ?? data.dir}
      style={{
        width: W,
        height: H, // RAWY-154: the card ALWAYS keeps its format's fixed size — the quote auto-fits to it
        background: paperBg,
        color: c.text,
        padding: pad,
        // The mark's band, added to whatever foot this style already keeps — never replacing it, so
        // a style with a generous bottom margin does not lose it to a small mark.
        paddingBlockEnd: `calc(${pad.split(" ")[0]} + ${markBand}px)`,
        position: "relative",
      }}
    >
      <GroundLayer ground={composition.ground} url={assetUrl(composition.ground.kind === "image" ? composition.ground.assetId : "")} paper={paperBg} />
      {/* A CUSTOM CARD IS A BLANK CANVAS. The preset draws a book quote's furniture — an opening
          quotation mark, a rule, a credit block — and none of that belongs on a card with no book
          behind it. Its ornament was appearing in front of the user's own words. */}
      {frame}
      {calmMark}
      {!composition.custom && inner}
      <ElementsLayer comp={composition} cardW={W} ink={c.text} paper={paperBg} assetUrl={assetUrl} hideId={editingId} onNeedsRoom={onNeedsRoom} />
      {brandMark(c.muted)}
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
  initialComposition,
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
  /**
   * THE CARD'S OWN DOCUMENT, when it has one.
   *
   * Style, text size and the show-on-card toggles used never to be stored, so reopening a card threw
   * them away and re-saving overwrote the good PNG with a Minimal auto-fit rebuild. A composition
   * carries them, and it takes precedence over the individual `initial*` props above — which stay
   * for the callers that legitimately have no document (a brand-new card from a passage).
   */
  initialComposition?: Composition | null;
  editId?: string; // …and re-save over the same card (Edit) instead of creating a new one
  lang: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // The document, when this card has one, is the source of truth for every control it names. A card
  // with none keeps the previous behaviour exactly: the `initial*` props, then the shipped defaults.
  const seed = initialComposition?.preset ?? null;
  const [themeId, setThemeId] = useState<ThemeId>(
    (initialComposition?.ground.themeId as ThemeId | undefined) ?? initialThemeId,
  );
  const [format, setFormat] = useState<CardFormat>(
    initialComposition?.canvas.format ?? initialFormat ?? "portrait",
  );
  const [meta, setMeta] = useState<CardMeta>(seed?.meta ?? initialMeta ?? DEFAULT_META);
  // RAWY-150: the card style + text size, independent of the paper (theme) and the quote font.
  const [cardStyle, setCardStyle] = useState<CardStyle>(seed?.style ?? initialCardStyle ?? "minimal");
  // Kept for compatibility with cards saved before the quote became a first-class element: it
  // still caps the PRESET's auto-fit. Once the quote is lifted, its own size governs.
  const [textSize] = useState<TextSize>(seed?.textSize ?? initialTextSize ?? "auto");
  // RAWY-154: the quote's own text controls (weight / line spacing / alignment). Defaults reproduce
  // the pre-RAWY-154 look — 400 weight, "normal" spacing, "auto" alignment (each style's default).
  const [quoteWeight] = useState<QuoteWeight>(seed?.quoteWeight ?? 400);
  const [quoteSpacing] = useState<QuoteSpacing>(seed?.quoteSpacing ?? "normal");
  const [quoteAlign] = useState<QuoteAlign>(seed?.quoteAlign ?? "auto");
  // RAWY-81 (#1): the quote's own font key — null means "follow the book font" (unchanged look).
  const [quoteFont] = useState<string | null>(seed?.quoteFont ?? initialQuoteFont ?? null);
  const customFonts = useFonts((s) => s.custom);
  const resolvedQuoteFont = resolveCardFont(quoteFont, data.dir === "rtl", customFonts);
  const [busy, setBusy] = useState(false);
  // Which of the three is working. `busy` alone dimmed all three equally, so a slow export and
  // a slow save looked identical - and the one the reader actually pressed said nothing back.
  const [working, setWorking] = useState<"copy" | "export" | "keep" | null>(null);
  /**
   * WHAT JUST HAPPENED, SAID ON THE THING THAT DID IT.
   *
   * A card that has been copied looks exactly like a card that has not, and the clipboard gives no
   * sign of its own — so the reader was left to guess whether the press worked. The confirmation
   * therefore belongs ON the button they pressed, where cause and effect are the same object,
   * rather than in a corner of the window that might be anywhere relative to their eye.
   *
   * The failure path keeps the toast. A failure is worth interrupting for and worth reading; a
   * success is worth glancing at, and glancing is what a button you are already looking at gets.
   */
  const [done, setDone] = useState<{ act: "copy" | "export" | "keep"; label: string } | null>(null);
  const doneTimer = useRef<number | null>(null);
  const succeed = useCallback((act: "copy" | "export" | "keep", label: string) => {
    setDone({ act, label });
    if (doneTimer.current) window.clearTimeout(doneTimer.current);
    // Long enough to be seen without being waited on. Under two seconds a glance away misses it.
    doneTimer.current = window.setTimeout(() => setDone(null), 2400);
  }, []);
  useEffect(() => () => { if (doneTimer.current) window.clearTimeout(doneTimer.current); }, []);
  /**
   * WHETHER THERE IS ANYTHING TO LOSE.
   *
   * Compared against the document this opened with, rather than counted from a flag set by every
   * handler — a flag has to be remembered in every new place that edits something, and the one place
   * it is forgotten is the one that loses a card. The serialised document is what a save would
   * write, so "different from what we opened with" is exactly the right question.
   */
  const openedWith = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Shown when the X is pressed with unsaved work. Never shown for a card nothing has touched. */
  const [askClose, setAskClose] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /** The selection, kept in a ref so the window's key handler reads the current one. */
  const selectedRef = useRef<string | null>(null);
  // Decided at mount, not at save: an image imported into this card is bound to this id immediately,
  // so it is referenced from the moment it is copied rather than from the moment Save is pressed.
  const cardIdRef = useRef<string>(editId ?? crypto.randomUUID());

  // The two halves of the document the user edits directly. The preset controls stay their own state
  // because they are still the quick path; these are the composition proper.
  const [elements, setElements] = useState<CardElement[]>(initialComposition?.elements ?? []);
  const [ground, setGround] = useState<Ground>(
    initialComposition?.ground ?? { kind: "theme", themeId: initialThemeId },
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The background is selectable like anything else, but it is not an element — it is the card's
  // own ground, so it gets a mode rather than an id.
  const [bgMode, setBgMode] = useState(false);
  /** Which form the mark takes. `lockup` is what every card had before it was a choice. */
  const [brandVariant, setBrandVariant] = useState<BrandVariant>(seed?.brandVariant ?? "lockup");
  /** Absent in the document means "the side the card reads from", which is what it has always been. */
  const [brandAlign, setBrandAlign] = useState<BrandAlign>(
    seed?.brandAlign ?? (data.dir === "rtl" ? "right" : "left"),
  );
  /**
   * WHERE THE MARK IS, AND HOW BIG.
   *
   * It was pinned to a corner, which was right when the only question was "which corner" and wrong
   * as soon as the answer was "actually, there". `brandPos` is the top-left of the mark as fractions
   * of the card, absent meaning "wherever `brandAlign` puts it" — so every card made before this
   * still opens exactly as it was, and the three corner buttons remain the quick way to a good
   * answer rather than the only one.
   */
  const [brandPos, setBrandPos] = useState<{ x: number; y: number } | null>(seed?.brandPos ?? null);
  const [brandSize, setBrandSize] = useState<number>(seed?.brandSize ?? 0.036);
  /** The mark's face. null = Sard's own, which is what every card made before this carries. */
  const [brandFont, setBrandFont] = useState<string | null>(seed?.brandFont ?? null);
  const [brandOpacity, setBrandOpacity] = useState<number>(seed?.brandOpacity ?? 0.78);
  /** The element being typed into ON THE CARD. Double-click opens it; blurring closes it. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 1 = the size that fits the workspace. Zoom multiplies it; it never changes the document. */
  const [zoom, setZoom] = useState(1);
  /**
   * The composition this card started from. A start, not a template — it is not reapplied.
   *
   * Reopening a card reads it back from the style the card was saved with, so the panel shows what
   * the user is actually looking at rather than always claiming "calm".
   */
  const [compId, setCompId] = useState<CompositionId>(
    () => (Object.keys(COMP_STYLE) as CompositionId[]).find(
      (k) => COMP_STYLE[k] === (seed?.style ?? initialCardStyle ?? "minimal"),
    ) ?? "calm",
  );
  /** The card's OWN direction, which is the content's; the editor chrome follows the UI language. */
  const [cardDir, setCardDir] = useState<"rtl" | "ltr">(
    initialComposition?.canvas.dir ?? (data.dir === "rtl" ? "rtl" : "ltr"),
  );
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(
    initialComposition ? { w: initialComposition.canvas.w, h: initialComposition.canvas.h } : null,
  );

  // The size the user is actually working at: a typed width and height are the card's real size,
  // and the stage that draws it has to agree with the document or the preview lies about the export.
  const dim = canvasSize ?? formatDims(format);
  const natW = dim.w / EXPORT_RATIO;
  const natH = dim.h / EXPORT_RATIO;

  // Managed images, resolved once: an element stores an id, never a path, so the id has to be turned
  // into something the webview can load. A map, so a card with several stickers costs one call.
  const [assets, setAssets] = useState<Record<string, string>>({});
  const loadAssets = useCallback(async () => {
    try {
      const rows: BackgroundRow[] = await backgroundsList();
      const next: Record<string, string> = {};
      for (const r of rows) next[r.id] = convertFileSrc(r.derivative_path || r.original_path);
      setAssets(next);
    } catch {
      /* an unreadable store leaves images unresolved rather than breaking the composer */
    }
  }, []);
  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);
  const assetUrl = useCallback<AssetUrl>((id) => (id ? assets[id] ?? null : null), [assets]);

  /**
   * THE MARK, MOVED BY HAND.
   *
   * Reported as the box it occupies so the overlay can draw a handle over it, and moved in fractions
   * of the card like everything else. The first drag is what turns "in a corner" into "here": it
   * seeds a position from where the mark actually is, then follows the pointer.
   */
  const brandHand = useMemo(
    () => ({
      box: () => {
        const el = cardRef.current?.querySelector(".pc-brandmark") as HTMLElement | null;
        const card = cardRef.current;
        if (!el || !card) return null;
        const r = el.getBoundingClientRect();
        const q = card.getBoundingClientRect();
        if (!q.width || !q.height) return null;
        return { x: (r.left - q.left) / q.width, y: (r.top - q.top) / q.height, w: r.width / q.width, h: r.height / q.height };
      },
      move: (dx: number, dy: number, from: { x: number; y: number }) =>
        setBrandPos({ x: Math.min(1.2, Math.max(-0.2, from.x + dx)), y: Math.min(1.2, Math.max(-0.2, from.y + dy)) }),
    }),
    [],
  );

  /** The ground, moved and zoomed by hand on the card itself. */
  const groundHand = useMemo(
    () => ({
      onMove: (dx: number, dy: number) =>
        setGround((g) => (g.kind === "image"
          ? { ...g, offsetX: clamp01(g.offsetX ?? 0, dx, 2), offsetY: clamp01(g.offsetY ?? 0, dy, 2) }
          : g)),
      onZoom: (factor: number) =>
        setGround((g) => (g.kind === "image"
          ? { ...g, scale: Math.min(GROUND_SCALE_MAX, Math.max(GROUND_SCALE_MIN, (g.scale ?? 1) * factor)) }
          : g)),
    }),
    [],
  );

  /**
   * THE WORDS EACH ROLE CARRIES.
   *
   * A custom card has none of them, and that is the whole of its blankness: there is nothing here to
   * seed from, so nothing is seeded and nothing is invented.
   */
  /**
   * SEVERAL COLLECTED PASSAGES, WRITTEN AS ONE QUOTE.
   *
   * The reader has been able to gather passages one at a time since long before this editor, and
   * the card it made set each one as its own block, with the theme's ornament between them and -
   * when they came from different chapters - each chapter named under its own passage.
   *
   * The document model has ONE element per literary role, which is what makes the rail's checks,
   * Delete, and restoring a role without duplicating it work at all. So the collection becomes one
   * quote element that still carries all of it: the ornament and the chapter lines are written into
   * the text. Nothing is dropped, nothing is run together into a single paragraph, and it stays
   * editable as exactly what it is - words on a card.
   */
  const collected = useMemo(() => {
    const list = data.passages ?? [];
    if (list.length < 2) return null;
    const differ = new Set(list.map((x) => (x.chapterLabel ?? "").trim())).size > 1;
    const ornament = cardSeparator(themeId);
    const block = (x: CardPassage) => (differ && x.chapterLabel ? x.text + "\n" + x.chapterLabel : x.text);
    return { count: list.length, text: list.map(block).join("\n\n" + ornament + "\n\n") };
  }, [data.passages, themeId]);

  const roleText = useMemo<RoleText>(() => {
    if (initialComposition?.custom) return {};
    return {
      quote: collected ? collected.text : data.passages?.length ? data.passages[0].text : data.quote,
      title: data.bookTitle ?? "",
      chapter: data.chapterLabel ?? "",
      author: data.author ?? "",
      attribution: [data.bookTitle, data.author].filter(Boolean).join(" — "),
    };
  }, [data, collected, initialComposition]);

  /**
   * A NEW BOOK CARD ARRIVES COMPOSED.
   *
   * Its roles are laid out at deliberate, non-overlapping positions with a real hierarchy, so the
   * card starts as a card rather than as a pile in the middle waiting to be sorted out. This runs
   * ONCE, and only for a card being made now: a card being REOPENED is whatever it was saved as, and
   * a card saved before any of this existed keeps rendering through the preset exactly as it did.
   */
  /** The canvas the automatic layout works against — its proportions decide the arrangement. */
  const layoutCanvas = useMemo(
    () => { const d = canvasSize ?? formatSize(format); return { format, w: d.w, h: d.h }; },
    [format, canvasSize],
  );

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (editId) return;
    if (initialComposition?.custom) return;
    if ((initialComposition?.elements.length ?? 0) > 0) return;
    if (!roleText.quote?.trim()) return;
    // WITHOUT THE ATTRIBUTION. It is built from the title and the author, so seeding it puts the
    // book's name and its writer on the card twice — photographed doing exactly that. It stays in
    // `roleText` because the rail offers it, and it appears when the user asks for it.
    const { attribution: _, ...seedText } = roleText;
    // AND AROUND THE MARK. The mark is drawn at the foot before any of these elements exist, so
    // seeding without its band is what put an author line and a wordmark in the same millimetres.
    setElements(seedComposition(compId, seedText, layoutCanvas,
      brandBand({ ...composition.preset, meta }, meta, layoutCanvas.w, layoutCanvas.h)));
    // Seeding is a one-time act at mount, so it deliberately does not track its inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The families the reader actually has: the card's own faces plus every family they imported.
  const fontChoices = useMemo(
    () => [
      { key: "var(--book-font)", label: "Book" },
      { key: "var(--ar-font)", label: "Arabic" },
      { key: "var(--ui-font)", label: "UI" },
      ...familiesOnce(customFonts).map((f) => ({ key: f.family_name, label: f.family_name })),
    ],
    [customFonts],
  );

  // WHAT THIS CARD IS, right now — assembled from the live controls rather than from a snapshot, so
  // it cannot drift out of step with what the user is looking at. Free elements ride along from the
  // opened document untouched until the editor that manipulates them exists; a card that has none
  // (every card today) carries an empty list, which is what tells the renderer "draw the preset".
  const composition: Composition = useMemo(
    () => ({
      v: COMPOSITION_VERSION,
      canvas: { format, ...(canvasSize ?? formatSize(format)), dir: cardDir },
      // The paper follows the theme control even when the ground is a photograph, because the ink and
      // every ornament still recolour from it.
      ground: ground.kind === "image"
        ? { ...ground, themeId }
        : { kind: "theme" as const, themeId, ...(ground.paper ? { paper: ground.paper } : {}) },
      preset: {
        style: cardStyle, textSize, meta, quoteFont, quoteWeight, quoteSpacing, quoteAlign,
        brandVariant, brandAlign, brandSize, brandOpacity,
        ...(brandFont ? { brandFont } : {}),
        ...(brandPos ? { brandPos } : {}),
      },
      elements,
      ...(initialComposition?.custom ? { custom: true as const } : {}),
      ...(initialComposition?.ext ? { ext: initialComposition.ext } : {}),
    }),
    [format, themeId, cardStyle, textSize, meta, quoteFont, quoteWeight, quoteSpacing, quoteAlign, brandVariant, brandAlign, brandPos, brandSize, brandOpacity, brandFont, elements, ground, canvasSize, cardDir, initialComposition],
  );

  // EVERY edit goes through the document. The editor keeps no second copy of an element's geometry,
  // so what the overlay drags and what the exporter draws cannot drift apart.
  const compRef = useRef<Composition>(composition);
  compRef.current = composition;
  // The mark's band is read from live state inside , which must not be re-created on
  // every meta change or a keystroke mid-edit would rebuild the measurement callback.
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const edit = useCallback((fn: (c: Composition) => Composition) => {
    setElements(fn(compRef.current).elements);
  }, []);
  const selected = findElement(composition, selectedId);

  /**
   * THE CARD'S OWN CONTROLS.
   *
   * Sard ships sixteen papers and NewQu draws eight; the number was never the point. All sixteen are
   * offered, and the custom colour underneath them is what removes the ceiling — a paper the user
   * types a hex for beats whichever theme is selected.
   */
  const papers = useMemo(
    () => THEME_ORDER.map((id) => {
      const th = resolveTheme(id);
      return { id, label: id, paper: th.colors.paperBg, ink: th.colors.text };
    }),
    [],
  );
  const docControls = useMemo(
    () => ({
      format,
      setFormat: (f: CardFormat) => { setFormat(f); setCanvasSize(null); },
      width: composition.canvas.w,
      height: composition.canvas.h,
      setSize: (w: number, h: number) => setCanvasSize({ w, h }),
      papers,
      paperId: themeId as string,
      setPaper: (id: string) => setThemeId(id as ThemeId),
      paperHex: ground.kind === "theme" ? ground.paper ?? null : null,
      setPaperHex: (hex: string | null) =>
        setGround((g) => (g.kind === "theme" ? (hex ? { ...g, paper: hex } : { kind: "theme" as const, themeId: g.themeId }) : g)),
      dir: cardDir,
      setDir: setCardDir,
      meta,
      setMeta: (patch: Partial<CardMeta>) => setMeta((m) => ({ ...m, ...patch })),
      // What the stamps would read, formatted by the same functions the card prints with — so the
      // panel cannot drift from the card by describing the setting instead of showing the result.
      stamps: { date: formatCardDate(data.date, lang), time: formatCardTime(data.date, lang) },
      composition: compId,
      // A composition is a START. Applying one rearranges what is there once; it is never reapplied,
      // so anything the user moves afterwards stays moved.
      applyComposition: (id: CompositionId) => {
        setCompId(id);
        setCardStyle(COMP_STYLE[id]);
        setElements(applyComposition(compRef.current, id, layoutCanvas).elements);
      },
    }),
    [format, composition.canvas.w, composition.canvas.h, papers, themeId, ground, cardDir, meta, compId, data.date, lang],
  );
  // What this card belongs to. A custom card belongs to nothing, and says so by showing nothing.
  const ctxLabel = composition.custom ? "" : (data.bookTitle ?? "");
  // The colour the toolbar's swatch shows: the element's own ink, or the paper's.
  const selectedSwatch =
    selected && selected.kind !== "unknown" && selected.kind !== "image" && selected.style.color
      ? selected.style.color
      : resolveTheme(themeId).colors.text;
  // The quote, once it has been lifted. Auto-fit is then ITS property rather than the preset's.
  const quoteEl = composition.elements.find((e) => e.kind !== "unknown" && e.kind !== "image" && e.origin === "quote");
  const autoFit = quoteEl && quoteEl.kind !== "unknown" && quoteEl.kind !== "image"
    ? quoteEl.style.size == null
    : textSize === "auto";

  /**
   * THE PRESET'S OWN PARTS, MEASURED — so they can be selected like anything else on the card.
   *
   * The old model made the quote unreachable: it was drawn by the preset, and turning it into
   * something editable meant opening a creation menu and asking for it. That is backwards — the
   * quote is already on the card. This measures where the preset actually put each part and what
   * type it actually used, so clicking one can hand back an element that looks identical.
   *
   * Measured rather than re-derived on purpose: the five preset layouts place their parts in five
   * different ways, and any second calculation of "where the quote is" would eventually disagree
   * with the one that draws it.
   */
  const [parts, setParts] = useState<{ part: PresetPart; rect: Rect; style: TextStyle; text: string }[]>([]);
  const partsDeps = [cardStyle, format, textSize, meta, quoteAlign, quoteSpacing, quoteWeight, quoteFont, themeId, elements];
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const cardBox = card.getBoundingClientRect();
    if (!cardBox.width) return;
    const rtl = data.dir === "rtl";
    const already = liftedParts(compRef.current);
    const found: { part: PresetPart; rect: Rect; style: TextStyle; text: string }[] = [];
    const seek: { part: PresetPart; sel: string; text: string }[] = [
      { part: "quote", sel: ".pc-quote-wrap", text: collected ? collected.text : data.passages?.length ? data.passages[0].text : data.quote },
      { part: "title", sel: ".pc-title, .pc-cartouche", text: data.bookTitle ?? "" },
      { part: "subtitle", sel: ".pc-subtitle", text: [data.chapterLabel, data.author].filter(Boolean).join(" — ") },
    ];
    for (const { part, sel, text } of seek) {
      if (presetHidden(already, part)) continue;
      const node = card.querySelector(sel) as HTMLElement | null;
      if (!node || !text) continue;
      const b = node.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      // The measured type comes from the node that is actually drawing, including the auto-fit size.
      const inner = (node.querySelector(".pc-quote") as HTMLElement | null) ?? node;
      // MIND THE TWO SCALES. `getComputedStyle` reports the font size in the card's own unscaled
      // pixels; `getBoundingClientRect` reports boxes AFTER the preview's `scale()` transform. Divide
      // one by the other and the fraction comes out too large by 1/scale — which re-wrapped a
      // four-line quote onto five and pushed it out of its box the moment it was lifted. Ratios of
      // two measured rects are safe (both scaled); a length against a rect is not.
      const cs = getComputedStyle(inner);
      const px = parseFloat(cs.fontSize) || 16;
      found.push({
        part,
        rect: {
          x: (rtl ? cardBox.right - b.right : b.left - cardBox.left) / cardBox.width,
          y: (b.top - cardBox.top) / cardBox.height,
          w: b.width / cardBox.width,
          h: b.height / cardBox.height,
        },
        style: {
          size: px / natW,
          weight: Number(cs.fontWeight) || 400,
          lineHeight: parseFloat(cs.lineHeight) / px || 1.6,
          align: cs.textAlign === "center" ? "center" : cs.textAlign === "right" || cs.textAlign === "end" ? (rtl ? "start" : "end") : "start",
          color: cs.color,
          opacity: 1,
          dir: "auto",
        },
        text,
      });
    }
    setParts(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, partsDeps);

  /**
   * WHAT AN AUTO-FITTED QUOTE IS ACTUALLY DRAWN AT.
   *
   * Auto-fit stores no size — that is the point of it — so taking the size by hand has to start from
   * the value the fit arrived at, read from the node that is drawing. Anything else would hand the
   * user a different size from the one they were looking at, which is what the old XS–XL row did.
   */
  const [fittedFrac, setFittedFrac] = useState<number | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !quoteEl || !autoFit) { setFittedFrac(null); return; }
    const node = card.querySelector(`[data-el="${quoteEl.id}"] > *`) as HTMLElement | null;
    if (!node) return;
    const px = parseFloat(getComputedStyle(node).fontSize);
    if (px > 0) setFittedFrac(px / natW);
  }, [quoteEl, autoFit, natW, elements]);
  const autoFrac = fittedFrac ?? parts.find((p) => p.part === "quote")?.style.size ?? 0.062;

  /**
   * The element a preset part would become — built from what was measured, so the card does not move
   * a pixel. Separate from `liftPart` because the visibility switch needs to lift a part it is about
   * to HIDE, and lifting used to imply selecting.
   */
  const buildLifted = useCallback((part: PresetPart): CardElement | null => {
    const found = parts.find((p) => p.part === part);
    if (!found) return null;
    return {
      id: newId(),
      kind: part === "quote" ? "quote" : "attribution",
      placement: { rect: found.rect },
      style: found.style,
      text: found.text,
      origin: part,
    };
  }, [parts]);

  /** Clicking a preset part hands back an element that looks exactly like what was there. */
  const liftPart = useCallback((part: PresetPart) => {
    const el = buildLifted(part);
    if (!el) return;
    setElements((prev) => addElement({ ...compRef.current, elements: prev }, el).elements);
    setSelectedId(el.id);
  }, [buildLifted]);

  /**
   * A NEW PIECE OF TEXT, PLACED AND SIZED.
   *
   * Not at the origin at some default fraction. Even on a blank canvas a thing you add should arrive
   * where a person would have put it, at a size they can read — the same regions the automatic
   * layout uses, so a hand-built card and a generated one have the same bones.
   */
  const newText = useCallback((): CardElement => ({
    id: newId(),
    kind: "text",
    placement: { rect: defaultRectFor("text", format) },
    style: defaultStyleFor("text", format),
    text: "",
  }), [format]);

  /**
   * TAKE THE SELECTED THING OFF THE CARD.
   *
   * A LITERARY ROLE is hidden rather than dropped, and the difference is the whole of requirement
   * five and six: the rail's check has to go quiet, and switching it back on has to bring back the
   * user's own words and their own type — not a fresh element built from the book again, and not a
   * second copy beside the first. A hidden element keeps everything and draws nothing, which is
   * exactly that. Anything else — a picture, a line of their own text — is simply removed.
   */
  const removeSelected = useCallback((id: string) => {
    const el = findElement(compRef.current, id);
    if (!el) return;
    const role = el.kind !== "unknown" && el.kind !== "image" ? el.origin : undefined;
    if (role) setElements((prev) => setHidden({ ...compRef.current, elements: prev }, id, true).elements);
    else setElements((prev) => removeElement({ ...compRef.current, elements: prev }, id).elements);
    setSelectedId(null);
    setEditingId(null);
  }, []);

  /** Add an element and select it, so the panel is already showing what was just created. */
  const addAndSelect = useCallback((make: (c: Composition) => CardElement) => {
    const el = make(compRef.current);
    setElements((prev) => addElement({ ...compRef.current, elements: prev }, el).elements);
    setSelectedId(el.id);
  }, []);



  /**
   * IMPORT AN IMAGE — through the managed store, never as a loose path.
   *
   * `backgroundImport` copies the file into app-data, bakes EXIF orientation, guards against decode
   * bombs and caps the derivative, and it returns an id. Only an id ever reaches the document, which
   * is what lets the collector track it and what keeps the asset protocol able to load it.
   */
  const pickImage = useCallback(async (): Promise<string | null> => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
    });
    if (typeof picked !== "string") return null;
    const row = await photocardStageImage(cardIdRef.current, picked);
    await loadAssets();
    return row.id;
  }, [loadAssets]);

  const addSticker = useCallback(async () => {
    const id = await pickImage().catch(() => null);
    if (id) addAndSelect((c) => makeImage(c, id));
  }, [pickImage, addAndSelect]);

  /** Swap the picture inside the selected image element, keeping its place and size. */
  const replaceImage = useCallback(async () => {
    if (!selectedId) return;
    const id = await pickImage().catch(() => null);
    if (id) edit((c) => updateImage(c, selectedId, { assetId: id }));
  }, [selectedId, pickImage, edit]);

  const setBackground = useCallback(async () => {
    const id = await pickImage().catch(() => null);
    if (id) setGround((g) => ({ kind: "image", assetId: id, themeId: g.themeId, fit: "cover", focalX: 0.5, focalY: 0.5, blur: 0, scrim: 0.18 }));
  }, [pickImage]);

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
  const measureKey = `${themeId}|${format}|${dim.w}x${dim.h}|${cardStyle}|${textSize}|${quoteWeight}|${quoteSpacing}|${quoteAlign}|${JSON.stringify(meta)}|${resolvedQuoteFont}|${data.quote.length}|${(data.passages ?? []).length}`;
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el) setNaturalH(el.offsetHeight);
  }, [measureKey]);
  /**
   * THE CANVAS TAKES THE ROOM THE WORKSPACE ACTUALLY HAS.
   *
   * It used to be fitted to two constants, so widening the popup made the desk bigger and the card
   * exactly the same — 512px of card inside 1088px of clear space. The workspace measures itself
   * instead, and the card fits what is left once the inspector and the objects strip have taken
   * theirs. Measured rather than derived from the layout numbers, because the layout numbers would
   * then exist in two places and drift.
   */
  const workRef = useRef<HTMLDivElement>(null);
  const [workBox, setWorkBox] = useState({ w: STAGE_MAX_W, h: STAGE_MAX_H });
  /**
   * DOES THE INSPECTOR STILL FIT BESIDE THE CARD?
   *
   * Measured, not guessed at from the window: the workspace already measures itself, and the same
   * rectangle answers this. `roomWithInspector` is what the stage would get if the panel keeps its
   * reservation; below `STAGE_MIN` the card used to stop shrinking and overflow back out under the
   * panel, which is the defect this whole change is about.
   */
  const [inspectorHasRoom, setInspectorHasRoom] = useState(true);
  useLayoutEffect(() => {
    const el = workRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      // Before the first layout the element has no box. Flooring that to a number invented a stage
      // out of nothing; keeping the previous value simply waits for a real measurement.
      if (r.width <= 0 || r.height <= 0) return;
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingInlineStart) + parseFloat(cs.paddingInlineEnd);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      // THE FLOOR IS GONE, AND THAT IS THE FIX. `Math.max(240, …)` did not keep the card usable — it
      // made the card LIE about the room it had, so `fitScale` scaled to 240 inside a box measured
      // at 8px and the difference spilled out of `.pcx-work` on both sides. The card now fits what
      // is actually there, and staying usable is the breakpoint's job below, not a clamp's.
      setWorkBox({ w: Math.max(1, r.width - padX), h: Math.max(1, r.height - padY) });
      // The reservation and the gutter are declared in the stylesheet; reading them back keeps one
      // definition rather than a second copy here that could drift from it.
      const mcs = getComputedStyle(el.closest(".pcx-modal") ?? el);
      const reserve = parseFloat(mcs.getPropertyValue("--pcx-insp-reserve")) || 372;
      const gutter = parseFloat(mcs.getPropertyValue("--pcx-gutter")) || 44;
      // HYSTERESIS, so a window dragged along the boundary does not flap: it takes a little more
      // room to bring the panel back than it took to send it away.
      setInspectorHasRoom((was) => inspectorFits(r.width, reserve, gutter, was));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /**
   * WHETHER THE INSPECTOR IS ON SCREEN — geometry, unless the reader has said otherwise.
   *
   * `inspectorOpen` was a prop passed a literal `true`, and `.pcx-strip.with-inspector` already
   * varied by it: the machinery for a panel that can be absent was drawn and never wired. This
   * wires it, and nothing more.
   *
   * WHERE THERE IS ROOM, NOTHING CHANGES: the panel is open, the reservation stands, and no control
   * appears — the wide layout is the one that shipped. Where there is not, the panel steps aside so
   * the card can have the room, and a control appears beside the zoom so it can be brought back. The
   * reader's own press wins over the geometry for as long as they stay at that width; moving back
   * into open country clears it, so the override cannot be carried somewhere it would be confusing.
   */
  const [inspectorChoice, setInspectorChoice] = useState<boolean | null>(null);
  useEffect(() => { setInspectorChoice(null); }, [inspectorHasRoom]);
  const inspectorOpen = inspectorChoice ?? inspectorHasRoom;

  const fitScale = useMemo(
    () => Math.min(workBox.w / natW, workBox.h / natH),
    [workBox, natW, natH],
  );
  const viewScale = fitScale * zoom;

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
    setDone(null); setBusy(true); setWorking("export");
    try {
      const blob = await rasterize();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = await save({ defaultPath: `sard-quote-${stamp}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
      if (path) {
        await savePhotoCardFile(path, await blob.arrayBuffer());
        succeed("export", t("photo.saved"));
      }
    } catch (e) {
      console.error(e);
      flash(t("photo.saveFail"));
    } finally {
      setBusy(false); setWorking(null);
    }
  };

  const onCopy = async () => {
    if (busy) return;
    setDone(null); setBusy(true); setWorking("copy");
    try {
      const blob = await rasterize();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      succeed("copy", t("photo.copied"));
    } catch (e) {
      console.error(e);
      flash(t("photo.copyFail"));
    } finally {
      setBusy(false); setWorking(null);
    }
  };

  // Save in app (RAWY-52): rasterise → store the PNG + a photo_cards row so it appears in the
  // Library "Cards" gallery, with its book / chapter / date.
  const onSaveInApp = async () => {
    if (busy) return;
    setDone(null); setBusy(true); setWorking("keep");
    try {
      const blob = await rasterize();
      // Edit (RAWY-57): re-save over the same id (upsert), keeping the original save time; a
      // fresh card gets a new id + now.
      await photocardSave({
        id: cardIdRef.current,
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
        // THE DOCUMENT. Everything this card is, written down — so reopening restores it instead of
        // rebuilding a Minimal auto-fit card over the top of it and overwriting the good PNG.
        doc: serializeComposition(composition),
        // Sent BESIDE the document, never parsed out of it: this is what the collector reads.
        images: referencedAssets(composition),
        createdAt: editId ? Math.floor(data.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
        png: await blob.arrayBuffer(),
      });
      // THE SAVE IS THE NEW BASELINE. Without this the editor goes on believing the work is
      // unsaved for the rest of the session: the reader saves, presses the X, and is warned about
      // losing changes that are already on the shelf. A warning that fires when nothing is at risk
      // is worse than none, because it teaches people to dismiss the one that matters.
      openedWith.current = wireRef.current;
      setDirty(false);
      succeed("keep", editId ? t("photo.updatedInApp") : t("photo.savedInApp"));
    } catch (e) {
      console.error(e);
      flash(t("photo.saveFail"));
    } finally {
      setBusy(false); setWorking(null);
    }
  };


  useEffect(() => {
    if (!passOpen) return;
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".pcx-passwrap")) return;
      setPassOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [passOpen]);

  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  /**
   * A TEXT BOX IS THE HEIGHT OF ITS TEXT. Not a minimum, not a maximum — the height.
   *
   * THE MODEL, and it is the reason metadata behaved the way it did. A text element has three
   * possible relationships with its box:
   *
   *   the size is the USER'S   the type is fixed, so the BOX follows the words. Set the measure by
   *                            dragging the width; the height is not a thing to be chosen, any more
   *                            than the height of a paragraph in a book is.
   *   the size is AUTO-FIT     the box is fixed and the TYPE follows it, shrinking to fill. Only a
   *                            card saved before «ملء البطاقة» was withdrawn is still in this mode.
   *   IT IS THE QUOTE          the box still follows the words, but it does so around its CENTRE
   *                            rather than its top — see the anchor below. The composition chose a
   *                            point in the room for the passage to sit around, and holding that
   *                            point is what keeps a two-word quote and a nine-line one both
   *                            balanced. Anchoring by the top instead was measured putting a quoted
   *                            passage 0.112 of the card above the middle of its own room.
   *
   * The old version of this only ever GREW, which meant the first relationship was only half
   * implemented. Measured in the running editor: an attribution arrived 0.12 of the card tall, one
   * short Arabic line needed 29px of a 66px box, and deleting text back down left the box at the
   * tallest it had ever been. That is the "long empty rectangle" — an authored height that nothing
   * was ever allowed to take back.
   *
   * IT CANNOT OSCILLATE. Only the height moves; the WIDTH is untouched, so the words wrap into
   * exactly the same lines and the next measurement reports the same need. It settles in one pass.
   *
   * THE FLOOR IS `MIN_SIZE`, the same floor dragging obeys, so a box can never become too small to
   * grab. THE CEILING is the card, and a box that would run off the foot slides up instead of
   * hanging over the edge.
   */
  /**
   * WHAT AN EMPTY ELEMENT SAYS WHILE IT IS WAITING FOR WORDS.
   *
   * The role's own name, taken from the same list the rail is built from — so the thing the reader
   * switched on and the thing that appears on the card are named identically, and there is no second
   * table of labels to drift. Anything that is not a literary role is a line of their own text, and
   * says so.
   */
  const emptyLabel = useCallback((el: TextElement) => {
    const role = el.origin ? LITERARY_ROLES.find((r) => r.part === el.origin) : undefined;
    return t(role ? role.label : "photo.el.textPlaceholder");
  }, [t]);

  /**
   * Set while a quote is being clamped, and read once the render has settled — a toast raised from
   * inside a state updater would be a render-time side effect, and would also fire on every
   * keystroke of a long passage rather than once when it stops fitting.
   */
  const tooLongRef = useRef(false);
  const wasTooLong = useRef(false);
  useEffect(() => {
    if (tooLongRef.current === wasTooLong.current) { tooLongRef.current = false; return; }
    wasTooLong.current = tooLongRef.current;
    if (tooLongRef.current) flash(t("photo.quote.tooLong"));
    tooLongRef.current = false;
  });

  const fitToText = useCallback((id: string, needed: number) => {
    if (!Number.isFinite(needed) || needed <= 0) return;
    setElements((prev) => {
      const el = prev.find((e) => e.id === id);
      if (!el || !isText(el)) return prev;
      const rect = el.placement.rect;
      const want = Math.min(Math.max(needed, MIN_SIZE), 1);
      /**
       * A QUOTE KEEPS ITS CENTRE; EVERYTHING ELSE KEEPS ITS TOP.
       *
       * A metadata line belongs to a stack that is built downward from a known edge, so its top is
       * the fixed thing and its height grows and shrinks below it. A quote is the opposite: the
       * composition chose a POINT in the room for it to sit around, and the words are centred in
       * its box. Anchor that box by its top and every change of length walks the passage upward —
       * measured before this: the box collapsed onto the text and stayed pinned to the room's top
       * edge, and the ink ended up 0.112 of the card above the middle.
       *
       * Holding the centre makes the box breathe symmetrically, so a two-word quote and a nine-line
       * one are both balanced on the same point, and shortening a long quote gives the room back
       * instead of leaving a box that has been stretched once and never returns.
       */
      let h = want;
      let y: number;
      if (el.kind === "quote") {
        /**
         * AND IT STAYS IN ITS ROOM.
         *
         * The size is the reader's, so the box is what gives way — but "gives way" was unbounded,
         * and a box may only take space that is not already spoken for. The room is the same one
         * the composing pass works in (`quoteRegion`): the format's margin, whatever sits below the
         * passage, and the band the mark has claimed.
         *
         * The centre is re-found INSIDE that room rather than kept absolutely, so a growing passage
         * opens upward as well as downward and only stops when the room does. What it never does is
         * step over the credit or the mark, which is what it did before: measured, a 13-line
         * passage at 42px took the whole card and covered all four credit lines and the mark.
         */
        const others = prev
          .filter((e) => e.id !== id && e.kind !== "unknown" && !e.hidden)
          .map((e) => (e as TextElement).placement.rect);
        const room = quoteRegion(format, rect, others,
          brandBand(compRef.current.preset, metaRef.current, layoutCanvas.w, layoutCanvas.h));
        const roomH = Math.max(MIN_SIZE, room.bottom - room.top);
        h = Math.min(want, roomH);
        const centre = rect.y + rect.h / 2;
        y = Math.min(Math.max(room.top, centre - h / 2), room.bottom - h);
        // WHEN THE ROOM IS NOT ENOUGH, SAY SO rather than quietly making the card worse. The size
        // stays theirs, the composition stays intact, and the one thing Sard can honestly do is
        // tell them the passage is longer than the card has room for at that size.
        if (want > roomH + 0.002) tooLongRef.current = true;
      } else {
        y = rect.y + want > 1 ? Math.max(0, 1 - want) : rect.y;
      }
      /**
       * NOTHING TO DO IS THE COMMON CASE, and it has to be recognised on the FINAL geometry.
       *
       * It used to bail on `want` — the height the words asked for — which is fine while that is
       * what they get and fatal once it is clamped: a passage asking for more than its room asked
       * again on every measurement, was clamped to the same height every time, and was written back
       * as a new array every time. Measured: the editor rendered until the card disappeared.
       */
      if (Math.abs(h - rect.h) <= 0.002 && Math.abs(y - rect.y) <= 0.002) return prev;
      const fitted = { ...el, placement: { ...el.placement, rect: { ...rect, y, h } } };
      return prev.map((e) => (e.id === id ? fitted : e));
    });
  }, []);

  /**
   * DELETE, FROM THE KEYBOARD.
   *
   * On the WINDOW, because the selection lives on the canvas and the canvas is not what has focus
   * after most edits — requiring a click on the card first would make the key unreliable in exactly
   * the way that teaches people not to use it.
   *
   * The one distinction that matters: while text is being typed, Delete belongs to the text. The
   * editor is a real focused field, so asking whether the active element is one is both the simplest
   * test and the correct one — it also covers the panel's own inputs, where Delete must edit the
   * number and not remove the element the number belongs to.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ESCAPE BACKS OUT OF WHAT IS OPEN — never out of the editor. Losing a card to a key pressed
      // to dismiss a colour picker would be the same accident the scrim used to cause.
      if (e.key === "Escape") {
        if (askClose) { e.preventDefault(); setAskClose(false); return; }
        if (passOpen) { e.preventDefault(); setPassOpen(false); return; }
        if (editingId) { e.preventDefault(); setEditingId(null); return; }
        if (bgMode) { e.preventDefault(); setBgMode(false); return; }
        if (selectedRef.current) { e.preventDefault(); setSelectedId(null); }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing || editingId) return;
      const id = selectedRef.current;
      if (!id) return;
      e.preventDefault();
      removeSelected(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId, askClose, bgMode, passOpen, removeSelected]);

  // ── closing, and what it costs ───────────────────────────────────────────────────────────────
  // The document as it stands, against the document this opened with. Recorded on the first render
  // so a card that has only been LOOKED at closes without a question.
  const wire = useMemo(() => serializeComposition(composition), [composition]);
  const wireRef = useRef(wire);
  useEffect(() => { wireRef.current = wire; }, [wire]);
  useEffect(() => {
    if (openedWith.current === null) { openedWith.current = wire; return; }
    setDirty(wire !== openedWith.current);
  }, [wire]);

  const tryClose = useCallback(() => {
    if (dirty) { setAskClose(true); return; }
    onClose();
  }, [dirty, onClose]);

  return (
    // THE POPUP. A creative workspace held over the Sard context, never a page of its own: the scrim
    // keeps the library or the reader visible behind it, and the modal is sized so the canvas has
    // room to be worked on rather than merely previewed.
    // THE SCRIM DOES NOT CLOSE THIS. A card is half an hour's work, and "click outside to dismiss"
    // is a gesture people make by accident — reaching for the reader behind, missing a control,
    // putting the mouse down. The way out is the X, and the X asks first if there is anything to lose.
    <div className="pcx-scrim">
      {/* THE WORKSPACE FOLLOWS THE READER'S LANGUAGE; THE CARD FOLLOWS THE BOOK'S.
          Opened from the reader, this used to inherit the BOOK's direction, so an English book put
          the rail and the inspector on the wrong sides of an Arabic interface. The card keeps
          `data.dir` — an English quote must still read left to right — but the chrome around it is
          part of Sard, and Sard is in the reader's language. */}
      <div
        className="pcx-modal"
        dir={lang === "ar" ? "rtl" : "ltr"}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* WHERE THE COMPOSER'S FLOATING SURFACES ARE DRAWN.
            The same host the Library uses, declared again here because this modal is its own shell:
            it defines `--pc-*` on this element, so a surface portalled into the Library's host would
            land outside those tokens. `overlayHost(el)` finds the nearest one, which from inside the
            composer is this.
            IT IS HERE TO ESCAPE A STACKING CONTEXT, measured rather than assumed. The floating
            toolbar `.pcx-tb` is `position: absolute; z-index: 32`, so it IS a stacking context, and
            the colour picker inside it carries `z-index: 46` — higher than the inspector's 34 and
            still painted underneath it, because 46 is ranked within 32. At 900px the inspector
            covered the toolbar's own swatch: `elementsFromPoint` over it returned
            `textarea.pcx-text · section.pcx-sec · aside.pcx-insp` ABOVE `button.pcx-tb-swatch`, so
            the control could not be pressed at all. No z-index on the picker can reach past that;
            only leaving the context can. */}
        <div className={OVERLAY_HOST_CLASS} />

        {/* ── TOP BAR ─────────────────────────────────────────────────────────────────────────
            Where the card is, what it belongs to, and what to do with it when it is finished. */}
        <header className="pcx-top">
          {/* An X, not a chevron. A chevron says "back to the page you came from"; this is a
              window over the reader, and closing it is the only navigation it has. */}
          <button
            className="pcx-top-back"
            onClick={tryClose}
            title={t("photo.close")}
            aria-label={t("photo.close")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
          <span className="pcx-top-title">{t("photo.title")}</span>
          {ctxLabel && (
            <span className="pcx-top-ctx" title={ctxLabel}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z" /></svg>
              <span>{ctxLabel}</span>
            </span>
          )}
          {/* A COLLECTION IS WORTH SAYING OUT LOUD. Someone who gathered five passages needs to
              see that five arrived; otherwise the only way to check is to read the card and count.
              The old panel said it and the first version of this top bar dropped it. */}
          {collected && (
            /* SEVERAL PASSAGES ARE A FACT ABOUT THE CARD, so this sits in the card's context area
               beside the book they came from - and it is a CONTROL, not another grey chip. The count
               used to sit in a pill identical to the book's, wearing a list glyph that opened
               nothing: it read as a debug readout because nothing about it invited a press. */
            <div className="pcx-passwrap">
              <button
                className="pcx-passages"
                aria-expanded={passOpen}
                aria-haspopup="dialog"
                title={t("photo.pass.open")}
                onClick={() => setPassOpen((v) => !v)}
              >
                <span className="pcx-pass-count">{localeNum(collected.count, lang)}</span>
                {/* The badge beside it is the number. Repeating it here read as "22 passages". */}
                <span className="pcx-pass-word">{t("photo.pass.word")}</span>
                <svg className="pcx-pass-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {passOpen && (
                <div className="pcx-pass-pop" role="dialog" aria-label={t("photo.pass.title")}>
                  <div className="pcx-pass-head">
                    <b>{t("photo.pass.title")}</b>
                    <i>{t("photo.pass.sub")}</i>
                  </div>
                  <ol className="pcx-pass-list">
                    {(data.passages ?? []).map((psg, i) => (
                      <li className="pcx-pass-row" key={i}>
                        <span className="pcx-pass-n" aria-hidden>{localeNum(i + 1, lang)}</span>
                        <span className="pcx-pass-body">
                          <span className="pcx-pass-text" dir="auto">{psg.text}</span>
                          <span className={`pcx-pass-ch${psg.chapterLabel ? "" : " none"}`} dir="auto">
                            {psg.chapterLabel || t("photo.pass.nochapter")}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <p className="pcx-pass-note">{t("photo.pass.note")}</p>
                </div>
              )}
            </div>
          )}
          <div className="pcx-top-gap" />
        </header>

        {/* ── BODY: a rail for making things; everything else is canvas ───────────────────────── */}
        <div className="pcx-body">
          {/* ── THE RAIL: what this card is made of, and what it could be made of ──────────────
              Not a toolbar of icons. Each literary role states three things at once — whether it is
              on the card, what it currently reads, and what it would say if you added it — so the
              card's contents are legible without opening anything. Adding is here; EDITING is on the
              card, which is what the note at the foot says and why nothing here opens a panel. */}
          <nav className="pcx-rail" onPointerDown={(e) => e.stopPropagation()}>
            <div className="pcx-railscroll">

            <section className="pcx-railsec">
              <h3 className="pcx-railhead">
                <b>{t("photo.rail.addTitle")}</b>
                <i>{t("photo.rail.addHint")}</i>
              </h3>
              <button className="pcx-addrow" onClick={() => { setBgMode(false); addAndSelect(() => newText()); }}>
                <span className="pcx-addtile">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M5 6h14M12 6v13M9 19h6" /></svg>
                </span>
                <span className="pcx-addtxt">
                  <b>{t("photo.rail.text")}</b>
                  <i>{t("photo.rail.textHint")}</i>
                </span>
                <span className="pcx-addplus" aria-hidden>+</span>
              </button>
              <button className="pcx-addrow" onClick={() => { setBgMode(false); void addSticker(); }}>
                <span className="pcx-addtile">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.6" /><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5" /></svg>
                </span>
                <span className="pcx-addtxt">
                  <b>{t("photo.rail.image")}</b>
                  <i>{t("photo.rail.imageHint")}</i>
                </span>
                <span className="pcx-addplus" aria-hidden>+</span>
              </button>
              {/* The ground is not ADDED, it is opened — so this one carries a chevron, not a plus,
                  and it holds the selected state while its panel is the one on screen. */}
              <button
                className={`pcx-addrow bg${bgMode ? " on" : ""}`}
                onClick={() => { setSelectedId(null); setBgMode((v) => !v); }}
              >
                <span className="pcx-addtile">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14l4.5-4 5 4.5" opacity=".55" /></svg>
                </span>
                <span className="pcx-addtxt">
                  <b>{t("photo.rail.bg")}</b>
                  <i>{t("photo.rail.bgHint")}</i>
                </span>
                <svg className="pcx-addchev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M15 5l-7 7 7 7" /></svg>
              </button>
            </section>

            <section className="pcx-railsec">
              <h3 className="pcx-railhead col">
                <b>{t(composition.custom ? "photo.rail.litBlank" : "photo.rail.litBook")}</b>
                <i>{t(composition.custom ? "photo.rail.litBlankHint" : "photo.rail.litBookHint")}</i>
              </h3>
              {LITERARY_ROLES.map((role) => {
                const live = composition.elements.find(
                  (e) => e.kind !== "unknown" && e.kind !== "image" && e.origin === role.part,
                );
                const part = parts.find((pp) => pp.part === role.part);
                const words = (roleText[role.part] ?? "").trim();
                const here = !!live || !!part;
                // ON is what the CARD shows. An element that exists but is hidden is off, and the
                // switch has to say so — the tick used to mean "this exists", which is a fact about
                // the document rather than about the picture the user is looking at.
                const visible = live ? !live.hidden : !!part;
                const chosen = !!live && live.id === selectedId;
                // ON A COLLECTED CARD THE QUOTE IS NOT ONE SENTENCE, so the first few words of
                // a joined string say nothing true about it. The rail agrees with the indicator
                // in the top bar instead: this role is three passages.
                const shown = role.part === "quote" && collected
                  ? t("photo.top.passages", { n: localeNum(collected.count, lang) })
                  : live && live.kind !== "unknown" && live.kind !== "image"
                    ? (live.text.trim() || "—")
                    : part ? part.text : "";
                /** Show or hide it, making it first if the card has not got one yet. */
                const setVisible = (on: boolean) => {
                  setBgMode(false);
                  if (live) {
                    edit((c) => setHidden(c, live.id, !on));
                    if (!on && selectedId === live.id) setSelectedId(null);
                    return;
                  }
                  if (part) {
                    // The PRESET is drawing this one, and a preset part cannot be hidden on its own
                    // — the only thing the document can switch off is an element. So lift it, which
                    // is what stops the preset drawing it, and hide the result. Nothing moves: the
                    // lifted element is built from the measured position and type of what was there.
                    const el = buildLifted(role.part);
                    if (!el) return;
                    setElements((prev) => addElement(
                      { ...compRef.current, elements: prev }, on ? el : { ...el, hidden: true },
                    ).elements);
                    if (on) setSelectedId(el.id);
                    return;
                  }
                  if (!on) return;
                  // Nothing on the card and nothing in the preset: make it. On a blank card there
                  // are no words to make it from, so it arrives empty and open to type.
                  // THE STACK MAKES ROOM, and the mark's band travels with it: a role added by
                  // hand lands above the mark, and the credit lines already on the card move up to
                  // let it in — unless the reader has placed one of them themselves.
                  const band = brandBand(composition.preset, meta, layoutCanvas.w, layoutCanvas.h);
                  let bornId: string | null = null;
                  setElements((prev) => {
                    const next = addRoleLaidOut(prev, compId, role.part, words, layoutCanvas, roleText, band);
                    const born = next[next.length - 1];
                    bornId = born && born.kind !== "unknown" ? born.id : null;
                    return next;
                  });
                  if (bornId) setSelectedId(bornId);
                  // Nothing to show yet, so it opens for typing — which is also what gives an empty
                  // field its one-line affordance instead of a rectangle waiting to be noticed.
                  if (!words && bornId) setEditingId(bornId);
                };
                return (
                  <div key={role.part} className={`pcx-role${visible ? " here" : ""}${chosen ? " on" : ""}${here && !visible ? " off" : ""}`}>
                    <button
                      className="pcx-role-check"
                      role="switch"
                      aria-checked={visible}
                      title={t(visible ? "photo.role.hideIt" : here ? "photo.role.showIt" : "photo.role.addIt")}
                      onClick={(e) => { e.stopPropagation(); setVisible(!visible); }}
                    >
                      <span className="pcx-role-tick" aria-hidden>
                        {visible ? (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4 10-10" /></svg>
                        ) : here ? null : "+"}
                      </span>
                    </button>
                    <button
                      className="pcx-role-main"
                      title={t(here ? "photo.role.onCard" : "photo.role.addIt")}
                      onClick={() => {
                        // Pressing the NAME reaches the element; the switch beside it is what shows
                        // and hides. A name that is off turns itself on rather than doing nothing.
                        if (live && !live.hidden) { setBgMode(false); setSelectedId(live.id); return; }
                        setVisible(true);
                      }}
                    >
                      <span className="pcx-role-txt">
                        <b>{t(role.label)}</b>
                        <i dir="auto">{shown || t(role.hint)}</i>
                      </span>
                    </button>
                  </div>
                );
              })}
            </section>

            {/* The mark belongs in this list because it IS one of the card's elements — it is simply
                the one the user does not place. Its form is the only thing to decide. */}
            <section className="pcx-railsec">
              <h3 className="pcx-railhead col">
                <b>{t("photo.brand.title")}</b>
                <i>{t("photo.brand.hint")}</i>
              </h3>
              <div className={`pcx-role${meta.brand ? " here" : ""}`}>
                <button
                  className="pcx-role-check"
                  role="switch"
                  aria-checked={meta.brand}
                  title={t(meta.brand ? "photo.brand.onCard" : "photo.brand.showIt")}
                  onClick={() => setMeta((m) => ({ ...m, brand: !m.brand }))}
                >
                  <span className="pcx-role-tick" aria-hidden>
                    {meta.brand ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4 10-10" /></svg>
                    ) : "+"}
                  </span>
                </button>
                <button
                  className="pcx-role-main"
                  title={t(meta.brand ? "photo.brand.onCard" : "photo.brand.showIt")}
                  onClick={() => setMeta((m) => ({ ...m, brand: !m.brand }))}
                >
                  <span className="pcx-role-txt">
                    <b>{t("photo.brand.mark")}</b>
                    <i>{t(meta.brand ? BRAND_FORMS.find((b) => b.v === brandVariant)!.title : "photo.brand.hidden")}</i>
                  </span>
                </button>
              </div>
              {meta.brand && (
                <>
                  <div className="pcx-segs tight forms">
                    {BRAND_FORMS.map((b) => (
                      <button
                        key={b.v}
                        className={brandVariant === b.v ? "on" : ""}
                        title={t(b.title)}
                        onClick={() => setBrandVariant(b.v)}
                      >{t(b.label)}</button>
                    ))}
                  </div>
                  {/* THE THREE CORNERS ARE A SHORTCUT, NOT THE CEILING.
                      Pressing one puts the mark back on the card's own baseline and clears any
                      position the user had dragged it to — which is what makes it a way back as well
                      as a way to start. PHYSICAL, and pinned left-to-right so the button on the left
                      is the one that puts the mark on the left, in both languages. */}
                  <div className="pcx-segs tight places" dir="ltr">
                    {BRAND_PLACES.map((b) => (
                      <button
                        key={b.v}
                        className={!brandPos && brandAlign === b.v ? "on" : ""}
                        title={t(b.title)}
                        onClick={() => { setBrandAlign(b.v); setBrandPos(null); }}
                      >
                        <svg width="15" height="12" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <path d={b.path} />
                        </svg>
                      </button>
                    ))}
                  </div>
                  {/* THE MARK'S FACE — one control, and only one.
                      It is a lockup, not a paragraph: the reader chooses the family and everything
                      else about it (its size, the gap, the divider, where it sits) stays measured
                      from `brandSize`, so this cannot move the mark or change what it collides
                      with. There is deliberately no weight, no spacing and no second family for the
                      Arabic half — the two halves are one piece of artwork and are set together.
                      «خطّ سَرْد» is the same `Picker`, with the same faces, that the toolbar offers
                      for any other text, so a face imported into Sard is available here too. */}
                  <Picker
                    width={148}
                    title={t("photo.brand.font")}
                    value={brandFont ?? ""}
                    options={[
                      { value: "", label: t("photo.brand.fontOwn") },
                      ...fontChoices.map((f) => ({ value: f.key, label: f.label, family: f.key })),
                    ]}
                    onPick={(v: string) => setBrandFont(v || null)}
                  />
                  <SliderField
                    label={t("photo.brand.size")}
                    value={Math.round(brandSize * composition.canvas.w)}
                    onChange={(v) => setBrandSize(v / composition.canvas.w)}
                    min={Math.round(0.012 * composition.canvas.w)}
                    max={Math.round(0.18 * composition.canvas.w)}
                    softMin={Math.round(0.02 * composition.canvas.w)}
                    softMax={Math.round(0.08 * composition.canvas.w)}
                    step={1} unit="px" precision={0} width={44}
                  />
                  <SliderField
                    label={t("photo.el.opacity")}
                    value={Math.round(brandOpacity * 100)}
                    onChange={(v) => setBrandOpacity(v / 100)}
                    min={5} max={100} step={1} unit="%" precision={0} width={42}
                  />
                  {/* Its exact place, once it has one. Dragging the mark on the card is the way in;
                      these are the way to be precise about where it landed. */}
                  {brandPos && (
                    <div className="pcx-pair">
                      <ScrubField
                        label={t("photo.ground.posX")}
                        value={Math.round(brandPos.x * 100)}
                        onChange={(v) => setBrandPos((p) => ({ x: v / 100, y: p ? p.y : 0.9 }))}
                        min={-20} max={120} step={1} unit="%" precision={0} width={44}
                      />
                      <ScrubField
                        label={t("photo.ground.posY")}
                        value={Math.round(brandPos.y * 100)}
                        onChange={(v) => setBrandPos((p) => ({ x: p ? p.x : 0.08, y: v / 100 }))}
                        min={-20} max={120} step={1} unit="%" precision={0} width={44}
                      />
                    </div>
                  )}
                  <p className="pcx-note">{t("photo.brand.dragHint")}</p>
                </>
              )}
            </section>

            </div>
            {/* Outside the scroller: it is the rule the whole column depends on, so it does not get
                to be the thing that falls below the fold when the mark's controls open. */}
            <p className="pcx-railnote">{t("photo.rail.note")}</p>
          </nav>

          {/* ── WORKSPACE. The canvas is the centre; everything else floats over it. ─────────── */}
          <div className={`pcx-work${inspectorOpen ? "" : " solo"}`} ref={workRef} onPointerDown={() => { setSelectedId(null); setBgMode(false); }}>
            <ObjectsStrip
              comp={composition}
              selectedId={selectedId}
              onSelect={(id) => { setBgMode(false); setSelectedId(id); }}
              zoom={zoom}
              onZoom={(z) => setZoom(z === "fit" ? 1 : z)}
              inspectorOpen={inspectorOpen}
              /* Offered only where the geometry is tight. At comfortable widths the panel is simply
                 there, and a control to dismiss something that is not in the way would be one more
                 thing in a row that is already the busiest part of the workspace. */
              onToggleInspector={inspectorHasRoom ? undefined : () => setInspectorChoice(!inspectorOpen)}
            />

            <div className="pcx-wrap" style={{ width: natW * viewScale, height: naturalH * viewScale }}>
              <div style={{ transform: `scale(${viewScale})`, transformOrigin: "top left", width: natW, height: naturalH }}>
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
                  composition={composition}
                  assetUrl={assetUrl}
                  editingId={editingId}
                  onNeedsRoom={fitToText}
                />
              </div>
              {/* Outside the scaled wrapper: a handle inside it would shrink with the preview, and a
                  handle inside the CARD would be exported. */}
              <CardOverlay
                comp={composition}
                width={natW * viewScale}
                height={naturalH * viewScale}
                rtl={(composition.canvas.dir ?? data.dir) === "rtl"}
                selectedId={selectedId}
                onSelect={(id) => { setBgMode(false); setSelectedId(id); }}
                onMove={(id, dx, dy) => edit((c) => moveBy(c, id, dx, dy))}
                onResize={(id, grip: ResizeGrip, dx, dy) => edit((c) => resizeBy(c, id, grip, dx, dy))}
                onCommit={() => undefined}
                parts={parts}
                onLiftPart={liftPart}
                editingId={editingId}
                ground={bgMode && ground.kind === "image" ? groundHand : undefined}
                brand={meta.brand ? brandHand : undefined}
                family={resolvedQuoteFont}
                autoFrac={autoFrac}
                emptyLabel={emptyLabel}
                onBeginEdit={(id) => { setSelectedId(id); setEditingId(id); }}
                onEditText={(text) => selected && edit((c) => updateText(c, selected.id, text))}
                onEndEdit={() => setEditingId(null)}
              />

              {/* The contextual toolbar floats ABOVE the card. Beneath it, it would read as a caption
                  belonging to the page rather than as controls belonging to the selection. */}
              {selected && (
                <CardToolbar
                  selected={selected}
                  canvasW={dim.w}
                  autoFrac={autoFrac}
                  fonts={fontChoices}
                  swatch={selectedSwatch}
                  onStyle={(patch) => edit((c) => updateStyle(c, selected.id, patch))}
                  onImage={(patch) => edit((c) => updateImage(c, selected.id, patch))}
                  onEditText={() => setEditingId(selected.id)}
                  onRemove={() => removeSelected(selected.id)}
                  onReplaceImage={() => { void replaceImage(); }}
                />
              )}
            </div>

            {/* ── INSPECTOR: an overlay beside the canvas, never a column of the page ──────────
                STILL AN OVERLAY, and still never a column: what changed is only whether it is on
                screen at all. Below the width where the card and the panel stop fitting together it
                is not rendered, its 372px reservation is released to the stage, and the strip offers
                the way back. Opening it there puts it back over the canvas exactly as it always sat
                — the model is unchanged, the room is simply no longer held for a panel that is not
                there. */}
            {inspectorOpen && (
            <aside className="pcx-insp" onPointerDown={(e) => e.stopPropagation()}>
              <header className="pcx-insp-head">
                <span className={`pcx-insp-dot ${bgMode ? "bg" : selected ? selected.kind : "doc"}`} aria-hidden />
                <span className="pcx-insp-name">
                  <b>{bgMode ? t("photo.ground") : selected && selected.kind !== "unknown" ? t(`photo.el.${selected.kind}`) : t("photo.insp.card")}</b>
                  <i>{bgMode ? t("photo.insp.bgSub") : selected ? t("photo.insp.elSub") : t("photo.insp.cardSub")}</i>
                </span>
              </header>

              {bgMode ? (
                <div className="pcx-bg">
                  <div
                    className="pcx-bg-prev"
                    style={ground.kind === "image" ? { backgroundImage: `url(${assetUrl(ground.assetId) ?? ""})` } : undefined}
                  >
                    {ground.kind !== "image" && <span>{t("photo.insp.noBg")}</span>}
                  </div>
                  <div className="pcx-bg-row">
                    <button className="pcx-bg-pick" onClick={() => void setBackground()}>{t("photo.add.background")}</button>
                    {ground.kind === "image" && (
                      <button className="pcx-bg-clear" onClick={() => setGround({ kind: "theme", themeId })}>{t("photo.add.removeBackground")}</button>
                    )}
                  </div>
                  {ground.kind === "image" && (
                    <>
                      {/* HOW THE PICTURE SITS. A ground is the one thing on a card that is almost
                          never the right shape, so filling or fitting it, and choosing WHICH part of
                          it survives the crop, is not a refinement — it is how the photograph is
                          placed at all. */}
                      <div className="pcx-segs">
                        {(["cover", "contain"] as const).map((fitv) => (
                          <button
                            key={fitv}
                            className={(ground.fit ?? "cover") === fitv ? "on" : ""}
                            onClick={() => setGround((g) => (g.kind === "image" ? { ...g, fit: fitv } : g))}
                          >{t(`photo.fit.${fitv}`)}</button>
                        ))}
                      </div>
                      {/* THE PICTURE IS PLACED BY HAND FIRST. Drag it on the card, scroll to zoom;
                          these are the same values afterwards, exactly. */}
                      <p className="pcx-note">{t("photo.ground.dragHint")}</p>
                      <div className="pcx-pair">
                        <ScrubField
                          label={t("photo.ground.posX")}
                          value={Math.round((ground.offsetX ?? 0) * 100)}
                          onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, offsetX: v / 100 } : g))}
                          min={-200} max={200} step={1} unit="%" precision={0} width={44}
                        />
                        <ScrubField
                          label={t("photo.ground.posY")}
                          value={Math.round((ground.offsetY ?? 0) * 100)}
                          onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, offsetY: v / 100 } : g))}
                          min={-200} max={200} step={1} unit="%" precision={0} width={44}
                        />
                      </div>
                      {/* Zoom is the one people reach for constantly, so it gets the track. 100–300%
                          is the useful span; the field still reaches 20–600%. */}
                      <SliderField
                        label={t("photo.ground.zoom")}
                        value={Math.round((ground.scale ?? 1) * 100)}
                        onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, scale: v / 100 } : g))}
                        min={GROUND_SCALE_MIN * 100} max={GROUND_SCALE_MAX * 100}
                        softMin={100} softMax={300} step={1} unit="%" precision={0} width={48}
                      />
                      <button
                        className="pcx-ghost"
                        onClick={() => setGround((g) => (g.kind === "image"
                          ? { kind: "image", assetId: g.assetId, themeId: g.themeId, fit: g.fit, blur: g.blur, scrim: g.scrim }
                          : g))}
                      >{t("photo.ground.recentre")}</button>
                      {/* The focal point is what the CROP keeps when the picture is bigger than the
                          card — a different question from where the picture has been pushed. */}
                      <div className="pcx-pair">
                        <ScrubField
                          label={t("photo.ground.focalX")}
                          value={Math.round((ground.focalX ?? 0.5) * 100)}
                          onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, focalX: v / 100 } : g))}
                          min={0} max={100} step={1} unit="%" precision={0} width={44}
                        />
                        <ScrubField
                          label={t("photo.ground.focalY")}
                          value={Math.round((ground.focalY ?? 0.5) * 100)}
                          onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, focalY: v / 100 } : g))}
                          min={0} max={100} step={1} unit="%" precision={0} width={44}
                        />
                      </div>
                      {/* THE SAME CONTROL THE PICTURE ELEMENTS HAVE, on the same kind of object.
                          It acts on the GROUND alone: a foreground picture is a different element
                          with its own flip, and neither can reach the other. */}
                      <FlipRow
                        label={t("photo.el.flip")}
                        flipX={!!ground.flipX}
                        flipY={!!ground.flipY}
                        onX={() => setGround((g) => (g.kind === "image" ? { ...g, flipX: !g.flipX } : g))}
                        onY={() => setGround((g) => (g.kind === "image" ? { ...g, flipY: !g.flipY } : g))}
                        labelX={t("photo.el.flipH")}
                        labelY={t("photo.el.flipV")}
                      />
                      <SliderField
                        label={t("photo.el.opacity")}
                        value={Math.round((ground.opacity ?? 1) * 100)}
                        onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, opacity: v / 100 } : g))}
                        min={0} max={100} step={1} unit="%" precision={0} width={42}
                      />
                      {/* Blur first, veil second: softening a busy photograph carries text where a
                          flat veil only dims it, and a veil heavy enough to rescue text on its own
                          defeats the reason for putting a photograph there. */}
                      <SliderField
                        label={t("photo.ground.blur")}
                        value={ground.blur ?? 0}
                        onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, blur: v } : g))}
                        min={0} max={60} softMin={0} softMax={24} step={0.5} unit="px" precision={1} width={42}
                      />
                      <SliderField
                        label={t("photo.ground.veil")}
                        value={Math.round((ground.scrim ?? 0) * 100)}
                        onChange={(v) => setGround((g) => (g.kind === "image" ? { ...g, scrim: v / 100 } : g))}
                        min={0} max={95} step={1} unit="%" precision={0} width={42}
                      />
                    </>
                  )}
                </div>
              ) : (

              <Inspector
                comp={composition}
                selected={selected}
                canvas={{ w: composition.canvas.w, h: composition.canvas.h }}
                doc={docControls}
                onStyle={(patch) => selected && edit((c) => updateStyle(c, selected.id, patch))}
                onText={(text) => selected && edit((c) => updateText(c, selected.id, text))}
                onImage={(patch) => selected && edit((c) => updateImage(c, selected.id, patch))}
                onRect={(rect) => selected && edit((c) => setPlacement(c, selected.id, { rect }))}
                onRotate={(deg) => selected && edit((c) => setPlacement(c, selected.id, { rotate: deg }))}
                onRemove={() => { if (selected) removeSelected(selected.id); }}
                onOrder={(dir) => selected && edit((c) =>
                  dir === "front" ? bringToFront(c, selected.id)
                  : dir === "forward" ? bringForward(c, selected.id)
                  : dir === "backward" ? sendBackward(c, selected.id)
                  : sendToBack(c, selected.id))
                }
                onReplaceImage={() => { void replaceImage(); }}
                onClearImage={() => { if (selected) removeSelected(selected.id); }}
              />
              )}
            </aside>
            )}
          </div>
        </div>
        {/* ── WHAT TO DO WITH IT, WHERE YOU ARRIVE HAVING FINISHED ────────────────────────────
            At the top these three sat beside the card's NAME, which is where you look before you
            have made anything. Composing runs down the card; the end of that is the foot, and the
            end of the work is here. They are also three different things and used to read as three
            similar buttons — each says what it leaves behind now, and only one of them is the one
            that keeps the card editable. */}
        {/* ── THE THREE WAYS THIS ENDS ────────────────────────────────────────────────────────
            One of them keeps the card; the other two take a copy of it away. So the two that take a
            copy sit together as a pair, and the one that keeps it stands apart and filled.

            What was wrong was not the grouping but the WEIGHT. The pair was transparent on the
            chrome with a hairline around it, which reads as a caption you can click rather than as
            a control - beside a filled primary it looked like an afterthought. Both now sit on the
            editor's raised surface with their own edge, the same surface every other control in
            this editor uses, so the three read as one family with one of them plainly first. */}
        <footer className="pcx-foot">
          <span className="pcx-foot-note">{t("photo.act.hint")}</span>
          <div className="pcx-foot-actions">
            <div className="pcx-foot-pair">
              <button className="pcx-act" onClick={onCopy} disabled={busy} aria-busy={working === "copy"}>
                {working === "copy" ? <span className="pcx-act-spin" aria-hidden /> : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>

                <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />

              </svg>
                )}
                <span>
                  <b>{t("photo.act.copy")}</b>
                  <i>{t("photo.act.copySub")}</i>
                </span>
                            {/* Sits OVER the button, so the words underneath keep their space and nothing
                  about the footer moves when the result arrives. */}
              {done?.act === "copy" && (
                <span className="pcx-act-done" role="status">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12.5l5 5L20 6.5" /></svg>
                  <b>{done.label}</b>
                </span>
              )}
</button>
              <button className="pcx-act" onClick={onSave} disabled={busy} aria-busy={working === "export"}>
                {working === "export" ? <span className="pcx-act-spin" aria-hidden /> : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>

                <path d="M12 3v12M8 11l4 4 4-4M4 19h16" />

              </svg>
                )}
                <span>
                  <b>{t("photo.act.export")}</b>
                  <i>{t("photo.act.exportSub")}</i>
                </span>
                            {/* Sits OVER the button, so the words underneath keep their space and nothing
                  about the footer moves when the result arrives. */}
              {done?.act === "export" && (
                <span className="pcx-act-done" role="status">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12.5l5 5L20 6.5" /></svg>
                  <b>{done.label}</b>
                </span>
              )}
</button>
            </div>
            <button className="pcx-act primary" onClick={onSaveInApp} disabled={busy} aria-busy={working === "keep"}>
              {working === "keep" ? <span className="pcx-act-spin" aria-hidden /> : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>

                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z" /><path d="M9 3v8l3-2 3 2V3" />

              </svg>
              )}
              <span>
                <b>{t("photo.act.keep")}</b>
                <i>{t("photo.act.keepSub")}</i>
              </span>
                        {/* Sits OVER the button, so the words underneath keep their space and nothing
                about the footer moves when the result arrives. */}
            {done?.act === "keep" && (
              <span className="pcx-act-done" role="status">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12.5l5 5L20 6.5" /></svg>
                <b>{done.label}</b>
              </span>
            )}
</button>
          </div>
        </footer>
        {toast && <div className="pc-toast">{toast}</div>}
      </div>
      <AskBeforeLeaving
        open={askClose}
        onKeep={() => { setAskClose(false); void onSaveInApp(); }}
        onStay={() => setAskClose(false)}
        onDiscard={() => { setAskClose(false); onClose(); }}
      />
    </div>
  );
}

/**
 * THE ONE QUESTION THIS EDITOR ASKS — on Sard's dialog layer, not on the editor's.
 *
 * It used to be a `<div class="pcx-ask">` inside the composer, `position: absolute; inset: 0`. That
 * reads as correct and is not: `.pcx-modal` is the containing block, so measured at 1600×1000 the
 * backdrop covered 1502×938 and stopped at the editor's rounded edge. The 48px of desk around it was
 * live — `elementFromPoint` in that margin returned the composer's own scrim, so the question that
 * claimed to be modal could be clicked straight past. It also had no focus trap, no Escape, and no
 * accessible name, because none of that comes with an absolutely positioned div.
 *
 * Sard already answers all of it: `useDialog` (focus in, Tab trapped, Escape, name, focus restored),
 * `useScrimDismiss` (press-outside with a near-miss guard), `.pf-dialog-scrim` on `document.body`.
 * The editor gets the same dialog every other Sard surface asks its questions with, and the answers
 * are unchanged — keep, stay, discard, with Escape meaning STAY.
 */
function AskBeforeLeaving({ open, onKeep, onStay, onDiscard }: {
  open: boolean;
  onKeep: () => void;
  onStay: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  // Escape and a press outside both mean STAY: a stray gesture must never save or discard for them.
  const dlg = useDialog({ onDismiss: onStay });
  const scrim = useScrimDismiss(onStay);
  if (!open) return null;
  return createPortal(
    <div className="pf-dialog-scrim pcx-ask-scrim" {...scrim.scrimProps}>
      <div
        className="pf-dialog"
        onClick={(e) => e.stopPropagation()}
        ref={(node) => { dlg.ref(node); scrim.panelRef(node); }}
        {...dlg.props}
      >
        <div className="pf-dialog-title" id={dlg.titleId}>{t("photo.close.title")}</div>
        <p className="pf-dialog-body">{t("photo.close.body")}</p>
        <div className="pf-dialog-actions">
          {/* Discarding is the quiet one and stands apart from the two that keep the work. */}
          <button className="pf-btn danger pcx-ask-drop" onClick={onDiscard}>
            {t("photo.close.discard")}
          </button>
          <button className="pf-btn" onClick={onStay}>{t("photo.close.stay")}</button>
          <button className="pf-btn primary" onClick={onKeep}>{t("photo.act.keep")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
