// Pressing FORWARD on the last sentence of a chapter.
//
// The clamp that serves every other transport move resolved this one back onto the sentence already
// playing, so the press replayed it instead of offering the next chapter. These fix the rule in place.
import { describe, expect, it } from "vitest";

import { resolveSkip, settleNeedsReplay } from "../../src/lib/tts";

describe("where a transport skip lands", () => {
  it("forward from the last sentence ends the chapter", () => {
    expect(resolveSkip(9, 1, 10)).toEqual({ kind: "chapter-end" });
  });

  it("forward from anywhere else advances one sentence", () => {
    expect(resolveSkip(0, 1, 10)).toEqual({ kind: "sentence", index: 1 });
    expect(resolveSkip(7, 1, 10)).toEqual({ kind: "sentence", index: 8 });
  });

  it("the press BEFORE the last one lands on the last sentence, it does not end the chapter", () => {
    // "First press → advance normally. When the final sentence is reached → remain on that sentence."
    expect(resolveSkip(8, 1, 10)).toEqual({ kind: "sentence", index: 9 });
  });

  it("a one-sentence chapter ends on the first forward press", () => {
    expect(resolveSkip(0, 1, 1)).toEqual({ kind: "chapter-end" });
  });

  it("backward never ends a chapter, and stops at the first sentence", () => {
    expect(resolveSkip(9, -1, 10)).toEqual({ kind: "sentence", index: 8 });
    expect(resolveSkip(0, -1, 10)).toEqual({ kind: "sentence", index: 0 });
    expect(resolveSkip(0, -5, 10)).toEqual({ kind: "sentence", index: 0 });
  });

  it("backward from the last sentence is an ordinary move, not an ending", () => {
    expect(resolveSkip(9, -1, 10)).toEqual({ kind: "sentence", index: 8 });
  });

  it("an empty queue is left to the caller, exactly as before", () => {
    // The clamp floors at 0, so this answers "sentence 0" — unchanged behaviour, and harmless: with no
    // sentences, `playFrom(0)` immediately satisfies `0 >= 0` and takes the same end branch. The rule
    // deliberately does not claim a chapter ended when there was never anything to read.
    expect(resolveSkip(0, 1, 0)).toEqual({ kind: "sentence", index: 0 });
  });

  it("chapters of different lengths end at their own last sentence", () => {
    for (const n of [1, 2, 3, 17, 250]) {
      expect(resolveSkip(n - 1, 1, n)).toEqual({ kind: "chapter-end" });
      if (n > 1) expect(resolveSkip(n - 2, 1, n)).toEqual({ kind: "sentence", index: n - 1 });
    }
  });

  it("is not direction-dependent — the delta is the media convention, never mirrored", () => {
    // Right = +1 in both RTL and LTR (see `skipSentenceForArrow`), so there is one rule, not two.
    expect(resolveSkip(9, 1, 10)).toEqual({ kind: "chapter-end" });
    expect(resolveSkip(9, -1, 10)).toEqual({ kind: "sentence", index: 8 });
  });
});

describe("once the chapter has already ended", () => {
  // The arrows must stay CLAIMED here. `handleNavKey` hands them to read-aloud only while it says it
  // wants them and otherwise turns a page — so leaving chapter-end out of that set meant the reader
  // paged away from the very state being offered. Measured in the running app: the reading cfi moved
  // from ".../2,/8/1:44)" to ".../10/1:48,/24/1:54)" while the tts index stayed on 286.
  it("forward has nowhere to go and stays put", () => {
    expect(resolveSkip(9, 1, 10, true)).toEqual({ kind: "stay" });
  });

  it("backward steps OFF the last sentence, so the end state is properly left", () => {
    // Returning to the last sentence itself was tried and is wrong in practice: it is one short
    // sentence away from ending again, so the chapter re-ended seconds later and the reader was stuck.
    expect(resolveSkip(9, -1, 10, true)).toEqual({ kind: "sentence", index: 8 });
  });

  it("so the end can be left and reached again — the owner's whole state machine", () => {
    expect(resolveSkip(9, -1, 10, true)).toEqual({ kind: "sentence", index: 8 });  // leave
    expect(resolveSkip(8, 1, 10, false)).toEqual({ kind: "sentence", index: 9 });  // forward to the last
    expect(resolveSkip(9, 1, 10, false)).toEqual({ kind: "chapter-end" });         // and end it again
  });

  it("a one-sentence chapter has nowhere back to go and stays on it", () => {
    expect(resolveSkip(0, -1, 1, true)).toEqual({ kind: "sentence", index: 0 });
    expect(resolveSkip(0, 1, 1, false)).toEqual({ kind: "chapter-end" });
  });

  it("an empty queue at the end cannot land below zero", () => {
    expect(resolveSkip(0, -1, 0, true)).toEqual({ kind: "sentence", index: 0 });
  });

  it("the flag changes nothing when it is not set — every earlier rule is untouched", () => {
    expect(resolveSkip(9, 1, 10, false)).toEqual({ kind: "chapter-end" });
    expect(resolveSkip(8, 1, 10, false)).toEqual({ kind: "sentence", index: 9 });
    expect(resolveSkip(9, -1, 10, false)).toEqual({ kind: "sentence", index: 8 });
    expect(resolveSkip(0, -1, 10, false)).toEqual({ kind: "sentence", index: 0 });
  });
});

describe("when a settled skipping session must start audio itself", () => {
  // A skipping session plays its FIRST skip immediately and then only moves the index; the settle
  // decides whether the landing still needs playing. Deciding by target alone was wrong because every
  // skip cancels the leading play — so two quick presses onto the SAME sentence left it highlighted,
  // "playing", and silent. The generation is what distinguishes a live leading play from a dead one.

  it("a lone skip is still playing, so the settle only warms the look-ahead", () => {
    // one press: lead started at 5 under generation 7, nothing has superseded it
    expect(settleNeedsReplay(5, 5, 7, 7)).toBe(false);
  });

  it("REPEATED presses onto the same sentence must replay — the reported fault", () => {
    // press 1 leads at 0 under gen 7; press 2 also resolves to 0 and bumps gen to 8, killing it
    expect(settleNeedsReplay(0, 0, 7, 8)).toBe(true);
  });

  it("and that is exactly what the start of a chapter produces every time", () => {
    // backward at index 0 clamps to 0, so every press in the burst has the same target
    let g = 7;
    const leadGen = g;
    for (const _ of [1, 2, 3, 4]) g += 1; // four more presses, each bumping the generation
    expect(settleNeedsReplay(0, 0, leadGen, g)).toBe(true);
  });

  it("a session that moved to a different sentence replays, as it always did", () => {
    expect(settleNeedsReplay(3, 9, 7, 8)).toBe(true);
    expect(settleNeedsReplay(3, 9, 7, 7)).toBe(true);
  });

  it("the generation alone is enough — a same-target session is never left silent", () => {
    for (const bumps of [1, 2, 5, 40]) {
      expect(settleNeedsReplay(4, 4, 10, 10 + bumps)).toBe(true);
    }
  });

  it("no leading play was ever started, so the landing must be played", () => {
    // -1 is the reset value for both, and a session that never led cannot be "still playing"
    expect(settleNeedsReplay(6, -1, -1, 12)).toBe(true);
  });
});
