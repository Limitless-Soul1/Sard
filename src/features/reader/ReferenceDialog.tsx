import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import type { AnchorRect } from "../../reader-engine/FoliateController";
import type { RefRow } from "../../lib/ipc";

// RAWY-260 — the ADD/EDIT REFERENCE dialog (docs/design/Sard References_Design (standalone).html).
//
// ONE dialog serves creating and editing. The only differences the design allows are that the note field
// arrives pre-filled and Delete appears — the note is ALWAYS editable, never a read-only box, so updating a
// reference takes a keystroke rather than a separate edit mode.
//
// The design fixes the content precisely: eyebrow, the selected phrase read-only, one note field, and the
// actions. Nothing else — no tags, colours, categories or metadata. Its own annotation reads:
// "SAVE · CANCEL · DELETE — Enter saves, Esc cancels; empty note disables Save. حذف sits alone on the
// opposite side and only appears when the reference already exists."
export function ReferenceDialog({
  phrase,
  existing,
  onSave,
  onDelete,
  onClose,
}: {
  /** The text the reader selected (create), or the stored phrase (edit) — shown verbatim, never folded. */
  phrase: string;
  /** The reference being edited, or null when creating. Drives the pre-fill AND whether Delete shows. */
  existing: RefRow | null;
  onSave: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t, dir } = useI18n();
  const [note, setNote] = useState(existing?.note ?? "");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setNote(existing?.note ?? ""), [existing?.id]);
  // "ONE FIELD, AUTOFOCUSED" — the reader should be typing the moment the dialog opens, with the cursor
  // after any existing note so an edit continues rather than overwrites.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const canSave = note.trim().length > 0; // the design disables Save on an empty note
  const save = () => { if (canSave) onSave(note.trim()); };

  return (
    <div className="ref-scrim" onPointerDown={onClose}>
      <div
        className="ref-dialog"
        dir={dir}
        role="dialog"
        aria-modal="true"
        aria-label={existing ? t("ref.edit") : t("ref.add")}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter saves, Esc cancels — per the design. Shift+Enter stays a newline so a note can breathe.
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
        }}
      >
        <div className="ref-eyebrow">{existing ? t("ref.edit") : t("ref.add")}</div>
        <div className="ref-field-label">{t("ref.selected")}</div>
        {/* The phrase is READ-ONLY: a reference is bound to this exact text, so editing it here would
            silently point the note at something else. Re-select the words to reference a different phrase. */}
        <div className="ref-phrase" dir="auto">{phrase}</div>
        <div className="ref-field-label ref-note-label">{t("ref.note")}</div>
        <textarea
          ref={areaRef}
          className="ref-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("ref.placeholder")}
          aria-label={t("ref.note")}
          dir={dir}
        />
        <div className="ref-actions">
          {/* Delete sits alone on the opposite side and ONLY exists for a reference that already exists —
              it removes the mark from every occurrence in the book. */}
          {existing && (
            <button type="button" className="ref-del" onClick={onDelete}>{t("ref.delete")}</button>
          )}
          <button type="button" className="ref-cancel" onClick={onClose}>{t("ref.cancel")}</button>
          <button type="button" className="ref-save" onClick={save} disabled={!canSave}>{t("ref.save")}</button>
        </div>
      </div>
    </div>
  );
}

// RAWY-260 — the REFERENCE POPUP. Per the design: label, phrase, note. No buttons — "any tap outside
// closes it", and it must never cover the line the reader tapped, so it is placed BELOW the occurrence
// when there is room above it and above otherwise.
export function ReferencePopup({
  row,
  rect,
  onOpen,
}: {
  row: RefRow;
  rect: AnchorRect;
  /** Tapping the popup opens the dialog on this reference — the edit path, without adding a button. */
  onOpen: () => void;
}) {
  const { t, dir } = useI18n();
  const below = rect.top < 220; // not enough room above → sit under the word instead of over it
  return (
    <div
      className={`ref-popup${below ? " below" : ""}`}
      dir={dir}
      role="note"
      style={{ left: rect.left + rect.width / 2, top: below ? rect.bottom + 10 : rect.top - 10 }}
      onPointerDown={(e) => { e.stopPropagation(); onOpen(); }}
    >
      <div className="ref-popup-head">
        <span className="ref-popup-dot" aria-hidden />
        <span className="ref-popup-label">{t("ref.label")}</span>
      </div>
      <div className="ref-popup-phrase" dir="auto">{row.phrase}</div>
      <div className="ref-popup-rule" />
      <div className="ref-popup-note" dir="auto">{row.note}</div>
    </div>
  );
}
