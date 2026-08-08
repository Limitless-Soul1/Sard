// RESILIENCE-1 — WHAT A NAVIGATION KEY MEANS.
//
// One table, deliberately tiny, and deliberately WITHOUT a direction argument.
//
// The reported defect was that in an Arabic book the page-turn arrows were reversed. The cause was
// that navigation went through foliate's `goLeft()`/`goRight()`, which ARE direction-aware, so the
// keys moved the page by screen geometry and their meaning flipped with the script.
//
// The fix is not a corrected branch — it is the ABSENCE of one. This function cannot consult the
// book's direction because it is never given it, so "→ means forward" is not a rule that has to be
// maintained; it is the only thing the code can express. Sard already worked this way everywhere
// else: the PDF path has always mapped → to the next page, and the read-aloud skip maps → to +1 with
// the note "media convention, NOT mirrored in RTL". EPUB paging was the outlier.

export type NavIntent = "forward" | "backward";

const FORWARD = new Set(["ArrowRight", "ArrowDown", "PageDown"]);
const BACKWARD = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);

/**
 * The reading-order intent of a key, or null when the key is not navigation.
 *
 * "Forward" always means the NEXT page of the book and "backward" the previous one, for an Arabic
 * book exactly as for an English one — the reader's own words: the reading direction must not invert
 * the meaning of the controls.
 */
export function navIntent(key: string): NavIntent | null {
  if (FORWARD.has(key)) return "forward";
  if (BACKWARD.has(key)) return "backward";
  return null;
}
