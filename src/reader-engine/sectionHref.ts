// RESILIENCE-1 / WP-6A — the href space for SYNTHESISED contents rows.
//
// A book whose own table of contents is unusable has no anchors worth pointing at, so a generated row
// targets a SPINE INDEX instead of a document href. ChaptersPanel's contract is href-based (a row is
// clickable when it has an href, and the current row is found by matching hrefs), so the index is
// carried inside an href-shaped string rather than by adding a parallel field to every surface.
//
// This lived as a bare prefix constant inside Reader.tsx, which is how the two defects below happened:
// the ONE place that could recognise these hrefs was the jump handler, and everything else that reads
// an href — above all the current-chapter resolver — silently treated them as unresolvable. Giving the
// space a name and a parser makes it usable everywhere, which is what "behaves like a native TOC"
// requires.
const PREFIX = "sard-section:";

/** The href for a generated row that targets spine section `index`. */
export const sectionHref = (index: number): string => `${PREFIX}${index}`;

/** The spine index a generated href targets, or `null` when this is an ordinary document href. */
export function parseSectionHref(href: string | null | undefined): number | null {
  if (!href || !href.startsWith(PREFIX)) return null;
  const n = Number(href.slice(PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Does this href belong to the synthesised space? */
export const isSectionHref = (href: string | null | undefined): boolean => parseSectionHref(href) !== null;
