// WHERE A STRANGER'S MARK BELONGS IN *YOUR* COPY — the decision, with no DOM in sight.
//
// A deposit bound to a different edition carries cfis that mean nothing here, so each mark has to earn
// its place by its own text. This module owns the rules that decide whether it has; the reader owns the
// searching and the anchoring.
//
// THE ONE RULE THAT MATTERS: a mark is placed only where its text occurs EXACTLY ONCE in the scope
// being searched. Never "the first occurrence", at any tier — an unplaced mark is a small
// disappointment, a misplaced one is a lie about what someone read.
//
// Two tiers, in order:
//
//   T1 · the section the sender's own chapter label names. A chapter keeps its NAME across editions far
//        more reliably than its position, which is why the label is the hint and the spine ordinal is
//        not — an ordinal in a forty-section edition means nothing in a sixty-section one.
//   T2 · the whole book, requiring GLOBAL uniqueness. This is the strictest rule in the algorithm, not
//        the loosest: it places a mark only when the book contains its words in exactly one place.
import { foldChar } from "../../../lib/references";

export type PlacementState =
  | "pending"
  | "located"
  | "placed"
  | "already_yours"
  | "ambiguous"
  | "absent"
  | "unanchorable";

/**
 * The shortest excerpt worth trusting, in folded characters.
 *
 * A four-character needle is not evidence: in a novel it will occur everywhere, and its uniqueness in
 * one chapter would be luck rather than identity. Below this a mark is refused outright rather than
 * being let through to a tier that might find it "unique" by accident.
 */
export const MIN_NEEDLE = 12;

/**
 * Fold text the way the reference matcher folds it — NFKC, tashkīl and tatweel stripped, alef/ya/
 * teh-marbuta folded, lowercased — one character at a time.
 *
 * Per character, deliberately: it is what lets the reader map a hit's index back to the exact text node
 * it came from, and it is the folding Sard's own in-book matching already uses. The needle and the
 * haystack must be folded by the SAME function or a count means nothing.
 */
export function foldText(s: string): string {
  let out = "";
  for (const ch of s) out += foldChar(ch);
  return out;
}

/** Every occurrence of `needle` in `hay`, counted; overlapping occurrences included. */
export function countIn(hay: string, needle: string, cap = 0): number {
  if (!hay || !needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return n;
    n++;
    from = i + 1;
    if (cap && n > cap) return n;
  }
}

/** What the search found, per tier. The reader fills this in; this module never touches a document. */
export interface TierEvidence {
  /** The section the sender's chapter label named, and how many times the needle occurs there.
   *  `null` when the label matched no section — a book with no usable table of contents, a label the
   *  recipient's edition does not use, or a mark that carried no label at all. */
  labelled: { section: number; count: number } | null;
  /** Occurrences across the whole book, and the single section holding it when there is exactly one. */
  whole: { count: number; section: number | null };
}

export interface Verdict {
  state: PlacementState;
  target_section: number | null;
}

/**
 * Decide, from evidence alone.
 *
 * Ambiguity is terminal: if the labelled chapter holds the words twice, finding them again elsewhere
 * cannot make the choice safer, so there is no falling through to a wider search. Absence is not
 * terminal at T1 — a different edition may simply name its chapters differently, so a labelled section
 * that does not contain the words hands the question to the whole book.
 */
export function decide(needle: string, evidence: TierEvidence): Verdict {
  if (!needle || needle.length < MIN_NEEDLE) {
    return { state: "unanchorable", target_section: null };
  }
  const t1 = evidence.labelled;
  if (t1) {
    if (t1.count === 1) return { state: "located", target_section: t1.section };
    if (t1.count > 1) return { state: "ambiguous", target_section: t1.section };
    // count === 0 → the label named a section that does not hold these words; ask the whole book
  }
  const t2 = evidence.whole;
  if (t2.count === 1 && t2.section !== null) return { state: "located", target_section: t2.section };
  if (t2.count > 1) return { state: "ambiguous", target_section: null };
  return { state: "absent", target_section: null };
}

/**
 * A note follows the highlight it belongs to, and is NEVER searched for on its own.
 *
 * Its body is the reader's words, not the book's; searching for them could only ever find a
 * coincidence. So a note linked to a highlight inherits that highlight's fate exactly, and a note with
 * no highlight has nothing to anchor to and says so.
 */
export function noteFollows(highlight: Verdict | null): Verdict {
  if (!highlight) return { state: "unanchorable", target_section: null };
  return { state: highlight.state, target_section: highlight.target_section };
}

/** Is this verdict final? A terminal state is never revisited, which is what makes the pass idempotent. */
export const isTerminal = (s: string | null | undefined): boolean =>
  s === "placed" || s === "already_yours" || s === "ambiguous" || s === "absent" || s === "unanchorable";
