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
