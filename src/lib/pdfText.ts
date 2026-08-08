// PDF TEXT FOR READ-ALOUD — extraction repair, quality scoring, and the honest verdict.
//
// A PDF's text layer is not prose. It is whatever the producer happened to embed, and in this corpus
// it arrives in three broken shapes:
//   1. NOTHING — the page is a scan. No repair exists; only OCR, and that is a separate product.
//   2. WATERMARKS ONLY — the body is images and the only text is a repeated site URL.
//   3. PRESENTATION FORMS — the text is the GLYPH codepoints (U+FB50–FEFF) the page draws rather than
//      the letters they represent. It renders correctly and reads as gibberish to a speech engine.
//
// Shape 3 is repairable, and the repair is a standard one rather than a hand-rolled table: Unicode
// NFKC maps every Arabic presentation form back to its base letter, and expands the lam-alef ligatures
// (U+FEF5–FEFC) into the two letters they stand for. That is why normalisation here is a normalisation
// and not a guess.
//
// Nothing in this module decides to SPEAK. It decides what the text is and how much to trust it; the
// reader is told when trust is low, because a confident wrong reading is worse than silence.

/**
 * ⚠ PDF READ-ALOUD IS TEMPORARILY DISABLED AT THE PRODUCT LEVEL — owner decision, 2026-08-08.
 *
 * **THIS IS NOT A REMOVAL.** The whole PDF read-aloud implementation is intentionally preserved and
 * still compiles: extraction and Arabic repair (this file), unit derivation and span-granular ranges
 * (`FoliateController.pdfDeriveUnits` / `pdfPageUnits`), sentence highlighting
 * (`pdfMarkUnit` / `pdfClearMarks` / `pdfWatchLayer`). Nothing was reverted. The feature is dormant,
 * not deleted.
 *
 * **TO RE-ENABLE: change this one constant to `true`.** Nothing else needs editing — the four call
 * sites below all read it, and they are the complete set:
 *
 *   1. `FoliateController.pdfHasSpeakableText()`  — the availability source. Returning `false` hides
 *      the Listen control (`ReaderChrome`) and the player (`Reader`), because both render on the same
 *      `(!isPdf || pdfCanListen)` condition, and `pdfCanListen` polls this method.
 *   2. `FoliateController.pdfWatchLayer()`        — so no MutationObserver is installed per PDF page.
 *   3. `FoliateController.showReadingHighlight()` — the fixed-layout branch, as defence in depth.
 *   4. `SettingsPanel`                            — the PDF panel's read-aloud note, which would
 *      otherwise advertise a feature the reader cannot reach.
 *
 * Grep `PDF_TTS_ENABLED` to find all of them. EPUB read-aloud is completely unaffected: it never
 * consults this flag, and none of the four sites is on the EPUB path.
 *
 * The acceptance checks for PDF read-aloud fail by design while this is `false`, because the control
 * they press is hidden. Re-run them when re-enabling.
 */
export const PDF_TTS_ENABLED = false;

/** How trustworthy a document's text layer is. */
export type PdfTextVerdict = "good" | "partial" | "unusable";

export interface PdfTextScore {
  verdict: PdfTextVerdict;
  /** Fraction of sampled pages that carried real text. */
  coverage: number;
  /** Letters that are Arabic or Latin, over all letters — low means mojibake. */
  legible: number;
  /** Share of characters still in the private-use area after repair (font-specific junk). */
  pua: number;
  /** Share of characters that were presentation forms BEFORE repair — how damaged the source was. */
  repaired: number;
  meanWordLen: number;
  chars: number;
  /** Human-facing reason when the verdict is not "good". */
  reason?: string;
}

const RE_PRESENTATION = /[ﭐ-﷿ﹰ-﻿]/;
const RE_ARABIC = /[؀-ۿݐ-ݿ]/;
const RE_LATIN = /[A-Za-z]/;
const RE_LETTER = /[\p{L}]/u;
const isPua = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0;
  return (n >= 0xe000 && n <= 0xf8ff) || (n >= 0xf0000 && n <= 0x10ffff && n <= 0x10fffd && n >= 0xf0000);
};

/**
 * Repair one run of extracted PDF text for speech.
 *
 * Deliberately NOT done here: stripping diacritics. Arabic tashkeel improves pronunciation, and a PDF
 * that carries it is the good case — removing it would degrade exactly the documents that work best.
 */
export function normalizePdfText(raw: string): string {
  if (!raw) return "";
  let s = raw;
  // NFKC folds Arabic presentation forms to base letters and expands lam-alef ligatures. It also
  // normalises the full-width Latin and ligature forms some producers emit.
  try { s = s.normalize("NFKC"); } catch { /* pathological input; keep the raw run */ }
  s = s
    .replace(/ـ+/g, "")                      // tatweel: pure typographic padding, never spoken
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "") // zero-width + bidi controls
    .replace(/�+/g, " ")                     // replacement chars: a failed decode, not a word
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")        // hyphenation split across a line break
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return s;
}

/**
 * Drop extraction artifacts that are text but not content. The dominant case in this corpus is a
 * download-site watermark stamped on every page, which would otherwise be read aloud on every page.
 */
export function stripPdfArtifacts(s: string): string {
  if (!s) return "";
  let out = s
    .replace(/\b(?:https?:\/\/|www\.)[^\s]+/gi, " ")        // bare URLs (kutub-pdf.net, foulabook…)
    .replace(/\b[\w.-]+\.(?:com|net|org|info)\b/gi, " ");
  // A token repeated many times in one page is a stamp, not prose — but this rule is deliberately
  // CONSERVATIVE. The real watermarks in the corpus are URLs, already removed above; this is only a
  // safety net. Set at 15% it deleted an entire page of legitimate repeated Arabic in testing, which
  // is the worse failure: a stamp read aloud is an annoyance, a deleted page is a silent book.
  const tokens = out.split(/\s+/).filter(Boolean);
  if (tokens.length > 12) {
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    const spam = new Set([...freq].filter(([t, n]) => n >= 6 && t.length > 3 && n / tokens.length > 0.25).map(([t]) => t));
    if (spam.size && spam.size < freq.size) out = tokens.filter((t) => !spam.has(t)).join(" ");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Score one page's raw (pre-repair) text. Sampling several pages then averaging is the caller's job. */
export function scorePdfPage(raw: string): { chars: number; legible: number; pua: number; repaired: number; meanWordLen: number } {
  const before = [...(raw ?? "")];
  const repaired = before.length ? before.filter((c) => RE_PRESENTATION.test(c)).length / before.length : 0;
  const clean = stripPdfArtifacts(normalizePdfText(raw ?? ""));
  const chars = [...clean];
  const letters = chars.filter((c) => RE_LETTER.test(c));
  const good = letters.filter((c) => RE_ARABIC.test(c) || RE_LATIN.test(c)).length;
  const words = clean.split(" ").filter(Boolean);
  return {
    chars: chars.length,
    legible: letters.length ? good / letters.length : 0,
    pua: chars.length ? chars.filter(isPua).length / chars.length : 0,
    repaired,
    meanWordLen: words.length ? words.reduce((a, w) => a + w.length, 0) / words.length : 0,
  };
}

const MIN_PAGE_CHARS = 40;

/**
 * The document-level verdict, from several sampled pages.
 *
 * The thresholds are set from the measured corpus, not from taste: a scan scores 0 coverage; a
 * watermark-only file scores high legibility on almost no pages, which is why coverage is judged
 * before legibility; and a presentation-form file scores badly BEFORE repair and well after, which is
 * the whole reason repair happens before scoring.
 */
export function scorePdfDocument(pages: string[]): PdfTextScore {
  const scored = pages.map(scorePdfPage);
  const withText = scored.filter((p) => p.chars >= MIN_PAGE_CHARS);
  const coverage = pages.length ? withText.length / pages.length : 0;
  const mean = (f: (p: typeof scored[number]) => number) =>
    withText.length ? withText.reduce((a, p) => a + f(p), 0) / withText.length : 0;
  const score: PdfTextScore = {
    verdict: "unusable",
    coverage: +coverage.toFixed(3),
    legible: +mean((p) => p.legible).toFixed(3),
    pua: +mean((p) => p.pua).toFixed(3),
    repaired: +mean((p) => p.repaired).toFixed(3),
    meanWordLen: +mean((p) => p.meanWordLen).toFixed(1),
    chars: Math.round(mean((p) => p.chars)),
  };
  if (withText.length === 0) {
    score.reason = "no-text-layer";
    return score;
  }
  if (coverage < 0.34) {
    score.reason = "sparse-text-layer";   // e.g. a watermark on an otherwise image-only book
    return score;
  }
  if (score.legible < 0.6 || score.pua > 0.03) {
    score.reason = "garbled-text-layer";  // decoded, but not into letters anyone can pronounce
    return score;
  }
  if (score.meanWordLen < 1.6 || score.meanWordLen > 14) {
    score.reason = "broken-word-boundaries";
    return score;
  }
  score.verdict = score.legible >= 0.85 && coverage >= 0.8 ? "good" : "partial";
  return score;
}

/** Is this run worth sending to a speech engine at all? */
export const hasSpeakableText = (s: string): boolean => {
  const clean = stripPdfArtifacts(normalizePdfText(s));
  return clean.length >= 2 && RE_LETTER.test(clean);
};
