// Where a new profile starts — the design's three answers, and what each one CLAIMS.
//
// A pure module for the same reason `dropRoute.ts` is one: the decision is a mapping, not a
// rendering question, and the unit suite is deliberately DOM-free. Keeping it here means the rule
// can be tested directly instead of inferred from a component.

import type { BuiltinThemeId } from "../../theme/tokens";

/** The design's three: how Sard looks now, one of the sixteen, or a paper of your own. */
export type StartFrom = "current" | "theme" | "custom";

/**
 * The preset a new profile may name as its own — or `null` for "built from scratch".
 *
 * ONLY "one of the sixteen" IS A CHOICE OF PRESET. The create dialog renders the swatch grid for
 * that option alone, so it is the only one where the reader has actually seen and picked a paper.
 *
 * "A paper of your own" is authored later, inside the editor, where the custom-paper dialog and its
 * four harmonies live; it still needs a canvas to open on, but a canvas is not a claim. Returning a
 * preset for it made a profile announce itself as Ivory — in the rail, on the card and in the
 * switcher — when the reader had never been offered Ivory, and persisted that claim.
 *
 * "How Sard looks now" captures whatever is live, which may itself be another profile, so it names
 * no preset either; `captureCurrent` already records the live paper.
 */
export function chosenPreset(start: StartFrom, base: BuiltinThemeId): BuiltinThemeId | null {
  return start === "theme" ? base : null;
}
