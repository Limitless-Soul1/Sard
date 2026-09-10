// THE COMPOSER'S INLINE ARITHMETIC — whether the inspector still fits beside the card.
//
// Kept apart from the component because it is the whole of the responsive decision, and because a
// decision made from measured numbers should be checkable against numbers rather than against a
// rendered tree.
//
// WHAT WENT WRONG. The workspace is a two-column grid — a 288px rail and the rest — and the
// inspector is an overlay pinned to the inline end, its room held open by a static
// `padding-inline-end` on `.pcx-work`. The card was then fitted to whatever that padding left over,
// through `Math.max(240, …)`. Below 240px of leftover the card stopped shrinking while the box went
// on shrinking, so the difference spilled symmetrically back OUT of the content box — underneath the
// very panel the padding was reserving for. Measured across widths, RTL, with a text element
// selected:
//
//     1004px   content 238px — the floor engages, 2px of overflow
//      950px   content 187px — the toolbar's colour swatch is under the inspector
//      820px   content  65px — the card itself can no longer be selected
//      760px   content   8px — 232px of a 240px card outside its own box
//
// Height never contributed: 1280×600 was clean, 900×1000 failed exactly as 900×700 did.

/** The narrowest stage the composer is still worth using, and the point the panel gives way at. */
export const STAGE_MIN = 240;

/**
 * How much more room it takes to bring the panel back than it took to send it away.
 *
 * A window dragged slowly across the boundary would otherwise flap the panel in and out on every
 * frame the pointer moved. 32px is a little over one drag step, and it is why 1024px keeps the panel
 * on the way DOWN and leaves it off on the way back UP until 1100.
 */
export const STAGE_MIN_HYST = 32;

/**
 * Does the inspector still fit beside the card?
 *
 * `workWidth` is the workspace's border box; `reserve` is the inspector's room and `gutter` the desk
 * margin opposite it — both read from the stylesheet, so the number lives in one place. `wasOpen`
 * carries the previous answer, which is what makes the threshold hysteretic rather than a knife edge.
 */
export function inspectorFits(
  workWidth: number,
  reserve: number,
  gutter: number,
  wasOpen: boolean,
): boolean {
  const roomWithInspector = workWidth - gutter - reserve;
  return roomWithInspector >= (wasOpen ? STAGE_MIN : STAGE_MIN + STAGE_MIN_HYST);
}

/**
 * The stage's room, given whether the panel is there.
 *
 * There is no floor. A floor is what made the card claim room it did not have; keeping the card
 * honest and letting `inspectorFits` decide when the room has run out is the whole correction. The
 * only clamp is against a non-positive box, which is not a small stage but an unmeasured one.
 */
export function stageRoom(workWidth: number, reserve: number, gutter: number, withInspector: boolean): number {
  return Math.max(1, workWidth - gutter - (withInspector ? reserve : gutter));
}
