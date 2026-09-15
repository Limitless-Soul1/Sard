// THE NOTE EDITOR — design D8.
//
// NO DESIGN SCREEN EXISTS FOR THIS ONE. The design kit draws the reference sheet in full but never a
// note editor — the whole file contains exactly one save button, and it says «حفظ المرجع». So this
// surface is built from the design's OWN vocabulary rather than invented next to it: the reference
// sheet's shape (grabber, an eyebrow-labelled block per field, a Cancel/Save pair whose save is the
// wider of the two) applied to the fields a Sard note actually has.
//
// IT OWNS NO DATA. The passage, its CFI and its chapter arrive from the platform's SelectionInfo via
// the reader; the write goes to `useAnnotations.addMarginNote`, which is the same standalone-note path
// the desktop panel uses. There is no mobile note model, no second store and no duplicated guard —
// the store already refuses a note with neither body nor title, and already upserts the result.

import { useLayoutEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { HIGHLIGHT_SLOTS } from "../../features/reader/highlightColors";
import type { HighlightColor } from "../../lib/ipc";

/** Matches the desktop composer's cap, so the same note cannot be longer on one platform than the other. */
const TITLE_MAX = 120;

interface Props {
  /** The selected passage, verbatim from the platform — shown so the reader can see what they are annotating. */
  passage: string;
  /** An existing note being edited (a tap on a highlight), so the editor opens on what is already there. */
  initialTitle?: string;
  initialBody?: string;
  initialColor?: HighlightColor;
  /** Saving is the reader's, not ours: the sheet reports a draft and the reader writes it. */
  onSave: (body: string, title: string, color: HighlightColor) => void;
  onCancel: () => void;
}

export function NoteEditor({ passage, onSave, onCancel, initialTitle = "", initialBody = "", initialColor = "amber" }: Props) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [color, setColor] = useState<HighlightColor>(initialColor);
  // RAWY-282's rule, kept identical here: EITHER field is enough to make a note worth keeping, so the
  // save is live when either has content. Duplicating the store's guard would be a second opinion; this
  // only decides whether the button LOOKS available.
  const canSave = body.trim() !== "" || title.trim() !== "";
  // Does the quoted passage actually have more than it can show? Asked of the RENDERED text rather than
  // guessed from a character count, because how much fits depends on the face, the size, the width and
  // the language — a threshold in characters would be wrong in Arabic the moment it was right in Latin.
  // Only a passage that overflows earns the recessed, scrollable ground; everything else stays a quote.
  const passageRef = useRef<HTMLDivElement | null>(null);
  const [passageOverflows, setPassageOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = passageRef.current;
    if (el) setPassageOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [passage]);

  return (
    <>
      <div className="mh-scrim" onClick={onCancel} />
      <div className="mh-sheet mn-sheet" role="dialog" aria-modal="true" aria-label={t("sel.note")}>
        <div className="mh-grab" />
        <div className="mn-head">
          <span className="mn-title">{t("sel.note")}</span>
        </div>

        {/* The passage is context, never an input: a note is ABOUT it and the reader must not be able to
            edit the book's words in the act of annotating them.
            IT CARRIES NO LABEL. Quoted, in the book's own face, directly under a sheet already titled
            «ملاحظة», it does not need a strip of upper-case letter-spaced type to announce that it is the
            selected words — that was the third of three stacked eyebrows that made this read as a form to
            be filled in rather than a note to be written. */}
        <div className="mn-field">
          <div
            ref={passageRef}
            className={`mn-passage${passageOverflows ? " mn-passage--bounded" : ""}`}
            dir="auto"
          >
            {passage}
          </div>
        </div>

        <div className="mn-field">
          <input
            className="mn-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("note.titlePlaceholder")}
            aria-label={t("note.title")}
            dir="auto"
            maxLength={TITLE_MAX}
          />
        </div>

        {/* Nor does the body: the sheet is titled «ملاحظة» and the field's own placeholder invites the
            note. The accessible name is on the control itself, so nothing is lost to a screen reader. */}
        <div className="mn-field mn-field--grow">
          <textarea
            className="mn-textarea"
            // Autofocus only when there is nothing to read yet — opening an EXISTING note (a tap on a
            // highlight) must show the note, not bury it under the keyboard. Same rule as R1.
            autoFocus={!initialBody && !initialTitle}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("hl.addNote")}
            // The label this replaces was never associated with the field, so the control had no
            // accessible name either before or after. Naming it here is the part that was missing.
            aria-label={t("hl.note")}
            dir="auto"
          />
        </div>

        {/* The same eight slots the selection sheet offers, so a note's colour and a highlight's colour
            are visibly the one vocabulary. */}
        <div className="mn-inks" role="group" aria-label={t("sel.ink")}>
          {HIGHLIGHT_SLOTS.map((slot) => (
            <button
              key={slot}
              type="button"
              className={`ms-ink ms-ink--${slot}${slot === color ? " on" : ""}`}
              aria-label={slot}
              aria-pressed={slot === color}
              onClick={() => setColor(slot)}
            />
          ))}
        </div>

        <div className="mn-foot">
          <button type="button" className="mn-btn" onClick={onCancel}>
            {t("note.cancel")}
          </button>
          <button
            type="button"
            className="mn-btn mn-btn--primary"
            disabled={!canSave}
            onClick={() => onSave(body, title, color)}
          >
            {t("hl.save")}
          </button>
        </div>
      </div>
    </>
  );
}
