// RAWY-260 — REFERENCES: the matching engine.
//
// A reference binds a note to a PHRASE, not to a location, so every occurrence of that phrase in the book
// carries the mark — including passages the reader reaches months later. This module owns two things and
// nothing else: how a phrase is FOLDED for comparison, and how a rendered section's text is SCANNED for
// occurrences. It is deliberately free of DOM-writing, React and Tauri so the rules are testable in
// isolation and can never drift between the create path and the render path.
//
// ⚠️ THE HARD CONSTRAINT: the mark is drawn by the CSS Custom Highlight API over Ranges. Nothing is ever
// written into the book — no <span>, no injected characters, no text mutation — because inserting or
// wrapping a node shifts foliate's CFI child-step indices and would break every stored bookmark, resume
// position, highlight and TTS range. This module therefore only ever PRODUCES Ranges; it never edits a doc.

/** Arabic combining marks + tatweel — dropped before comparing, so «كِتاب» and «كتاب» agree. */
const TASHKIL_TATWEEL = /[ـً-ْٰۖ-ۭ]/g;

/**
 * The comparison key for a phrase. Mirrors the folding the in-book search already uses (RAWY-86/88) so the
 * two behave the same way on the same text: NFKC (collapses Arabic presentation forms), tashkīl/tatweel
 * stripped, alef/ya/teh-marbuta folded, lowercased.
 *
 * Whitespace is COLLAPSED, not dropped — unlike the search's fold. A reference may be a short PHRASE
 * ("Tarot Club", "City of Silver"), so word boundaries have to survive folding; dropping spaces would let
 * "Tarot Club" match inside an unrelated run of letters.
 */
export function foldPhrase(s: string): string {
  return s
    .normalize("NFKC")
    .replace(TASHKIL_TATWEEL, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Token count of a phrase — lets the section scanner skip multi-token work when every phrase is 1 word. */
export function phraseWordCount(s: string): number {
  const f = foldPhrase(s);
  return f ? f.split(" ").length : 0;
}

/**
 * Is the character at `i` a word character? Unicode-aware: any letter or number in ANY script counts, so
 * this is correct for Arabic without special-casing it, and never inspects shaping.
 */
// Letters, numbers and combining marks in ANY script — correct for Arabic without special-casing it, and
// it never inspects shaping. The APOSTROPHES are included deliberately: the spec's own example is that
// «Klein» must NOT match "Klein's", and an apostrophe is otherwise punctuation, which would read as a word
// boundary and match. Both the ASCII quote and the typographic one (U+2019) count, since real prose uses
// the latter. Arabic is unaffected — it does not mark possession this way.
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’]/u;
const isWordChar = (s: string, i: number): boolean => i >= 0 && i < s.length && WORD_CHAR.test(s[i]);

/**
 * A whole-phrase boundary test. This is what makes «Klein» match "Klein" but NOT "Klein's" or "Kleiner":
 * the character on each side of the hit must not itself be a word character. Punctuation, spaces, quotes,
 * dashes and the string edges all qualify as boundaries.
 */
function isWholeMatch(hay: string, start: number, end: number): boolean {
  return !isWordChar(hay, start - 1) && !isWordChar(hay, end);
}

/** One occurrence, expressed in the section's FOLDED text; the caller maps it back to a DOM Range. */
export interface PhraseHit {
  /** Index into the folded haystack. */
  start: number;
  /** Exclusive end index into the folded haystack. */
  end: number;
  /** Which reference matched (its id), so the popup knows what to show. */
  refId: string;
}

/**
 * Find every whole-phrase occurrence of each reference inside one section's folded text.
 *
 * Cost is O(text × references) worst case, but references per book are counted in tens and each scan is a
 * plain `indexOf` — no regex compilation per phrase, no backtracking. Crucially this runs ONCE PER SECTION,
 * on load, over that section's text only: the whole book is never rescanned, so a 1400-chapter EPUB costs
 * exactly as much as the chapter on screen.
 *
 * Longer phrases are matched FIRST and claimed regions are skipped, so "City of Silver" wins over a bare
 * "Silver" reference inside it rather than both marking the same words.
 */
export function findPhraseHits(
  foldedText: string,
  refs: { id: string; phrase_fold: string }[],
): PhraseHit[] {
  const hits: PhraseHit[] = [];
  if (!foldedText) return hits;
  // Longest first so a phrase reference beats a single-word one nested inside it.
  const ordered = [...refs]
    .filter((r) => r.phrase_fold)
    .sort((a, b) => b.phrase_fold.length - a.phrase_fold.length);
  // Marks positions already claimed by a longer phrase — one byte per char, cheap and allocation-free.
  const claimed = new Uint8Array(foldedText.length);
  for (const r of ordered) {
    const needle = r.phrase_fold;
    let from = 0;
    for (;;) {
      const i = foldedText.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      from = i + 1; // advance by one so overlapping occurrences are still found
      if (!isWholeMatch(foldedText, i, end)) continue;
      let overlaps = false;
      for (let k = i; k < end; k++) {
        if (claimed[k]) { overlaps = true; break; }
      }
      if (overlaps) continue;
      for (let k = i; k < end; k++) claimed[k] = 1;
      hits.push({ start: i, end, refId: r.id });
    }
  }
  return hits;
}

/** The shape the renderer needs — the note/phrase for display come from the store, not from here. */
export interface RefLite {
  id: string;
  phrase_fold: string;
}

// A section is folded ONE CHARACTER AT A TIME so each folded char can be mapped back to its source node,
// which means `foldPhrase` would otherwise run hundreds of thousands of times per chapter. A book uses only
// a few hundred DISTINCT characters, so memoise per char — the same trick the search fold uses (RAWY-178).
const FOLD_CHAR_CACHE = new Map<string, string>();
export function foldChar(ch: string): string {
  let v = FOLD_CHAR_CACHE.get(ch);
  if (v === undefined) {
    // Whitespace must SURVIVE as a single space (phrases have word boundaries), so it is folded here
    // rather than through foldPhrase, whose trim/collapse is meant for a whole phrase.
    v = /\s/.test(ch) ? " " : foldPhrase(ch);
    FOLD_CHAR_CACHE.set(ch, v);
  }
  return v;
}
