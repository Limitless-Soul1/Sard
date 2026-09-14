// The tag filter's semantics, as pure functions — so they can be tested.
//
// Sard's unit runner is deliberately `environment: "node"` with no DOM shim (vitest.config.ts: a fake
// DOM "would invite tests that pass in a fake DOM and lie about WebView2"). The rules that decide WHICH
// annotations a filter shows are not DOM questions at all, so they live here rather than inline in the
// panel, where they would be reachable only by rendering React.
//
// THE FILTER IS SHARED, not per-kind. It sits beside the book-scope control in the sidebar header and
// applies to every annotation kind that HAS tags — which today means notes and highlights, and only
// those. References, replacements and bookmarks have no tag relationship in the schema at all, so the
// control is not offered on their tabs rather than offered and silently inert.
//
// TWO SEPARATE IDEAS, deliberately not conflated:
//
//     TAG OPTIONS   = every tag that EXISTS — read from the `tags` table (`tagsList`), library-wide.
//     FILTER RESULT = the annotations IN SCOPE that carry the chosen tag — what this module computes.
//
// The options once came from the visible rows, so that the menu could never offer a choice yielding
// nothing. That made the control lie: tags living on other books simply were not listed. An empty
// result is a legitimate answer — "this book has nothing under that tag" — and the menu is not the
// place to prevent it. Nothing here computes the option list any more; it is not a scope question.
//
// Everything below is about the tag NAMES an annotation carries. Names, not ids, because that is what
// the rows themselves carry (`NoteRow.tags` and `HighlightRow.tags`, both projected from the same
// `note_tags` join) and what the reader typed.

/**
 * Anything with tag names on it.
 *
 * Deliberately STRUCTURAL rather than a union of the row types: a `NoteRow`, a `HighlightRow` and a
 * cross-book `AnnoItem` all carry `tags: string[]` and all three flow through this filter, so naming
 * them individually would only add a reason for the list to fall out of date.
 */
export interface Tagged {
  tags: string[];
}

/**
 * The notes a filter should show. `null` means no filter — every note, tagged or not.
 *
 * ANY of a note's tags matches, so a note carrying several appears under each of them; there is no
 * notion of a primary tag.
 */
export function filterByTag<T extends Tagged>(notes: readonly T[], tag: string | null): T[] {
  if (tag === null) return [...notes];
  return notes.filter((n) => n.tags.includes(tag));
}

/**
 * Is this filter still meaningful against these notes?
 *
 * A filter naming a tag the current notes no longer carry would hide everything with no way back to
 * the full list — which is exactly what a book switch, an untag, or deleting the last note carrying a
 * tag would otherwise produce. The panel clears the filter when this returns false.
 */
export function tagFilterStillValid(tag: string | null, available: readonly string[]): boolean {
  return tag === null || available.includes(tag);
}
