import { describe, expect, it } from "vitest";
import {
  DEPOSIT_VERSION,
  buildManifest,
  emptySelection,
  isSendable,
  manifestText,
  markCount,
} from "../../src/features/deposit/model/manifest";
import type { DepositPlan } from "../../src/lib/ipc";

/**
 * THE MANIFEST IS THE WHOLE OF WHAT LEAVES.
 *
 * These tests are the sender's privacy contract written as assertions: what is carried, what is
 * deliberately absent, and the two places where a relationship has to survive without an identifier.
 */
const plan = (over: Partial<DepositPlan> = {}): DepositPlan => ({
  book: {
    hash: "a".repeat(64),
    format: "epub",
    title: "T",
    author: "A",
    language: "ar",
    dir: "rtl",
    size_bytes: 4096,
  },
  spine_count: 20,
  book_bytes: 4096,
  cover_bytes: 512,
  book_source: "C:/managed/aaa.epub",
  cover_source: "C:/managed/covers/aaa.jpg",
  book_member: "book/" + "a".repeat(64) + ".epub",
  cover_member: "cover/cover.jpg",
  sections: [
    { kind: "highlight", id: "h1", section: "/6/4", section_index: 1 },
    { kind: "highlight", id: "h2", section: "/6/8", section_index: 3 },
    { kind: "note", id: "n1", section: "/6/8", section_index: 3 },
  ],
  counts: { highlights: 2, notes: 1, references: 1, replacements: 1 },
  ...over,
});

const rows = {
  highlights: [
    { id: "h1", book_id: "b", cfi: "epubcfi(/6/4!/4,/1:0,/1:9)", color: "amber", text_excerpt: "one", chapter_label: "I", created_at: 10, alpha: 0.4 },
    { id: "h2", book_id: "b", cfi: "epubcfi(/6/8!/4,/1:0,/1:9)", color: "sky", text_excerpt: "two", chapter_label: "II", created_at: 11, alpha: null },
  ] as never[],
  notes: [
    { id: "n1", book_id: "b", highlight_id: "h1", cfi: "epubcfi(/6/8!/4)", color: "rose", body: "a thought", chapter_label: "II", created_at: 12, updated_at: 13, title: "T", tags: ["شخصيات"] },
  ] as never[],
  references: [
    { id: "r1", book_id: "b", phrase: "كلاين", phrase_fold: "كلاين", word_count: 1, note: "gloss", created_at: 1, updated_at: 2 },
  ] as never[],
  replacements: [
    { id: "p1", book_id: "b", phrase: "مورتون", phrase_fold: "مورتون", replacement: "مورتِن", word_count: 1, enabled: true, created_at: 1, updated_at: 2 },
  ] as never[],
};

const all = () => ({
  highlights: new Set(["h1", "h2"]),
  notes: new Set(["n1"]),
  references: new Set(["r1"]),
  replacements: new Set(["p1"]),
});

const build = (selection = all(), over: Partial<Parameters<typeof buildManifest>[0]> = {}) =>
  buildManifest({
    plan: plan(),
    highlights: rows.highlights,
    notes: rows.notes,
    references: rows.references,
    replacements: rows.replacements,
    selection,
    inscription: { text: "قرأته في شتاء طويل", signed: "مؤمن" },
    includeBook: true,
    appVersion: "1.2.2",
    now: 1756800000,
    ...over,
  });

describe("the deposit manifest", () => {
  it("carries only what the sender bound", () => {
    const m = build({ ...all(), highlights: new Set(["h1"]) });
    expect(m.marks.highlights).toHaveLength(1);
    expect(m.marks.highlights[0].text).toBe("one");
    expect(markCount(m)).toBe(4);
  });

  it("binds nothing when nothing is selected, and an inscription alone is still sendable", () => {
    const m = build(emptySelection());
    expect(markCount(m)).toBe(0);
    expect(isSendable(m)).toBe(true); // the letter is the point of the feature
    const silent = build(emptySelection(), { inscription: { text: "  ", signed: "م" } });
    expect(isSendable(silent)).toBe(false);
  });

  it("carries no local ids — the receiver recomputes every one of them", () => {
    const text = manifestText(build());
    for (const id of ["h1", "h2", "n1", "r1", "p1"]) {
      expect(text.includes(`"${id}"`), `${id} leaked into the manifest`).toBe(false);
    }
  });

  it("keeps a note's link to its highlight as an INDEX, not an identifier", () => {
    const m = build();
    expect(m.marks.notes[0].of_highlight).toBe(0); // h1 is the first highlight emitted
    expect(m.marks.highlights[0].cfi).toContain("/6/4");
  });

  it("drops the link when the highlight itself was not bound", () => {
    const m = build({ ...all(), highlights: new Set(["h2"]) });
    expect(m.marks.notes[0].of_highlight).toBeNull();
  });

  it("carries the SEMANTIC colour slot, so the receiver's theme paints it", () => {
    const m = build();
    expect(m.marks.highlights.map((h) => h.color)).toEqual(["amber", "sky"]);
  });

  it("does not carry a replacement's enabled flag — an imported one arrives switched off", () => {
    const text = manifestText(build());
    expect(text.includes('"enabled"')).toBe(false);
  });

  it("does not carry tags, progress, bookmarks or a highlight's local ink", () => {
    // A forbidden KEY, not a forbidden substring: "replacements" contains the letters of "placement",
    // and an assertion that cannot tell those apart would fail on a manifest that is perfectly correct.
    const text = manifestText(build());
    for (const key of ["tags", "fraction", "locator_cfi", "bookmarks", "alpha", "placements", "enabled"]) {
      expect(text.includes(`"${key}"`), `${key} leaked into the manifest`).toBe(false);
    }
  });

  it("carries the section a mark falls in, and tolerates one that has none", () => {
    const p = plan({ sections: [{ kind: "highlight", id: "h1", section: null, section_index: null }] });
    const m = buildManifest({
      plan: p,
      highlights: rows.highlights,
      notes: [],
      references: [],
      replacements: [],
      selection: { ...emptySelection(), highlights: new Set(["h1"]) },
      inscription: { text: "", signed: "م" },
      includeBook: true,
      appVersion: "1.2.2",
      now: 1,
    });
    expect(m.marks.highlights[0].section_index).toBeNull();
  });

  it("names the book file only when the book travels, and the cover ALWAYS", () => {
    // The cover was once carried only when the book was not, on the reasoning that a deposit holding
    // the book already holds its cover. True of the bytes, useless to the reader: the receiver is the
    // one person who has never seen this book, and his sheet had no face to show. It now travels in
    // both kinds of deposit.
    expect(build().book.file).toContain("book/");
    expect(build().book.cover).toBe("cover/cover.jpg");
    const without = build(all(), { includeBook: false });
    expect(without.book.file).toBeUndefined();
    expect(without.book.cover).toBe("cover/cover.jpg");
  });

  it("declares its version and stays legible when unzipped", () => {
    const m = build();
    expect(m.deposit).toBe(DEPOSIT_VERSION);
    const text = manifestText(m);
    expect(text.split("\n").length).toBeGreaterThan(10); // indented, not a single line of soup
    expect(JSON.parse(text).book.hash).toBe("a".repeat(64));
  });
});
