// In-context highlights + notes (RAWY-20; RAWY-21 moves data into the shared store).
// Selecting text shows a floating toolbar (5 theme colours + Note); clicking a highlight
// opens a popover to recolour, note, or remove it. Highlights are anchored by CFI through
// foliate's overlayer (they re-draw across reflow/zoom/font and reopen); colour is a
// SEMANTIC slot so it adapts to the theme. State lives in useAnnotations so the side panel
// (AnnotationsPanel) reflects every change.

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { useI18n } from "../../i18n";
import { THEMES, useTheme } from "../../theme";
import type { AnchorRect, AnnotationHit, FoliateController, SelectionInfo } from "../../reader-engine/FoliateController";
import { useAnnotations } from "./annotationsStore";
import { useReader } from "../../reader-engine/store"; // RAWY-259: the book title for the metadata block
import { useReferences } from "./referencesStore"; // RAWY-260
import { ReferenceDialog, ReferencePopup } from "./ReferenceDialog"; // RAWY-260
import { HIGHLIGHT_SLOTS, isHex } from "./highlightColors";
import { TagPicker } from "./TagPicker";
import { localeNum, uiDateTimeFormat } from "../../lib/format";
// RAWY-259: the ONE ink resolution — the same function the page renderer uses, so the editor preview and
// the mark on the page can never drift apart.
import {
  resolveHighlightInk,
  DEFAULT_INK,
  INK_MIN,
  INK_PAD_X_EM,
  INK_PAD_TOP_EM,
  INK_PAD_BOTTOM_EM,
  INK_RADIUS_EM,
  INK_EDGE_EM,
} from "../../lib/highlightInk";
import { noteTagsFor, noteTagsSet, translate, translatorSettingsGet, type HighlightColor, type HighlightRow, type NoteRow, type RefRow } from "../../lib/ipc";

function useHl() {
  const id = useTheme((s) => s.themeId);
  return THEMES[id].colors.highlight;
}

// The "+" affordance (an SVG, perfectly centred — RAWY-122 ISSUE C) and the back chevron.
const PlusGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
);
// RAWY-260: the reference action glyph — a small bookmark/tag mark drawn in the same stroke language as
// the toolbar's other icons, so the row still reads as one set rather than a bolted-on extra.
const RefIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 4h12v16l-6-4-6 4z" />
  </svg>
);
const BackChevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m15 18-6-6 6-6" />
  </svg>
);

// RAWY-123: a hue → a PALE highlight wash #hex. Fixed L≈72%, S≈60% (per the design) so black/light text
// stays readable under it (the highlight is drawn with the usual translucent wash opacity on top).
function hueHex(h: number): string {
  const s = 0.6;
  const l = 0.72;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hx = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

// RAWY-123: the hybrid custom-colour picker (design "1c — curated first, hue if you want it"). Opened
// from the "+", it REPLACES the popover's rows IN PLACE: a back-to-presets button + title, the eight
// curated slot shades for a fast tap, an "or fine-tune a hue" bar for a free colour, then a preview +
// Apply. A picked slot applies the semantic theme slot (adapts to the theme); a hue applies a pale
// #hex — both drawn as the usual translucent highlight wash. It renders INSIDE `.hl-pop`, so RAWY-122's
// click-away can't close it (the popover stops pointerdown propagation); a click TRULY outside, or Esc,
// still clears the selection. Replaces the RAWY-122 stub; no native <input type="color"> anywhere.
function CustomColorPicker({
  hl,
  onApply,
  onBack,
}: {
  hl: Record<string, string>;
  onApply: (c: HighlightColor) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<HighlightColor>(HIGHLIGHT_SLOTS[0]);
  const [hue, setHue] = useState<number | null>(null); // set once the hue bar is dragged
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const selHex = isHex(selected) ? (selected as string) : hl[selected as string] ?? hl.amber;

  const hueFromX = (clientX: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(360, ((clientX - r.left) / r.width) * 360));
  };
  const pickHue = (clientX: number) => {
    const h = hueFromX(clientX);
    setHue(h);
    setSelected(hueHex(h) as HighlightColor);
  };
  const onHueDown = (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragging.current = true;
    pickHue(e.clientX);
  };
  const onHueMove = (e: React.PointerEvent) => {
    if (dragging.current) pickHue(e.clientX);
  };
  const onHueUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  return (
    <div className="hl-cpick">
      <div className="hl-cpick-head">
        <button type="button" className="hl-cpick-back" onClick={onBack} title={t("hl.backToPresets")} aria-label={t("hl.backToPresets")}>
          <BackChevron />
        </button>
        <span className="hl-cpick-title">{t("hl.custom")}</span>
      </div>
      <div className="hl-cpick-grid">
        {HIGHLIGHT_SLOTS.map((c) => (
          <button
            key={c}
            type="button"
            className={`hl-cpick-swatch${selected === c ? " on" : ""}`}
            style={{ background: hl[c] }}
            onClick={() => { setHue(null); setSelected(c); }}
            aria-label={c}
          />
        ))}
      </div>
      <div className="hl-cpick-or">
        <span className="hl-cpick-rule" />
        <span className="hl-cpick-or-label">{t("hl.orHue")}</span>
        <span className="hl-cpick-rule" />
      </div>
      <div className="hl-cpick-hue" ref={barRef} onPointerDown={onHueDown} onPointerMove={onHueMove} onPointerUp={onHueUp}>
        <div className="hl-cpick-thumb" style={{ left: `${((hue ?? 0) / 360) * 100}%` }}>
          <span className="hl-cpick-thumb-dot" style={{ background: hue != null ? hueHex(hue) : "transparent" }} />
        </div>
      </div>
      <div className="hl-cpick-foot">
        <div className="hl-cpick-preview">
          <span className="hl-cpick-dot" style={{ background: selHex }} />
          <span className="hl-cpick-hex">{selHex.toUpperCase()}</span>
        </div>
        <button type="button" className="hl-cpick-apply" style={{ background: selHex }} onClick={() => onApply(selected)}>
          {t("hl.apply")}
        </button>
      </div>
    </div>
  );
}

// The 8 slot dots + a custom-colour swatch. RAWY-123: the "+" opens the hybrid custom-colour picker
// (in place of the dots); picking a colour recolours the highlight and returns to the dots. `active`
// is the currently-applied colour (a slot name or a #hex) so the right dot is ringed.
// RAWY-259: the ink-density control. NINE bars per the design; the floor stops a mark ever becoming
// invisible, and DEFAULT_INK is what an untouched highlight (alpha NULL = follow the theme) shows in the
// control, so opening the editor on an old highlight never silently changes it.
const INK_BARS = 9; // the design draws the density as nine bars
// Metadata timestamps: day + month is enough for a note, and it localises without a date library.
const fmtStamp = (unix: number, lang: string): string =>
  uiDateTimeFormat(lang, { day: "numeric", month: "long" }).format(new Date(unix * 1000));

export function ColorRow({ active, onPick }: { active?: string | null; onPick: (c: HighlightColor) => void }) {
  const hl = useHl();
  const custom = isHex(active);
  const [picking, setPicking] = useState(false);
  if (picking) {
    return <CustomColorPicker hl={hl} onApply={(c) => { onPick(c); setPicking(false); }} onBack={() => setPicking(false)} />;
  }
  return (
    <div className="hl-dots">
      {HIGHLIGHT_SLOTS.map((c) => (
        <button
          key={c}
          className={`hl-dot${active === c ? " active" : ""}`}
          style={{ background: hl[c] }}
          onClick={() => onPick(c)}
          aria-label={c}
        />
      ))}
      <button
        type="button"
        className={`hl-dot hl-custom${custom ? " active" : ""}`}
        style={custom ? { background: active as string } : undefined}
        onClick={() => setPicking(true)}
        title="Custom colour"
        aria-label="Custom colour"
      >
        {!custom && <span className="hl-custom-plus" aria-hidden><PlusGlyph /></span>}
      </button>
    </div>
  );
}

// Place the floating UI centred over the selection; clamp to the viewport, flip below if
// there isn't room above. `below` is decided by the caller via the rect's top.
function anchorStyle(rect: AnchorRect, below: boolean): CSSProperties {
  const left = Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);
  return below ? { left, top: rect.bottom + 10 } : { left, top: rect.top - 10 };
}

// Action-tier line icons (design's SVGs; stroke = currentColor so they inherit the button ink).
const PenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="11" height="11" rx="2.4" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
  </svg>
);
const PhotoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4.5" width="18" height="15" rx="2.6" /><circle cx="8.4" cy="10" r="1.5" /><path d="m20 17-5.2-5.2L5 19.5" />
  </svg>
);
// "Add to card" (RAWY-60) — a card with a plus: collect this passage into the photo-card basket.
const AddCardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4.5" width="18" height="15" rx="2.6" /><path d="M12 9.2v6.1M8.9 12.2h6.2" />
  </svg>
);
// RAWY-124: Listen — start read-aloud FROM the selection (the TTS waveform, matching the top bar).
const ListenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </svg>
);
// Translate — a globe with an overlaid glyph, in the same 16×16 stroke idiom as the other actions.
const TranslateIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 9h7M7.5 4.5c1.8 2.6 2.5 4.6 2.5 7s-.7 4.4-2.5 7M3 13c1.2 2.5 3.3 4 6 4" />
    <path d="M13 19l3-7 3 7M14.2 17h3.6" />
  </svg>
);

// The redesigned selection toolbar (RAWY-59, design "Selection Toolbar — two-tier popover"):
// a floating dark popover with the COLOUR PALETTE on top (one tap highlights in that ink — no
// highlight sub-step) and, below a hairline, the ACTIONS row (Note · Copy · Create photo card).
// The palette + custom picker keep the RAWY-20 semantic-slot behaviour; RTL mirrors both rows.
function SelectionToolbar({
  sel,
  onColor,
  onListen,
  onReference,
  onNote,
  onCopy,
  onAddToCard,
  onPhotoCard,
  onTranslate,
}: {
  sel: SelectionInfo;
  onColor: (c: HighlightColor) => void;
  onListen: () => void;
  onReference: () => void;
  onNote: () => void;
  onCopy: () => void;
  onAddToCard: () => void;
  onPhotoCard: () => void;
  /** Translate the selection. Absent when translation is disabled in Settings — the button is not
   *  rendered at all, so there is no path to send text to a provider while the feature is off. */
  onTranslate?: () => void;
}) {
  const { t } = useI18n();
  const hl = useHl();
  const below = sel.rect.top < 90;
  // RAWY-123: the "+" opens the hybrid custom-colour picker IN PLACE of the two tiers (back returns).
  const [picking, setPicking] = useState(false);
  return (
    <div
      className={`hl-pop${below ? " below" : ""}`}
      style={anchorStyle(sel.rect, below)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {picking ? (
        <CustomColorPicker hl={hl} onApply={onColor} onBack={() => setPicking(false)} />
      ) : (
        <>
          {/* tier 1 — palette (one tap highlights) */}
          <div className="hl-pop-colors">
            {HIGHLIGHT_SLOTS.map((c) => (
              <button key={c} className="hl-pop-swatch" style={{ background: hl[c] }} onClick={() => onColor(c)} aria-label={c} />
            ))}
            <span className="hl-pop-vsep" />
            <button type="button" className="hl-pop-custom" onClick={() => setPicking(true)} title={t("hl.custom")} aria-label={t("hl.custom")}>
              <span className="hl-pop-custom-dot" aria-hidden><PlusGlyph /></span>
            </button>
          </div>
          {/* hairline */}
          <div className="hl-pop-line" />
          {/* tier 2 — actions. RAWY-124: the FULL set is FIVE — Listen · Note · Copy · Add-to-card ·
              Create-photo-card. Do NOT drop one (listen-from-selection was long missing because it was
              never wired here — it is EPUB-only, and the selection toolbar is EPUB-only, so it always shows). */}
          <div className="hl-pop-actions">
            <button className="hl-pop-act" onClick={onListen}><ListenIcon />{t("tts.listen")}</button>
            <button className="hl-pop-act" onClick={onNote}><PenIcon />{t("hl.note")}</button>
            {/* RAWY-260: ONE new action added to the existing toolbar — the toolbar itself is untouched,
                and RAWY-124's warning still holds: never drop one of the other five. */}
            <button className="hl-pop-act" onClick={onReference}><RefIcon />{t("ref.add")}</button>
            <button className="hl-pop-act" onClick={onCopy}><CopyIcon />{t("hl.copy")}</button>
            {/* Translate — shown only when the feature is enabled in Settings. Sits beside Copy since
                both are read-only "what is this text" actions, leaving the create-* actions grouped. */}
            {onTranslate && (
              <button className="hl-pop-act" onClick={onTranslate}><TranslateIcon />{t("tr.act")}</button>
            )}
            <button className="hl-pop-act" onClick={onAddToCard}><AddCardIcon />{t("photo.addToCard")}</button>
            <button className="hl-pop-act primary" onClick={onPhotoCard}><PhotoIcon />{t("photo.card")}</button>
          </div>
        </>
      )}
    </div>
  );
}

// The Translate result popover — shown in place of the toolbar once a translation is requested.
// Three states: loading (a spinner + the source line), result (the translation + detected source),
// error (the message). It anchors to the SAME rect the toolbar used, so the reader's eye doesn't
// travel. A click outside / Esc dismisses it; the parent AnnotationLayer already wires those.
function TranslatePopover({ sel, onClose }: { sel: SelectionInfo; onClose: () => void }) {
  const { t, dir } = useI18n();
  const [state, setState] = useState<{ k: "loading" } | { k: "ok"; text: string; src: string | null; provider: string } | { k: "err"; msg: string }>({ k: "loading" });
  const below = sel.rect.top < 140;

  useEffect(() => {
    let alive = true;
    translate(sel.text)
      .then((r) => { if (alive) setState({ k: "ok", text: r.text, src: r.detected_source, provider: r.provider }); })
      .catch((e) => { if (alive) setState({ k: "err", msg: String(e) }); });
    return () => { alive = false; };
  }, [sel.text]);

  return (
    <div
      className={`tr-pop${below ? " below" : ""}`}
      dir={dir}
      role="dialog"
      aria-label={t("tr.act")}
      style={anchorStyle(sel.rect, below)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="tr-pop-head">
        <span className="tr-pop-eye">{t("tr.act")}</span>
        <button className="tr-pop-x" onClick={onClose} aria-label="✕">✕</button>
      </div>
      <div className="tr-pop-quote" dir="auto">{sel.text}</div>
      {state.k === "loading" && (
        <div className="tr-pop-loading"><span className="tr-pop-spin" aria-hidden /> {t("tr.loading")}</div>
      )}
      {state.k === "err" && (
        <div className="tr-pop-err">{state.msg}</div>
      )}
      {state.k === "ok" && (
        <>
          <div className="tr-pop-result" dir="auto">{state.text}</div>
          <div className="tr-pop-meta">
            {state.src && <span>{t("tr.source", { lang: state.src })}</span>}
            <button
              className="tr-pop-copy"
              onClick={() => { navigator.clipboard.writeText(state.text).catch(console.error); onClose(); }}
            >
              {t("tr.copy")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// RAWY-259 — THE NOTES EDITOR, compact layout.
// Source of truth: docs/design/Note Editor Compact (standalone).html — 704×480, `grid-template-columns:
// 1fr 254px`, paper section + 254px rail. It REPLACES the earlier 928×664 design entirely; nothing from
// that layout is carried over. The backend it drives (per-highlight alpha, its migration, IPC, Rust
// command, store action and the shared ink renderer) is untouched — this is the UI it connects to.
//
// CENTRED BY CONSTRUCTION: a fixed full-viewport scrim flex-centres the sheet, so it is centred on open, at
// any window size and after a resize, with nothing measured and no position ever remembered.
// The «يدعم ماركداون» badge in the design is deliberately NOT implemented — Sard has no markdown renderer
// and the UI must not advertise a feature that does not exist (owner's instruction).
function NoteEditorModal({
  hi,
  note,
  onColor,
  onAlpha,
  onSaveNote,
  onRemove,
  onClose,
}: {
  hi: HighlightRow;
  note: NoteRow | undefined;
  onColor: (c: HighlightColor) => void;
  onAlpha: (a: number) => void;
  onSaveNote: (body: string, tagIds: string[], title: string) => void; // RAWY-282: + title
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t, lang, dir } = useI18n();
  const [body, setBody] = useState(note?.body ?? "");
  const [title, setTitle] = useState(note?.title ?? ""); // RAWY-282
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [alpha, setAlpha] = useState<number>(hi.alpha ?? DEFAULT_INK);
  // The design's quote is collapsible (`qClamp` / `quoteToggleLabel`) — compact by default, expandable when
  // the reader wants the whole passage. Two lines collapsed, per the design's clamp.
  const [quoteOpen, setQuoteOpen] = useState(false);
  const barsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setBody(note?.body ?? "");
    setTitle(note?.title ?? ""); // RAWY-282: reset with the body, on the same note/highlight identity
    setAlpha(hi.alpha ?? DEFAULT_INK);
    if (note?.id) noteTagsFor(note.id).then((ts) => setTagIds(ts.map((x) => x.id))).catch(() => setTagIds([]));
    else setTagIds([]);
  }, [note?.id, hi.id, hi.alpha]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const hl = useHl();
  const themeId = useTheme((s) => s.themeId);
  const themeDark = THEMES[themeId].dark;
  const themePaper = THEMES[themeId].colors.paperBg;
  const inkHex = isHex(hi.color) ? hi.color : (hl[hi.color as keyof typeof hl] ?? hi.color);
  // The preview ink comes from the SHARED resolver the page renderer uses, with the density being dragged —
  // so this is the mark itself, not a representation of it.
  const previewInk = resolveHighlightInk({ ink: inkHex, dark: themeDark, paper: themePaper, alpha });
  const filled = Math.round(alpha * INK_BARS);
  const created = hi.created_at ? fmtStamp(hi.created_at, lang) : null;
  const edited = note?.updated_at ? fmtStamp(note.updated_at, lang) : null;
  const bookTitle = useReader.getState().bookTitle;

  // The density strip: drag or arrow-key, read from the strip's START edge in the current direction.
  const applyFromPointer = (clientX: number) => {
    const el = barsRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const raw = dir === "rtl" ? (r.right - clientX) / r.width : (clientX - r.left) / r.width;
    const v = Math.max(INK_MIN, Math.min(1, raw));
    setAlpha(v);
    onAlpha(v); // live redraw of THIS mark only
  };

  return (
    <div className="nec-scrim" onPointerDown={onClose}>
      <div
        className="nec"
        // The design's root is `dir="rtl"`, so `1fr 254px` puts the paper on the RIGHT and the rail on the
        // LEFT. This modal renders inside `.reader-root`, which pins `direction: ltr`, so the direction is
        // set explicitly here from the UI language — otherwise the whole layout comes out mirrored.
        dir={dir}
        role="dialog"
        aria-modal="true"
        aria-label={t("ne.title")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* PAPER */}
        <section className="nec-paper">
          <div className="nec-grain" aria-hidden />
          <div className="nec-quote-head">
            <span className="nec-eyebrow">{t("ne.passage")}</span>
            <button type="button" className="nec-quote-toggle" onClick={() => setQuoteOpen((v) => !v)} aria-expanded={quoteOpen}>
              {quoteOpen ? t("ne.less") : t("ne.more")}
            </button>
          </div>
          <div className="nec-quote">
            <p dir="auto" className={quoteOpen ? "open" : undefined}>
              {/* RAWY-259: the preview is the SAME mark, not a likeness of it. Colour, blend and opacity
                  come from the shared resolver; padding, radius and the .24em end-fade come from the SAME
                  geometry constants the page renderer grows its rects by — so shape, padding, rendering
                  style and density all match what the reader sees in the book. */}
              <span
                className="nec-mark"
                style={{
                  background: previewInk.fill,
                  mixBlendMode: previewInk.blend,
                  opacity: previewInk.opacity,
                  padding: `${INK_PAD_TOP_EM}em ${INK_PAD_X_EM}em ${INK_PAD_BOTTOM_EM}em`,
                  borderRadius: `${INK_RADIUS_EM}em`,
                  ["--nec-edge" as string]: `${INK_EDGE_EM}em`,
                }}
              >
                {hi.text_excerpt ?? ""}
              </span>
            </p>
          </div>
          <div className="nec-rule-row">
            <span className="nec-eyebrow">{t("ne.myNote")}</span>
            <span className="nec-rule" />
          </div>
          {/* RAWY-282: optional title, above the body and inside the same section, so the editor reads
              "Title / Note" exactly as the panel's does. Single-line by design — a heading, not a
              second body — and `dir={dir}` for the same reason the textarea uses it (RAWY-259: an empty
              field under dir="auto" resolves LTR and puts the caret on the wrong side in an Arabic UI). */}
          <input
            className="nec-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("note.titlePlaceholder")}
            aria-label={t("note.title")}
            dir={dir}
            maxLength={120}
          />
          <textarea
            className="nec-note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("ne.placeholder")}
            aria-label={t("ne.myNote")}
            // RAWY-259: NOT dir="auto" — with an EMPTY field auto resolves to LTR, so in an Arabic UI the
            // caret started on the left. Following the UI direction puts it on the correct side from the
            // first keystroke; text-align:start then keeps the text on that side as it is typed.
            dir={dir}
            autoFocus
          />
          {/* Character counter only — the design's markdown badge is deliberately omitted. */}
          <div className="nec-foot">
            <span aria-live="polite">{t("ne.chars", { n: localeNum(body.length, lang) })}</span>
          </div>
        </section>

        {/* RAIL */}
        <aside className="nec-rail">
          <div className="nec-rail-head">
            <span className="nec-rail-title">{t("ne.title")}</span>
            <button type="button" className="nec-x" onClick={onClose} aria-label={t("ne.close")} title={t("ne.close")}>✕</button>
          </div>

          <div className="nec-group">
            <div className="nec-group-head">
              <span className="nec-label">{t("ne.colour")}</span>
              <span className="nec-value" dir="auto">{isHex(hi.color) ? hi.color.toUpperCase() : hi.color}</span>
            </div>
            {/* ColorRow carries the 8 slots AND the custom hue/hex picker; the compact sizing is applied by
                `.nec-colors` so the controls match the design without re-implementing their behaviour. */}
            <div className="nec-colors">
              <ColorRow active={hi.color} onPick={onColor} />
            </div>
          </div>

          <div className="nec-density">
            <span className="nec-label">{t("ne.density")}</span>
            <div
              className="nec-bars"
              ref={barsRef}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); applyFromPointer(e.clientX); }}
              onPointerMove={(e) => { if (e.buttons) applyFromPointer(e.clientX); }}
              onKeyDown={(e) => {
                const step = e.key === "ArrowLeft" ? -0.05 : e.key === "ArrowRight" ? 0.05 : 0;
                if (!step) return;
                e.preventDefault();
                const v = Math.max(INK_MIN, Math.min(1, alpha + step));
                setAlpha(v);
                onAlpha(v);
              }}
              role="slider"
              tabIndex={0}
              aria-label={t("ne.density")}
              aria-valuemin={Math.round(INK_MIN * 100)}
              aria-valuemax={100}
              aria-valuenow={Math.round(alpha * 100)}
            >
              {Array.from({ length: INK_BARS }, (_, i) => (
                <span
                  key={i}
                  className="nec-bar"
                  style={{ height: `${38 + i * 6}%`, background: i < filled ? inkHex : undefined }}
                />
              ))}
            </div>
            <span className="nec-value nec-pct">{localeNum(Math.round(alpha * 100), lang)}٪</span>
          </div>

          <div className="nec-group">
            <span className="nec-label">{t("ne.tags")}</span>
            {/* TagPicker provides search, multi-select, create and remove — the tag behaviour the design
                shows, kept intact; `.nec-tags` applies the compact chip sizing. */}
            <div className="nec-tags">
              <TagPicker selected={tagIds} onChange={setTagIds} />
            </div>
          </div>

          {/* Metadata — the design's two-column grid, with ONLY fields Sard actually stores. The design's
              «الموضع» (page · %) has no stored counterpart and is omitted rather than invented. */}
          <div className="nec-meta">
            {bookTitle && (
              <div><div className="nec-meta-k">{t("ne.book")}</div><div className="nec-meta-v" dir="auto">{bookTitle}</div></div>
            )}
            {created && <div><div className="nec-meta-k">{t("ne.created")}</div><div className="nec-meta-v">{created}</div></div>}
            {hi.chapter_label && (
              <div className="nec-meta-wide"><div className="nec-meta-k">{t("ne.chapter")}</div><div className="nec-meta-v" dir="auto">{hi.chapter_label}</div></div>
            )}
            {edited && <div><div className="nec-meta-k">{t("ne.updated")}</div><div className="nec-meta-v">{edited}</div></div>}
          </div>

          <div className="nec-actions">
            <button type="button" className="nec-save" onClick={() => onSaveNote(body, tagIds, title)}>{t("hl.save")}</button>
            <button type="button" className="nec-cancel" onClick={onClose}>{t("ne.cancel")}</button>
            <button type="button" className="nec-del" onClick={onRemove} aria-label={t("ne.delete")} title={t("ne.delete")}>🗑</button>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function AnnotationLayer({
  ctrlRef,
  onPhotoCard,
  onAddToCard,
  onListen,
}: {
  ctrlRef: RefObject<FoliateController | null>;
  onPhotoCard?: (sel: SelectionInfo) => void;
  onAddToCard?: (sel: SelectionInfo) => void;
  onListen?: (sel: SelectionInfo) => void; // RAWY-124: listen-from-selection (start TTS from here)
}) {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [active, setActive] = useState<AnnotationHit | null>(null);
  // The selection currently being translated. When set, the TranslatePopover replaces the toolbar.
  const [trSel, setTrSel] = useState<SelectionInfo | null>(null);
  // Whether translation is enabled in Settings — loaded once. The toolbar button is rendered only
  // when true, so there is no accidental path to a provider while the feature is off.
  const [trEnabled, setTrEnabled] = useState(false);
  useEffect(() => {
    translatorSettingsGet()
      .then((s) => setTrEnabled(s.enabled))
      .catch(() => setTrEnabled(false));
  }, []);
  const highlightByCfi = useAnnotations((s) => s.highlightByCfi);
  const noteForHighlight = useAnnotations((s) => s.noteForHighlight);
  // Subscribe to the arrays so the popover re-renders when the store mutates.
  useAnnotations((s) => s.highlights);
  useAnnotations((s) => s.notes);

  // Wire the controller's selection + click callbacks once (the controller instance is stable).
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    ctrl.onSelection((s) => {
      setSelection(s);
      if (s) setActive(null);
      // The controller fires onSelection(null) on EVERY pointerdown inside the content iframe
      // (FoliateController.ts:1539) — including a plain tap on text, not just a drag-select. So this
      // is the bridge that dismisses the Translate popover when the reader presses anywhere on the
      // book: pointer events inside the iframe never reach the parent-window listener wired in the
      // dismiss() Effect above, but they DO surface here through the controller's selection callback.
      setTrSel(null);
    });
    ctrl.onShowAnnotation((hit) => {
      setSelection(null);
      setActive(hit);
      // RAWY-132: tapping a stored highlight also dismisses any pending fresh text selection — clear the
      // REAL browser selection too (RAWY-122 invariant) so a later pointerup can't re-raise the toolbar.
      ctrl.clearSelection();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismiss on a click anywhere in the parent chrome, or on Esc (toolbars stop propagation). RAWY-122:
  // ALSO clear the REAL text selection — not just the React popover — so a lingering browser selection
  // can't re-fire the toolbar on the next pointerup and the highlighted text doesn't stay visibly
  // selected. Select-to-read is then effortless to cancel (click away / Esc). Esc from inside the
  // reading frame is handled in the controller (the frame has focus there); this covers parent focus.
  useEffect(() => {
    const dismiss = () => {
      setSelection(null);
      setActive(null);
      setTrSel(null); // also drop the Translate result popover on any outside pointerdown/Esc
      ctrlRef.current?.clearSelection();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const store = useAnnotations.getState;

  // RAWY-122: after any action (or dismiss) also drop the live text selection so nothing re-fires.
  const clearSel = () => ctrlRef.current?.clearSelection();
  const onPickColor = async (c: HighlightColor) => {
    if (!selection) return;
    await store().createHighlight(selection.cfi, c, selection.text);
    setSelection(null);
    clearSel();
  };
  const onNote = async () => {
    if (!selection) return;
    const row = (await store().createHighlight(selection.cfi, "amber", selection.text)) ?? highlightByCfi(selection.cfi);
    const rect = selection.rect;
    setSelection(null);
    clearSel();
    if (row) setActive({ cfi: row.cfi, rect }); // open the popover to type
  };
  const onCopy = () => {
    if (!selection) return;
    navigator.clipboard.writeText(selection.text).catch(console.error);
    setSelection(null);
    clearSel();
  };
  // RAWY-124: Listen from the selection — hand the passage up to start read-aloud from here.
  const onListenSel = () => {
    if (!selection) return;
    const s = selection;
    setSelection(null);
    clearSel();
    onListen?.(s);
  };
  // Add to the photo-card basket (RAWY-60) — collect this passage, keep reading, compose later.
  const onAdd = () => {
    if (!selection) return;
    const s = selection;
    setSelection(null);
    clearSel();
    onAddToCard?.(s);
  };

  const activeHi = active ? highlightByCfi(active.cfi) : undefined;
  const activeNote = activeHi ? noteForHighlight(activeHi.id) : undefined;

  const changeColor = (c: HighlightColor) => {
    if (activeHi) store().setColor(activeHi.id, c);
  };
  const saveNote = async (body: string, tagIds: string[], title = "") => {
    if (activeHi) {
      // Save the note first (it returns the row, so we have the note id), THEN set its tags.
      // RAWY-205: a TAG ALONE is enough — with tags but no body we still get a row back (an empty-body
      // anchor note), so the tag persists on a body-less highlight. Only when body AND tags are both
      // empty is there no note (and nothing to tag): the row goes and its links cascade away.
      // RAWY-282: a TITLE alone is enough for the same reason — see `saveNoteForHighlight`.
      const saved = await store().saveNoteForHighlight(activeHi, body, tagIds.length > 0, title);
      if (saved) await noteTagsSet(saved.id, tagIds);
    }
    setActive(null);
  };
  const removeHighlight = async () => {
    if (activeHi) await store().removeHighlight(activeHi.id);
    setActive(null);
  };

  // RAWY-260 — REFERENCES. Two surfaces: the dialog (create AND edit, one path) and the popup shown when
  // the reader taps a marked phrase. A tap on the popup opens the dialog on that reference, which is the
  // edit path — no extra button, and the note is immediately editable.
  const refs = useReferences();
  const [refDialog, setRefDialog] = useState<{ phrase: string; existing: RefRow | null } | null>(null);
  const [refPopup, setRefPopup] = useState<{ row: RefRow; rect: AnchorRect } | null>(null);
  useEffect(() => {
    ctrlRef.current?.onReferenceHit((hit) => {
      const row = useReferences.getState().byId(hit.refId);
      if (row) setRefPopup({ row, rect: hit.rect });
    });
  }, [ctrlRef]);
  const onReference = () => {
    const s = selection;
    if (!s) return;
    const phrase = s.text.trim();
    setSelection(null);
    clearSel();
    // Referencing a phrase that already has one EDITS it rather than creating a duplicate.
    setRefDialog({ phrase, existing: useReferences.getState().byPhrase(phrase) ?? null });
  };

  return (
    <>
      {/* RAWY-260: the reference popup — display only, per the design. Any tap outside closes it; a tap
          ON it opens the dialog for editing. */}
      {refPopup && (
        <>
          <div className="ref-popup-scrim" onPointerDown={() => setRefPopup(null)} />
          <ReferencePopup
            row={refPopup.row}
            rect={refPopup.rect}
            onOpen={() => { setRefDialog({ phrase: refPopup.row.phrase, existing: refPopup.row }); setRefPopup(null); }}
          />
        </>
      )}
      {refDialog && (
        <ReferenceDialog
          phrase={refDialog.phrase}
          existing={refDialog.existing}
          onSave={async (note) => { await refs.save(refDialog.phrase, note); setRefDialog(null); }}
          onDelete={async () => { if (refDialog.existing) await refs.remove(refDialog.existing.id); setRefDialog(null); }}
          onClose={() => setRefDialog(null)}
        />
      )}
      {selection && !trSel && (
        <SelectionToolbar
          sel={selection}
          onColor={onPickColor}
          onListen={onListenSel}
          onReference={onReference}
          onNote={onNote}
          onCopy={onCopy}
          onAddToCard={onAdd}
          onPhotoCard={() => {
            const s = selection;
            setSelection(null);
            clearSel();
            onPhotoCard?.(s);
          }}
          onTranslate={trEnabled ? () => {
            const s = selection;
            // Keep the selection rect for anchoring, but drop the live toolbar + browser selection so
            // the popover owns the surface. trSel replaces `selection` as the rendered anchor.
            setTrSel(s);
            setSelection(null);
            clearSel();
          } : undefined}
        />
      )}
      {trSel && <TranslatePopover sel={trSel} onClose={() => setTrSel(null)} />}
      {active && activeHi && (
        <NoteEditorModal
          hi={activeHi}
          note={activeNote}
          onColor={changeColor}
          onAlpha={(a) => store().setAlpha(activeHi.id, a)}
          onSaveNote={saveNote}
          onRemove={removeHighlight}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}
