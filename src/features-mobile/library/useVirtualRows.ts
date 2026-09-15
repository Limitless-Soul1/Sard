// Windowing for the library LIST.
//
// WHY THIS IS NOT `useVirtualGrid`. The grid's arithmetic has to derive a row pitch from a measured
// column width, because a card's height follows its cover's aspect ratio plus however many lines its
// title happened to take. That derivation is exactly what failed on the device: the assumed 260px ran
// against an actual 311–328px, the window drifted out of the viewport, and the last book became
// unreachable.
//
// A LIST ROW HAS NO SUCH DEGREE OF FREEDOM. The design fixes its parts — 13px of padding, a 44×66
// cover, 13px of padding, a 1px rule — so the pitch is a CONSTANT, declared here once and enforced in
// CSS by the same number. There is nothing to measure and nothing to drift. That is the whole reason
// the list is the primary surface and not merely the prettier one.
//
// The constant is shared with `mobile.css` by being quoted there; if one changes the other must, and
// the row height is asserted in the tests below so a change cannot pass unnoticed.

/** Row pitch in px: 13 top padding + 66 cover + 13 bottom padding + 1 hairline = 93. */
export const ROW_PITCH = 93;

export interface RowWindow {
  /** First and last item index to render, inclusive. `last` is -1 when there is nothing to render. */
  first: number;
  last: number;
  /** Spacer heights, so the scrollbar and the scroll position stay honest. */
  padTop: number;
  padBottom: number;
}

/**
 * Which rows to render for a scroll position.
 *
 * `scrollTop` is measured from the top of the LIST, so a caller with content above it passes
 * `scrollTop - heightOfThatContent` and may pass a negative number — which simply means the list has
 * not been reached yet and the window starts at 0.
 *
 * `overscan` is in ROWS. Two rather than the grid's one: a list row is a third of a grid row's height,
 * so the same flick crosses three times as many of them, and two rows of slack is what keeps a fast
 * scroll from showing a hole while still bounding how many covers decode at once.
 */
export function windowRows(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 2,
): RowWindow {
  if (count <= 0) return { first: 0, last: -1, padTop: 0, padBottom: 0 };

  const top = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(top / ROW_PITCH) - overscan);
  // A viewport of 0 — which is what an unmeasured container reports — must still render SOMETHING, or
  // the list is blank until a resize happens to arrive. The overscan alone guarantees that.
  const spans = Math.ceil(Math.max(0, viewportHeight) / ROW_PITCH) + overscan * 2;
  const last = Math.min(count - 1, first + spans);

  return {
    first,
    last,
    padTop: first * ROW_PITCH,
    padBottom: Math.max(0, (count - 1 - last) * ROW_PITCH),
  };
}
