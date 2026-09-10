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

// ---------------------------------------------------------------------------------------------
// AN EMPTY CONTAINER HAS NOTHING TO SAY.
// ---------------------------------------------------------------------------------------------
//
// THE DEFECT. Books converted from other formats keep their dialogue markers as angle brackets, and a
// conversion that lost the dialogue leaves the marker behind with nothing inside it — the source reads
// `&lt;&gt;`, the page shows `<>`, and the sentence is grammatically complete without it. Measured in a
// real book, four consecutive paragraphs end that way.
//
// What the endpoint does with that is VOICE-DEPENDENT, which is exactly why the rule cannot be about
// voices. Measured on the same two sentences:
//
//   ar-EG-SalmaNeural            `<>` alone → 0 bytes; inside a sentence it is ignored, and the audio
//                                is byte-identical with and without it (15696B / 2.616s, either way).
//   en-AU-WilliamMultilingualNeural  `<>` alone → 3600 bytes, 0.600s, ZERO word boundaries, peak 0.164 —
//                                audible sound that is not speech. Inside the two real sentences it cost
//                                552ms and 648ms, and removing it left the SAME three words in each.
//
// Neither bracket does this alone (`<` and `>` each measured silent on that voice); the PAIR does. So
// the question Sard asks is not "does this voice make a noise" but "is there anything here to say",
// which is decidable from the text and gives the same answer for every voice and every book.
//
// THE RULE. Remove an angle-bracket span that contains no letter and no digit. `SPEAKABLE` is the same
// test the reader uses to decide whether a segment is worth speaking at all (`hasSpeech` in
// FoliateController) — deliberately a separate copy, because that one decides whether a UNIT exists and
// this one decides whether a SPAN inside a unit carries anything; conflating them would make a change to
// either silently change the other.
//
// Nested pairs collapse from the inside out, so `<<>>` and `<<<>>>` go the same way as `<>`. A span that
// holds real content is kept WHOLE — `<نعم>`, `<hello>`, `<007>` are speech and are none of this rule's
// business. In `<نعم <> العالم>` only the empty inner pair goes; the outer span has content and stays.
//
// A SPACE, NOT NOTHING. Replacing with the empty string would join the words either side — `word<>word`
// would be spoken as one word. A space cannot do that, and an extra space is inaudible.
//
// WHY THIS IS NOT IN `speakableText`. That function is LENGTH-PRESERVING BY CONTRACT and word tracking
// depends on it: `setReadingWords` searches `speakableText(displayed)` for each word Edge reports, and
// its comment states that an index into that string is the same index into the displayed text. This
// rule removes characters, so putting it there would silently break the reading pill. It belongs on the
// synthesis path only, which is where the caller applies it — the displayed text is never touched.
//
// It is also NOT xml escaping: escaping makes text safe to TRANSPORT inside SSML and happens later, at
// the Rust boundary. This decides what is worth speaking at all. Two responsibilities, two places.

/** Does this carry anything a voice could pronounce? A letter or a digit, in any script. */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** An angle-bracket span with no bracket inside it — the innermost pair at any depth. */
const ANGLE_SPAN = /<[^<>]*>/g;

/**
 * The text with empty angle-bracket containers removed. Everything else is returned untouched,
 * including every kind of ordinary punctuation, which this rule never looks at.
 */
export function withoutEmptyMarkup(text: string): string {
  // The overwhelming majority of sentences contain no angle bracket at all and cost one indexOf.
  if (!text || !text.includes("<")) return text;
  let out = text;
  for (;;) {
    // Each pass strictly shortens the string or returns, so this terminates.
    const next = out.replace(ANGLE_SPAN, (span) => (SPEAKABLE.test(span.slice(1, -1)) ? span : " "));
    if (next === out) return out;
    out = next;
  }
}

// ---------------------------------------------------------------------------------------------
// FORMATTING MARKS THE VOICE READS OUT LOUD.
// ---------------------------------------------------------------------------------------------
//
// THE DEFECT. A reader listening to a book hears «hash», «tilde», «star» — the endpoint pronounces
// certain marks as words. They are formatting, not language: nothing is lost by not saying them, and
// the page must go on showing them exactly as the book wrote them.
//
// WHAT WAS MEASURED, on the real endpoint, on ar-EG-SalmaNeural AND en-AU-WilliamMultilingualNeural,
// reading Edge's own `WordBoundary` metadata rather than guessing from audio length. A byte delta
// cannot tell «pronounced» from «paused», and «،» lengthening a sentence is correct prosody, not a
// defect — so the question asked of every candidate was: does the endpoint emit it as its OWN WORD?
//
//   ALWAYS ITS OWN WORD, both voices:   # ~ * ^ &
//   NEVER ITS OWN WORD, both voices:    - – — / | ( ) [ ] : , …
//
// The first group is this rule's business. The second is prosody and is left completely alone —
// `,` and `.` in particular are how the voice breathes, and removing them would damage the reading
// this rule exists to improve.
//
// WHY WELDING DOES NOT MATTER FOR THE FIVE. «الرمز a#b هنا» and «الرمز a # b هنا» return
// BYTE-IDENTICAL audio and the identical word list — `["الرمز","a","#","b","هنا"]`. The endpoint
// already splits the mark out, so the neighbouring tokens were never joined to begin with, and
// replacing it with a space reproduces exactly the token stream Edge produced, minus the mark.
//
// A SPACE, NOT NOTHING — the same rule `withoutEmptyMarkup` arrived at, for the same reason. The
// empty string would make `a#b` into one word `ab`, which the endpoint would then pronounce as a
// word it never saw. A space cannot join anything, and an extra space is inaudible.
//
// THE HYPHEN IS DIFFERENT, AND THE DIFFERENCE IS MEASURED. A single «-» is NOT spoken: «نص عربي - نص
// آخر» returns four words and no dash, and so does the Arabic dialogue opener «- ومن يكون هذا
// الرجل؟». Welded, it is part of a single token — `a-b`, `-5`, `2026-09-10`, `1990-2000` and
// `الخالد-المرتد` each come back as ONE word, and splitting them changes the reading outright
// («2026-09-10» becomes «2026, 09, 10»). But a RUN of two or more, standing on its own, is spoken
// once per character: «--» → `-`,`-` and «---» → `-`,`-`,`-`. The threshold is exactly two.
// Underscore behaves the same way, so both are handled by one rule.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH. `& @ % + =` are spoken when they stand alone, and are still
// left alone here: they carry meaning that suppressing them would destroy — `Tom & Jerry`, `R&D`,
// `AT&T`, `a@b.com`, `10%`, and arithmetic each came back as a single token, or as a word the reader
// wants to hear. A mark that MEANS something is not decoration, and `&` is the one member of the
// "always spoken" set that is usually a word: silencing it would turn «Tom & Jerry» into two names
// with nothing between them.
//
// WHY IT IS NOT IN `speakableText`. That function is length-preserving by contract and word tracking
// depends on it. This one removes characters, so it belongs on the synthesis path only — exactly
// where `withoutEmptyMarkup` sits, and applied by the same caller.

/**
 * The marks the endpoint reads out as their own word wherever they appear AND that mean nothing.
 *
 * `&` is measured in the same "always its own word" group and is deliberately NOT here: it is read as
 * a word because it usually IS one.
 */
const DECORATIVE_MARK = /[#~*^]/;

/** …collapsed a run at a time, so `###` costs one space rather than three. */
const DECORATIVE_MARK_RUN = /[#~*^]+/g;

/**
 * A rule drawn out of connectors — two or more of them, standing on its own between spaces or at an
 * edge. The run length is what separates a decorative rule from a hyphen doing real work: one is
 * never spoken and often joins a token, two or more are always spoken and never join anything.
 */
const DECORATIVE_RULE = /(?:^|\s)(?:-{2,}|_{2,})(?=\s|$)/g;

/**
 * The text with formatting marks the voice would otherwise pronounce replaced by a space.
 *
 * Total and idempotent: it only ever rewrites marks to spaces, so a second pass finds nothing left to
 * do. It can never empty a speech-bearing sentence, because it never touches a letter or a digit —
 * which is what keeps `isImplausiblyShortAudio` from seeing a request that has become empty.
 */
export function withoutDecorativeSymbols(text: string): string {
  if (!text) return text;
  let out = text;
  // Non-global for the test, global for the replace: a `/g` regex carries `lastIndex` between calls,
  // and testing with one is how a shared regex starts answering for the previous string.
  if (DECORATIVE_MARK.test(out)) out = out.replace(DECORATIVE_MARK_RUN, " ");
  if (out.includes("-") || out.includes("_")) out = out.replace(DECORATIVE_RULE, " ");
  return out;
}
