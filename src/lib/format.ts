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

// Extract the book's OWN chapter number from its TOC label ("الفصل 1022: عنوان" -> 1022,
// "Chapter 1022" -> 1022) — the first run of digits, Western or Arabic-Indic. Never fabricates:
// returns null if the label has no digits at all (e.g. "Prologue"/"المقدمة"), so callers can fall
// back honestly instead of inventing a number the book doesn't provide.
export function extractChapterNumber(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = toWesternDigits(label).match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
