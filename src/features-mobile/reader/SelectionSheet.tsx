// THE SELECTION SHEET — design D7 / J1.
//
// SARD SITS AROUND THE PLATFORM'S SELECTION, NEVER ON TOP OF IT. Android keeps its own handles, its
// own magnifier and its own word-then-drag behaviour; the only thing Sard takes away is the floating
// Copy/Share/Select-all bar, and it takes that away by preventing `contextmenu` inside the content
// document (FoliateController.setSuppressNativeSelectionMenu). MEASURED on Chromium 150: with the
// selection first cleared to rangeCount 0, a long-press still produced a live selection with native
// handles while the platform bar no longer appeared — and identically for Arabic.
//
// There is NO custom selection engine here and there must not be one. The range, its text and its
// rect all come from the platform via `SelectionInfo`; this file draws a sheet and calls Sard.
//
// THE ORDER IS THE DESIGN'S: ink row first, actions second. "Highlighting is the common act; it
// should cost one tap, not a menu then a colour."
//
// THE ACTION SET IS J1's — Note, Copy, Reference, Listen, Card. The design's other screen (D7) lists
// "Share" and "Look up" instead of Reference and Listen; J1's set is the one that maps onto
// capabilities Sard actually has, and "Look up" has no implementation anywhere in the product, so it
// is not drawn rather than drawn dead.

import { useI18n } from "../../i18n";
import { HIGHLIGHT_SLOTS } from "../../features/reader/highlightColors";
import type { HighlightColor } from "../../lib/ipc";
import { Icon, type IconName } from "../components/Icon";

export interface SelectionAction {
  id: "note" | "copy" | "reference" | "listen" | "card";
  icon: IconName;
  key: string;
}

/** J1's five, in the design's order. */
const ACTIONS: SelectionAction[] = [
  { id: "note", icon: "note", key: "sel.note" },
  { id: "copy", icon: "copy", key: "sel.copy" },
  { id: "reference", icon: "reference", key: "sel.reference" },
  { id: "listen", icon: "listen", key: "tts.listen" },
  { id: "card", icon: "photoCard", key: "sel.card" },
];

interface Props {
  /** The platform's selection, verbatim — never a reconstruction. */
  text: string;
  onInk: (c: HighlightColor) => void;
  onAction: (id: SelectionAction["id"]) => void;
  onDismiss: () => void;
  /** Actions whose surface is not built yet: drawn, disabled, never silently dropped. */
  unavailable?: SelectionAction["id"][];
}

export function SelectionSheet({ text, onInk, onAction, onDismiss, unavailable = [] }: Props) {
  const { t } = useI18n();
  return (
    // The sheet rises from the bottom "positioned so it never covers the selection or the handles" —
    // which on a phone means the bottom edge, since the selection can be anywhere above it. The
    // backdrop is deliberately NOT a scrim: dimming the page would hide the very passage the reader
    // is acting on, and the native handles must stay visible and draggable behind this.
    <div className="ms-root" role="dialog" aria-modal="false" aria-label={t("sel.title")}>
      <div className="ms-quote" dir="auto">
        {text}
      </div>

      {/* INK ROW FIRST — one tap to highlight, in any of Sard's eight slots. */}
      <div className="ms-inks" role="group" aria-label={t("sel.ink")}>
        {HIGHLIGHT_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            className={`ms-ink ms-ink--${slot}`}
            onClick={() => onInk(slot)}
            aria-label={slot}
          />
        ))}
      </div>

      <div className="ms-actions">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            className="ms-action"
            onClick={() => onAction(a.id)}
            disabled={unavailable.includes(a.id)}
            aria-disabled={unavailable.includes(a.id) || undefined}
          >
            <Icon name={a.icon} />
            <span>{t(a.key as Parameters<typeof t>[0])}</span>
          </button>
        ))}
      </div>

      <button type="button" className="ms-dismiss" onClick={onDismiss}>
        {t("edit.cancel")}
      </button>
    </div>
  );
}
