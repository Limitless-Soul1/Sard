// RESILIENCE-1 / WP-6A — NAVIGATION for a book whose own table of contents is unusable.
//
// THE RULE, and it is deliberately the whole rule:
//
//     a section's own heading, if it has one — otherwise a NUMBER.
//
// Sard does not invent a title. A label derived from a section's opening sentence looks like a
// chapter name the author wrote, and no such name exists in the file; a reader cannot tell the
// difference, which makes it a quiet fabrication of metadata. Numbering is honest — it says "this is
// the fifth section" and claims nothing more — and it is just as navigable.
//
// WHAT THIS REPLACED, and why the simpler rule is better. An earlier version preferred headings,
// judged whether a heading SET looked machine-generated (a4's 195 headings all collapse to
// "Chapter-# #"), and fell back to the first 40 characters of body text. It worked, and it was
// measured, but it made Sard responsible for repairing malformed EPUBs by manufacturing metadata —
// and it needed a threshold justified by a single book. This version has no threshold, no content
// inspection, and no judgement about heading quality: a heading is used because the book has one.
//
// A consequence worth stating: this reads ONLY each section's heading, never its text. That is a
// smaller walk (no `textContent` on 196 documents) as well as a smaller idea.

/** One linear spine section, reduced to the only thing a label may come from. */
export interface SectionHeading {
  /** The first h1–h6 in the section, trimmed. Empty when the section has none. */
  heading: string;
}

export interface SynthEntry {
  /** The section's own heading, or `null` when it has none — the caller renders a numbered label. */
  label: string | null;
  /** 1-based position in the LINEAR spine, which is what a numbered label counts. */
  ordinal: number;
  /** Index into `book.sections`, for navigation. */
  index: number;
}

export interface SynthToc {
  entries: SynthEntry[];
  /** How many entries carry the book's own heading — the rest are numbered. */
  titled: number;
}

/**
 * Build navigable contents from the spine.
 *
 * EVERY linear section gets a row. Nothing is skipped and nothing is judged: a section with no
 * heading is not a defect to be worked around, it is simply a section with no heading, and the
 * reader is told exactly that by a number.
 *
 * `sections` must already be limited to LINEAR sections, in spine order; `indices[i]` is the
 * position of `sections[i]` in `book.sections` so a row can navigate.
 */
export function synthesiseToc(
  sections: readonly SectionHeading[],
  indices: readonly number[],
): SynthToc {
  const entries: SynthEntry[] = [];
  let titled = 0;
  for (let i = 0; i < sections.length; i++) {
    const heading = sections[i].heading.replace(/\s+/g, " ").trim();
    if (heading) titled++;
    entries.push({ label: heading || null, ordinal: i + 1, index: indices[i] ?? i });
  }
  return { entries, titled };
}
