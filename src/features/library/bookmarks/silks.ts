// WHERE EACH RIBBON SITS ON THE HEAD OF A COVER.
//
// A ribbon is not decoration: one is drawn per saved place, in that place's own dye, at the depth
// the place sits at in the book. So the head of a cover is a true summary of a book's reading —
// how many places are saved, how far in they are, how clustered, and in which colours — readable
// without opening anything.
//
// DEPTH IS THE WHOLE-BOOK FRACTION, which is Sard's own measure of how far into a book a position
// lies and is already stored on every bookmark. The reference derives the same quantity as
// `chapter ÷ chapters`; the fraction answers the same question with better resolution and needs no
// chapter count, so nothing has to be looked up to draw a shelf.
//
// Pure on purpose: the spacing rules below are the part of the design most likely to be quietly
// broken by a later edit, and a pure function can be held to them by a test.

/** A saved place, reduced to what placing a ribbon needs. */
export interface Place {
  id: string;
  /** How far into the book, 0..1. Out-of-range values are clamped rather than refused. */
  depth: number;
}

/** One ribbon, in the units the markup uses. */
export interface Silk {
  /** Distance across the head, as a percentage string. */
  pos: string;
  /** How far the strip is pushed up out of the pages, on the shelf. */
  lift: string;
  /** Its length on the shelf. */
  len: string;
  /** The same two, at the size the opened book's head uses. */
  headLift: string;
  headLen: string;
  /** Each ribbon settles a little after the one before, so a set reads as cloth, not a rig. */
  delay: string;
}

/**
 * The head's usable span, in percent. The run starts just inside the leading edge and stops short
 * of the trailing one, so a ribbon at either extreme still sits ON the cover rather than over its
 * edge.
 */
const LEAD = 3;
const TRAIL = 86;
/**
 * The closest two ribbons may stand. An 18px strip on a 172px cover is about 10.5%, so this sits
 * just above touching: near-adjacent places separate instead of overlapping, and the spacing still
 * reads as depth until the head is full.
 */
const GAP = 10.6;

/** Stable per place, so a ribbon never jitters between renders. */
function hand(id: string, depth: number): { stand: number; tail: number } {
  const last = id.length ? id.charCodeAt(id.length - 1) : 0;
  const j = (last + Math.round(depth * 1000)) % 3;
  return { stand: 5 - [1, 0, 1][j], tail: [2, 0, 1][j] };
}

/**
 * Places in, ribbons out — in depth order, never padded, never trimmed, never recoloured.
 *
 * Crowding is resolved in two passes: push each ribbon far enough from the one before, then, if the
 * run has been pushed past the trailing edge, pull the whole run back inside the head. Beyond about
 * eight ribbons the spacing saturates and position becomes indicative rather than exact — which is
 * the honest outcome for a head that is full.
 */
export function silks(places: Place[]): Silk[] {
  const rows = places.slice().sort((a, b) => a.depth - b.depth);
  const at = rows.map((p) => {
    const d = Math.min(1, Math.max(0, Number.isFinite(p.depth) ? p.depth : 0));
    return LEAD + d * (TRAIL - LEAD);
  });
  for (let i = 1; i < at.length; i++) {
    if (at[i] - at[i - 1] < GAP) at[i] = at[i - 1] + GAP;
  }
  const over = at.length ? at[at.length - 1] - TRAIL : 0;
  if (over > 0) {
    for (let i = at.length - 1; i >= 0; i--) {
      at[i] -= over;
      if (i && at[i] - at[i - 1] >= GAP) break;
    }
  }
  return rows.map((p, i) => {
    const { stand, tail } = hand(p.id, p.depth);
    return {
      pos: `${Math.max(LEAD, at[i]).toFixed(1)}%`,
      delay: `${i * 22}ms`,
      lift: `${5 - stand}px`,
      len: `${stand + 25 + tail}px`,
      headLift: `${4 - Math.min(4, stand)}px`,
      headLen: `${Math.min(4, stand) + 18 + tail}px`,
    };
  });
}

/** The order the ribbons were drawn in — the record's rows follow it, so the two agree. */
export const byDepth = <T extends { depth: number }>(rows: T[]): T[] =>
  rows.slice().sort((a, b) => a.depth - b.depth);
