// A bottom sheet — the mobile equivalent of the desktop drawer, and NOT a port of it.
//
// The desktop opens side panels because a wide window has room beside the page. A phone does not, and
// a panel that takes a third of a 400px screen leaves a column of text nobody can read. A sheet comes
// up from the bottom edge instead, where a thumb already is.
//
// EVERY SHEET IS A STACK ENTRY. It is pushed by the caller before mounting, so Android's Back
// dismisses exactly one sheet, in the order they were opened, without this component knowing anything
// about navigation. `onDismiss` is what the chrome calls when a gesture or the scrim asks to close —
// it pops the stack, and the stack decides what is underneath.

import { useEffect, useRef, type ReactNode } from "react";

export function Sheet({
  title,
  onDismiss,
  children,
  /** A sheet that fills the screen — Search and Contents want the height; a picker does not. */
  full = false,
}: {
  title?: string;
  onDismiss: () => void;
  children: ReactNode;
  full?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Focus moves into the sheet on open so a screen reader announces it and lands inside rather than
  // continuing to read the surface behind it.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div className="ms-scrim" onPointerDown={onDismiss} role="presentation">
      <div
        ref={panel}
        className={`ms-sheet${full ? " ms-sheet--full" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // The sheet is inside the scrim so the scrim can catch a tap outside it; this stops a tap on
        // the sheet itself from reaching that handler and closing what the reader just opened.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* The grabber is decorative — the gesture surface is the whole header, and the control that
            actually closes is the button below, which a screen reader can reach. */}
        <div className="ms-grabber" aria-hidden="true" />
        {title ? (
          <header className="ms-sheet-head">
            <h2 className="ms-sheet-title">{title}</h2>
          </header>
        ) : null}
        <div className="ms-sheet-body">{children}</div>
      </div>
    </div>
  );
}
