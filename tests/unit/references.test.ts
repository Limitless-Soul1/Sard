// THE TWO FOLDS MUST AGREE.
//
// A reference is stored as a folded PHRASE and found by scanning a folded SECTION. Those two folds are
// produced by different code paths — `foldPhrase` over the whole selection, and a per-character walk
// over the rendered text — so anything they disagree about is a reference that exists, is stored
// correctly, and is never marked. That is what these tests pin down.
import { describe, expect, it } from "vitest";
import { findPhraseHits, foldCharInto, foldPhrase } from "../../src/lib/references";

/** The section haystack, folded exactly as the renderer folds it. */
const section = (s: string): string => {
  let hay = "";
  for (const ch of s) hay += foldCharInto(ch, hay.charCodeAt(hay.length - 1) === 32);
  return hay;
};
const marks = (source: string, phrase: string): number =>
  findPhraseHits(section(source), [{ id: "r", phrase_fold: foldPhrase(phrase) }]).length;

describe("a reference finds its phrase in the section it was made in", () => {
  it("marks a single word", () => {
    expect(marks("he met Klein on the stair", "Klein")).toBe(1);
  });

  it("marks a phrase whose words are separated by ONE space", () => {
    expect(marks("the Tarot Club met at dusk", "Tarot Club")).toBe(1);
  });

  // THE DEFECT. Every one of these folded to more spaces in the section than in the stored phrase, so
  // `indexOf` failed and the mark never appeared — while the reference sat in the database looking
  // perfectly healthy. Two of the three are how EPUB XHTML is ordinarily written.
  it("marks a phrase across a newline and indentation, as XHTML is normally written", () => {
    expect(marks("the Tarot\n      Club met at dusk", "Tarot Club")).toBe(1);
  });

  it("marks a phrase across several spaces", () => {
    expect(marks("the Tarot   Club met at dusk", "Tarot Club")).toBe(1);
  });

  it("marks a phrase across a tab", () => {
    expect(marks("the Tarot\tClub met at dusk", "Tarot Club")).toBe(1);
  });

  it("marks an Arabic phrase across a line break, tashkīl and all", () => {
    // The selection carries the newline the reader dragged over; the section carries the indentation.
    expect(marks("قال إن الأسماء تُعطى\n      مرة واحدة", "تُعطى\n      مرة")).toBe(1);
  });

  it("still refuses a phrase that is only part of a longer word", () => {
    // The whole-phrase rule is what keeps «Klein» off "Kleiner"; collapsing must not loosen it.
    expect(marks("Kleiner stood there", "Klein")).toBe(0);
    expect(marks("he read the Tarot Clubhouse sign", "Tarot Club")).toBe(0);
  });

  it("marks every occurrence, however the whitespace between the words is written", () => {
    expect(marks("Tarot Club, then Tarot\n  Club, then Tarot  Club", "Tarot Club")).toBe(3);
  });

  it("maps a hit back to a range that is not collapsed", () => {
    // The renderer builds a Range from [start,end); a zero-length hit would draw nothing.
    const hay = section("the Tarot\n   Club met");
    const [hit] = findPhraseHits(hay, [{ id: "r", phrase_fold: foldPhrase("Tarot Club") }]);
    expect(hit).toBeTruthy();
    expect(hit.end).toBeGreaterThan(hit.start);
    expect(hay.slice(hit.start, hit.end)).toBe("tarot club");
  });

  it("leaves the folded text otherwise unchanged, so offsets still address real characters", () => {
    // Collapsing may only ever REMOVE a repeated space; nothing else about the fold moves.
    expect(section("one two")).toBe("one two");
    expect(section("one  two")).toBe("one two");
    expect(section("  leading")).toBe(" leading");
  });
});
