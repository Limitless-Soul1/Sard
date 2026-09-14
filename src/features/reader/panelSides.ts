// WHICH PHYSICAL SIDE EACH READING PANEL DOCKS ON — and therefore where its control belongs.
//
// RAWY-32 pinned the reading panels to FIXED PHYSICAL sides that do not move when the interface
// language flips, and it stated the rule those sides exist to serve: a panel sits on the SAME
// PHYSICAL SIDE as the toolbar button that opens it. Notes obeyed it and the settings slide-over
// obeyed it. Contents and Search did not, and not by oversight in their placement — the top bar had
// only ONE control group, `.rc-btns`, pinned to the physical right. A panel-opening control could
// therefore only ever be placed on the right, whatever side its panel used, so the two whose panels
// dock LEFT ended up as far from them as the bar allows. The right-side controls satisfied the rule
// by coincidence rather than by construction, which is why nothing caught it.
//
// So the rule is declared here, once, and BOTH halves read it: `ReaderChrome` puts a control in the
// group belonging to its panel's side, and each panel takes its dock class from the same entry.
// Neither half can drift from the other, and a new panel cannot be introduced without saying where
// it lives.
//
// PHYSICAL, IN BOTH DIRECTIONS — and nothing here branches on direction. `.reader-chrome` is pinned
// `direction: ltr` and the panels position with physical `left`/`right`, so "left" names the same
// edge of the screen in Arabic and in English. A control and its panel therefore meet on that edge
// in both, which is what makes this correct for RTL and LTR at once instead of tuned for either.
// The reading TEXT and the page-turn chevrons still follow the book, exactly as before; only the
// chrome is pinned, exactly as RAWY-32 decided.

/** A fixed physical edge of the reading view. Not logical: it does not flip with any direction. */
export type PanelSide = "left" | "right";

/** The reading panels that a toolbar control opens. */
export type ReaderPanel = "contents" | "search" | "notes" | "settings";

/**
 * THE MAPPING. `contents` and `search` share the left edge (opening one closes the other — there is
 * a single left panel); `notes` and the settings slide-over share the right edge for the same
 * reason. A left panel and a right panel coexist, which is why the two edges exist at all.
 */
export const READER_PANEL_SIDE: Readonly<Record<ReaderPanel, PanelSide>> = Object.freeze({
  contents: "left",
  search: "left",
  notes: "right",
  settings: "right",
});

/**
 * The CSS class that docks a panel to its side.
 *
 * `rp-lead` / `rp-trail` are the historical names and they are PHYSICAL — `rp-lead` is `left: 0`,
 * `rp-trail` is `right: 0`, with no RTL swap anywhere in the sheet. They are kept rather than
 * renamed so this change touches placement and nothing else; this function is what makes their
 * meaning unambiguous at every call site.
 */
export function panelDockClass(panel: ReaderPanel): "rp-lead" | "rp-trail" {
  return READER_PANEL_SIDE[panel] === "left" ? "rp-lead" : "rp-trail";
}

/** Does this panel dock on the physical left? The test `ReaderChrome` groups its controls by. */
export const docksLeft = (panel: ReaderPanel): boolean => READER_PANEL_SIDE[panel] === "left";
