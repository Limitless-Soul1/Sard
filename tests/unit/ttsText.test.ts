// The one place the spoken string may differ from the displayed one.
//
// The rule under test is not "normalize digits" in general — it is the narrow, measured repair for
// the runs Edge drops. Everything else must pass through untouched, and the rewrite must be
// length-preserving, because word tracking maps Edge's boundary text back onto the DISPLAYED
// sentence by consuming the word's own length.
import { describe, expect, it } from "vitest";

import { hasExtendedDigits, speakableText } from "../../src/lib/ttsText";

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
