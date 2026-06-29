// Annotations panel (RAWY-21, band C-II): a trailing-side slide-in panel with Notes |
// Highlights tabs that READ what RAWY-20 stored. Each item shows its chapter label; click
// jumps to its location via CFI. Notes are editable/deletable inline and can be added as a
// standalone "margin note" at the current spot (the affordance deferred from RAWY-20).
// Highlights can be recoloured or deleted from the list. State comes from useAnnotations,
// so the in-context layer and this panel always agree. Mirrors with the BOOK direction.

import { useEffect, useState, type CSSProperties } from "react";

import { useI18n } from "../../i18n";
import { THEMES, useTheme } from "../../theme";
import { useReader } from "../../reader-engine/store";
import { useAnnotations } from "./annotationsStore";
import type { HighlightColor, HighlightRow, NoteRow } from "../../lib/ipc";

const COLORS: HighlightColor[] = ["amber", "rose", "sky", "green", "purple"];
const slot = (c: string | null | undefined): HighlightColor => (COLORS.includes(c as HighlightColor) ? (c as HighlightColor) : "amber");

function useHl() {
  const id = useTheme((s) => s.themeId);
  return THEMES[id].colors.highlight;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onJump: (cfi: string) => void;
  isRtlBook: boolean;
  initialTab?: "notes" | "highlights";
}

export function AnnotationsPanel({ open, onClose, onJump, isRtlBook, initialTab = "notes" }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"notes" | "highlights">(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const highlights = useAnnotations((s) => s.highlights);
  const notes = useAnnotations((s) => s.notes);
  const dir = isRtlBook ? "rtl" : "ltr";

  return (
    <aside className={`reader-panel rp-trail${open ? " show" : ""}`} dir={dir} aria-hidden={!open}>
      <div className="rp-head">
        <div className="rp-tabs">
          <button className={`rp-tab${tab === "notes" ? " on" : ""}`} onClick={() => setTab("notes")}>
            {t("panel.notes")} <span className="rp-count">{notes.length}</span>
          </button>
          <button className={`rp-tab${tab === "highlights" ? " on" : ""}`} onClick={() => setTab("highlights")}>
            {t("panel.highlights")} <span className="rp-count">{highlights.length}</span>
          </button>
        </div>
        <button className="rp-x" onClick={onClose} aria-label="✕">✕</button>
      </div>

      <div className="rp-scroll">
        {tab === "notes" ? (
          <NotesTab highlights={highlights} notes={notes} onJump={onJump} />
        ) : (
          <HighlightsTab highlights={highlights} onJump={onJump} />
        )}
      </div>
    </aside>
  );
}

function NotesTab({ highlights, notes, onJump }: { highlights: HighlightRow[]; notes: NoteRow[]; onJump: (cfi: string) => void }) {
  const { t } = useI18n();
  const hl = useHl();
  const updateNote = useAnnotations((s) => s.updateNote);
  const deleteNote = useAnnotations((s) => s.deleteNote);
  const addMarginNote = useAnnotations((s) => s.addMarginNote);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [marginDraft, setMarginDraft] = useState("");

  const locate = (n: NoteRow): string | null =>
    n.cfi ?? highlights.find((h) => h.id === n.highlight_id)?.cfi ?? null;

  const addMargin = async () => {
    const cfi = useReader.getState().cfi;
    const chapter = useReader.getState().chapterLabel;
    if (!cfi || !marginDraft.trim()) {
      setComposing(false);
      setMarginDraft("");
      return;
    }
    await addMarginNote(cfi, "amber", marginDraft, chapter);
    setComposing(false);
    setMarginDraft("");
  };

  return (
    <>
      <div className="rp-toolrow">
        {composing ? (
          <div className="rp-compose">
            <textarea
              className="rp-textarea"
              autoFocus
              value={marginDraft}
              onChange={(e) => setMarginDraft(e.target.value)}
              placeholder={t("hl.addNote")}
              dir="auto"
              rows={3}
            />
            <div className="rp-compose-foot">
              <button className="rp-mini" onClick={() => { setComposing(false); setMarginDraft(""); }}>{t("note.cancel")}</button>
              <button className="rp-mini primary" onClick={addMargin}>{t("hl.save")}</button>
            </div>
          </div>
        ) : (
          <button className="rp-add" onClick={() => setComposing(true)}>＋ {t("panel.addMarginNote")}</button>
        )}
      </div>

      {notes.length === 0 && <div className="rp-empty">{t("panel.noNotes")}</div>}

      {notes.map((n) => {
        const target = locate(n);
        const editing = editId === n.id;
        return (
          <div key={n.id} className="rp-item note-item" style={{ "--swatch": hl[slot(n.color)] } as CSSProperties}>
            <div className="rp-item-head">
              <span className="rp-chapter" onClick={() => target && onJump(target)} role="button" tabIndex={0}>
                {n.chapter_label || (n.highlight_id ? "" : t("panel.marginNote"))}
              </span>
              <div className="rp-item-actions">
                <button className="rp-mini" onClick={() => { setEditId(n.id); setDraft(n.body ?? ""); }}>{t("note.edit")}</button>
                <button className="rp-mini danger" onClick={() => deleteNote(n.id)}>{t("note.delete")}</button>
              </div>
            </div>
            {editing ? (
              <div className="rp-compose">
                <textarea className="rp-textarea" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} dir="auto" rows={3} />
                <div className="rp-compose-foot">
                  <button className="rp-mini" onClick={() => setEditId(null)}>{t("note.cancel")}</button>
                  <button className="rp-mini primary" onClick={async () => { await updateNote(n.id, draft, n.color); setEditId(null); }}>{t("hl.save")}</button>
                </div>
              </div>
            ) : (
              <div className="rp-note-body" onClick={() => target && onJump(target)}>{n.body}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

function HighlightsTab({ highlights, onJump }: { highlights: HighlightRow[]; onJump: (cfi: string) => void }) {
  const { t } = useI18n();
  const hl = useHl();
  const setColor = useAnnotations((s) => s.setColor);
  const removeHighlight = useAnnotations((s) => s.removeHighlight);

  return (
    <>
      {highlights.length === 0 && <div className="rp-empty">{t("panel.noHighlights")}</div>}
      {highlights.map((h) => (
        <div key={h.id} className="rp-item hi-item" style={{ "--swatch": hl[slot(h.color)] } as CSSProperties}>
          <div className="rp-item-head">
            <span className="rp-chapter" onClick={() => onJump(h.cfi)} role="button" tabIndex={0}>{h.chapter_label}</span>
            <button className="rp-mini danger" onClick={() => removeHighlight(h.id)}>{t("note.delete")}</button>
          </div>
          <div className="rp-excerpt" onClick={() => onJump(h.cfi)}>{h.text_excerpt}</div>
          <div className="rp-dots">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`rp-dot${h.color === c ? " active" : ""}`}
                style={{ background: hl[c] }}
                onClick={() => setColor(h.id, c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
