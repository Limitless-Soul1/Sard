// RESILIENCE-1 / WP-6A — spine navigation, pinned to the two MEASURED books.
//
// THE RULE: a section's own heading if it has one, otherwise a NUMBER. Sard never invents a title
// from a section's text — a label taken from an opening sentence is indistinguishable, to a reader,
// from a chapter name the author wrote, and no such name exists in these files.
//
// Both flagged books are covered by construction, using the shapes measured through foliate's own
// `createDocument()`:
//
//   word-generated--a4.epub            196 linear sections · 195 with a heading · 1 without
//   word-generated--unknown-title.epub 116 linear sections ·   0 with a heading
//
// What these tests mostly guard is a NEGATIVE: that nothing here ever reads a section's text.

import { describe, expect, it } from "vitest";
import { synthesiseToc, type SectionHeading } from "../../src/reader-engine/tocSynth";

const idx = (n: number) => Array.from({ length: n }, (_, i) => i);

/** `a4` as measured: 195 headings ("Chapter-<n> 0"), and section 0 with none. */
const a4: SectionHeading[] = [
  { heading: "" },
  ...Array.from({ length: 195 }, (_, i) => ({ heading: `Chapter-${734 + i} 0` })),
];

/** `unknown-title` as measured: 116 sections, not one heading among them. */
const unknownTitle: SectionHeading[] = Array.from({ length: 116 }, () => ({ heading: "" }));

describe("WP-6A — word-generated--a4.epub", () => {
  const out = synthesiseToc(a4, idx(a4.length));

  it("gives every section a row — 196, where the book offered 1", () => {
    expect(out.entries.length).toBe(196);
  });

  it("uses the book's OWN headings, however poor they look", () => {
    // "Chapter-734 0" is a converter artefact, but it is what the book says. Substituting something
    // that reads better would be Sard inventing metadata, which is the thing this rule forbids.
    expect(out.titled).toBe(195);
    expect(out.entries[1].label).toBe("Chapter-734 0");
  });

  it("numbers the one section that has no heading, rather than naming it", () => {
    expect(out.entries[0].label).toBeNull();
    expect(out.entries[0].ordinal).toBe(1);
  });
});

describe("WP-6A — word-generated--unknown-title.epub", () => {
  const out = synthesiseToc(unknownTitle, idx(unknownTitle.length));

  it("numbers all 116 sections consecutively", () => {
    expect(out.entries.length).toBe(116);
    expect(out.titled).toBe(0);
    expect(out.entries.every((e) => e.label === null)).toBe(true);
    expect(out.entries[0].ordinal).toBe(1);
    expect(out.entries[115].ordinal).toBe(116);
  });

  it("keeps EVERY section, including the empty ones", () => {
    // 9 of these sections have no text at all. They are still real spine sections, and omitting them
    // would make the numbering lie about where the reader is going.
    expect(out.entries.length).toBe(unknownTitle.length);
  });
});

describe("WP-6A — the rule itself", () => {
  it("prefers a real heading over a number", () => {
    const out = synthesiseToc([{ heading: "Down the Rabbit-Hole" }, { heading: "" }], [0, 1]);
    expect(out.entries[0].label).toBe("Down the Rabbit-Hole");
    expect(out.entries[1].label).toBeNull();
  });

  it("collapses whitespace in a heading but never rewrites it", () => {
    const out = synthesiseToc([{ heading: "  A  ragged\n heading " }], [0]);
    expect(out.entries[0].label).toBe("A ragged heading");
  });

  it("treats a whitespace-only heading as absent", () => {
    expect(synthesiseToc([{ heading: "   \n " }], [0]).entries[0].label).toBeNull();
  });

  it("numbers by LINEAR position, so the count matches what the reader scrolls past", () => {
    const out = synthesiseToc([{ heading: "" }, { heading: "" }, { heading: "" }], [4, 7, 9]);
    expect(out.entries.map((e) => e.ordinal)).toEqual([1, 2, 3]);
    // …while still navigating to the real spine positions.
    expect(out.entries.map((e) => e.index)).toEqual([4, 7, 9]);
  });

  it("takes ONLY a heading — there is no way to pass it text", () => {
    // The structural guarantee. `SectionHeading` has one field, so no future edit can quietly
    // reintroduce a title derived from a section's prose without changing this type first.
    const probe: SectionHeading = { heading: "x" };
    expect(Object.keys(probe)).toEqual(["heading"]);
  });

  it("handles an empty book without inventing anything", () => {
    const out = synthesiseToc([], []);
    expect(out.entries).toEqual([]);
    expect(out.titled).toBe(0);
  });
});
