// THE GESTURE THAT TAKES HOLD OF A BOOK — one implementation, for every surface that draws one.
//
// `BookTile` owned this, which was fine while Vista, Covers and Spines were the only places a book
// could be picked up. Details draws rows rather than tiles and cannot use `BookTile`, so the choice
// was to copy the gesture or to share it. Copied, the two would drift: the 340 ms threshold, the
// rule that arrange mode never opens a book, and the rule that a hold consumes the click that
// follows it are not three settings but one behaviour, and it has already been got wrong once in
// each direction.
//
// What this does NOT own is the drag itself. Once a book is in hand, `LibraryDesign`'s window
// listeners carry it: the ghost, the lit landing place, the hit-test and the release are all there
// and are shared by every view. This hook only decides how a press becomes a pickup.

import { useCallback, useEffect, useRef } from "react";

export interface PickupHandlers {
  /** Manual Ordering is on. A book must never open while it is, whatever else is true. */
  arrangeOn: boolean;
  /** This shelf's order is the reader's to set. False on a computed shelf and on the unshelved run. */
  orderable?: boolean;
  /** Selection mode owns the press entirely; nothing is lifted and nothing is opened. */
  selectOn?: boolean;
  /** Arrange mode: the press arms a drag straight away. */
  onArrangeDown: (x: number, y: number, el: Element) => void;
  /** Outside arrange mode: a press held past the threshold lifts the book. */
  onPickUp: (x: number, y: number) => void;
  onOpen: () => void;
  onToggleSelect?: () => void;
}

/** How long a press must be held, outside arrange mode, before it becomes a pickup. */
export const HOLD_MS = 340;

export function useBookPickup(h: PickupHandlers) {
  const hold = useRef<number | null>(null);
  /**
   * Set the moment the hold lifts the book, and cleared by the click it then swallows.
   *
   * Measured before this existed: on «خارج الأرفف» a press-and-hold lifted the book AND opened it,
   * because the release fell through to the click handler, which had no way of knowing the press
   * had already been spent. It reset a finished book to unread. Where landing places are inserted
   * the tile shifts out from under the pointer and the click misses by accident — an accident of
   * layout, not a rule. This is the rule.
   */
  const fired = useRef(false);

  useEffect(() => () => { if (hold.current) window.clearTimeout(hold.current); }, []);

  const orderable = h.orderable !== false;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (h.selectOn) return;
    if (h.arrangeOn) {
      e.preventDefault(); // no text selection, and no click reaching what is underneath
      // A shelf that cannot be reordered arms nothing — and, just as importantly, does not fall
      // through to the press-and-hold below, which would lift a book that has nowhere to go.
      if (orderable) h.onArrangeDown(e.clientX, e.clientY, e.currentTarget as Element);
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    fired.current = false;
    hold.current = window.setTimeout(() => {
      hold.current = null;
      fired.current = true; // the press is spent; whatever the release does, it is not an open
      h.onPickUp(x, y);
    }, HOLD_MS);
  }, [h, orderable]);

  const cancelHold = useCallback(() => {
    if (hold.current) { window.clearTimeout(hold.current); hold.current = null; }
  }, []);

  const onClick = useCallback((e: React.MouseEvent) => {
    // Arrange is handled by the pointer handlers; a click here would take the book a second time
    // at the end of every drag.
    if (h.arrangeOn) { e.stopPropagation(); return; }
    if (fired.current) { fired.current = false; e.stopPropagation(); return; }
    if (h.selectOn) { h.onToggleSelect?.(); return; }
    h.onOpen();
  }, [h]);

  /**
   * THE KEYBOARD'S VERSION OF THAT SAME CLICK.
   *
   * It lives here, beside `onClick`, rather than in the tile, because the three answers a press can
   * have — nothing under arrange, toggle under select, otherwise open — are ONE behaviour. Written
   * out a second time in a component they would drift, and the drift would be silent: a keyboard
   * user in select mode would open a book where a pointer would have ticked it.
   *
   * The hold has no keyboard equivalent, so `fired` is not consulted; there is no press to spend.
   */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // ONLY THE TILE'S OWN ACTIVATION. Enter on the ⋯, or on an item of the menu it opens, belongs to
    // that control and bubbles up through here on its way out. Answering it would open the book
    // standing behind the menu — which is the exact defect Priority 6 spent its time on, arriving
    // from the other direction.
    if (e.target !== e.currentTarget) return;
    // Space scrolls the shelf otherwise, and Enter would reach whatever is behind.
    e.preventDefault();
    e.stopPropagation();
    if (h.arrangeOn) return;
    if (h.selectOn) { h.onToggleSelect?.(); return; }
    h.onOpen();
  }, [h]);

  /** What the surface should offer under the pointer. Never `pointer` under arrange: that is the
   *  open affordance, and nothing opens there. */
  const cursor = h.arrangeOn ? (orderable ? "grab" : "default") : "pointer";

  return { onPointerDown, cancelHold, onClick, onKeyDown, cursor };
}
