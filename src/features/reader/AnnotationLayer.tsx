// In-context highlights + notes (RAWY-20; RAWY-21 moves data into the shared store).
// Selecting text shows a floating toolbar (5 theme colours + Note); clicking a highlight
// opens a popover to recolour, note, or remove it. Highlights are anchored by CFI through
// foliate's overlayer (they re-draw across reflow/zoom/font and reopen); colour is a
// SEMANTIC slot so it adapts to the theme. State lives in useAnnotations so the side panel
// (AnnotationsPanel) reflects every change.

import { useEffect, useState, type CSSProperties, type RefObject } from "react";

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

// The 8 slot dots + a custom-colour swatch (conic-gradient "+", opens a native picker → #hex).
// `active` is the currently-applied colour (a slot name or a #hex) so the right dot is ringed.
export function ColorRow({ active, onPick }: { active?: string | null; onPick: (c: HighlightColor) => void }) {
  const hl = useHl();
  const custom = isHex(active);
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
      <label className={`hl-dot hl-custom${custom ? " active" : ""}`} style={custom ? { background: active as string } : undefined} title="Custom colour">
        {!custom && <span className="hl-custom-plus" aria-hidden>+</span>}
        <input
          type="color"
          className="hl-custom-input"
          value={custom ? (active as string) : "#C98A5E"}
          onChange={(e) => onPick(e.target.value)}
          aria-label="Custom colour"
        />
      </label>
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

// The redesigned selection toolbar (RAWY-59, design "Selection Toolbar — two-tier popover"):
// a floating dark popover with the COLOUR PALETTE on top (one tap highlights in that ink — no
// highlight sub-step) and, below a hairline, the ACTIONS row (Note · Copy · Create photo card).
// The palette + custom picker keep the RAWY-20 semantic-slot behaviour; RTL mirrors both rows.
function SelectionToolbar({
  sel,
  onColor,
  onNote,
  onCopy,
  onAddToCard,
  onPhotoCard,
}: {
  sel: SelectionInfo;
  onColor: (c: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onAddToCard: () => void;
  onPhotoCard: () => void;
}) {
  const { t } = useI18n();
  const hl = useHl();
  const below = sel.rect.top < 90;
  return (
    <div
      className={`hl-pop${below ? " below" : ""}`}
      style={anchorStyle(sel.rect, below)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* tier 1 — palette (one tap highlights) */}
      <div className="hl-pop-colors">
        {HIGHLIGHT_SLOTS.map((c) => (
          <button key={c} className="hl-pop-swatch" style={{ background: hl[c] }} onClick={() => onColor(c)} aria-label={c} />
        ))}
        <span className="hl-pop-vsep" />
        <label className="hl-pop-custom" title={t("hl.custom")}>
          <span className="hl-pop-custom-dot" aria-hidden>+</span>
          <input type="color" defaultValue="#C98A5E" onChange={(e) => onColor(e.target.value)} aria-label={t("hl.custom")} />
        </label>
      </div>
      {/* hairline */}
      <div className="hl-pop-line" />
      {/* tier 2 — actions (Note · Copy · Add to card · Create photo card) */}
      <div className="hl-pop-actions">
        <button className="hl-pop-act" onClick={onNote}><PenIcon />{t("hl.note")}</button>
        <button className="hl-pop-act" onClick={onCopy}><CopyIcon />{t("hl.copy")}</button>
        <button className="hl-pop-act" onClick={onAddToCard}><AddCardIcon />{t("photo.addToCard")}</button>
        <button className="hl-pop-act primary" onClick={onPhotoCard}><PhotoIcon />{t("photo.card")}</button>
      </div>
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
}: {
  ctrlRef: RefObject<FoliateController | null>;
  onPhotoCard?: (sel: SelectionInfo) => void;
  onAddToCard?: (sel: SelectionInfo) => void;
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismiss on a click anywhere in the parent chrome (toolbars stop propagation).
  useEffect(() => {
    const onDown = () => {
      setSelection(null);
      setActive(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  const store = useAnnotations.getState;

  const onPickColor = async (c: HighlightColor) => {
    if (!selection) return;
    await store().createHighlight(selection.cfi, c, selection.text);
    setSelection(null);
  };
  const onNote = async () => {
    if (!selection) return;
    const row = (await store().createHighlight(selection.cfi, "amber", selection.text)) ?? highlightByCfi(selection.cfi);
    const rect = selection.rect;
    setSelection(null);
    if (row) setActive({ cfi: row.cfi, rect }); // open the popover to type
  };
  const onCopy = () => {
    if (!selection) return;
    navigator.clipboard.writeText(selection.text).catch(console.error);
    setSelection(null);
  };
  // Add to the photo-card basket (RAWY-60) — collect this passage, keep reading, compose later.
  const onAdd = () => {
    if (!selection) return;
    const s = selection;
    setSelection(null);
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
          onNote={onNote}
          onCopy={onCopy}
          onAddToCard={onAdd}
          onPhotoCard={() => {
            const s = selection;
            setSelection(null);
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
