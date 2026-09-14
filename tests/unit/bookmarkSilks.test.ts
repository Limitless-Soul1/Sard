// THE RIBBONS ARE A CLAIM ABOUT THE DATA, so the claim is held to.
//
// The head of a cover is supposed to say how many places are saved, how far into the book they sit
// and how clustered they are. Each of those is a property of `silks()`, and each is the kind of
// thing a later edit could quietly break while the shelf still looked plausible.
import { describe, it, expect } from "vitest";
import { silks, byDepth, type Place } from "../../src/features/library/bookmarks/silks";

const pct = (s: string) => Number.parseFloat(s);
const place = (id: string, depth: number): Place => ({ id, depth });

describe("the ribbons on a cover's head", () => {
  it("draws exactly one per saved place — never padded, never trimmed", () => {
    expect(silks([]).length).toBe(0);
    expect(silks([place("a", 0.2)]).length).toBe(1);
    expect(silks([place("a", 0.1), place("b", 0.5), place("c", 0.9)]).length).toBe(3);
  });

  it("puts a place further into the book further along the head", () => {
    const [early, late] = silks([place("a", 0.1), place("b", 0.8)]);
    expect(pct(early.pos)).toBeLessThan(pct(late.pos));
  });

  it("orders by depth however the rows arrive", () => {
    const shuffled = [place("c", 0.9), place("a", 0.1), place("b", 0.5)];
    const out = silks(shuffled).map((s) => pct(s.pos));
    expect(out).toEqual([...out].sort((x, y) => x - y));
  });

  it("keeps near-adjacent places apart rather than letting them overlap", () => {
    // Three places within a hair of each other: without the rule they would sit on top of one
    // another and the head would claim one ribbon where there are three.
    const out = silks([place("a", 0.50), place("b", 0.505), place("c", 0.51)]).map((s) => pct(s.pos));
    for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(10.5);
  });

  it("keeps the whole run on the cover, however full the head", () => {
    // Ten places crowded at the very end: pushing them apart would walk the last ones off the edge,
    // so the run is pulled back inside instead.
    const many = Array.from({ length: 10 }, (_, i) => place("m" + i, 0.92 + i * 0.001));
    for (const s of silks(many)) {
      expect(pct(s.pos)).toBeGreaterThanOrEqual(3);
      expect(pct(s.pos)).toBeLessThanOrEqual(86.01);
    }
  });

  it("stays put between renders — a ribbon is placed, not stamped anew", () => {
    const rows = [place("x9", 0.2), place("y4", 0.44), place("z1", 0.77)];
    expect(silks(rows)).toEqual(silks(rows.slice().reverse()));
  });

  it("varies the hand a little, so a row of ribbons is not a row of clones", () => {
    // Seeded from the id, so the variation is stable — but it must actually vary.
    const lens = new Set(
      Array.from({ length: 12 }, (_, i) => silks([place("id" + i, 0.5)])[0].len),
    );
    expect(lens.size).toBeGreaterThan(1);
  });

  it("survives a depth that is missing or out of range instead of drawing off the cover", () => {
    for (const bad of [Number.NaN, -3, 4]) {
      const [s] = silks([place("odd", bad)]);
      expect(pct(s.pos)).toBeGreaterThanOrEqual(3);
      expect(pct(s.pos)).toBeLessThanOrEqual(86.01);
    }
  });

  it("settles the set in sequence rather than all at once", () => {
    const out = silks([place("a", 0.1), place("b", 0.4), place("c", 0.8)]);
    expect(out.map((s) => s.delay)).toEqual(["0ms", "22ms", "44ms"]);
  });

  it("orders the record's rows the same way the ribbons run", () => {
    const rows = [{ depth: 0.9 }, { depth: 0.1 }, { depth: 0.5 }];
    expect(byDepth(rows).map((r) => r.depth)).toEqual([0.1, 0.5, 0.9]);
  });
});
