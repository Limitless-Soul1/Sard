// In-context highlights + notes (RAWY-20). Selecting text shows a floating toolbar (5
// theme colours + Note); clicking a highlight opens a popover to recolour, note, or
// remove it. Highlights are anchored by CFI through foliate's overlayer (they re-draw
// across reflow/zoom/font and reopen); colour is stored as a SEMANTIC slot so it adapts
// to the theme. All chrome via theme tokens. Notes attach to a highlight (highlight_id).

import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { useI18n } from "../../i18n";
import { THEMES, useTheme } from "../../theme";
import { useReader } from "../../reader-engine/store";
import type { AnchorRect, AnnotationHit, FoliateController, SelectionInfo } from "../../reader-engine/FoliateController";
import {
  highlightCreate,
  highlightDelete,
  highlightSetColor,
  highlightsForBook,
  noteCreate,
  noteDelete,
  notesForBook,
  type HighlightColor,
  type HighlightRow,
  type NoteRow,
} from "../../lib/ipc";

const COLORS: HighlightColor[] = ["amber", "rose", "sky", "green", "purple"];

function useHl() {
  const id = useTheme((s) => s.themeId);
  return THEMES[id].colors.highlight;
}

// Place the floating UI centred over the selection; clamp to the viewport, flip below if
// there isn't room above. `below` is decided by the caller via the rect's top.
function anchorStyle(rect: AnchorRect, below: boolean): CSSProperties {
  const left = Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);
  return below ? { left, top: rect.bottom + 10 } : { left, top: rect.top - 10 };
}

function SelectionToolbar({
  sel,
  onColor,
  onNote,
}: {
  sel: SelectionInfo;
  onColor: (c: HighlightColor) => void;
  onNote: () => void;
}) {
  const { t } = useI18n();
  const hl = useHl();
  const below = sel.rect.top < 90;
  return (
    <div
      className={`hl-bar${below ? " below" : ""}`}
      style={anchorStyle(sel.rect, below)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="hl-dots">
        {COLORS.map((c) => (
          <button key={c} className="hl-dot" style={{ background: hl[c] }} onClick={() => onColor(c)} aria-label={c} />
        ))}
      </div>
      <span className="hl-sep" />
      <button className="hl-action" onClick={onNote}>
        <span className="hl-pen" aria-hidden>✎</span>
        {t("hl.note")}
      </button>
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
  const hl = useHl();
  const [body, setBody] = useState(note?.body ?? "");
  useEffect(() => setBody(note?.body ?? ""), [note?.id, hi.id]);
  const below = hit.rect.top < 150;
  return (
    <div
      className={`hl-card${below ? " below" : ""}`}
      style={anchorStyle(hit.rect, below)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="hl-dots">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`hl-dot${hi.color === c ? " active" : ""}`}
            style={{ background: hl[c] }}
            onClick={() => onColor(c)}
            aria-label={c}
          />
        ))}
        <span className="hl-grow" />
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
  bookId,
  reloadKey,
}: {
  ctrlRef: RefObject<FoliateController | null>;
  bookId: string | null;
  reloadKey: number;
}) {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [active, setActive] = useState<AnnotationHit | null>(null);
  const hiRef = useRef<Map<string, HighlightRow>>(new Map()); // cfi → highlight
  const noteRef = useRef<Map<string, NoteRow>>(new Map()); // highlight_id → note
  const [, force] = useState(0);
  const refresh = () => force((n) => n + 1);

  // Wire the controller's selection + click callbacks once.
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

  // (Re)load this book's highlights + notes and re-apply them to the page.
  useEffect(() => {
    if (!bookId) return;
    let alive = true;
    (async () => {
      const [hs, ns] = await Promise.all([highlightsForBook(bookId), notesForBook(bookId)]);
      if (!alive) return;
      hiRef.current = new Map(hs.map((h) => [h.cfi, h]));
      noteRef.current = new Map(ns.filter((n) => n.highlight_id).map((n) => [n.highlight_id as string, n]));
      await ctrlRef.current?.loadHighlights(hs.map((h) => ({ cfi: h.cfi, color: h.color })));
      refresh();
    })().catch(console.error);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, bookId]);

  const chapter = () => useReader.getState().chapterLabel;

  const createHighlight = useCallback(async (cfi: string, color: HighlightColor, text: string): Promise<HighlightRow | null> => {
    if (!bookId) return null;
    const label = await ctrlRef.current?.addHighlight(cfi, color);
    const row = await highlightCreate(bookId, cfi, color, text, label ?? chapter());
    if (row) hiRef.current.set(cfi, row);
    return row;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  const onPickColor = async (c: HighlightColor) => {
    if (!selection) return;
    await createHighlight(selection.cfi, c, selection.text);
    setSelection(null);
  };
  const onNote = async () => {
    if (!selection) return;
    const row = (await createHighlight(selection.cfi, "amber", selection.text)) ?? hiRef.current.get(selection.cfi);
    setSelection(null);
    if (row) setActive({ cfi: row.cfi, rect: selection.rect }); // open the popover to type
  };

  const activeHi = active ? hiRef.current.get(active.cfi) : undefined;
  const activeNote = activeHi ? noteRef.current.get(activeHi.id) : undefined;

  const changeColor = async (c: HighlightColor) => {
    if (!activeHi) return;
    ctrlRef.current?.setHighlightColor(activeHi.cfi, c);
    const updated = await highlightSetColor(activeHi.id, c);
    if (updated) hiRef.current.set(activeHi.cfi, updated);
    refresh();
  };
  const saveNote = async (rawBody: string) => {
    if (!activeHi || !bookId) return;
    const body = rawBody.trim();
    const existing = noteRef.current.get(activeHi.id);
    if (!body) {
      if (existing) {
        await noteDelete(existing.id);
        noteRef.current.delete(activeHi.id);
      }
    } else {
      const note = await noteCreate({
        bookId,
        highlightId: activeHi.id,
        color: activeHi.color,
        body,
        chapterLabel: activeHi.chapter_label,
      });
      if (note) noteRef.current.set(activeHi.id, note);
    }
    setActive(null);
  };
  const removeHighlight = async () => {
    if (!activeHi) return;
    ctrlRef.current?.removeHighlight(activeHi.cfi);
    await highlightDelete(activeHi.id);
    const note = noteRef.current.get(activeHi.id);
    if (note) await noteDelete(note.id);
    hiRef.current.delete(activeHi.cfi);
    noteRef.current.delete(activeHi.id);
    setActive(null);
  };

  return (
    <>
      {selection && <SelectionToolbar sel={selection} onColor={onPickColor} onNote={onNote} />}
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
