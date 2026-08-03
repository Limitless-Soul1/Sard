// Small formatting helpers. localeNum renders Western digits in Arabic-Indic when the UI
// language is Arabic, so panel counts/percentages read natively (٤٢ قصيدة · ٩٪).
const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

export function localeNum(n: number, lang: string): string {
  const s = String(Math.round(n));
  return lang === "ar" ? s.replace(/\d/g, (d) => AR_DIGITS[Number(d)]) : s;
}

// RAWY-65: remap the digits WITHIN an already-formatted string ("1.35", "42%", "160px" — any
// decimal places, units, or separators the caller already produced) — unlike localeNum, this
// never rounds, so it's the right helper wherever the display isn't a bare integer.
export function localeDigits(s: string, lang: string): string {
  return lang === "ar" ? s.replace(/\d/g, (d) => AR_DIGITS[Number(d)]) : s;
}

// RAWY-67: the reverse direction — Arabic-Indic digits IN a book-provided string back to Western,
// so a TOC label ("الفصل ١٠٢٢") can be parsed the same way as one already using Western digits
// ("Chapter 1022"). Only touches digit glyphs; everything else in the string is untouched.
const AR_TO_WESTERN: Record<string, string> = Object.fromEntries(AR_DIGITS.map((d, i) => [d, String(i)]));
export function toWesternDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => AR_TO_WESTERN[d]);
}

// RAWY-287 — a strict Roman numeral, anchored and well-formed. `[MDCLXVI]+` alone would accept
// "MIX", "DID" and other real words, so the ordering rules are enforced rather than the alphabet.
const ROMAN = /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;
const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanValue(s: string): number | null {
  if (!ROMAN.test(s)) return null;
  const t = s.toLowerCase();
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN_VALUES[t[i]];
    const next = ROMAN_VALUES[t[i + 1]];
    total += next && next > v ? -v : v;
  }
  return total > 0 ? total : null;
}

/**
 * RAWY-287: the CHAPTER DESIGNATOR a label carries, or `null` when it carries none.
 *
 * WHY THIS IS NOT "the first digits anywhere". The previous implementation was
 * `toWesternDigits(label).match(/\d+/)`, which reads a number out of ANY position in ANY label.
 * Measured on a real Project Gutenberg EPUB, that turned the front-matter entry
 * "THE MILLENNIUM FULCRUM EDITION 3.0" into chapter "3", while the book's actual first chapter,
 * "CHAPTER I. Down the Rabbit-Hole", yielded nothing at all because its designator is a Roman
 * numeral. The reader was shown a Contents row numbered 3 and a Chapter I numbered 4.
 *
 * THE RULE, stated in terms of how books are actually titled rather than in terms of any one book:
 * a designator is a number that OPENS the label, optionally after ONE leading word (the localized
 * "Chapter" / "الفصل" / "Kapitel" / "Capítulo" — the word varies, the SHAPE does not). Digits three
 * words deep are prose, not a designator. Both Western and Arabic-Indic digits are accepted
 * (`toWesternDigits`), as are Roman numerals.
 *
 * A Roman numeral must additionally be the whole label or be followed by PUNCTUATION, never by a
 * space. "I" and "II" are designators (The Metamorphosis titles its parts exactly that way) and
 * "CHAPTER I. Down the Rabbit-Hole" is one, but "I Am Legend" is a title whose first word happens to
 * be a letter that is also a numeral — requiring punctuation is what separates the two generically.
 */
export function extractChapterNumber(label: string | null | undefined): number | null {
  if (!label) return null;
  // Strip leading punctuation/quotes/whitespace so "«12. Title" and "— II." still present their head.
  const s = toWesternDigits(label).replace(/^[\s\p{P}\p{S}]+/u, "");
  if (!s) return null;
  // Digits opening the label, or opening it after exactly one leading word.
  const digits = s.match(/^(?:[\p{L}\p{M}]+[\s.:—–-]+)?(\d+)/u);
  if (digits) {
    const n = Number(digits[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Roman numeral in the same two shapes, but only when terminated by punctuation or end-of-label.
  const roman = s.match(/^(?:[\p{L}\p{M}]+[\s.:—–-]+)?([MDCLXVImdclxvi]+)(?=$|[\s]*[\p{P}\p{S}])/u);
  if (roman) return romanValue(roman[1]);
  return null;
}
