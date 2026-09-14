import { describe, expect, it } from "vitest";
import {
  MIN_NEEDLE,
  countIn,
  decide,
  foldText,
  isTerminal,
  noteFollows,
} from "../../src/features/deposit/model/placement";

/**
 * THE RULE THIS FILE DEFENDS: a mark is placed only where its text occurs EXACTLY ONCE in the scope
 * being searched — never "the first occurrence", at any tier.
 *
 * An unplaced mark is a small disappointment. A misplaced one is a lie about what someone read, and
 * every test below exists to make the second impossible.
 */
const long = (s: string) => s.padEnd(MIN_NEEDLE + 4, "x");

describe("deciding where a deposited mark belongs", () => {
  it("places a mark whose words appear once in the chapter the sender named", () => {
    const v = decide(long("needle"), { labelled: { section: 7, count: 1 }, whole: { count: 3, section: null } });
    expect(v).toEqual({ state: "located", target_section: 7 });
  });

  it("refuses when the named chapter holds the words twice — and does NOT widen the search", () => {
    // Finding them again elsewhere cannot make the choice safer, so ambiguity is terminal.
    const v = decide(long("needle"), { labelled: { section: 7, count: 2 }, whole: { count: 2, section: null } });
    expect(v.state).toBe("ambiguous");
  });

  it("falls through to the whole book when the named chapter does not hold them", () => {
    // A different edition may simply name its chapters differently.
    const v = decide(long("needle"), { labelled: { section: 7, count: 0 }, whole: { count: 1, section: 12 } });
    expect(v).toEqual({ state: "located", target_section: 12 });
  });

  it("places from the whole book ONLY when the book holds the words exactly once", () => {
    expect(decide(long("n"), { labelled: null, whole: { count: 1, section: 4 } })).toEqual({
      state: "located",
      target_section: 4,
    });
    expect(decide(long("n"), { labelled: null, whole: { count: 2, section: null } }).state).toBe("ambiguous");
    expect(decide(long("n"), { labelled: null, whole: { count: 9, section: null } }).state).toBe("ambiguous");
  });

  it("says absent when the words are nowhere in this copy", () => {
    expect(decide(long("n"), { labelled: null, whole: { count: 0, section: null } }).state).toBe("absent");
    expect(decide(long("n"), { labelled: { section: 2, count: 0 }, whole: { count: 0, section: null } }).state).toBe(
      "absent",
    );
  });

  it("refuses a needle too short to be evidence, however unique it looks", () => {
    // Uniqueness of a fragment is luck, not identity — so this is refused before any tier runs.
    const v = decide("short", { labelled: { section: 1, count: 1 }, whole: { count: 1, section: 1 } });
    expect(v.state).toBe("unanchorable");
    expect(decide("", { labelled: null, whole: { count: 1, section: 1 } }).state).toBe("unanchorable");
  });

  it("never returns a target section for a state that is not located", () => {
    const cases = [
      decide("short", { labelled: { section: 3, count: 1 }, whole: { count: 1, section: 3 } }),
      decide(long("n"), { labelled: null, whole: { count: 0, section: null } }),
      decide(long("n"), { labelled: null, whole: { count: 5, section: null } }),
    ];
    for (const v of cases) if (v.state !== "located") expect(v.target_section === null || v.state === "ambiguous").toBe(true);
  });
});

describe("a note follows its highlight and is never searched for", () => {
  it("inherits the highlight's fate exactly", () => {
    expect(noteFollows({ state: "located", target_section: 5 })).toEqual({ state: "located", target_section: 5 });
    expect(noteFollows({ state: "ambiguous", target_section: null }).state).toBe("ambiguous");
    expect(noteFollows({ state: "absent", target_section: null }).state).toBe("absent");
  });

  it("has nothing to anchor to when it belongs to no highlight", () => {
    expect(noteFollows(null)).toEqual({ state: "unanchorable", target_section: null });
  });
});

describe("counting and folding", () => {
  it("counts every occurrence, including overlapping ones", () => {
    expect(countIn("aaaa", "aa")).toBe(3);
    expect(countIn("abcabc", "abc")).toBe(2);
    expect(countIn("abc", "zzz")).toBe(0);
    expect(countIn("", "a")).toBe(0);
    expect(countIn("abc", "")).toBe(0);
  });

  it("stops early when a cap is given — a second occurrence is all ambiguity needs", () => {
    expect(countIn("aaaaaaaa", "a", 1)).toBe(2);
  });

  it("folds the needle and the haystack by the same rule, so a count means something", () => {
    // Arabic: tashkīl stripped, alef and ya folded — the same folding the reference matcher uses.
    const hay = foldText("قَالَ إنَّ الأمرَ يسيرٌ");
    const needle = foldText("قال ان الامر");
    expect(hay.includes(needle)).toBe(true);
    // Latin: case folded.
    expect(foldText("The Rabbit-Hole").includes(foldText("the rabbit-hole"))).toBe(true);
  });

  it("does not fold two different phrases into one", () => {
    expect(foldText("كلاين").includes(foldText("أودري"))).toBe(false);
  });
});

describe("terminal states", () => {
  it("knows which verdicts are final — which is what makes the pass idempotent", () => {
    for (const s of ["placed", "already_yours", "ambiguous", "absent", "unanchorable"]) {
      expect(isTerminal(s)).toBe(true);
    }
    for (const s of ["pending", "located", null, undefined, ""]) expect(isTerminal(s)).toBe(false);
  });
});
