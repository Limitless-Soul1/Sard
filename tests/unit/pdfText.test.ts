// The repair and the verdict are the parts that decide whether a reader hears their book or hears
// nonsense, so they are tested against the SHAPES the measured corpus actually produced.
import { describe, it, expect } from "vitest";
import { normalizePdfText, stripPdfArtifacts, scorePdfPage, scorePdfDocument, hasSpeakableText } from "../../src/lib/pdfText";

describe("normalizePdfText", () => {
  it("folds Arabic presentation forms back to base letters", () => {
    // ﺭﺳﺎﻟﺔ in Forms-B (the shape رسالة الغفران's text layer actually carries).
    const pres = "ﺭﺴﺎﻟﺔ";
    const out = normalizePdfText(pres);
    expect(out).toBe("رسالة");
    expect(/[ﭐ-﷿ﹰ-﻿]/.test(out)).toBe(false);
  });

  it("expands the lam-alef ligature into two letters", () => {
    expect(normalizePdfText("ﻻ")).toBe("لا");
  });

  it("removes tatweel padding without touching real letters", () => {
    expect(normalizePdfText("كــتــاب")).toBe("كتاب");
  });

  it("keeps tashkeel — diacritics help Arabic pronunciation", () => {
    const withHarakat = "كِتَابٌ";
    expect(normalizePdfText(withHarakat)).toContain("ِ");
  });

  it("strips zero-width and bidi control characters", () => {
    expect(normalizePdfText("ا​ب‬ج")).toBe("ابج");
  });

  it("rejoins a word hyphenated across a line break", () => {
    expect(normalizePdfText("con-\ntinue")).toBe("continue");
  });

  it("collapses whitespace and drops replacement characters", () => {
    expect(normalizePdfText("a   \n b � c")).toBe("a b c");
  });

  it("survives an empty or pathological run", () => {
    expect(normalizePdfText("")).toBe("");
    expect(normalizePdfText("   ")).toBe("");
  });
});

describe("stripPdfArtifacts", () => {
  it("removes the download-site watermark that dominates one corpus file", () => {
    const stamped = "www.kutub-pdf.net www.kutub-pdf.net www.kutub-pdf.net www.kutub-pdf.net";
    expect(stripPdfArtifacts(stamped)).toBe("");
  });

  it("removes a token stamped repeatedly across a page but keeps the prose", () => {
    // The stamp has to dominate the page before it is touched — see the conservatism note in the
    // module: an over-eager rule deleted a whole page of legitimate repeated Arabic.
    const words = ["كتاب", "قراءة", "صفحة", "سطر", "فصل", "نصوص"];
    const prose = words.join(" ");
    const page = ("STAMPED STAMPED STAMPED " + prose + " ").repeat(6); // 1/3 of the page is the stamp
    const out = stripPdfArtifacts(page);
    expect(out).toContain("كتاب");
    expect(out).not.toContain("STAMPED");
  });

  it("does NOT delete prose that legitimately repeats a word", () => {
    const page = "الحرب ".repeat(30);
    expect(stripPdfArtifacts(page)).toContain("الحرب");
  });

  it("leaves ordinary prose alone", () => {
    const prose = "هذا نص عربي عادي لا يحتوي على علامات مائية";
    expect(stripPdfArtifacts(prose)).toBe(prose);
  });
});

describe("scorePdfDocument", () => {
  it("calls a scanned book unusable — no text on any page", () => {
    const s = scorePdfDocument(["", "", "", "", ""]);
    expect(s.verdict).toBe("unusable");
    expect(s.reason).toBe("no-text-layer");
    expect(s.coverage).toBe(0);
  });

  it("calls a watermark-only book unusable rather than reading the watermark aloud", () => {
    const s = scorePdfDocument(["www.kutub-pdf.net ".repeat(12), "", "", "", ""]);
    expect(s.verdict).toBe("unusable");
    expect(["no-text-layer", "sparse-text-layer"]).toContain(s.reason);
  });

  it("calls mojibake unusable", () => {
    const junk = "Ûa ‘‹èÐ < <  ".repeat(12);
    const s = scorePdfDocument([junk, junk, junk, junk, junk]);
    expect(s.verdict).toBe("unusable");
  });

  it("accepts presentation-form Arabic BECAUSE it is repaired before scoring", () => {
    // Varied Forms-B words, so the page looks like prose rather than a stamp.
    const forms = ["ﺭﺴﺎﻟﺔ", "ﺍﻟﻜﺘﺎﺏ", "ﻣﻘﺪﻣﺔ", "ﺻﻔﺤﺔ", "ﻓﺼﻮﻝ", "ﺗﺤﻘﻴﻖ", "ﻗﺮﺍﺀﺓ", "ﻧﺼﻮﺹ"];
    const page = Array.from({ length: 30 }, (_, i) => forms[i % forms.length]).join(" ");
    const s = scorePdfDocument([page, page, page, page, page]);
    expect(s.verdict).not.toBe("unusable");
    expect(s.repaired).toBeGreaterThan(0.5); // the source WAS damaged
    expect(s.legible).toBeGreaterThan(0.9);  // and the repair worked
  });

  it("accepts clean Arabic prose as good", () => {
    const page = "هذا كتاب عربي مكتوب بنص سليم يمكن قراءته بصوت مسموع دون أي مشكلة تذكر. ".repeat(6);
    const s = scorePdfDocument([page, page, page, page, page]);
    expect(s.verdict).toBe("good");
    expect(s.legible).toBeGreaterThan(0.9);
  });

  it("reports partial when only some pages carry text", () => {
    const page = "هذا كتاب عربي مكتوب بنص سليم يمكن قراءته بصوت مسموع. ".repeat(6);
    const s = scorePdfDocument([page, page, page, "", ""]);
    expect(s.verdict).toBe("partial");
  });
});

describe("hasSpeakableText", () => {
  it("rejects a run that is only a watermark", () => {
    expect(hasSpeakableText("www.foulabook.com")).toBe(false);
  });
  it("rejects punctuation and digits with no letters", () => {
    expect(hasSpeakableText("«» ٣٤ —")).toBe(false);
  });
  it("accepts presentation-form Arabic once repaired", () => {
    expect(hasSpeakableText("ﺭﺴﺎﻟﺔ")).toBe(true);
  });
});
