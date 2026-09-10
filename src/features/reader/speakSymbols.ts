// WHETHER THE VOICE SAYS THE DECORATIVE MARKS — the هيئة's preference, and this book's answer to it.
//
// THREE STATES, NOT TWO, and the third is the whole point. A book may say "pronounce them", "do not
// pronounce them", or say NOTHING — and saying nothing has to stay distinguishable from saying no,
// or a reader who turns the setting off for one book could never get back to following their هيئة.
// `null` is the third state; an absent row is how it is spelled on disk.
//
// WHY A ROW OF ITS OWN, and why this is not the two-level reading style coming back. `perBookSettings`
// records that Sard used to resolve a PARTIAL `ReadingStyle` per book over the global one, and that it
// was removed on measured evidence: a book that had once been tuned kept its own faces and colours
// whatever هيئة was worn, so switching هيئة changed everything except the book in front of you. That
// resolver is gone and stays gone. This is the OTHER pattern the reader already uses — one row, one
// question, per book — exactly as `pdf.zoom.<id>`, `furthest_read:<id>` and `chapters_read:<id>` do,
// and the note beside the last of those states the rule this follows: "no schema change, no migration,
// and an absent key simply means this book has no mark yet".
//
// It cannot grow into the old resolver, because it can only ever answer one boolean question.

/** Per-book memory. The mark is a property of the book being read, not of the library. */
export const speakSymbolsKey = (bookId: string): string => `tts.speakSymbols.${bookId}`;

/** How the two answers are written. An absent row is the third state and is never written as text. */
export const speakSymbolsAttr = (v: boolean): string => (v ? "1" : "0");

/**
 * The book's own answer, or `null` for "this book has not been asked".
 *
 * Total: anything that is not one of the two written forms reads as `null`, so a row written by a
 * future version, or corrupted, degrades to following the هيئة rather than to a guess.
 */
export function parseSpeakSymbols(raw: string | null | undefined): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/**
 * What the voice will actually do: the book's answer when it has one, the هيئة's otherwise.
 *
 * Written as a function rather than `??` at each call site because there are two of them — the
 * synthesis path and the control that has to show which state the reader is in — and a precedence
 * rule that lives in two places is a precedence rule that will eventually disagree with itself.
 */
export function effectiveSpeakSymbols(bookOverride: boolean | null, appearance: boolean): boolean {
  return bookOverride ?? appearance;
}
