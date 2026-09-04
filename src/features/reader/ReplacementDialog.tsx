import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import type { RepRow } from "../../lib/ipc";
import { isArabicText } from "../../lib/typography";

// THE ADD/EDIT REPLACEMENT DIALOG, created from a selection in the reader.
//
// It follows the References & Replacements design's own editor rather than inventing a second look: two
// fields of equal weight with the arrow between them, the ORIGINAL muted and the REPLACEMENT in text ink,
// both set in the reading face at 21px — because what the reader is composing is a line of the book, not
// a form field. The design's `⟵` points from the new wording back to the author's, which is why the
// original sits on the leading side and the replacement follows it.
//
// ONE dialog serves creating and editing, like the reference dialog beside it. What differs is that BOTH
// fields are editable here: a reference is bound to the exact phrase it marks, but a replacement is a rule
// the reader owns outright, and the design lets them correct either side of it in place.
export function ReplacementDialog({
  phrase,
  existing,
  bookTitle,
  onSave,
  onDelete,
  onClose,
}: {
  /** The text the reader selected (create), or the stored phrase (edit). Pre-filled as the original. */
  phrase: string;
  /** The rule being edited, or null when creating. Drives the pre-fill AND whether Delete shows. */
  existing: RepRow | null;
  /** Named in the scope line, because a rule applying to ONE book is the thing readers most misread. */
  bookTitle: string;
  onSave: (from: string, to: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t, dir } = useI18n();
  const [from, setFrom] = useState(existing?.phrase ?? phrase);
  const [to, setTo] = useState(existing?.replacement ?? "");
  const toRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setFrom(existing?.phrase ?? phrase);
    setTo(existing?.replacement ?? "");
  }, [existing?.id, phrase]);

  // The original arrives filled in from the selection, so the field the reader actually has to fill is the
  // replacement — that is the one that gets the cursor, with it placed after any existing text so an edit
  // continues rather than overwrites.
  useEffect(() => {
    const el = toRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const canSave = from.trim().length > 0 && to.trim().length > 0;
  const save = () => { if (canSave) onSave(from.trim(), to.trim()); };

  return (
    <div className="ref-scrim" onPointerDown={onClose}>
      <div
        className="ref-dialog rep-dialog"
        dir={dir}
        role="dialog"
        aria-modal="true"
        aria-label={t("rep.newInBook")}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          else if (e.key === "Enter") { e.preventDefault(); save(); }
        }}
      >
        <div className="ref-eyebrow">{existing ? t("rep.editInBook") : t("rep.newInBook")}</div>
        <div className="rep-row">
          <input
            className={`rep-input rep-from${isArabicText(from) ? " ar" : ""}`}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder={t("rep.from")}
            aria-label={t("rep.fromLabel")}
            dir="auto"
          />
          <span className="rep-arrow" aria-hidden>⟵</span>
          <input
            ref={toRef}
            className={`rep-input rep-to${isArabicText(to) ? " ar" : ""}`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={t("rep.to")}
            aria-label={t("rep.toLabel")}
            dir="auto"
          />
        </div>
        {/* The design states the scope in the editor itself, in the reader's own words, because "this book
            alone" and "can be switched off" are the two promises the feature makes. */}
        {/* A RULE ALREADY EXISTS FOR THESE WORDS, AND THE READER IS TOLD SO — on the spot, before he
            composes a second one that the database would refuse without ever saying why. */}
        {existing && (
          <div className="rep-exists">
            {t("rep.already", { from: existing.phrase, to: existing.replacement })}
          </div>
        )}
        <div className="rep-scope">{t("rep.scopeHint", { title: bookTitle })}</div>
        <div className="ref-actions">
          {existing && (
            <button type="button" className="ref-del" onClick={onDelete}>{t("rep.delete")}</button>
          )}
          <button type="button" className="ref-cancel" onClick={onClose}>{t("rep.cancel")}</button>
          <button type="button" className="ref-save" onClick={save} disabled={!canSave}>
            {existing ? t("rep.save") : t("rep.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
