// WHAT IS HANDED TO THE VOICE — and the one place it may differ from what is on the page.
//
// THE DEFECT THIS CLOSES, measured against the real Edge endpoint rather than reasoned about.
// A standalone run of EXTENDED Arabic-Indic digits (U+06F0–U+06F9 — the Persian/Urdu forms ۰۱۲۳۴۵۶۷۸۹)
// is not spoken by Edge at all. Not mispronounced, not read as separate digits: SILENTLY DROPPED.
// The proof is the audio itself. Synthesizing «العدد ۶۳ هنا» and «العدد ۱۴۰۵ هنا» returns
// BYTE-IDENTICAL audio — two different numbers, the same sound — and «۳۶» on its own returns 1590
// bytes of silence with zero word boundaries. The same sentence with ARABIC-INDIC digits (٦٣) or
// LATIN digits (63) is a second longer and carries a word boundary for the number.
//
// It is not the voice. Measured across `en-AU-WilliamMultilingualNeural` and native Arabic voices
// (ar-DZ, ar-BH, …): every one of them drops the run. It is the endpoint.
//
// The missing word-tracking pill was only the visible symptom; the real cost is that a reader
// listening to a book written with Persian-form numerals hears the sentence with the number missing,
// with nothing on screen to say so.
//
// THE FIX, AND WHY IT IS SAFE. The two digit sets are the same ten values in the same order, so
// U+06Fx maps to U+066x code point for code point. Rewriting them ON THE WAY TO THE VOICE:
//   • never touches the book. No DOM change, no text-node change, so every CFI, bookmark, highlight,
//     annotation and TTS range keeps resolving — the invariant the whole number-colouring work was
//     rebuilt around.
//   • never touches what is DISPLAYED. The page still shows ۱۴۰۵; only the audio request says ١٤٠٥.
//   • is LENGTH-PRESERVING, one character for one character. That matters for word tracking: Edge
//     returns the boundary text in the normalized form (٦٣), which `setReadingWords` cannot find
//     verbatim in the displayed sentence, so it falls to its existing "consume the word's own
//     length" path — and because the length is identical, that lands exactly on the displayed run.
//   • changes nothing for any other script. Arabic-Indic, Latin, and digits joined to letters (و۸,
//     which Edge already handles) are untouched by construction.
//
// The one thing it does change is the SOUND: the number is now spoken instead of skipped. That is
// the point.

/** Extended Arabic-Indic (Persian/Urdu) digits — the run Edge drops. */
const EXTENDED_DIGIT = /[۰-۹]/g;

/** U+06F0..U+06F9 → U+0660..U+0669. Same values, same order, same length. */
const toArabicIndic = (ch: string): string =>
  String.fromCharCode(ch.charCodeAt(0) - 0x06f0 + 0x0660);

/**
 * The text to SPEAK for a sentence, which is not always the text to SHOW.
 *
 * Returns the input unchanged when it carries no extended digits, so the overwhelmingly common case
 * costs one failed regex test and allocates nothing.
 */
export function speakableText(text: string): string {
  if (!text) return text;
  EXTENDED_DIGIT.lastIndex = 0;
  if (!EXTENDED_DIGIT.test(text)) return text;
  EXTENDED_DIGIT.lastIndex = 0;
  return text.replace(EXTENDED_DIGIT, toArabicIndic);
}

/** Does this text carry digits Edge would otherwise drop? Used by tests and diagnostics. */
export function hasExtendedDigits(text: string): boolean {
  EXTENDED_DIGIT.lastIndex = 0;
  return EXTENDED_DIGIT.test(text ?? "");
}
