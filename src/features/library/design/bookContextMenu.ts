// A RIGHT-CLICK ON A BOOK OPENS THE BOOK'S OWN MENU — the one that is already there.
//
// The ⋯ answers "what can I do with this book", and a right-click asks the identical question. So it
// is answered by the SAME component, opened at the pointer (`BookActionsHandle.openAt`), rather than
// by a second menu assembled beside it. That is the whole of the design: there is no parallel item
// list, no parallel dismissal, no parallel keyboard model, and an action added to `BookActions`
// appears under the right-click everywhere, in every format, without this file changing.
//
// It lives here rather than inside `BookActions` because the gesture belongs to the BOOK — the whole
// card, tile or row — while the component it opens is mounted somewhere inside it. Four formats wire
// the same two lines, so the rule is written once.
import { useCallback, useRef } from "react";

import type { BookActionsHandle } from "./BookActions";

export interface BookContextMenu {
  /** Give this to the `<BookActions>` this book draws. */
  ref: React.RefObject<BookActionsHandle | null>;
  /** Give this to the element that IS the book — the card, the tile, or the row. */
  onContextMenu: (e: React.MouseEvent) => void;
}

export function useBookContextMenu(opts?: {
  /** Called before the menu opens — where a format has a press-and-hold to disarm. */
  onOpen?: () => void;
  /** Off while the format is doing something else with the press (multi-select, manual ordering). */
  enabled?: boolean;
}): BookContextMenu {
  const ref = useRef<BookActionsHandle | null>(null);
  const enabled = opts?.enabled ?? true;
  const onOpen = opts?.onOpen;
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      // THE MENU'S OWN RIGHT-CLICK IS NOT THE BOOK'S.
      //
      // The menu is portalled to the overlay host, so in the DOM it is nowhere near this card — but
      // React propagates through the REACT tree, and `<BookActions>` is a child of the card. Without
      // this, a right-click on a menu item would re-open the menu it was aimed at, at the new point.
      const el = e.target as Element | null;
      if (el?.closest?.('[data-book-menu="1"]')) return;
      // A field inside a book's row keeps the platform's own editing menu; nothing here is worth
      // taking Cut/Copy/Paste away for.
      if (el?.closest?.("input, textarea, [contenteditable=\"true\"]")) return;
      const h = ref.current;
      if (!h) return; // no ⋯ drawn for this book (selection mode) — leave the gesture alone
      e.preventDefault();
      e.stopPropagation();
      onOpen?.();
      h.openAt(e.clientX, e.clientY, e.currentTarget as HTMLElement);
    },
    [enabled, onOpen],
  );
  return { ref, onContextMenu };
}
