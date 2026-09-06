import { describe, expect, it } from "vitest";
import { availableIn, inspectDeposit } from "../../src/features/deposit/model/inspect";
import { DEPOSIT_VERSION } from "../../src/features/deposit/model/manifest";

/**
 * READING A STRANGER'S FILE.
 *
 * Every refusal here is a sentence the receiver will actually see, and every acceptance is a manifest
 * whose optional fields were defaulted rather than trusted. The rule that matters most: NEWER IS
 * REFUSED, OLDER IS ACCEPTED — a deposit from a later Sard may carry meaning this build cannot see,
 * and taking it would silently discard that; an older one is safe, because absence is how every
 * optional field spells its default.
 */
const HASH = "a".repeat(64);
const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    deposit: DEPOSIT_VERSION,
    created_at: 1756800000,
    app: { name: "Sard", version: "1.2.2" },
    sender: { name: "S" },
    book: { hash: HASH, format: "epub", title: "T", spine_count: 20 },
    inscription: { text: "hello", signed: "S" },
    marks: {
      highlights: [
        { cfi: "epubcfi(/6/4!/4,/1:0,/1:3)", section: "/6/4", section_index: 1, color: "sky", text: "x" },
      ],
      notes: [{ cfi: "epubcfi(/6/4!/4)", section_index: 1, body: "n", of_highlight: 0 }],
      references: [{ phrase: "klein", phrase_fold: "klein", word_count: 1, note: "g" }],
      replacements: [{ phrase: "a", phrase_fold: "a", word_count: 1, replacement: "b" }],
    },
    ...over,
  });

const ok = (text: string) => {
  const r = inspectDeposit(text);
  if (!r.ok) throw new Error(`expected an accepted deposit, got ${r.refusal.code}`);
  return r.manifest;
};
const refusal = (text: string) => {
  const r = inspectDeposit(text);
  if (r.ok) throw new Error("expected a refusal");
  return r.refusal;
};

describe("inspecting a deposit", () => {
  it("reads a whole deposit and counts its layers", () => {
    const m = ok(good());
    expect(m.book.hash).toBe(HASH);
    expect(availableIn(m)).toEqual({ highlights: 1, notes: 1, references: 1, replacements: 1 });
    expect(m.inscription.text).toBe("hello");
  });

  it("refuses a file that does not claim to be a deposit — as foreign, not as newer", () => {
    expect(refusal(JSON.stringify({ hello: 1 })).code).toBe("dep.err.notSard");
    expect(refusal("{").code).toBe("dep.err.unreadable");
    expect(refusal(JSON.stringify([1, 2])).code).toBe("dep.err.unreadable");
  });

  it("refuses a deposit from a later Sard, and accepts one from an earlier", () => {
    const newer = refusal(good({ deposit: DEPOSIT_VERSION + 1 }));
    expect(newer.code).toBe("dep.err.newer");
    // An older one is safe by construction: this build reads what it knows and defaults the rest.
    const older = ok(good({ deposit: 1, marks: {} }));
    expect(availableIn(older)).toEqual({ highlights: 0, notes: 0, references: 0, replacements: 0 });
  });

  it("refuses a book identity that is not a real content hash", () => {
    expect(refusal(good({ book: { hash: "short" } })).code).toBe("dep.err.badBook");
    expect(refusal(good({ book: {} })).code).toBe("dep.err.badBook");
    expect(refusal(good({ book: { hash: `${"z".repeat(64)}` } })).code).toBe("dep.err.badBook");
  });

  it("refuses a member name that climbs out of its folder", () => {
    expect(refusal(good({ book: { hash: HASH, file: "book/../../escape.epub" } })).code).toBe("dep.err.badMember");
    expect(refusal(good({ book: { hash: HASH, cover: "/etc/passwd" } })).code).toBe("dep.err.badMember");
    expect(refusal(good({ book: { hash: HASH, file: "elsewhere.epub" } })).code).toBe("dep.err.badMember");
  });

  it("refuses a manifest larger than the ceiling, before parsing it", () => {
    const r = refusal("x".repeat(1024 * 1024 + 1));
    expect(r.code).toBe("dep.err.tooLarge");
  });

  it("keeps a sectionless mark rather than dropping it", () => {
    const m = ok(
      good({
        marks: {
          highlights: [{ cfi: "epubcfi(/6/8)", section: "/6/8", section_index: null, text: "loose" }],
          notes: [],
          references: [],
          replacements: [],
        },
      }),
    );
    expect(m.marks.highlights[0].section_index).toBeNull();
    expect(m.marks.highlights[0].cfi).toBe("epubcfi(/6/8)");
  });

  it("carries a reference's and a replacement's place through, so his map is not blank", () => {
    // MEASURED, THEN FIXED. The reader rebuilds every row field by field, and these two were missing
    // the two fields the map is drawn from: the sender's own sheet showed all four kinds at their
    // chapters and the receiver's showed highlights and notes only.
    const m = ok(
      good({
        marks: {
          highlights: [],
          notes: [],
          references: [{ phrase: "term", phrase_fold: "term", word_count: 1, note: "n", section: "/6/1986", section_index: 992 }],
          replacements: [{ phrase: "from", phrase_fold: "from", word_count: 1, replacement: "to", section: "/6/1490", section_index: 744 }],
        },
      }),
    );
    expect(m.marks.references[0].section_index).toBe(992);
    expect(m.marks.references[0].section).toBe("/6/1986");
    expect(m.marks.replacements[0].section_index).toBe(744);
    expect(m.marks.replacements[0].section).toBe("/6/1490");
  });

  it("leaves a rule from a copy written before the place travelled unplaced", () => {
    const m = ok(
      good({
        marks: {
          highlights: [],
          notes: [],
          references: [{ phrase: "term", phrase_fold: "term", word_count: 1, note: "n" }],
          replacements: [{ phrase: "from", phrase_fold: "from", word_count: 1, replacement: "to" }],
        },
      }),
    );
    expect(m.marks.references[0].section_index).toBeNull();
    expect(m.marks.replacements[0].section_index).toBeNull();
  });

  it("drops a note's link when it points at no highlight", () => {
    const m = ok(
      good({
        marks: { highlights: [], notes: [{ body: "n", of_highlight: 7 }], references: [], replacements: [] },
      }),
    );
    expect(m.marks.notes[0].of_highlight).toBeNull();
  });

  it("survives a manifest whose fields are all the wrong type", () => {
    const m = ok(
      JSON.stringify({
        deposit: 1,
        book: { hash: HASH, title: 42, spine_count: "many" },
        marks: { highlights: [{ cfi: 5, color: null }], notes: "no", references: 3, replacements: null },
        inscription: "not an object",
        sender: 9,
      }),
    );
    expect(m.book.title).toBeNull();
    expect(m.book.spine_count).toBeNull();
    expect(m.marks.highlights[0].cfi).toBe("");
    expect(m.marks.highlights[0].color).toBe("amber"); // a slot is always a slot
    expect(m.marks.notes).toEqual([]);
    expect(m.inscription).toEqual({ text: "", signed: "" });
  });

  it("drops a reference or replacement with no phrase — there is nothing to key it on", () => {
    const m = ok(
      good({
        marks: {
          highlights: [],
          notes: [],
          references: [{ phrase: "", note: "x" }, { phrase: "k", phrase_fold: "k", note: "y" }],
          replacements: [{ replacement: "only" }],
        },
      }),
    );
    expect(m.marks.references).toHaveLength(1);
    expect(m.marks.replacements).toHaveLength(0);
  });
});
