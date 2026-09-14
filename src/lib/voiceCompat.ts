// RESILIENCE-1 / WP-5A — CAN THIS VOICE READ THIS BOOK?
//
// Answered BEFORE the first synthesis, because for two different reasons no after-the-fact check can
// be sufficient:
//
//   * Edge returns SUCCESS for a mismatch. Measured (M1, 10 live syntheses against the real
//     endpoint): an en-US / fr-FR / de-DE voice fed Arabic script returns HTTP success carrying a
//     6-byte MP3 — about one millisecond of nothing — against 28,000–41,000 bytes for every working
//     pair. The reader hears silence and the pipeline sees a completed request.
//
// THE RULE IS ASYMMETRIC, BECAUSE THE MEASUREMENT IS.
//
//   voice          text      result
//   en-US-Aria     Arabic    6 bytes          ← silence
//   fr-FR-Denise   Arabic    6 bytes          ← silence
//   de-DE-Katja    Arabic    6 bytes          ← silence
//   ar-EG-Salma    English   36,741 bytes     ← works
//   ar-EG-Salma    French    41,356 bytes     ← works
//   en-US-Aria     French    33,434 bytes     ← works
//
// A voice that cannot RENDER a script produces nothing; a mere language mismatch within a script it
// can render is fine. So an Arabic voice reading an English book is NOT warned about — the original
// symmetric plan would have flagged it, and that combination measurably works. A false warning is
// worse than a missing one: it teaches readers to dismiss the dialog.
//
// SCRIPTS THAT HAVE NOT BEEN MEASURED ARE TREATED AS COMPATIBLE. Sard's world is Arabic and Latin
// (all 17 corpus books), and this module makes no claim about CJK or Cyrillic. Guessing there would
// manufacture exactly the false positives the rule above exists to avoid.

/** What Sard sniffed from the book's own text at import (WP-2), not what its metadata claimed. */
export type BookScript = "arabic" | "latin" | null;

export type Compatibility =
  /** Proceed unchanged. */
  | "compatible"
  /** A Multilingual voice — proceed unchanged, and never warn. */
  | "universal"
  /** MEASURED to produce silence. Do not dispatch without the reader's explicit consent. */
  | "incompatible";

/**
 * Locales whose voices render Arabic script.
 *
 * `ar` is the measured one. The others use the Arabic script and are included so a Persian or Urdu
 * voice is not warned about on an Arabic book — that would be a speculative FALSE POSITIVE, which
 * this design ranks as the worse error. If one of them turns out to produce silence too, the
 * empty-audio net (WP-5B) still catches it at synthesis time.
 */
const ARABIC_SCRIPT_LANGS = new Set(["ar", "fa", "ur", "ps", "ckb", "sd", "ug"]);

/** The primary ISO code of a locale: "ar-EG" → "ar", "ar_JO-kareem-medium" → "ar". */
export function primaryLang(locale: string): string {
  const head = (locale || "").trim().split(/[-_]/)[0] ?? "";
  return head.toLowerCase();
}

/** Does this voice's locale render Arabic script? */
function speaksArabicScript(locale: string): boolean {
  return ARABIC_SCRIPT_LANGS.has(primaryLang(locale));
}

/**
 * A Multilingual voice speaks any language by design, and was measured doing exactly that
 * (WilliamMultilingual + Arabic → 33,219 bytes). Detected by id, the same test the picker already
 * uses to sort them to the top (TtsVoicePicker.tsx).
 */
export function isMultilingual(voiceId: string): boolean {
  return (voiceId || "").includes("Multilingual");
}

export interface VoiceIdentity {
  id: string;
  /** The voice's locale — `EdgeVoiceInfo.lang`. */
  lang: string;
}

/**
 * The pre-flight verdict for one (book, voice) pair.
 *
 * Deliberately takes only what it needs, and takes the SNIFFED script rather than the book's declared
 * language: WP-2 exists because declared metadata lies (an Arabic book tagged `dc:language=en` is in
 * the corpus). Trusting the declaration here would gate on the same field that was already wrong.
 */
export function voiceCompatibility(bookScript: BookScript, voice: VoiceIdentity): Compatibility {
  if (isMultilingual(voice.id)) return "universal";
  // Only a script MEASURED to fail can be incompatible. `latin` and `null` fall through to
  // compatible, which is what every Latin-script pair measured.
  if (bookScript !== "arabic") return "compatible";
  return speaksArabicScript(voice.lang) ? "compatible" : "incompatible";
}

// ── WP-5B — the safety net, for whatever the pre-flight does not catch ───────────────────────────

/**
 * The smallest believable synthesis, in bytes.
 *
 * MEASURED: a mismatched pair returns **6 bytes**; the shortest real sentence measured returned
 * **28,676**. The gap is three orders of magnitude, so this threshold does not need to be finely
 * judged — it needs to sit anywhere in a very wide empty valley. 512 is deliberately far above the
 * failure (6) and far below the smallest success (28,676), so neither a terse one-word unit nor a
 * future codec change can plausibly cross it by accident.
 *
 * At 48 kbit/s mono MP3, 512 bytes is roughly 85 ms — shorter than any spoken word.
 */
export const MIN_PLAUSIBLE_AUDIO_BYTES = 512;

/**
 * Did a SUCCESSFUL synthesis actually contain speech?
 *
 * This is the signal M1 proved is the only one available: Edge does not reject a mismatch, does not
 * return a 4xx and does not error, so there is no wire failure to classify. What it returns instead
 * is a success carrying essentially nothing.
 *
 * Only meaningful for a request that HAD text — an empty request legitimately yields empty audio, and
 * calling that a compatibility failure would be a bug in the detector.
 */
export function isImplausiblyShortAudio(requestText: string, byteLength: number): boolean {
  if (!requestText.trim()) return false; // nothing was asked for; nothing back is correct
  return byteLength < MIN_PLAUSIBLE_AUDIO_BYTES;
}
