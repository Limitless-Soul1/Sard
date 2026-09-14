import { describe, expect, it } from "vitest";
import { between, dropChangesNothing, first, rankForDrop, spread } from "../../src/features/library/design/rank";

/** The alphabet the keys are written in, so a test can read a key apart without exporting internals. */
const DIGIT_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The ordering keys are the foundation the whole arrangement rests on, so they are tested for the
 * things that actually break ordering schemes in the field rather than for the happy path:
 * repeated insertion into one gap, insertion at both ends, long sequences, and the promise that a
 * key written today still sorts correctly against one written after ten thousand more moves.
 */
describe("ordering keys", () => {
  const sorted = (xs: string[]) => [...xs].sort();

  it("puts a first book somewhere sensible", () => {
    const r = first();
    expect(r.length).toBeGreaterThan(0);
    // an integer key: a marker saying how many digits follow, then the digits
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(between(r, null) > r).toBe(true);
    expect(between(null, r) < r).toBe(true);
  });

  it("always lands strictly between its bounds", () => {
    const a = between(null, null);
    const b = between(a, null);
    expect(b > a).toBe(true);
    const mid = between(a, b);
    expect(mid > a && mid < b).toBe(true);
  });

  it("refuses bounds that are not in order", () => {
    const [lo, hi] = spread(2);
    expect(() => between(hi, lo)).toThrow(RangeError);
    expect(() => between(lo, lo)).toThrow(RangeError);
  });

  it("refuses text that is not a key at all", () => {
    // Ranks are opaque: nothing outside this module may invent one.
    expect(() => between("banana", null)).toThrow(RangeError);
    expect(() => between(null, "!")).toThrow(RangeError);
  });

  it("gives every value exactly one spelling", () => {
    // Two spellings of one value would break the promise that equal order means equal text.
    //
    // The integer digits MAY end in zero — the marker fixes how many of them there are, so «510000»
    // can only be read one way. It is the FRACTION that must never end in zero, because there the
    // digits run until the string does and a trailing zero would be a second way to write the same
    // value. This is the rule the pure-fraction design needed applied to the whole key; with an
    // integer part it applies to the tail alone.
    const fractionOf = (r: string) => r.slice(1 + DIGIT_ALPHABET.indexOf(r[0]));
    let lo: string | null = null;
    for (let i = 0; i < 400; i++) {
      const r: string = between(lo, null);
      expect(fractionOf(r).endsWith("0")).toBe(false);
      lo = r;
    }
    let squeeze: string = between(null, null);
    const ceiling = between(squeeze, null);
    for (let i = 0; i < 400; i++) {
      squeeze = between(squeeze, ceiling);
      expect(fractionOf(squeeze).endsWith("0")).toBe(false);
    }
  });

  it("is deterministic — the same bounds always give the same key", () => {
    const [lo, hi] = spread(2);
    expect(between(lo, hi)).toBe(between(lo, hi));
    expect(between(null, lo)).toBe(between(null, lo));
    expect(between(hi, null)).toBe(between(hi, null));
    // and squeezing the same gap twice without writing gives the same answer twice
    const once = between(lo, hi);
    expect(between(lo, once)).toBe(between(lo, once));
  });

  // ── the case that kills float-based schemes ─────────────────────────────────────────────
  it("survives ten thousand insertions into the SAME gap", () => {
    const lo = between(null, null);
    const hi = between(lo, null);
    let upper = hi;
    const made: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const r = between(lo, upper);
      expect(r > lo).toBe(true);
      expect(r < upper).toBe(true);
      made.push(r);
      upper = r; // squeeze into the same gap again, the worst case there is
    }
    // every key distinct, and the run is strictly descending as it was built
    expect(new Set(made).size).toBe(made.length);
    for (let i = 1; i < made.length; i++) expect(made[i] < made[i - 1]).toBe(true);
    // THE COST IS LENGTH, AND IT IS GRADUAL RATHER THAN FATAL. Each squeeze halves what is left of
    // one interval, and a base-62 digit carries just under six bits, so the fraction grows by about
    // one character per six insertions — measured at 2,006 characters for ten thousand of them. The
    // bound below is loose on purpose: what it must catch is a regression to growth per insertion,
    // which would land at ten thousand. A float would not reach here at all — fifty-three bits of
    // mantissa are spent after about fifty bisections and then demand a renumber.
    expect(made[made.length - 1].length).toBeLessThan(10_000 / 4);
    expect(made[0].length).toBeLessThan(12);
  });

  it("keeps prepended keys short too", () => {
    let head = between(null, null);
    for (let i = 0; i < 10_000; i++) head = between(null, head);
    expect(head.length).toBeLessThan(12);
  });

  it("survives ten thousand insertions at the very beginning", () => {
    let head = between(null, null);
    const all = [head];
    for (let i = 0; i < 10_000; i++) {
      head = between(null, head);
      all.unshift(head);
    }
    expect(sorted(all)).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
  });

  it("survives ten thousand insertions at the very end", () => {
    let tail = between(null, null);
    const all = [tail];
    for (let i = 0; i < 10_000; i++) {
      tail = between(tail, null);
      all.push(tail);
    }
    expect(sorted(all)).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
    // APPENDING IS THE COMMON CASE AND MUST STAY SHORT. Ten thousand appends move a whole
    // number; they must not lengthen the key the way bisecting toward one did.
    expect(tail.length).toBeLessThan(12);
  });

  it("keeps a long container in order however it was built", () => {
    // 2000 books inserted at random places, then read back by sorting the keys alone.
    let rng = 12345;
    const rand = (n: number) => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) % n);
    const run: { id: string; rank: string }[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = run.length ? rand(run.length + 1) : 0;
      const lower = at > 0 ? run[at - 1].rank : null;
      const upper = at < run.length ? run[at].rank : null;
      run.splice(at, 0, { id: "b" + i, rank: between(lower, upper) });
    }
    const byRank = [...run].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    expect(byRank.map((x) => x.id)).toEqual(run.map((x) => x.id));
    expect(new Set(run.map((x) => x.rank)).size).toBe(run.length);
  });

  it("spreads a whole container evenly and in order", () => {
    const rs = spread(50);
    expect(rs.length).toBe(50);
    expect(sorted(rs)).toEqual(rs);
    expect(new Set(rs).size).toBe(50);
  });

  it("sorts the same way in JavaScript and in SQLite's byte order", () => {
    // Every digit is ASCII, so a byte-wise comparison and a JS string comparison cannot disagree.
    const rs = spread(200);
    const byBytes = [...rs].sort((a, b) => {
      const ba = Buffer.from(a, "ascii"), bb = Buffer.from(b, "ascii");
      return Buffer.compare(ba, bb);
    });
    expect(byBytes).toEqual(rs);
  });
});

describe("where a book lands when it is dropped", () => {
  const build = (n: number) => spread(n).map((rank, i) => ({ id: "b" + i, rank }));

  it("moves a book forward to exactly where the hand let go", () => {
    // 1 2 3 4 5 · take 5, drop it in front of 2 → 1 5 2 3 4
    const run = build(5);
    const r = rankForDrop(run, "b4", "b1");
    const after = [...run.filter((x) => x.id !== "b4"), { id: "b4", rank: r }]
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .map((x) => x.id);
    expect(after).toEqual(["b0", "b4", "b1", "b2", "b3"]);
  });

  it("moves a book backward to exactly where the hand let go", () => {
    // 1 2 3 4 5 · take 1, drop it in front of 4 → 2 3 1 4 5
    const run = build(5);
    const r = rankForDrop(run, "b0", "b3");
    const after = [...run.filter((x) => x.id !== "b0"), { id: "b0", rank: r }]
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .map((x) => x.id);
    expect(after).toEqual(["b1", "b2", "b0", "b3", "b4"]);
  });

  it("takes a book to the front and to the end", () => {
    const run = build(5);
    const toFront = rankForDrop(run, "b3", "b0");
    expect(toFront < run[0].rank).toBe(true);
    const toEnd = rankForDrop(run, "b1", null);
    expect(toEnd > run[4].rank).toBe(true);
  });

  it("puts the only book of an empty container in place", () => {
    const r = rankForDrop([], "b0", null);
    expect(r.length).toBeGreaterThan(0);
  });

  it("treats a vanished target as the end rather than failing", () => {
    // A list drawn before the last change can name a book that has since moved away.
    const run = build(3);
    const r = rankForDrop(run, "b0", "gone");
    expect(r > run[2].rank).toBe(true);
  });

  it("reaches every gap of a container", () => {
    const run = build(6);
    const targets: (string | null)[] = [...run.map((x) => x.id), null];
    const landed = new Set<string>();
    for (const before of targets) {
      const mover = "b2";
      const r = rankForDrop(run, mover, before);
      const seq = [...run.filter((x) => x.id !== mover), { id: mover, rank: r }]
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((x) => x.id)
        .join(",");
      landed.add(seq);
    }
    // Every gap gives a distinct arrangement except the two that mean «leave it alone».
    expect(landed.size).toBe(targets.length - 1);
  });
});

describe("a release that changes nothing", () => {
  const run = spread(4).map((rank, i) => ({ id: "b" + i, rank }));

  it("knows a book dropped in front of itself has not moved", () => {
    expect(dropChangesNothing(run, "b1", "S", "S", "b1")).toBe(true);
  });

  it("knows a book dropped in front of the book that already follows it has not moved", () => {
    expect(dropChangesNothing(run, "b1", "S", "S", "b2")).toBe(true);
  });

  it("knows the last book dropped at the end has not moved", () => {
    expect(dropChangesNothing(run, "b3", "S", "S", null)).toBe(true);
  });

  it("does not mistake a real move for one", () => {
    expect(dropChangesNothing(run, "b3", "S", "S", "b0")).toBe(false);
    expect(dropChangesNothing(run, "b0", "S", "S", null)).toBe(false);
    expect(dropChangesNothing(run, "b1", "S", "S", "b3")).toBe(false);
  });

  it("never calls a move to another container a no-op", () => {
    expect(dropChangesNothing(run, "b1", "OTHER", "S", "b2")).toBe(false);
    expect(dropChangesNothing(run, "b1", "OTHER", "S", null)).toBe(false);
  });
});
