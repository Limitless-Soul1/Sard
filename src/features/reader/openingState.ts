// WHEN THE READER HAS NOTHING TO SHOW YET, and how the contents panel must say so.
//
// WHY THIS IS A MODULE AND NOT TWO INLINE CONDITIONS. Both defects it fixes were the same mistake in
// two places: an ABSENCE was rendered as a FINDING. The reading surface showed a bare page while the
// book was being parsed, and the contents panel announced "this book has no contents list" — the
// final answer — before the contents had been resolved at all. Neither surface was reading the
// status the reader already tracks.
//
// MEASURED on a real Linux machine, opening a 10.2 MB EPUB with 1,432 TOC entries: the host
// handshake takes ~22 ms and the bytes ~54 ms, but the engine's own open takes ~2.48 s. For that
// whole 2.5 s the reader claimed the book had no chapters and showed an empty page. The parse time
// is real work and is not this module's business; presenting it honestly is.
//
// Keeping the decision in ONE place is what stops the two surfaces disagreeing — a spinner on the
// page beside "no contents list" in the panel would be worse than either defect alone.
import type { ReaderStatus } from "../../reader-engine/store";

/**
 * Is the book still being opened?
 *
 * `ready` and `error` are the only two statuses that mean the work has FINISHED — one with a book,
 * one with a reason. Everything else is still in progress: `loading` is the parse, and `idle` is the
 * first render, before `openBook` has run. Asking the question this way round is deliberate. A new
 * status added to `ReaderStatus` later would be treated as "still working", which shows a spinner
 * for slightly too long; the other way round it would assert an empty book, which is a lie.
 */
export function isOpening(status: ReaderStatus): boolean {
  return status !== "ready" && status !== "error";
}

/** What the contents panel should render in place of its list. */
export type ContentsView = "loading" | "empty" | "list";

/**
 * Loading, genuinely empty, or a list — never guessed from `toc.length` alone.
 *
 * An empty TOC means nothing on its own: it is the same value before the book is parsed and after a
 * book with no contents list has been parsed. Only the reader's status separates them, which is why
 * it has to be passed in.
 *
 * ERROR IS DELIBERATELY NOT A CASE HERE. When a book fails to open, `isOpening` is false and the TOC
 * is empty, so this returns "empty" — exactly what the panel showed before this change. The failure
 * is reported by the reader's own error card, which covers the reading surface with its recovery
 * actions; adding a second, quieter explanation in the panel would compete with it.
 */
export function contentsView(opening: boolean, tocLength: number): ContentsView {
  if (opening) return "loading";
  return tocLength === 0 ? "empty" : "list";
}
