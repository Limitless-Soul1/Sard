// ─────────────────────────────────────────────────────────────────────────────
// THE UI NUMBERING POLICY (RAWY-261) — this file owns it, and nothing else does.
//
// Every number Sard's own INTERFACE generates renders in WESTERN (Latin) digits 0–9, in every
// UI language, Arabic included. The Arabic UI stays fully Arabic — only the DIGITS are Latin:
//   «الفصل 1023»   not  «الفصل ١٠٢٣»
//   «3 من 18»       not  «٣ من ١٨»
//
// SCOPE — Sard's UI ONLY. It NEVER touches EPUB/PDF content. Book text (paragraphs, the book's
// own chapter titles, footnotes, quotes, OCR, imported HTML) is rendered by foliate/PDF.js
// straight from the author's document and never passes through this file, so an author who
// wrote ١٢٣٤٥ still reads ١٢٣٤٥. The one place the two meet is a TOC row: the row's BADGE
// number is ours (formatted here → Latin), the row's LABEL is the book's string (rendered
// verbatim → untouched). Book-provided labels only ever travel the READ-ONLY direction below
// (toWesternDigits / extractChapterNumber), which parses them and never rewrites what is shown.
//
// HOW IT PROPAGATES — a component inherits the policy automatically by doing any of:
//   • localeNum(n, lang)                — a number → its UI string
//   • localeDigits(s, lang)             — an already-composed string ("1.35", "42%", "160px")
//   • uiDateTimeFormat / uiRelativeTimeFormat / uiLocale — dates, times, relative times
//   • t("key", { n })                   — i18n interpolation is String(n): Latin by construction
// A future component that does none of these still renders Latin digits, because that is what
// JavaScript's own number→string conversion produces. Arabic-Indic digits can now only appear
// in the UI by someone deliberately reintroducing a substitution table — there is none left.
// ─────────────────────────────────────────────────────────────────────────────

// The Unicode numbering system every UI formatter is pinned to. Stated EXPLICITLY rather than
// left to the locale default: CLDR's default numbering system for `ar` has changed across ICU
// versions (older ICU resolves `ar` → `arab`), and Sard runs on whatever ICU the installed
// WebView2 ships. `-u-nu-latn` makes the result identical on every engine and every version.
export const UI_NUMBERING_SYSTEM = "latn";

/** The BCP-47 locale every UI-facing Intl formatter must be built with. Arabic keeps its Arabic
 *  month names, weekdays, plural rules and word order — only the digits are pinned to Latin. */
export function uiLocale(lang: string): string {
  return lang === "ar" ? `ar-u-nu-${UI_NUMBERING_SYSTEM}` : "en";
}

// Intl formatter construction is the expensive part, so each distinct shape is built once.
const integerFormats = new Map<string, Intl.NumberFormat>();

function integerFormat(lang: string): Intl.NumberFormat {
  const locale = uiLocale(lang);
  let f = integerFormats.get(locale);
  if (!f) {
    // useGrouping:false — a chapter number is "1023", never "1,023"; this also keeps every
    // existing readout byte-identical to the String(n) it replaced, apart from the digits.
    f = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
    integerFormats.set(locale, f);
  }
  return f;
}

/** A UI-generated integer → its display string (counts, percentages, chapter numbers). */
export function localeNum(n: number, lang: string): string {
  const v = Math.round(n);
  return integerFormat(lang).format(v === 0 ? 0 : v); // v===0 folds -0, which Intl prints as "-0"
}

/** A string the caller already composed ("1.35", "42%", "160px" — any decimals, units or
 *  separators) → the same string under the UI numbering policy. Unlike localeNum it never
 *  rounds, so it is the right helper wherever the display isn't a bare integer. Callers build
 *  these from JS numbers, which are already Latin, so this is normally an identity; it stays
 *  the named seam so the policy holds even if a caller is fed digits from elsewhere.
 *  Pass only UI-generated text here — never a book-provided string. */
export function localeDigits(s: string, _lang?: string): string {
  return toWesternDigits(s);
}

/** A UI date/time formatter. Use INSTEAD OF `new Intl.DateTimeFormat(...)` so the numbering
 *  policy can never be bypassed; pass whatever options the surface needs. */
export function uiDateTimeFormat(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(uiLocale(lang), options);
}

/** A UI relative-time formatter ("قبل 5 أيام"). Same rule as uiDateTimeFormat. */
export function uiRelativeTimeFormat(lang: string, options: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return new Intl.RelativeTimeFormat(uiLocale(lang), options);
}

// ── READ-ONLY direction: parsing what the BOOK wrote ─────────────────────────
// RAWY-67: Arabic-Indic digits IN a book-provided string → Western, so a TOC label
// ("الفصل ١٠٢٢") can be parsed the same way as one already using Western digits
// ("Chapter 1022"). Only touches digit glyphs; everything else in the string is untouched.
// This NEVER rewrites displayed book text — its callers use the result to compare/extract only.
const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const AR_TO_WESTERN: Record<string, string> = Object.fromEntries(AR_DIGITS.map((d, i) => [d, String(i)]));
export function toWesternDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => AR_TO_WESTERN[d]);
}

// Extract the book's OWN chapter number from its TOC label ("الفصل 1022: عنوان" -> 1022,
// "Chapter 1022" -> 1022) — the first run of digits, Western or Arabic-Indic. Never fabricates:
// returns null if the label has no digits at all (e.g. "Prologue"/"المقدمة"), so callers can fall
// back honestly instead of inventing a number the book doesn't provide. The returned NUMBER is
// then re-rendered by localeNum, which is why a TOC badge reads 1023 even when the book's own
// label says ١٠٢٣ — the badge is Sard's, the label beside it stays the author's.
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
