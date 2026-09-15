// THE REFERENCE SHEET — design R1.
//
// The design DOES specify this one (unlike the note editor): a bottom sheet titled «مرجع» with the
// scope stated beside it, the phrase in a read-only block, one note field, and a Cancel/Save pair whose
// save is the wider of the two. This is that, with the desktop dialog's rules carried over verbatim
// because they are the product's rules and not the desktop's:
//
//   * ONE surface serves create AND edit. Re-referencing the same phrase edits the existing reference
//     rather than making a second one — that is the backend's own keying on (book, folded phrase), so
//     the sheet does not need to decide it, only to pre-fill.
//   * The phrase is READ-ONLY. A reference is bound to this exact text; editing it here would silently
//     point the note at something else.
//   * An empty note disables Save.
//   * Delete appears only for a reference that already exists, and removes the mark from EVERY
//     occurrence in the book.
//
// WHAT THE DESIGN DRAWS AND THIS DOES NOT: an occurrence count («٣١ موضعًا»). Nothing in Sard counts a
// phrase's occurrences across a whole book — `findPhraseHits` works per rendered section — so the number
// would have to come from a full-book scan built for this label alone. A count that is invented is worse
// than a count that is absent, so the row states the scope in words instead.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import type { RefRow } from "../../lib/ipc";

interface Props {
  /** The selected text (create) or the stored phrase (edit) — shown verbatim, never folded. */
  phrase: string;
  /** The reference already made for this phrase, if any. Drives pre-fill and whether Delete shows. */
  existing: RefRow | null;
  onSave: (note: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function ReferenceSheet({ phrase, existing, onSave, onDelete, onCancel }: Props) {
  const { t, dir } = useI18n();
  const [note, setNote] = useState(existing?.note ?? "");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  // "One field, autofocused" — but ONLY when there is nothing to read yet.
  //
  // The sheet serves two arrivals and they want opposite things. Creating: the reader chose «مرجع» to
  // write something, so the caret and the keyboard should already be there. READING: the reader tapped
  // a marked phrase to SEE the note — and MEASURED on the device, autofocusing there threw the keyboard
  // up over half the sheet, hiding the very note they asked for. An existing reference therefore opens
  // quiet and legible; tapping the field still starts an edit, with the caret at the end as before.
  useEffect(() => {
    if (existing) return;
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [existing]);

  const canSave = note.trim().length > 0;

  return (
    <>
      <div className="mh-scrim" onClick={onCancel} />
      <div
        className="mh-sheet mn-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={existing ? t("ref.edit") : t("ref.add")}
      >
        <div className="mh-grab" />
        <div className="mn-head">
          <span className="mn-title">{t("ref.label")}</span>
          {/* The design states the scope right here, and it earns its place: a reference is the one
              annotation in Sard that is NOT bound to the passage it was made from. */}
          <span className="mn-scope">{t("ref.scopeHint")}</span>
        </div>

        <div className="mn-field">
          <div className="mn-label">{t("ref.selected")}</div>
          <div className="mn-passage" dir="auto">
            {phrase}
          </div>
        </div>

        <div className="mn-field mn-field--grow">
          <div className="mn-label">{t("ref.note")}</div>
          <textarea
            ref={areaRef}
            className="mn-textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("ref.placeholder")}
            aria-label={t("ref.note")}
            dir={dir}
          />
        </div>

        <div className="mn-foot">
          {existing && (
            <button type="button" className="mn-btn mn-btn--danger" onClick={onDelete}>
              {t("ref.delete")}
            </button>
          )}
          <button type="button" className="mn-btn" onClick={onCancel}>
            {t("ref.cancel")}
          </button>
          <button
            type="button"
            className="mn-btn mn-btn--primary"
            disabled={!canSave}
            onClick={() => canSave && onSave(note.trim())}
          >
            {t("ref.save")}
          </button>
        </div>
      </div>
    </>
  );
}
