// Book metadata is bidirectional text; the interface around it is not.
//
// These two facts have to be kept apart, and the Details view was mixing them. A row computed ONE
// "is this Arabic" flag from the TITLE and then styled the AUTHOR with it, so an Arabic book by an
// English author rendered that author in the Arabic face at Arabic metrics — and the reverse pair
// rendered an Arabic author in the Latin face. A field's script is a property of that field.
//
// The second half is alignment. `dir="auto"` is the right way to order the GLYPHS of a mixed
// string: the browser's first-strong rule decides the paragraph direction and the bidi algorithm
// does the rest. But it also moves `start`/`end` with the field's own direction — so in an Arabic
// interface an English title hugged the left of its column while the Arabic author beside it hugged
// the right, the two texts drifted to opposite ends of their cells, and the reader saw a title
// apparently sitting under the Author heading.
//
// So: DIRECTION comes from the content, ALIGNMENT comes from the interface. A column belongs to the
// layout and stays where the layout puts it; the text inside renders in its own direction.

/** Arabic and its presentation forms — the same range the rest of the library tests against. */
export const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export const isArabicText = (s: string | null | undefined): boolean => !!s && ARABIC.test(s);

/**
 * Which face a metadata field should be set in, judged from THAT FIELD.
 *
 * `declaredDir` is the book's own `dir` and is only consulted for a field with no strong script of
 * its own — a title that is all digits and punctuation, say. It must never be allowed to decide the
 * script of a field that plainly states its own.
 */
export function fieldScript(text: string | null | undefined, declaredDir?: string | null): "arabic" | "latin" {
  if (isArabicText(text)) return "arabic";
  if (text && text.trim()) return "latin"; // it has strong content of its own; believe it
  return declaredDir === "rtl" ? "arabic" : "latin";
}

/**
 * The style a metadata cell needs so it cannot disturb, or be disturbed by, its neighbours.
 *
 * `isolate` makes the field its own bidi run. Two adjacent fields in one row are already separate
 * boxes, but isolation is what guarantees a trailing neutral — a bracket, a dash, a digit — cannot
 * be reordered across the boundary between them.
 */
export function fieldStyle(rtlUi: boolean): { unicodeBidi: "isolate"; textAlign: "left" | "right" } {
  return { unicodeBidi: "isolate", textAlign: rtlUi ? "right" : "left" };
}
