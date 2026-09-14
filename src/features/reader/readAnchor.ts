// WHEN A JUMP STOPS BEING A JUMP.
//
// After a programmatic jump (a search hit, an annotation, a bookmark, a cross-reference) the reading
// position is frozen and the return pill offers the way back. The freeze ends — thaws — when the
// reader is plainly reading where they landed rather than inspecting it, and one of the two signals
// for that is distance: `THAW_LOCATIONS` locations forward of the landing.
//
// THE LANDING IS NOT THE FIRST RELOCATE. One jump emits several — the engine's own re-anchor on
// expand, and, for a search hit, a second navigation by construction: `goToSearchHit` goes to the cfi
// and then re-finds the hit's real text in the rendered document and scrolls to that. Taking the first
// relocate as the baseline and measuring the rest against it means a jump that settles further on than
// it first touched down thaws ITSELF, and the pill vanishes the instant it appeared — intermittently,
// because whether it happens depends on how far the correction moved in that particular book.
//
// So the baseline is only fixed once the jump's navigation has resolved. Until then every relocate is
// still the landing.

/** What the arriving relocate means for a held anchor. */
export type LandingStep = {
  /** The location the thaw distance should be measured from, from now on. */
  baseline: number;
  /** Has the reader moved far enough past the landing to have adopted it? */
  thaw: boolean;
};

/**
 * Fold one relocate into the anchor's landing state.
 *
 * `baseline` is null before any landing has been recorded. `jumpInFlight` is true while the navigation
 * that caused this jump has not yet resolved — every relocate then re-records the landing instead of
 * being measured against it. Forward only: paging back toward the passage jumped to is still
 * inspection, never adoption.
 */
export function landingStep(
  baseline: number | null,
  here: number,
  jumpInFlight: boolean,
  thawAfter: number,
): LandingStep {
  if (baseline == null || jumpInFlight) return { baseline: here, thaw: false };
  return { baseline, thaw: here - baseline >= thawAfter };
}
