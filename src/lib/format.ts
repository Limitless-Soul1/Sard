// Small formatting helpers. localeNum renders Western digits in Arabic-Indic when the UI
// language is Arabic, so panel counts/percentages read natively (٤٢ قصيدة · ٩٪).
const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

export function localeNum(n: number, lang: string): string {
  const s = String(Math.round(n));
  return lang === "ar" ? s.replace(/\d/g, (d) => AR_DIGITS[Number(d)]) : s;
}
