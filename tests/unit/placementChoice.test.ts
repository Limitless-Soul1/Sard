// A case is not a placement destination.
//
// It contains shelves, so it cannot answer "which shelf?" — the same reason a case takes no drop in
// Vista. Choosing one only narrows the level below it. Book Details used to render the two levels as
// one control with Save underneath, so choosing a case and pressing Save read as filing the book and
// silently did nothing at all: reproduced against the running app as `did anything move? false`.
//
// `awaitsShelfChoice` is that pending state, named — and it is the only thing that stands between a
// case selection and Save doing nothing. Every assertion here fails if the predicate is removed.

import { describe, expect, it } from "vitest";
import { awaitsShelfChoice } from "../../src/features/library/design/model";

const UNFILED = null;

describe("choosing a case leaves a placement unfinished", () => {
  it("a case the book is NOT in, with shelves to choose from, is not yet a destination", () => {
    // THE REGRESSION. The book sits outside every case; the reader aims at «Test». Nothing has been
    // placed, and Save must not behave as though something had.
    expect(awaitsShelfChoice(UNFILED, "case-test", 3)).toBe(true);
    expect(awaitsShelfChoice("case-a", "case-b", 2)).toBe(true);
  });

  it("the case the book already sits in is not a pending choice", () => {
    // Opening the dialog must not immediately demand a shelf for where the book already is.
    expect(awaitsShelfChoice("case-a", "case-a", 4)).toBe(false);
    expect(awaitsShelfChoice(UNFILED, UNFILED, 3)).toBe(false);
  });

  it("a case with no shelf to offer does not demand one", () => {
    // The level below already says the case is empty; asking for a shelf that cannot exist would be
    // an instruction the reader cannot follow.
    expect(awaitsShelfChoice(UNFILED, "case-empty", 0)).toBe(false);
    expect(awaitsShelfChoice("case-a", "case-empty", 0)).toBe(false);
  });

  it("moving BACK to the loose shelves is a pending choice like any other", () => {
    // «Not in a case» is a place with shelves in it, not an escape from choosing one.
    expect(awaitsShelfChoice("case-a", UNFILED, 3)).toBe(true);
    expect(awaitsShelfChoice("case-a", UNFILED, 0)).toBe(false);
  });

  it("is settled the moment the book's placement moves into the chosen case", () => {
    // A shelf click files the book, so the book's own case becomes the chosen one and the pending
    // state clears — which is what makes case → shelf → placement still work.
    const chosen = "case-test";
    expect(awaitsShelfChoice(UNFILED, chosen, 3)).toBe(true);
    expect(awaitsShelfChoice(chosen, chosen, 3)).toBe(false);
  });

  it("never depends on how many shelves there are beyond there being one", () => {
    for (const n of [1, 2, 9, 40]) expect(awaitsShelfChoice(UNFILED, "c", n)).toBe(true);
  });
});
