// THE REPLACEMENT ARITHMETIC — the part with a right answer a browser is not needed to check.
//
// Two things here can be wrong in a way no type catches and no screenshot reveals: WHICH runs of text a
// rule claims, and HOW an offset moves once those runs are substituted. The first decides whether «اله»
// quietly eats «الهلال»; the second decides whether an existing highlight still covers the words the
// reader put it on. Both were measured against a running library before this file existed — 16/16 Latin
// and 24/24 Arabic annotations restored exactly by the translation below — and these keep that honest.
//
// What this CANNOT prove is that the page reads correctly, that a rule can be switched off from the UI,
// or that the surface matches the design. Those are checked by running the application.
import { describe, expect, it } from "vitest";
import { foldPhrase } from "../../src/lib/references";
import {
  applyToText,
  expandQuery,
  shiftOffset,
  textHasReplacement,
  type NodeEdit,
  type RepLite,
} from "../../src/lib/replacements";

const rule = (phrase: string, replacement: string, id = "r1"): RepLite => ({
  id,
  phrase,
  phrase_fold: foldPhrase(phrase),
  replacement,
});

const ILAH = [rule("اله", "حاكم")];

describe("which runs a rule claims", () => {
  it("replaces the standalone word", () => {
    expect(applyToText("قال اله ثم مضى", ILAH)).toBe("قال حاكم ثم مضى");
  });

  // The whole point of reusing the reference matcher rather than String.replace: a longer word that
  // merely CONTAINS the phrase is not a match, in either direction.
  it("leaves الهلال alone", () => {
    expect(applyToText("رأيت الهلال في السماء", ILAH)).toBe("رأيت الهلال في السماء");
  });
  it("leaves واله alone", () => {
    expect(applyToText("وقال واله إنه صادق", ILAH)).toBe("وقال واله إنه صادق");
  });
  it("leaves الهي alone", () => {
    expect(applyToText("يا الهي ارحمني", ILAH)).toBe("يا الهي ارحمني");
  });

  it("treats punctuation, line breaks and the string edge as boundaries", () => {
    expect(applyToText("اله.", ILAH)).toBe("حاكم.");
    expect(applyToText("اله، ثم غاب", ILAH)).toBe("حاكم، ثم غاب");
    expect(applyToText("قال\nاله\nثم", ILAH)).toBe("قال\nحاكم\nثم");
    expect(applyToText("اله يحكم", ILAH)).toBe("حاكم يحكم");
  });

  // Folding is not length-preserving, so a vowelled source is where a naive index lands mid-word.
  it("matches a vowelled source and swallows its marks", () => {
    expect(applyToText("جاء الهُ الكريم", ILAH)).toBe("جاء حاكم الكريم");
    expect(applyToText("الْمَلِك حاضر", [rule("الملك", "الحاكم")])).toBe("الحاكم حاضر");
  });

  it("replaces every occurrence, not only the first", () => {
    expect(applyToText("اله ثم اله", ILAH)).toBe("حاكم ثم حاكم");
  });

  it("prefers the longer phrase when two rules overlap", () => {
    const reps = [rule("ملك", "أمير", "short"), rule("ملك الملوك", "السلطان", "long")];
    expect(applyToText("جاء ملك الملوك اليوم", reps)).toBe("جاء السلطان اليوم");
  });

  it("reports whether a passage is affected at all", () => {
    expect(textHasReplacement("قال اله", ILAH)).toBe(true);
    expect(textHasReplacement("رأيت الهلال", ILAH)).toBe(false);
  });

  it("is identity when no rule is in force", () => {
    expect(applyToText("قال اله ثم مضى", [])).toBe("قال اله ثم مضى");
  });

  // The run swallows TRAILING COMBINING MARKS so a vowelled source is replaced whole. A space folds to a
  // space rather than to nothing, which is the only reason that loop stops before eating the word gap —
  // if it ever folded away, «الله محمد» would come back as «...الكبيرُمحمد» with the space gone.
  it("does not eat the space after a vowelled match", () => {
    expect(applyToText("لا إله إلا اللهُ محمد", [rule("الله", "الحاكم")])).toBe("لا إله إلا الحاكم محمد");
  });
});

describe("offset translation", () => {
  // «اله»(3) -> «حاكم»(4) at author offset 4, so everything after it moves by one.
  const edits: NodeEdit[] = [{ start: 4, origLen: 3, newLen: 4 }];

  it("leaves an offset before the run untouched", () => {
    expect(shiftOffset(edits, 2, false, true)).toBe(2);
    expect(shiftOffset(edits, 2, false, false)).toBe(2);
  });

  it("shifts an offset after the run by the growth", () => {
    expect(shiftOffset(edits, 9, false, true)).toBe(10);
    expect(shiftOffset(edits, 10, false, false)).toBe(9);
  });

  it("round-trips every offset outside the run", () => {
    for (const off of [0, 1, 4, 7, 8, 12, 40]) {
      const there = shiftOffset(edits, off, false, true);
      expect(shiftOffset(edits, there, false, false)).toBe(off);
    }
  });

  // An offset inside a substituted run has no exact twin, so the ends clamp OUTWARDS — otherwise a
  // translated range would cover half a word.
  it("clamps an offset inside the run, each end to its own side", () => {
    expect(shiftOffset(edits, 5, false, true)).toBe(4);
    expect(shiftOffset(edits, 5, true, true)).toBe(8);
  });

  it("handles several runs in one node, and shrinking ones", () => {
    const many: NodeEdit[] = [
      { start: 0, origLen: 3, newLen: 1 },
      { start: 10, origLen: 2, newLen: 6 },
    ];
    expect(shiftOffset(many, 5, false, true)).toBe(3);
    expect(shiftOffset(many, 20, false, true)).toBe(22);
    for (const off of [4, 5, 9, 13, 20, 60]) {
      expect(shiftOffset(many, shiftOffset(many, off, false, true), false, false)).toBe(off);
    }
  });

  it("is identity with no edits", () => {
    expect(shiftOffset(undefined, 7, false, true)).toBe(7);
    expect(shiftOffset([], 7, true, false)).toBe(7);
  });
});

// The section-level behaviour — substituting a rendered document in place, restoring it exactly, and
// matching a phrase the markup split across nodes — is deliberately NOT tested here. It needs a real
// browser DOM, and this project's unit tests run in plain node with no jsdom; a hand-built stub would
// only test the stub. Those properties are measured against the running application instead, on real
// books and real annotations, which is the stronger evidence in any case.

describe("search expansion", () => {
  // Search reads the AUTHOR's text through a separate parse, so the author's word already works; typing
  // the replacement is what has to be translated back.
  it("adds the author's word when the replacement is typed", () => {
    expect(expandQuery("حاكم", ILAH, foldPhrase)).toEqual(["حاكم", "اله"]);
  });
  it("leaves the author's own word as a single term", () => {
    expect(expandQuery("اله", ILAH, foldPhrase)).toEqual(["اله"]);
  });
  it("ignores an unrelated query", () => {
    expect(expandQuery("سماء", ILAH, foldPhrase)).toEqual(["سماء"]);
  });
  it("is a no-op with no rules", () => {
    expect(expandQuery("حاكم", [], foldPhrase)).toEqual(["حاكم"]);
  });
});
