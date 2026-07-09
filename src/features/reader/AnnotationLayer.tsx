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
import { HIGHLIGHT_SLOTS, isHex } from "./highlightColors";
import type { HighlightColor, HighlightRow, NoteRow } from "../../lib/ipc";

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

// The redesigned selection toolbar (RAWY-59, design "Selection Toolbar — two-tier popover"):
// a floating dark popover with the COLOUR PALETTE on top (one tap highlights in that ink — no
// highlight sub-step) and, below a hairline, the ACTIONS row (Note · Copy · Create photo card).
// The palette + custom picker keep the RAWY-20 semantic-slot behaviour; RTL mirrors both rows.
function SelectionToolbar({
  sel,
  onColor,
  onListen,
  onNote,
  onCopy,
  onAddToCard,
  onPhotoCard,
}: {
  sel: SelectionInfo;
  onColor: (c: HighlightColor) => void;
  onListen: () => void;
  onNote: () => void;
  onCopy: () => void;
  onAddToCard: () => void;
  onPhotoCard: () => void;
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
            <button className="hl-pop-act" onClick={onCopy}><CopyIcon />{t("hl.copy")}</button>
            <button className="hl-pop-act" onClick={onAddToCard}><AddCardIcon />{t("photo.addToCard")}</button>
            <button className="hl-pop-act primary" onClick={onPhotoCard}><PhotoIcon />{t("photo.card")}</button>
          </div>
        </>
      )}
    </div>
  );
}

function HighlightPopover({
  hit,
  hi,
  note,
  onColor,
  onSaveNote,
  onRemove,
}: {
  hit: AnnotationHit;
  hi: HighlightRow;
  note: NoteRow | undefined;
  onColor: (c: HighlightColor) => void;
  onSaveNote: (body: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [body, setBody] = useState(note?.body ?? "");
  useEffect(() => setBody(note?.body ?? ""), [note?.id, hi.id]);
  const below = hit.rect.top < 150;
  return (
    <div
      className={`hl-card${below ? " below" : ""}`}
      style={anchorStyle(hit.rect, below)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="hl-card-top">
        <ColorRow active={hi.color} onPick={onColor} />
        <button className="hl-remove" onClick={onRemove}>{t("hl.remove")}</button>
      </div>
      <textarea
        className="hl-note"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("hl.addNote")}
        dir="auto"
        rows={3}
      />
      <div className="hl-card-foot">
        <button className="hl-save" onClick={() => onSaveNote(body)}>{t("hl.save")}</button>
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
  const saveNote = async (body: string) => {
    if (activeHi) await store().saveNoteForHighlight(activeHi, body);
    setActive(null);
  };
  const removeHighlight = async () => {
    if (activeHi) await store().removeHighlight(activeHi.id);
    setActive(null);
  };

  return (
    <>
      {selection && (
        <SelectionToolbar
          sel={selection}
          onColor={onPickColor}
          onListen={onListenSel}
          onNote={onNote}
          onCopy={onCopy}
          onAddToCard={onAdd}
          onPhotoCard={() => {
            const s = selection;
            setSelection(null);
            clearSel();
            onPhotoCard?.(s);
          }}
        />
      )}
      {active && activeHi && (
        <HighlightPopover
          hit={active}
          hi={activeHi}
          note={activeNote}
          onColor={changeColor}
          onSaveNote={saveNote}
          onRemove={removeHighlight}
        />
      )}
    </>
  );
}
