// REPLACEMENTS — reading a word as something else, without changing the book.
//
// A replacement differs from a reference in exactly one way that matters: a reference DECORATES a range,
// while a replacement changes the GLYPHS. That was measured to rule out the safe-looking option. Drawing
// the new word over the old one in the overlayer keeps every CFI untouched, but the original keeps its
// own advance width, and across ten realistic pairs in the four bundled Arabic faces only 2 of 40 fell
// within ±10% of it — «اله» → «حاكم» needs 2.0-2.1× the room in three of the four. Fitting it means
// condensing Arabic to 47%, which destroys the letterforms. So the text itself is changed.
//
// WHAT MAKES THAT SAFE, AND WHY THE DIGITS REGRESSION DOES NOT APPLY. That regression was caused by
// SPLITTING text nodes into spans, which moved the child-step indices a CFI is built from. This writes
// `textNode.data` in place: no node added, none removed, none split. Measured on real annotations, the
// stored CFI still resolves to the SAME text node in 16/16 Latin and 24/24 Arabic cases. Only the
// character offset inside that one node moves — and that is arithmetic this module can undo exactly.
//
// THE COORDINATE RULE, which the whole feature rests on:
//
//     stored CFIs are ALWAYS in the author's coordinates. The page may be in replaced coordinates.
//
// So resolving a CFI shifts offsets author -> displayed, and minting one shifts them displayed -> author.
// Both directions are `shiftOffset` below, and both are identity when the section has no replacement,
// which is why a library that never makes one behaves exactly as before.
import { foldChar, findPhraseHits } from "./references";

/** The minimum a matcher needs: the folded key to find, and the wording to show instead. */
export interface RepLite {
  id: string;
  phrase_fold: string;
  replacement: string;
  /** The author's wording verbatim. Only the search expansion needs it; the matcher works on the fold. */
  phrase?: string;
}

/** One applied substitution inside ONE text node, expressed in that node's AUTHOR coordinates. */
export interface NodeEdit {
  /** Offset in the node's original data where the replaced run begins. */
  start: number;
  /** Length of the author's run that was replaced. */
  origLen: number;
  /** Length of the text now standing in its place. */
  newLen: number;
}

/** What a section had done to it — enough to translate offsets and to put it back exactly. */
export interface SectionPlan {
  /** Per node, its edits ascending by `start`, in author coordinates. */
  edits: Map<Text, NodeEdit[]>;
  /** Per node, the author's data, so the section restores byte-for-byte. */
  original: Map<Text, string>;
  /** How many occurrences were substituted, for the reader-facing notice. */
  count: number;
}

export const emptyPlan = (): SectionPlan => ({ edits: new Map(), original: new Map(), count: 0 });

/**
 * Translate an offset between the two coordinate systems.
 *
 * `toDisplayed` shifts author -> page (resolving a stored CFI); the inverse shifts page -> author
 * (minting a CFI from a live selection). An offset landing strictly INSIDE a substituted run has no
 * exact twin, so the two ends clamp in opposite directions — a start collapses to the run's beginning,
 * an end to its end — which keeps a translated range covering the same words rather than half a word.
 */
export function shiftOffset(
  edits: NodeEdit[] | undefined,
  offset: number,
  isEnd: boolean,
  toDisplayed: boolean,
): number {
  if (!edits || !edits.length) return offset;
  // `shift` is the growth of every run that ends before `offset`, always counted in author terms; which
  // side it is added to is the only thing that differs between the two directions.
  let shift = 0;
  for (const e of edits) {
    const startHere = toDisplayed ? e.start : e.start + shift;
    const lenHere = toDisplayed ? e.origLen : e.newLen;
    if (offset >= startHere + lenHere) {
      shift += e.newLen - e.origLen;
      continue;
    }
    if (offset > startHere) {
      const runStart = toDisplayed ? e.start + shift : e.start;
      return isEnd ? runStart + (toDisplayed ? e.newLen : e.origLen) : runStart;
    }
    break; // edits are ascending; nothing further can affect this offset
  }
  return toDisplayed ? offset + shift : offset - shift;
}

/** Where the author's runs are inside one string, whole-word, through the shared matcher. */
function runsIn(text: string, reps: RepLite[]): { start: number; end: number; to: string }[] {
  if (!text || !reps.length) return [];
  let hay = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const fc = foldChar(text[i]);
    for (let k = 0; k < fc.length; k++) {
      hay += fc[k];
      map.push(i);
    }
  }
  const byId = new Map(reps.map((r) => [r.id, r.replacement]));
  const out: { start: number; end: number; to: string }[] = [];
  for (const h of findPhraseHits(hay, reps)) {
    if (h.start >= map.length) continue;
    const start = map[h.start];
    let end = h.end - 1 < map.length ? map[h.end - 1] + 1 : text.length;
    // A combining mark folds to nothing, so it has no entry in `map`; swallow any that trail the run so
    // the vowelled «الهُ» is replaced whole rather than leaving its damma orphaned against the new word.
    while (end < text.length && foldChar(text[end]) === "") end++;
    out.push({ start, end, to: byId.get(h.refId) ?? "" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Apply replacements to a plain string — the same matcher and the same runs the page uses.
 *
 * This is what makes an annotation read the way the page reads: a stored passage carries the author's
 * wording, and when a rule is in force the surface shows that passage with the rule applied. Nothing is
 * written back; the row keeps the author's words.
 */
export function applyToText(text: string, reps: RepLite[]): string {
  const runs = runsIn(text, reps);
  if (!runs.length) return text;
  let out = text;
  for (let i = runs.length - 1; i >= 0; i--) out = out.slice(0, runs[i].start) + runs[i].to + out.slice(runs[i].end);
  return out;
}

/** Does this string contain anything a rule would change? Used to decide whether to say so. */
export const textHasReplacement = (text: string, reps: RepLite[]): boolean => runsIn(text, reps).length > 0;

/**
 * Substitute every occurrence in a rendered section, in place.
 *
 * The section is folded ONE CHARACTER AT A TIME with a map back to its source node, exactly as the
 * reference matcher does it, so a phrase is found across the whole section rather than per text node —
 * which is what lets a multi-word rule match when the author's markup happens to split it across an
 * italic or a footnote anchor. A run spanning several nodes puts the whole replacement in the first
 * node's share and empties the rest: the glyphs land in one place, and each node's arithmetic stays
 * independent and exact.
 *
 * MUST RUN BEFORE ANY OVERLAY IS DRAWN. Writing `.data` collapses live Ranges the DOM is tracking, so a
 * section is substituted while it loads and never while its highlights are on screen.
 */
export function applyToSection(doc: Document, reps: RepLite[]): SectionPlan {
  const plan = emptyPlan();
  if (!reps.length || !doc.body) return plan;

  const nodes: Text[] = [];
  let hay = "";
  const srcNode: Text[] = [];
  const srcOff: number[] = [];
  try {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      nodes.push(t);
      const s = t.data;
      for (let i = 0; i < s.length; i++) {
        const fc = foldChar(s[i]);
        for (let k = 0; k < fc.length; k++) {
          hay += fc[k];
          srcNode.push(t);
          srcOff.push(i);
        }
      }
    }
  } catch {
    return plan; // a torn-down section — nothing to do
  }
  if (!hay) return plan;

  const byId = new Map(reps.map((r) => [r.id, r.replacement]));
  const hits = findPhraseHits(hay, reps);
  if (!hits.length) return plan;

  // Collect per-node runs first; nothing is written until the whole section has been planned.
  const perNode = new Map<Text, { start: number; end: number; to: string }[]>();
  for (const h of hits) {
    if (h.start >= srcNode.length) continue;
    const to = byId.get(h.refId) ?? "";
    // Split the hit into one segment per source node it crosses.
    const segs: { node: Text; from: number; to: number }[] = [];
    for (let k = h.start; k < h.end && k < srcNode.length; k++) {
      const node = srcNode[k];
      const off = srcOff[k];
      const last = segs[segs.length - 1];
      if (last && last.node === node) last.to = off + 1;
      else segs.push({ node, from: off, to: off + 1 });
    }
    if (!segs.length) continue;
    // Swallow trailing combining marks on the final segment, which fold away and so have no hay entry.
    const tail = segs[segs.length - 1];
    while (tail.to < tail.node.data.length && foldChar(tail.node.data[tail.to]) === "") tail.to++;
    segs.forEach((s, i) => {
      const list = perNode.get(s.node) ?? [];
      list.push({ start: s.from, end: s.to, to: i === 0 ? to : "" });
      perNode.set(s.node, list);
    });
    plan.count++;
  }

  for (const [node, runsRaw] of perNode) {
    const runs = runsRaw.sort((a, b) => a.start - b.start);
    plan.original.set(node, node.data);
    plan.edits.set(
      node,
      runs.map((r) => ({ start: r.start, origLen: r.end - r.start, newLen: r.to.length })),
    );
    let data = node.data;
    for (let i = runs.length - 1; i >= 0; i--) data = data.slice(0, runs[i].start) + runs[i].to + data.slice(runs[i].end);
    node.data = data;
  }
  return plan;
}

/** Put a section back to the author's wording, exactly. Measured to restore the baseline byte-for-byte. */
export function restoreSection(plan: SectionPlan): void {
  for (const [node, data] of plan.original) {
    try {
      node.data = data;
    } catch {
      /* the node left the tree with its section — nothing to restore */
    }
  }
  plan.edits.clear();
  plan.original.clear();
  plan.count = 0;
}

/**
 * Expand a search query so BOTH wordings find the passage.
 *
 * Search reads the book through foliate's own `createDocument()`, a fresh parse that never sees the
 * rendered page — so it always searches the AUTHOR's text. Typing the author's word therefore works
 * untouched; typing the replacement must be translated back to what is actually written. Returning the
 * query itself first keeps the ordinary case first in the results.
 */
export function expandQuery(query: string, reps: RepLite[], fold: (s: string) => string): string[] {
  const q = query.trim();
  if (!q || !reps.length) return q ? [q] : [];
  const fq = fold(q);
  const out = [q];
  for (const r of reps) {
    if (!r.replacement) continue;
    const author = r.phrase ?? r.phrase_fold;
    if (fold(r.replacement) === fq && !out.some((x) => fold(x) === fold(author))) out.push(author);
  }
  return out;
}
