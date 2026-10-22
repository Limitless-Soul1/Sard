// The reader's translation view — everything about it that can be checked without a browser: which rendered
// paragraph each stored one is, what each paragraph shows, what the reader says when translating cannot be done, and
// the approved words. The page itself (the attributes, the hidden original, the layout) is checked in a real WebView2.
import { describe, expect, it } from "vitest";

import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";
import { marksFor, match, type Labels, type Rendered } from "../../src/features/translation/reader/apply";
import { asReaderError, noticeFor } from "../../src/features/translation/reader/useBookTranslation";

const labels: Labels = { review: "R", reviewHint: "RH", notTranslated: "NT", keptOriginal: "KO" };
const leaf = (path: number[], text: string, tag = "p"): Rendered => ({ path, tag, text });
const para = (ordinal: number, path: number[], text: string, tag = "p") => ({ ordinal, path, tag, text });

describe("finding a paragraph on the page", () => {
  it("is the leaf at its path when the tag and the text agree there", () => {
    const rendered = [leaf([0], "One."), leaf([1], "Two.")];
    expect(match([para(0, [0], "One."), para(1, [1], "Two.")], rendered)).toEqual(new Map([[0, 0], [1, 1]]));
  });

  it("follows the text, in order, when the reader's own passes moved the paths", () => {
    // A placeholder the reader inserted at the top of the body moves every path by one.
    const rendered = [leaf([0], "Title hidden", "div"), leaf([1], "One."), leaf([2], "Two.")];
    expect(match([para(0, [0], "One."), para(1, [1], "Two.")], rendered)).toEqual(new Map([[0, 1], [1, 2]]));
  });

  it("never guesses: a paragraph found nowhere, or whose tag differs, is left alone", () => {
    const rendered = [leaf([0], "One."), leaf([1], "Changed by a replacement.")];
    expect(match([para(0, [0], "One.", "h2"), para(1, [1], "Two.")], rendered)).toEqual(new Map());
  });

  it("never gives one leaf to two paragraphs, and keeps reading order", () => {
    const rendered = [leaf([0], "Same."), leaf([1], "Same.")];
    expect(match([para(0, [5], "Same."), para(1, [6], "Same.")], rendered)).toEqual(new Map([[0, 0], [1, 1]]));
  });
});

describe("what a paragraph shows", () => {
  it("is its translation, marked when a check is unresolved", () => {
    expect(marksFor({ kind: "translation", text: "ت", review: false }, labels)).toEqual({ translation: "ت", note: null, title: null });
    expect(marksFor({ kind: "translation", text: "ت", review: true }, labels)).toEqual({ translation: "ت", note: "R", title: "RH" });
  });

  it("is the original with a note when there is no translation, or when the paragraph keeps its elements", () => {
    expect(marksFor({ kind: "not_translated" }, labels)).toEqual({ translation: null, note: "NT", title: null });
    expect(marksFor({ kind: "kept_original" }, labels)).toEqual({ translation: null, note: "KO", title: null });
  });

  it("is simply the original, with nothing said, while it waits to be translated", () => {
    expect(marksFor({ kind: "pending" }, labels)).toBeNull();
  });
});

describe("what the reader says", () => {
  it("opens the models section, and says nothing, when no model is ready", () => {
    expect(noticeFor({ kind: "no_ready_model" })).toBeNull();
  });

  it("explains a WebView2 update, and words every failure in approved sentences with the detail behind Details", () => {
    expect(noticeFor({ kind: "runtime_changed", detail: "d" })).toEqual({ key: "translation.reader.runtimeChanged", detail: "d" });
    expect(noticeFor({ kind: "busy" })).toEqual({ key: "translation.inUse.engine", detail: null });
    expect(noticeFor({ kind: "failed", memory: true, engineBusy: false, detail: "d" })?.key).toBe("translation.fail.memory");
    expect(noticeFor({ kind: "failed", memory: false, engineBusy: true, detail: "d" })?.key).toBe("translation.inUse.engine");
    expect(noticeFor({ kind: "failed", memory: false, engineBusy: false, detail: "d" })).toEqual({ key: "translation.fail.unknown", detail: "d" });
  });

  it("takes anything that is not the backend's own refusal as a failure with its text", () => {
    expect(asReaderError({ kind: "busy" })).toEqual({ kind: "busy" });
    expect(asReaderError(new Error("section 3 could not be read"))).toEqual({ kind: "failed", memory: false, engineBusy: false, detail: "section 3 could not be read" });
  });
});

describe("the approved words (2026-10-22)", () => {
  const english = en as Record<string, string>;
  const arabic = ar as Record<string, string>;
  it("are exactly as approved, in both languages", () => {
    const keys = ["translate", "original", "translation", "translating", "noModel", "review", "reviewHint", "notTranslated", "keptOriginal", "runtimeChanged"].map((k) => `translation.reader.${k}`);
    expect(keys.map((k) => english[k])).toEqual([
      "Translate",
      "Original",
      "Translation",
      "Translating…",
      "No translation model is ready yet. Download one below to translate this book.",
      "Needs review",
      "A check flagged a possible problem here. Compare it with the original.",
      "Not translated — shown in the original.",
      "Not translated: it contains links, notes, images or line breaks.",
      "WebView2 was updated while Sard was open, so this book can't be translated right now. Restart Sard, then choose Translate again.",
    ]);
    expect(keys.map((k) => arabic[k])).toEqual([
      "ترجمة",
      "الأصل",
      "الترجمة",
      "جارٍ الترجمة…",
      "لا يوجد نموذج ترجمة جاهز بعد. نزِّل أحد النماذج أدناه لترجمة هذا الكتاب.",
      "بحاجة إلى مراجعة",
      "نبّه أحد الفحوص إلى مشكلة محتملة هنا. قارِنها بالأصل.",
      "لم تُترجَم — تظهر بنصّها الأصلي.",
      "لم تُترجَم: تحتوي على روابط أو حواشٍ أو صور أو فواصل أسطر.",
      "حُدِّث ⁨WebView2⁩ و«سَرْد» مفتوح، لذا تتعذّر ترجمة هذا الكتاب الآن. أعِد تشغيل «سَرْد»، ثم اختر «ترجمة» مجددًا.",
    ]);
  });
});
