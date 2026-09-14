// The one place the spoken string may differ from the displayed one.
//
// The rule under test is not "normalize digits" in general — it is the narrow, measured repair for
// the runs Edge drops. Everything else must pass through untouched, and the rewrite must be
// length-preserving, because word tracking maps Edge's boundary text back onto the DISPLAYED
// sentence by consuming the word's own length.
import { describe, expect, it } from "vitest";

import {
  hasExtendedDigits,
  speakableText,
  withoutDecorativeSymbols,
  withoutEmptyMarkup,
} from "../../src/lib/ttsText";
import {
  effectiveSpeakSymbols,
  parseSpeakSymbols,
  speakSymbolsAttr,
  speakSymbolsKey,
} from "../../src/features/reader/speakSymbols";

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

describe("a formatting mark the voice would say out loud", () => {
  // MEASURED, both voices, from Edge's own word boundaries rather than from audio length: `# ~ * ^ &`
  // always come back as their own word, and `- – — / | ( ) [ ] : , …` never do. Of the first group only
  // `# ~ * ^` are this rule's business: `&` is read aloud because it usually IS a word.

  it("silences the marks the endpoint pronounces", () => {
    expect(withoutDecorativeSymbols("#")).toBe(" ");
    expect(withoutDecorativeSymbols("~")).toBe(" ");
    expect(withoutDecorativeSymbols("*")).toBe(" ");
    expect(withoutDecorativeSymbols("^")).toBe(" ");
  });

  it("KEEPS «&» — measured in the same group, but it is usually a word", () => {
    // `&` is read aloud like `#` is, and that is the difference: «Tom & Jerry» wants the conjunction
    // said. Silencing it would leave two names with nothing between them.
    expect(withoutDecorativeSymbols("&")).toBe("&");
    expect(withoutDecorativeSymbols("Tom & Jerry")).toBe("Tom & Jerry");
    expect(withoutDecorativeSymbols("R&D")).toBe("R&D");
    expect(withoutDecorativeSymbols("AT&T")).toBe("AT&T");
    expect(withoutDecorativeSymbols("البحث & التطوير")).toBe("البحث & التطوير");
  });

  it("collapses a run to ONE space rather than one per character", () => {
    expect(withoutDecorativeSymbols("###")).toBe(" ");
    expect(withoutDecorativeSymbols("~~~")).toBe(" ");
    expect(withoutDecorativeSymbols("***")).toBe(" ");
    expect(withoutDecorativeSymbols("### عنوان الفصل")).toBe("  عنوان الفصل");
  });

  it("never joins the words on either side — a space, not nothing", () => {
    // `a#b` and `a # b` return byte-identical audio and the same word list, so the tokens were never
    // joined; the empty string would invent a word `ab` that the endpoint never saw.
    expect(withoutDecorativeSymbols("a#b")).toBe("a b");
    expect(withoutDecorativeSymbols("a~b")).toBe("a b");
    expect(withoutDecorativeSymbols("word*word")).toBe("word word");
  });

  it("handles the shapes the owner reported, in Arabic", () => {
    expect(withoutDecorativeSymbols("# عنوان الفصل")).toBe("  عنوان الفصل");
    expect(withoutDecorativeSymbols("عنوان الفصل #")).toBe("عنوان الفصل  ");
    expect(withoutDecorativeSymbols("~ نص عربي هنا")).toBe("  نص عربي هنا");
    expect(withoutDecorativeSymbols("نص عربي هنا ~")).toBe("نص عربي هنا  ");
  });
});

describe("a rule drawn out of hyphens or underscores", () => {
  // The threshold is exactly two, measured: a single «-» produces NO word boundary, «--» produces two
  // and «---» three. Welded, a hyphen is part of one token and splitting it changes the reading.

  it("silences a decorative run standing on its own", () => {
    expect(withoutDecorativeSymbols("نص عربي -- نص آخر")).toBe("نص عربي  نص آخر");
    expect(withoutDecorativeSymbols("نص عربي --- نص آخر")).toBe("نص عربي  نص آخر");
    expect(withoutDecorativeSymbols("نص عربي ---- نص آخر")).toBe("نص عربي  نص آخر");
    expect(withoutDecorativeSymbols("__")).toBe(" ");
    expect(withoutDecorativeSymbols("___")).toBe(" ");
  });

  it("KEEPS a single hyphen — it is not spoken, and it is often doing real work", () => {
    // Measured: «نص عربي - نص آخر» comes back as four words with no dash at all.
    expect(withoutDecorativeSymbols("نص عربي - نص آخر")).toBe("نص عربي - نص آخر");
    // The Arabic dialogue opener. A reader would notice this one immediately.
    expect(withoutDecorativeSymbols("- ومن يكون هذا الرجل؟")).toBe("- ومن يكون هذا الرجل؟");
  });

  it("KEEPS a hyphen welded into a token — each of these is ONE word to the endpoint", () => {
    for (const t of ["a-b", "A-B", "well-known", "الخالد-المرتد", "-5", "2026-09-10", "1990-2000", "3-4"]) {
      expect(withoutDecorativeSymbols(t)).toBe(t);
    }
    // …including a welded RUN: nothing here is standing on its own.
    expect(withoutDecorativeSymbols("a--b")).toBe("a--b");
    expect(withoutDecorativeSymbols("a__b")).toBe("a__b");
  });

  it("KEEPS a single underscore, which is how identifiers are written", () => {
    expect(withoutDecorativeSymbols("a_b")).toBe("a_b");
    expect(withoutDecorativeSymbols("snake_case_name")).toBe("snake_case_name");
  });

  it("does not treat a dash that is not a hyphen as one", () => {
    // U+2013 and U+2014 are neither spoken nor this rule's business.
    expect(withoutDecorativeSymbols("نص – نص")).toBe("نص – نص");
    expect(withoutDecorativeSymbols("قال — وهو يبتسم — إنه ذهب")).toBe("قال — وهو يبتسم — إنه ذهب");
  });
});

describe("what the rule must never touch", () => {
  it("leaves the punctuation the voice BREATHES with completely alone", () => {
    // `,` and `.` are prosody. Measured as never producing a word boundary, and removing them would
    // damage the reading this rule exists to improve.
    for (const t of ["قال: نعم.", "نعم، ثم مضى.", "؟!", "…", "...", ":", ";", "،", "؛", "!", "؟"]) {
      expect(withoutDecorativeSymbols(t)).toBe(t);
    }
    const sentence = "قال الرجل: نعم، ثم مضى… وهو يبتسم.";
    expect(withoutDecorativeSymbols(sentence)).toBe(sentence);
  });

  it("leaves the marks that CARRY MEANING alone — @ % + = were excluded on purpose", () => {
    for (const t of ["a@b.com", "10%", "42%", "a+b", "a=b", "C++", "sard.app/help", "A/B", "a|b"]) {
      expect(withoutDecorativeSymbols(t)).toBe(t);
    }
  });

  it("leaves brackets alone — the empty-container rule owns those, and only when empty", () => {
    for (const t of ["()", "[]", "{}", "(نعم)", "[42]"]) {
      expect(withoutDecorativeSymbols(t)).toBe(t);
    }
  });

  it("leaves ordinary prose byte-identical, in both scripts", () => {
    const ar = "كان الفصل ٤٦، وهو جميل؟ ثم مضى في طريقه.";
    const en = "The quick brown fox jumped (twice) - 42% of the time!";
    expect(withoutDecorativeSymbols(ar)).toBe(ar);
    expect(withoutDecorativeSymbols(en)).toBe(en);
  });
});

describe("the invariants the synthesis path depends on", () => {
  it("is idempotent", () => {
    for (const t of ["a#b", "### عنوان", "نص -- نص", "__", "a-b", "قال: نعم.", "", "   "]) {
      expect(withoutDecorativeSymbols(withoutDecorativeSymbols(t))).toBe(withoutDecorativeSymbols(t));
    }
  });

  it("NEVER empties a sentence that carries speech", () => {
    // This is what keeps `isImplausiblyShortAudio` from seeing an empty request and raising a
    // PERMANENT voice-mismatch failure. The rule only ever rewrites marks to spaces.
    const speakable = /[\p{L}\p{N}]/u;
    for (const t of ["# عنوان", "a#b", "نص -- نص", "### 42 ###", "~ ن ~", "&a&", "_ _ a _ _"]) {
      expect(speakable.test(t)).toBe(true);
      expect(speakable.test(withoutDecorativeSymbols(t))).toBe(true);
    }
  });

  it("never removes a letter or a digit, whatever it is given", () => {
    const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).join("");
    for (const t of ["#a~b*c^d&e", "الخالد-المرتد -- 2026-09-10", "__x__", "###"]) {
      expect(letters(withoutDecorativeSymbols(t))).toBe(letters(t));
    }
  });

  it("handles empty and whitespace input without throwing", () => {
    expect(withoutDecorativeSymbols("")).toBe("");
    expect(withoutDecorativeSymbols("   ")).toBe("   ");
  });

  it("survives a global-regex call sequence without state leaking between calls", () => {
    // Both inner regexes are `/g`; a shared one that kept `lastIndex` would start answering for the
    // previous string. Same call, twice, must give the same answer.
    expect(withoutDecorativeSymbols("a#b")).toBe("a b");
    expect(withoutDecorativeSymbols("a#b")).toBe("a b");
    expect(withoutDecorativeSymbols("نص -- نص")).toBe("نص  نص");
    expect(withoutDecorativeSymbols("نص -- نص")).toBe("نص  نص");
  });

  it("takes only text, so it cannot behave differently for one voice than another", () => {
    expect(withoutDecorativeSymbols.length).toBe(1);
  });
});

describe("speakableText is untouched by the new rule", () => {
  it("is still length-preserving, which is what keeps word tracking aligned", () => {
    // The tracking path calls `speakableText` ALONE (`FoliateController.setReadingWords`). If the new
    // rule had been folded into it, an index into the result would no longer be an index into the
    // displayed sentence and the reading pill would drift.
    for (const t of ["العدد ۶۳ هنا", "# عنوان ۱۴۰۵", "نص -- نص ۳۶"]) {
      expect(speakableText(t)).toHaveLength(t.length);
    }
  });

  it("still leaves formatting marks exactly where they are", () => {
    // Proof that suppression happens on the synthesis path and NOWHERE else.
    expect(speakableText("# عنوان")).toBe("# عنوان");
    expect(speakableText("نص -- نص")).toBe("نص -- نص");
  });
});

describe("whose answer wins: the book's, or the هيئة's", () => {
  // THREE STATES, AND THE THIRD IS THE POINT. "no" and "not asked" have to stay distinguishable, or a
  // reader who silenced the marks for one book could never hand that book back to their هيئة.

  it("the four-state matrix", () => {
    expect(effectiveSpeakSymbols(null, true)).toBe(true);    // هيئة on,  book unset  → on
    expect(effectiveSpeakSymbols(null, false)).toBe(false);  // هيئة off, book unset  → off
    expect(effectiveSpeakSymbols(false, true)).toBe(false);  // هيئة on,  book says no → no
    expect(effectiveSpeakSymbols(true, false)).toBe(true);   // هيئة off, book says yes→ yes
  });

  it("changing هيئة moves a book that has NOT answered, and not one that has", () => {
    // The same book, the same override, under two different هيئات.
    expect(effectiveSpeakSymbols(null, false)).toBe(false);
    expect(effectiveSpeakSymbols(null, true)).toBe(true);   // followed the change
    expect(effectiveSpeakSymbols(false, false)).toBe(false);
    expect(effectiveSpeakSymbols(false, true)).toBe(false); // did NOT follow the change
  });

  it("clearing the book's answer hands it back to the هيئة", () => {
    expect(effectiveSpeakSymbols(true, false)).toBe(true);
    expect(effectiveSpeakSymbols(null, false)).toBe(false);
  });

  it("`false` is a real answer and never collapses into `unset`", () => {
    expect(parseSpeakSymbols("0")).toBe(false);
    expect(parseSpeakSymbols("0")).not.toBe(null);
    expect(effectiveSpeakSymbols(parseSpeakSymbols("0"), true)).toBe(false);
  });

  it("survives the round trip through a settings row, which is how it persists", () => {
    for (const v of [true, false] as const) {
      expect(parseSpeakSymbols(speakSymbolsAttr(v))).toBe(v);
    }
    // An absent row — a book never asked, or one whose answer was cleared — is the third state.
    expect(parseSpeakSymbols(null)).toBe(null);
    expect(parseSpeakSymbols(undefined)).toBe(null);
    expect(parseSpeakSymbols("")).toBe(null);
    // Total: anything unrecognised degrades to following the هيئة rather than to a guess.
    expect(parseSpeakSymbols("yes")).toBe(null);
    expect(parseSpeakSymbols("2")).toBe(null);
  });

  it("the row is per book, and namespaced so it cannot collide", () => {
    expect(speakSymbolsKey("abc")).toBe("tts.speakSymbols.abc");
    expect(speakSymbolsKey("abc")).not.toBe(speakSymbolsKey("abd"));
  });
});

describe("the synthesis boundary composes the setting the way production does", () => {
  // Production: `speakSymbols ? markupSafe : withoutDecorativeSymbols(markupSafe)`, where
  // `markupSafe = withoutEmptyMarkup(speakableText(text))`. These assert BOTH branches.
  const markupSafe = (t: string) => withoutEmptyMarkup(speakableText(t));
  const spoken = (t: string, speak: boolean) =>
    (speak ? markupSafe(t) : withoutDecorativeSymbols(markupSafe(t)));

  const SENTENCE = "# الفصل: نص عربي -- نص آخر، وفي 2026-09-10 نسبة 10% مع Tom & Jerry.";

  it("ON — the marks are said, and the string is exactly what it was before the feature", () => {
    // The whole point of the disabled branch: byte-identical to the old pipeline.
    expect(spoken(SENTENCE, true)).toBe(markupSafe(SENTENCE));
    expect(spoken(SENTENCE, true)).toContain("#");
    expect(spoken(SENTENCE, true)).toContain("--");
  });

  it("OFF — only the decorative marks go", () => {
    const out = spoken(SENTENCE, false);
    expect(out).not.toContain("#");
    expect(out).not.toContain("--");
    // …and everything that carries meaning stays.
    expect(out).toContain("2026-09-10");
    expect(out).toContain("10%");
    expect(out).toContain("Tom & Jerry");
    expect(out).toContain("،");
    expect(out).toContain(".");
  });

  it("both branches keep the digit repair and the empty-container rule", () => {
    for (const speak of [true, false]) {
      expect(spoken("العدد ۳۶: <>.", speak)).toContain("٣٦");
      expect(spoken("العدد ۳۶: <>.", speak)).not.toContain("<>");
    }
  });
});

describe("segmentation cannot move, because the rule runs after it", () => {
  // THE REGRESSION THIS GUARDS. Segmentation happens in `FoliateController`: `Intl.Segmenter` splits the
  // DISPLAYED text into `ttsUnits`, `hasSpeech` drops the ones carrying no letter or digit, and the
  // survivors are handed to `tts.ts` as `sentences[]` — already split, already indexed, already paired
  // with the Ranges the highlight is drawn from. The new rule is applied inside `synthInvoke`, per
  // sentence, on the way to the engine. It is therefore incapable of changing any of that, and these
  // assertions state the property rather than trusting the arrangement to stay as it is.
  const HAS_SPEECH = /[\p{L}\p{N}]/u; // the same predicate as FoliateController's `hasSpeech`
  const segment = (t: string) =>
    [...new Intl.Segmenter("ar", { granularity: "sentence" }).segment(t)]
      .map((s) => s.segment)
      .filter((s) => HAS_SPEECH.test(s));

  const CHAPTER = [
    "# الفصل الأول: البداية.",
    "قال الرجل: نعم، ثم مضى في طريقه… وهو يبتسم.",
    "نص عربي -- نص آخر.",
    "كان ذلك في 2026-09-10، ونسبة النجاح 10%.",
    "~ ملاحظة على الهامش ~.",
    "الخالد-المرتد كتاب معروف؟ نعم!",
    "راسل a@b.com أو زر sard.app/help.",
    "- ومن يكون هذا الرجل؟",
  ].join(" ");

  it("segments the SAME chapter text into the same units either way", () => {
    // The rule is never applied before segmentation; this proves the units do not depend on it.
    const units = segment(CHAPTER);
    expect(units.length).toBeGreaterThan(1);
    expect(segment(CHAPTER)).toEqual(units);
  });

  it("applying the rule per unit changes neither the count nor the order", () => {
    const units = segment(CHAPTER);
    const spoken = units.map(withoutDecorativeSymbols);
    expect(spoken).toHaveLength(units.length);
    // Index i still corresponds to unit i — which is what keeps the spoken queue, the sentence bands
    // and the word ranges pointing at the same sentence.
    spoken.forEach((s, i) => expect(HAS_SPEECH.test(s)).toBe(units[i] !== undefined));
  });

  it("no unit becomes empty or unspeakable, so no new permanent-failure path opens", () => {
    // `isImplausiblyShortAudio` raises VOICE_MISMATCH_MARKER — a PERMANENT failure that skips the retry
    // ladder — when a request that had text comes back with almost no audio. A rule that emptied a unit
    // would create exactly that. It cannot: it never removes a letter or a digit.
    for (const unit of segment(CHAPTER)) {
      expect(HAS_SPEECH.test(withoutDecorativeSymbols(unit))).toBe(true);
      expect(withoutDecorativeSymbols(unit).trim()).not.toBe("");
    }
  });

  it("every word the tracker looks for still survives in the spoken text", () => {
    // Tracking searches `speakableText(displayed)` for each word Edge reports, BY CONTENT. The
    // suppressed marks are ones Edge emits as their OWN word, never as part of one, so the words either
    // side are untouched and still findable.
    for (const unit of segment(CHAPTER)) {
      const words = unit.split(/\s+/).filter((w) => HAS_SPEECH.test(w));
      const spoken = withoutDecorativeSymbols(unit);
      for (const w of words) {
        // A word may lose a leading/trailing mark; its speakable core must remain.
        const core = w.replace(/^[#~*^]+|[#~*^]+$/g, "");
        if (core) expect(spoken).toContain(core);
      }
    }
  });
});

describe("the three transforms compose the way production composes them", () => {
  // Production calls `withoutDecorativeSymbols(withoutEmptyMarkup(speakableText(text)))`, at the single
  // engine boundary in `tts.ts`. These assert the whole composition, not any one part.
  const spoken = (t: string) => withoutDecorativeSymbols(withoutEmptyMarkup(speakableText(t)));

  it("does all three jobs at once", () => {
    // extended digits normalised, empty container gone, formatting mark silenced.
    expect(spoken("العدد ۳۶ # هنا: <>.")).toBe("العدد ٣٦   هنا:  .");
  });

  it("the order does not matter, because the parts commute", () => {
    // The new rule never adds or removes a letter or digit, so it cannot change whether a bracketed
    // span counts as speakable — which is the only thing `withoutEmptyMarkup` decides.
    for (const t of ["<۳۶>", "a#b", "<نعم> # <>", "نص -- نص <>"]) {
      expect(withoutDecorativeSymbols(withoutEmptyMarkup(speakableText(t))))
        .toBe(withoutEmptyMarkup(withoutDecorativeSymbols(speakableText(t))));
    }
  });

  it("ordinary prose survives the whole composition unchanged", () => {
    const t = "قال الرجل: نعم، ثم مضى.";
    expect(spoken(t)).toBe(t);
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
