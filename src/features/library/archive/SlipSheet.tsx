// ONE SLIP, LIFTED ONTO THE DESK.
//
// Opening a slip does not leave the archive. The reference lifts it into a page on a scrimmed desk —
// Sard's founding model — at full reading measure and leading, and it is from THERE that the reader
// decides what to do with it. That distinction is the whole point of this sheet: the archive is a
// place to read what you kept, and going back to the book is one of four things you might want, not
// the only thing a click can mean.
//
// EVERY ACTION IS AN EXISTING ONE. Reading in the book is the same open path the shelves already use;
// the image card is the composer the reader opens; deleting calls the same two commands the reader's
// own store calls, in the same order. Only the note editor is local, and deliberately so — it writes
// through `noteUpdate`/`noteCreate` exactly as everything else does, which is reuse of the flow
// without reaching into the reader's panel, whose redesign is somebody else's task.

import { useEffect, useRef, useState } from "react";
import { useScrimDismiss } from "../../../components/useDialog";

import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n";
import {
  annoIsNote,
  highlightDelete,
  noteCreate,
  noteDelete,
  noteUpdate,
  type AnnoItem,
} from "../../../lib/ipc";
import { resolveHighlightInk } from "../../../lib/highlightInk";
import { markStyle } from "./mark";
import { colorValue } from "../../reader/highlightColors";
import { scriptOf } from "../../../lib/typography";
import type { ThemeColors } from "../../../theme/tokens";

interface Props {
  item: AnnoItem;
  hl: ThemeColors["highlight"];
  dark: boolean;
  paper: string;
  /** Relative date, formatted by the caller so this stays presentational. */
  when: string;
  onClose: () => void;
  /** The archive's own open path — the same one every shelf uses. */
  onRead: (it: AnnoItem) => void;
  /** Hand this annotation to the existing card composer. */
  onCard: (it: AnnoItem) => void;
  /** Something was written or removed; the archive reloads. */
  onChanged: () => void;
}

export function SlipSheet({ item, hl, dark, paper, when, onClose, onRead, onCard, onChanged }: Props) {
  // The backdrop takes a press only when the gesture began there and ends clear of the sheet.
  const scrim = useScrimDismiss(onClose);

  const { t } = useI18n();
  const isNote = annoIsNote(item);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.note ?? (isNote ? item.text ?? "" : ""));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  // ESCAPE CLOSES, AND THE SHEET TAKES FOCUS. Without the second the reader's next keystroke goes to
  // whatever was focused behind the scrim, which on this surface is a filter button.
  //
  // WHILE THE DELETE CONTROL IS ASKING, ESCAPE ANSWERS IT. Escape means "take back the last step",
  // and the last step here was arming a destructive action — closing the whole sheet instead leaves
  // the reader to find the slip again and re-open it to learn whether anything happened. One owner
  // for the key, because this listener captures: a handler on the control itself would never run.
  // The capturing handler is registered once; a ref is how it reads a state that changes under it.
  const armedRef = useRef(false);
  armedRef.current = confirming;
  useEffect(() => {
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (armedRef.current) { setConfirming(false); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const swatch = item.color ? colorValue(item.color, hl) : null;
  const ink = !isNote && swatch ? resolveHighlightInk({ ink: swatch, dark, paper }) : null;
  const arabic = scriptOf(item.text, item.book_dir) === "arabic";

  const save = async () => {
    setBusy(true);
    try {
      const body = draft.trim();
      if (item.note_id) {
        // An emptied note is a deleted note — the same meaning the reader's editor gives it.
        if (body) await noteUpdate(item.note_id, body);
        else await noteDelete(item.note_id);
      } else if (body) {
        await noteCreate({
          bookId: item.book_id,
          highlightId: item.kind === "highlight" ? item.id : null,
          cfi: item.cfi,
          color: item.color,
          body,
          chapterLabel: item.chapter_label,
        });
      }
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      // THE READER'S OWN ORDER. A highlight's note is removed with it; a standalone note is just a
      // note. Calling the same commands in the same sequence is what keeps the two surfaces agreeing.
      if (isNote && item.note_id) await noteDelete(item.note_id);
      else {
        if (item.note_id) await noteDelete(item.note_id);
        await highlightDelete(item.id);
      }
      onClose();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="arch-scrim" {...scrim.scrimProps}>
      <div
        className="arch-sheet"
        ref={(node) => { sheetRef.current = node; scrim.panelRef(node); }}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="arch-sheet-head">
          <div className="arch-sheet-id">
            <div className="arch-sheet-chipline">
              {swatch && <span className="arch-sheet-chip" style={{ background: swatch }} aria-hidden />}
              <span className="arch-sheet-kind">
                {isNote ? t("panel.marginNote") : t("ne.passage")}
              </span>
              <span className="arch-sheet-when">{when}</span>
            </div>
            <div className="arch-sheet-book">{item.book_title}</div>
            {item.chapter_label && <div className="arch-sheet-chapter">{item.chapter_label}</div>}
            {/* The same line the wall shows, kept where the slip names its book and its chapter. */}
            {item.sender && <div className="arch-sheet-from">{t("arch.from", { name: item.sender })}</div>}
          </div>
          <button className="arch-sheet-close ui-close" onClick={onClose} aria-label={t("ne.close")}>
            <Icon name="close" size="sm" />
          </button>
        </div>

        {/* THE PASSAGE, AT FULL READING MEASURE. This is the one place the kept words are shown whole:
            no cap, no fade, the mark exactly as the book draws it. */}
        {item.text && (
          <div className={`arch-sheet-passage${arabic ? " ar" : ""}${isNote ? " quoted" : ""}`}>
            {ink ? (
              <span className="arch-ink" style={markStyle(ink, paper)}>{item.text}</span>
            ) : (
              item.text
            )}
          </div>
        )}

        {/* The reader's own words, or the invitation to write some. */}
        {editing ? (
          <div className="arch-sheet-note editing">
            <label className="arch-sheet-note-label">{t("ne.myNote")}</label>
            <textarea
              className="arch-sheet-editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className="arch-sheet-editrow">
              <button className="arch-btn primary" onClick={save} disabled={busy}>{t("arch.save")}</button>
              <button
                className="arch-btn"
                onClick={() => { setDraft(item.note ?? ""); setEditing(false); }}
                disabled={busy}
              >
                {t("ne.cancel")}
              </button>
            </div>
          </div>
        ) : (
          item.note && (
            <div className="arch-sheet-note">
              <div className="arch-sheet-note-label">
                <Icon name="markNote" size="sm" />
                {t("ne.myNote")}
              </div>
              <div className="arch-sheet-note-body">{item.note}</div>
            </div>
          )
        )}

        {item.tags.length > 0 && (
          <div className="arch-sheet-tags">
            {item.tags.map((tg) => <span key={tg} className="arch-tag">{tg}</span>)}
          </div>
        )}

        <div className="arch-sheet-actions">
          {/* THE THINGS YOU DO WITH THE SLIP, kept together as one group. They were loose children of
              the row, and the destructive control was pushed away from them by an automatic margin —
              which is the right look while everything fits on one line, and becomes a control thrown
              to the opposite corner of a SECOND line as soon as it does not. Grouped, the row has
              two parts rather than four, and a wrap moves a whole part. */}
          <div className="arch-sheet-actions-main">
            <button className="arch-btn primary" onClick={() => onRead(item)}>{t("arch.readInBook")}</button>
            {!editing && (
              <button className="arch-btn" onClick={() => setEditing(true)}>{t("arch.editNote")}</button>
            )}
            <button className="arch-btn" onClick={() => onCard(item)}>{t("arch.imageCard")}</button>
          </div>

          {/* DELETION ASKS FIRST, in place. A second click on the same control is the confirmation —
              the same shape the Library uses elsewhere, and it keeps the destructive action from
              being one stray click away.

              IT DOES NOT CHANGE SIZE WHEN IT ASKS. «حذف» and «أمتأكّد من الحذف؟» are very different
              widths, and swapping one for the other re-measured the row: at a narrow-but-ordinary
              window that was the difference between a row that fitted and a row that wrapped, so
              arming the control moved it to another line and another edge. Both labels are laid in
              the SAME grid cell, so the control is always as wide as its longest word and arming it
              cannot move anything. The reader is told which one is live by `aria-label`, because
              only one of them is ever painted.

              Escape disarms rather than closing the sheet, but only while it is armed — see the
              key handler above, which is where this surface's Escape lives. */}
          <button
            className={`arch-btn danger${confirming ? " armed" : ""}`}
            aria-label={confirming ? t("arch.deleteConfirm") : t("ne.delete")}
            onClick={() => (confirming ? remove() : setConfirming(true))}
            onBlur={() => setConfirming(false)}
            disabled={busy}
          >
            <span className="arch-btn-swap" aria-hidden>
              <span className={confirming ? "on" : ""}>{t("arch.deleteConfirm")}</span>
              <span className={confirming ? "" : "on"}>{t("ne.delete")}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
