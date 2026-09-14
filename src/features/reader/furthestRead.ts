// THE FURTHEST POSITION A READER HAS REACHED IN A BOOK — the destination for "take me back to where I
// got to", and nothing else.
//
// WHY THIS IS NOT A NEW READING-PROGRESS SYSTEM. Sard already decides, once, where the reader is and
// when that is worth recording: the relocate handler writes `reading_progress` on a debounce, and
// REFUSES to write while a return-anchor holds (RAWY-250 — a jump is being previewed, so the reader is
// inspecting, not reading). This mark is simply the MAXIMUM of that same value over time. It advances
// on exactly the writes the existing pipeline already makes, so it inherits every distinction that
// pipeline draws — most importantly the one the owner asked about:
//
//   · jump to chapter 900 from 488 and come back  → the freeze held, no progress was written at 900,
//     so the mark stays at 488. Browsing is not reaching.
//   · jump to 900 and READ ON                     → the freeze thaws (dismissed, or read forward past
//     the landing), progress is written there, and the mark advances. That is genuinely reaching it.
//
// One definition, one moment, no second opinion about what "read" means.
//
// WHY A CFI AND NOT A CHAPTER NUMBER. A chapter number is a label the Contents panel computes for
// display (`bookNumbers` picks the book's own designators or falls back to position, per book); it is
// not an identity and it moves when a TOC is re-derived. Sard's reading position has always been a
// CFI, which addresses a point in the text itself, survives a section change, and is what
// `goToLocator` navigates by. So the mark stores what the reader already stores, and the chapter is
// only ever DISPLAYED from it.
//
// The label and section travel with the cfi as a convenience for the button — a stale label after a
// TOC change is cosmetic and self-heals the moment the reader relocates there, while the cfi still
// navigates correctly.

/** The furthest point reached in one book. `cfi` is authoritative; the rest is for display. */
export type FurthestMark = {
  /** Where it is — the only field navigation uses. */
  cfi: string;
  /** How far through the book, 0..1. The ordering fallback, and never trusted over a cfi compare. */
  fraction: number;
  /** The chapter label as it read when the mark was set, or null in a book with no contents. */
  label: string | null;
  /**
   * The href of the contents entry the mark sits in, or null.
   *
   * DISPLAY ONLY, and the reason it is stored: the Contents panel is the one place that decides how a
   * chapter is NAMED — its own numbering source per book, and the neutral "الفصل N" it substitutes
   * while chapter titles are hidden. Given the href it can look the mark up as one of its own rows and
   * name it exactly as it names every other, so the anti-spoiler setting is honoured by construction
   * instead of by a second copy of the rule that could disagree with the list beneath it.
   */
  href: string | null;
  /** The spine section the mark lives in, or -1 when it was not known. Display/diagnostics only. */
  sec: number;
};

/**
 * Where the candidate stands relative to the held mark in the book's own order — negative before,
 * positive after, 0 the same place — or null when the engine could not say.
 *
 * THE RESULT, NOT THE COMPARATOR. The ordering of two cfis is the reading engine's to define, and on
 * platforms where the engine runs behind a port a function cannot be handed across it at all. So the
 * engine is ASKED and this module is told the answer, which also makes the rule below a pure function
 * of three plain values and testable without an engine.
 */
export type Order = number | null;

/**
 * Read a stored mark back. Anything malformed — an old value, a truncated write, a hand-edited row —
 * means "nothing recorded yet", never a throw: this runs on the open path, and a book must always
 * open.
 */
export function parseFurthest(raw: string | null | undefined): FurthestMark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FurthestMark>;
    if (!v || typeof v.cfi !== "string" || v.cfi.length === 0) return null;
    return {
      cfi: v.cfi,
      fraction: typeof v.fraction === "number" && Number.isFinite(v.fraction) ? v.fraction : 0,
      label: typeof v.label === "string" && v.label.length > 0 ? v.label : null,
      href: typeof v.href === "string" && v.href.length > 0 ? v.href : null,
      sec: typeof v.sec === "number" && Number.isFinite(v.sec) ? v.sec : -1,
    };
  } catch {
    return null;
  }
}

export function serialiseFurthest(m: FurthestMark): string {
  return JSON.stringify(m);
}

/**
 * Is `candidate` genuinely beyond `held`?
 *
 * The engine's ordering is the authority — it understands the document order that fractions only
 * approximate.
 *
 * FRACTION IS THE FALLBACK, NOT THE RULE. When the engine could not order the two, the fraction still
 * orders positions correctly for every book that reports one, and a book that reports none simply
 * never advances past its first mark — which is the safe direction to fail in: a mark that lags is a
 * button that goes somewhere real, while a mark that overshoots sends the reader ahead of themselves.
 * EQUAL is not beyond, so re-reading the same page never rewrites the row.
 */
export function isBeyond(candidate: { cfi: string; fraction: number }, held: FurthestMark | null, order: Order): boolean {
  if (!candidate.cfi) return false;
  if (!held) return true;
  if (order !== null && Number.isFinite(order)) return order > 0;
  return candidate.fraction > held.fraction;
}

/**
 * The mark after seeing `candidate`, or NULL when nothing changed.
 *
 * Returning null rather than the unchanged mark is what keeps the write cheap: the caller persists
 * only on a non-null answer, so paging backwards through half a book writes nothing at all, and
 * reading forward writes once per position the existing progress debounce already reports.
 */
export function advanceFurthest(
  held: FurthestMark | null,
  candidate: FurthestMark,
  order: Order,
): FurthestMark | null {
  return isBeyond(candidate, held, order) ? candidate : null;
}

/**
 * Should the "go to the furthest point" action be offered at all?
 *
 * BY CHAPTER, NOT BY CFI, and that is a correction rather than a convenience. Comparing the live cfi
 * with the mark's looks exact and is unusably sensitive: navigating TO the mark lands on the page
 * that CONTAINS it, and that page's reported cfi is a fraction of a page behind the one stored — so
 * the mark stays nominally "ahead" for ever and the control never goes away. Measured in the running
 * reader: after pressing the action and arriving, it was still offered, pointing at the chapter the
 * reader was standing in.
 *
 * The unit of comparison should be the unit the control NAMES, and it names a chapter. So both sides
 * are contents-row indices: the row the reader is inside, and the row the mark lives in. A reader in
 * the chapter they got to is already there and is offered nothing; a reader in any earlier chapter is
 * offered the way back. `activeIndex` is -1 when the reader is inside no listed entry at all, which
 * compares correctly against any real row without a special case.
 *
 * THE TRADE-OFF, STATED: within ONE very long chapter this offers nothing, because there is no
 * earlier chapter to have come back from. In a book whose whole text is a single section there is no
 * "furthest chapter" to return to, and the control stays out of the way rather than offering to move
 * the reader somewhere it cannot name.
 */
export function offerReturn(furthestIndex: number, activeIndex: number): boolean {
  return furthestIndex >= 0 && furthestIndex > activeIndex;
}

/**
 * The mark a book opens with.
 *
 * A book read before this mark existed has no stored row, and treating that as "has reached nowhere"
 * would be false — and, now that the spoiler-safe search boundary follows this mark, a regression:
 * a null mark seals nothing and reveals the whole book to a search. Where the reader STOPPED READING
 * is a point they reached, so it becomes the opening mark.
 *
 * It carries no contents href or section — neither is known before the view exists — so it names
 * itself by percentage until the first real position refines it. The caller persists a mark seeded
 * this way immediately: held only in memory it would be lost the moment the reader paged backwards
 * and closed the book, which is the exact case the whole feature exists for.
 */
export function markFromResume(
  stored: FurthestMark | null,
  saved: { cfi?: string | null; fraction?: number | null } | null | undefined,
): FurthestMark | null {
  if (stored) return stored;
  if (!saved?.cfi) return null;
  return {
    cfi: saved.cfi,
    fraction: typeof saved.fraction === "number" && Number.isFinite(saved.fraction) ? saved.fraction : 0,
    label: null,
    href: null,
    sec: -1,
  };
}

/**
 * Has the spoiler-safe boundary parted company with where the reader is standing?
 *
 * Only the WORDING of the search panel depends on this. While the reader is at their furthest point
 * the boundary IS their position and the panel says so, exactly as it always has; once they move back
 * the boundary stays put, and calling that "your position now" would be a plain untruth.
 *
 * By contents row where the mark knows its row — the same unit `offerReturn` uses, so the two controls
 * can never disagree about whether the reader is behind their furthest point. A mark seeded from the
 * resume position has no row yet, and then the whole-book fraction answers it.
 */
export function boundaryHasParted(
  mark: FurthestMark | null,
  furthestIndex: number,
  activeIndex: number,
  hereFraction: number,
): boolean {
  if (!mark?.cfi) return false;
  if (furthestIndex >= 0) return offerReturn(furthestIndex, activeIndex);
  return mark.fraction > hereFraction;
}

/** Where an explicit contents jump put the reader, once its landing has been seen. */
export type Landing = { loc: number | null; frac: number };

/**
 * Has the reader moved ON from where the contents list put them?
 *
 * WHY A TIME WINDOW WAS THE WRONG INSTRUMENT. The first attempt ignored relocates for 1.5s after a
 * contents jump, on the reasoning that the landing arrives within a frame or two. Measured in the
 * running reader: it does — and then ANOTHER relocate arrives at the same position much later,
 * whenever the reading area is re-laid out (opening the Contents panel is enough). That one fell
 * outside the window and advanced the mark, so a reader who jumped to chapter 900 to look at it had
 * chapter 900 recorded as read the moment they opened the contents list again.
 *
 * Position answers what time cannot: a re-layout reports the SAME place, and only reading moves
 * forward from it. `loc` is foliate's location index — the same unit the return-anchor's own thaw rule
 * uses for the same question — and the whole-book fraction stands in for books that report none.
 * Forward only: paging back toward the start of the chapter you landed in is not reading on.
 */
export function movedOnFrom(landing: Landing | null, here: Landing): boolean {
  if (!landing) return true; // nothing pending — the reader was not sent anywhere
  if (landing.loc != null && here.loc != null) return here.loc > landing.loc;
  return here.frac > landing.frac;
}
