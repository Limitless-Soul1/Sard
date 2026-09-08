// The one place the spoken string may differ from the displayed one.
//
// The rule under test is not "normalize digits" in general — it is the narrow, measured repair for
// the runs Edge drops. Everything else must pass through untouched, and the rewrite must be
// length-preserving, because word tracking maps Edge's boundary text back onto the DISPLAYED
// sentence by consuming the word's own length.
import { describe, expect, it } from "vitest";

import { hasExtendedDigits, speakableText, withoutEmptyMarkup } from "../../src/lib/ttsText";

describe("speakableText", () => {
  it("rewrites extended Arabic-Indic digits to the forms Edge speaks", () => {
    expect(speakableText("العدد ۶۳ هنا")).toBe("العدد ٦٣ هنا");
    expect(speakableText("العام ۱۴۰۵")).toBe("العام ١٤٠٥");
    expect(speakableText("۰۱۲۳۴۵۶۷۸۹")).toBe("٠١٢٣٤٥٦٧٨٩");
  });

  it("is length-preserving, which is what keeps word tracking aligned", () => {
    for (const s of ["۶۳", "العام ۱۴۰۵ ومدة ۳۶ يوماً", "۱۲ — Chapter 12 — الصفحة"]) {
      expect(speakableText(s).length).toBe(s.length);
    }
  });

  it("leaves Arabic-Indic digits alone — Edge already speaks them", () => {
    const s = "وفي الصفحة (٤٠٧) من الدفتر";
    expect(speakableText(s)).toBe(s);
  });

  it("leaves Latin digits alone", () => {
    const s = "وسجّل الرقم 1987 ثم أضاف 42";
    expect(speakableText(s)).toBe(s);
  });

  it("leaves ordinary Arabic prose byte-identical", () => {
    const s = "كان الطريق طويلاً، ومشى الرجل حتى بلغ البئر.";
    expect(speakableText(s)).toBe(s);
  });

  it("returns the SAME string object when there is nothing to change", () => {
    // The common case must not allocate: every sentence in a book goes through here.
    const s = "لا أرقام هنا";
    expect(speakableText(s)).toBe(s);
  });

  it("rewrites a digit joined to a letter too, without disturbing the letter", () => {
    // Edge does speak `و۸` — the join gives it a token — but normalising it is harmless and keeps
    // the rule a simple character map rather than a context-sensitive one.
    expect(speakableText("معه و۸ حبات")).toBe("معه و٨ حبات");
  });

  it("handles empty and whitespace input without throwing", () => {
    expect(speakableText("")).toBe("");
    expect(speakableText("   ")).toBe("   ");
  });

  it("is idempotent", () => {
    const once = speakableText("العام ۱۴۰۵ ومدة ۳۶");
    expect(speakableText(once)).toBe(once);
  });

  it("does not touch other scripts' digits", () => {
    // Devanagari and Bengali digits are NOT part of the measured defect and must pass through.
    const s = "१२३ ১২৩";
    expect(speakableText(s)).toBe(s);
  });

  it("survives a global-regex call sequence without state leaking between calls", () => {
    // `EXTENDED_DIGIT` is a module-level /g regex; a stale lastIndex would make every other call wrong.
    expect(hasExtendedDigits("۶۳")).toBe(true);
    expect(hasExtendedDigits("۶۳")).toBe(true);
    expect(speakableText("۶۳")).toBe("٦٣");
    expect(speakableText("۶۳")).toBe("٦٣");
    expect(hasExtendedDigits("63")).toBe(false);
  });
});

describe("an empty angle-bracket container is not speech", () => {
  // WHY THIS EXISTS, measured rather than assumed. A book converted from another format kept its
  // dialogue markers and lost the dialogue, leaving `&lt;&gt;` in the source and `<>` on the page. What
  // the endpoint makes of that depends on the VOICE: ar-EG-SalmaNeural returns 0 bytes (silence), while
  // en-AU-WilliamMultilingualNeural returns 3600 bytes — 0.60s, ZERO word boundaries, audible and not
  // speech. The rule is therefore about the text, not the voice, and gives the same answer for both.

  it("removes the reported construct", () => {
    expect(withoutEmptyMarkup("<>")).toBe(" ");
  });

  it("removes it however it is padded, because padding is not content", () => {
    expect(withoutEmptyMarkup("< >")).toBe(" ");
    expect(withoutEmptyMarkup("<  >")).toBe(" ");
    expect(withoutEmptyMarkup("<\t>")).toBe(" ");
    expect(withoutEmptyMarkup("<\n>")).toBe(" ");
  });

  it("collapses nested empty pairs from the inside out", () => {
    expect(withoutEmptyMarkup("<<>>").trim()).toBe("");
    expect(withoutEmptyMarkup("<<<>>>").trim()).toBe("");
  });

  it("KEEPS a span that holds real content, whole and untouched", () => {
    expect(withoutEmptyMarkup("<نعم>")).toBe("<نعم>");
    expect(withoutEmptyMarkup("<hello>")).toBe("<hello>");
    expect(withoutEmptyMarkup("<007>")).toBe("<007>");
    expect(withoutEmptyMarkup("<C++>")).toBe("<C++>");
  });

  it("keeps the outer span that has content and drops only the empty inner one", () => {
    expect(withoutEmptyMarkup("<نعم <> العالم>")).toBe("<نعم   العالم>");
  });

  it("keeps guillemet-style quoting around real content", () => {
    expect(withoutEmptyMarkup("<<نعم>>")).toBe("<<نعم>>");
  });

  it("never joins the words on either side", () => {
    // The empty string would make one word of two; a space cannot, and is inaudible.
    expect(withoutEmptyMarkup("a <> b")).toBe("a   b");
    expect(withoutEmptyMarkup("word<>word")).toBe("word word");
  });

  it("the two reported sentences keep every spoken word", () => {
    expect(withoutEmptyMarkup("كتبت فرانكا ردها: <>.")).toBe("كتبت فرانكا ردها:  .");
    expect(withoutEmptyMarkup("أجاب 007 بسرعة: <>.")).toBe("أجاب 007 بسرعة:  .");
  });

  it("leaves ordinary punctuation completely alone — this is not a symbol filter", () => {
    for (const t of ["قال: نعم.", "؟!", "...", "—", "،", "؛", "()", "[]", "A/B", "C++", "007", "42%"]) {
      expect(withoutEmptyMarkup(t)).toBe(t);
    }
  });

  it("leaves ordinary prose alone, and costs nothing when there is no bracket", () => {
    const ar = "كان الفصل ٤٦، وهو جميل؟ ثم مضى في طريقه.";
    const en = "The quick brown fox jumped (twice) - 42% of the time!";
    expect(withoutEmptyMarkup(ar)).toBe(ar);
    expect(withoutEmptyMarkup(en)).toBe(en);
    expect(withoutEmptyMarkup("")).toBe("");
  });

  it("an unmatched bracket is not a container and is left as it is", () => {
    expect(withoutEmptyMarkup("a < b")).toBe("a < b");
    expect(withoutEmptyMarkup("5 > 3")).toBe("5 > 3");
    expect(withoutEmptyMarkup("a < b and c > d")).toBe("a < b and c > d");
  });

  it("is independent of the voice by construction — it never sees one", () => {
    // The function takes only text. There is no voice, engine or endpoint in its signature, so it
    // cannot behave differently for one voice than another.
    expect(withoutEmptyMarkup.length).toBe(1);
  });
});

describe("the two transforms compose the way production composes them", () => {
  // Production calls `withoutEmptyMarkup(speakableText(text))`. These assert the pair, not either half.
  const spoken = (t: string) => withoutEmptyMarkup(speakableText(t));

  it("digit normalisation still happens, and the empty container still goes", () => {
    // U+06F3 U+06F6 are the extended digits Edge drops; they must still become U+0663 U+0666.
    expect(spoken("العدد ۳۶: <>.")).toBe("العدد ٣٦:  .");
  });

  it("a bracketed run of extended digits is CONTENT and survives, normalised", () => {
    expect(spoken("<۳۶>")).toBe("<٣٦>");
  });

  it("ordinary prose is unchanged by the pair", () => {
    const t = "قال الرجل: نعم، ثم مضى.";
    expect(spoken(t)).toBe(t);
  });
});
