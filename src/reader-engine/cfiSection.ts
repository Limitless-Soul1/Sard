// RAWY-229: the SPINE SECTION of a foliate CFI, and the "same chapter?" test built on it.
//
// WHY THIS IS A MODULE AND NOT A PRIVATE METHOD. It was both of those things inside
// `FoliateController`, and it is pure — no engine state, no DOM, just a regex over a string. That
// purity is what makes it the one place the hosted transport cannot route through the reader host:
// `Reader.tsx:300` calls `bookmarkVisible` inside a REACT RENDER BODY, which cannot await, so on
// WebKit the answer has to be computed in the application while the engine runs elsewhere.
//
// The alternatives were worse. Re-implementing the rule in the transport would put two copies of a
// CFI parser in the codebase, and the day they disagreed a bookmark would light up in the wrong
// chapter with nothing to point at. Pushing a precomputed visibility set from the host would make a
// render path depend on a snapshot arriving in time.
//
// So it moves, exactly as `navIntent.ts` already did for the same reason: ONE copy, shared with its
// tests, called by the controller and by the transport alike. `FoliateController.bookmarkVisible`
// still exists and still behaves identically — it delegates here.

/**
 * The spine section of a foliate CFI: the step before `!` (or the whole inner CFI at a section
 * boundary, which has no `!`), with any `[assertion]` stripped.
 *
 * Two CFIs in the same chapter share it exactly, so string equality is "same chapter".
 */
export function cfiSection(cfi: string | null | undefined): string | null {
  if (!cfi) return null;
  const m = /^epubcfi\((.*)\)$/.exec(cfi.trim());
  const inner = m ? m[1] : cfi.trim();
  const spine = inner.split("!")[0].replace(/\[[^\]]*\]/g, "").trim();
  return spine || null;
}

/**
 * Is `bookmarkCfi` in the same chapter as `currentCfi`?
 *
 * The bookmark marker stays lit anywhere in its chapter — top to bottom, any scroll position — and
 * goes out only when the reader LEAVES that chapter. Section identity is what expresses that, not a
 * whole-book fraction window.
 */
export function sameSection(
  bookmarkCfi: string | null | undefined,
  currentCfi: string | null | undefined,
): boolean {
  const a = cfiSection(bookmarkCfi);
  const b = cfiSection(currentCfi);
  return a != null && a === b;
}
