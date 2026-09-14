// THE SHELF'S ARITHMETIC — what a book plate is allowed to claim, and how Arabic counts it.
//
// Kept out of the component for the reason the archive's model is: every one of these is DERIVED, so
// every one can be wrong in a way no type catches — a plural that says «٢ مراجع» instead of «مرجعان»,
// a preview that labels what the design deliberately leaves unlabelled, or a count that includes a
// rule the reader switched off.
import type { RefRow, RepRow } from "../../../lib/ipc";

/** Which of the two the plate is previewing. The design gives neither a badge — they are told apart by
 *  their own grammar: a reference is a word under a rule, a replacement is `original ⟵ new`. */
export type PreviewKind = "ref" | "rep";

export interface PreviewItem {
  kind: PreviewKind;
  text: string;
  /** Only for a replacement: what it becomes. */
  to?: string;
  /** Only for a replacement: whether the rule is currently in force (drives which side carries ink). */
  on?: boolean;
}

/**
 * Arabic counts in FOUR forms, not two: one, a dual, a plural for 3-10, and an accusative singular from
 * 11 up — reference · references · 5 references · 12 references in Arabic's own grammar. Getting this
 * wrong reads as machine translation, which is exactly what this surface must not sound like.
 *
 * THE NUMBER IS FORMATTED BY THE CALLER, never here. Sard's numbering policy (RAWY-261) puts every
 * digit the interface generates in WESTERN digits in every language, Arabic included, and states that
 * Arabic-Indic digits can only come back by someone reintroducing a substitution table. An earlier
 * draft of this file was that table. It is gone; `fmt` is `localeNum`, which owns the policy.
 */
export function pluralAr(
  n: number,
  forms: { one: string; two: string; few: string; many: string },
  fmt: (n: number) => string,
): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${fmt(n)} ${forms.few}`;
  return `${fmt(n)} ${forms.many}`;
}

/**
 * The plate previews what the reader last made in this book, WHICHEVER KIND IT IS.
 *
 * The design's rule, in its own words: "because the two are interleaved, a book that holds both always
 * shows both, a book that holds only rules shows only rules, and the balance is a property of the data
 * rather than a layout decision". So they are taken in turn rather than one kind first — and the cap is
 * four when the book holds both, three when it holds one.
 */
export function previewFor(refs: RefRow[], reps: RepRow[]): PreviewItem[] {
  const both = refs.length > 0 && reps.length > 0;
  const out: PreviewItem[] = [];
  for (let i = 0; i < Math.max(refs.length, reps.length); i++) {
    if (refs[i]) out.push({ kind: "ref", text: refs[i].phrase });
    if (reps[i]) out.push({ kind: "rep", text: reps[i].phrase, to: reps[i].replacement, on: reps[i].enabled });
  }
  return out.slice(0, both ? 4 : 3);
}

/** Does this row match the search? The design states the rule: it searches reference words AND their
 *  notes AND replacements, across every book, and does not distinguish vowelled from unvowelled. */
export function matchesQuery(
  fold: (s: string) => string,
  q: string,
  refs: RefRow[],
  reps: RepRow[],
  title: string,
): boolean {
  const f = fold(q);
  if (!f) return true;
  if (fold(title).includes(f)) return true;
  for (const r of refs) if (fold(r.phrase).includes(f) || fold(r.note).includes(f)) return true;
  for (const p of reps) if (fold(p.phrase).includes(f) || fold(p.replacement).includes(f)) return true;
  return false;
}
