// THE SHARED TAG FILTER IN THE IN-READER ANNOTATIONS SIDEBAR.
//
// The filter is a SECOND GLOBAL control, beside the book-scope one, and it applies to every annotation
// kind that actually carries tags — notes and highlights, and only those. A highlight's tags are the
// tags on the note attached to it (RAWY-205's empty-body anchor note exists so a body-less highlight
// can be tagged at all), so both kinds arrive here as the same shape and go through the same functions.
//
// The panel is React and Sard's unit runner has no DOM by design, so what is pinned here is the part
// that decides WHICH annotations a filter shows — extracted into `noteTags.ts` precisely so it can be
// tested without rendering anything. The sidebar's appearance and wiring are verified in the harness.

import { describe, expect, it } from "vitest";
import { filterByTag, tagFilterStillValid } from "../../src/features/reader/noteTags";

/** A note. Only `tags` matters to the filter; the id makes a result identifiable. */
const note = (id: string, ...tags: string[]) => ({ id, kind: "note" as const, tags });
/** A highlight. Structurally identical here, which is the point — one filter serves both. */
const hl = (id: string, ...tags: string[]) => ({ id, kind: "highlight" as const, tags });

const IMPORTANT = "مهم";
const CHARACTERS = "شخصيات";
const QUOTE = "اقتباس";

describe("tag OPTIONS and filter RESULTS are separate concerns", () => {
  // THE BUG THIS REPLACES. The option list was derived from the annotations in view, so a tag that
  // existed on another book was simply absent from the menu and could never be chosen. Options now
  // come from the `tags` table (`tagsList`) and are not computed here at all — which is the point:
  // there is no function in this module that could re-couple them to scope.
  it("a tag with nothing in scope still filters — to an empty list, which is a real answer", () => {
    const inScope = [note("A", IMPORTANT), note("B", CHARACTERS)];
    // «اقتباس» exists in the library but nothing here carries it.
    expect(filterByTag(inScope, QUOTE)).toEqual([]);
  });

  it("and the same tag matches once the scope contains it — the filter never had to change", () => {
    const otherBook = [note("C", QUOTE), hl("D", QUOTE)];
    expect(filterByTag(otherBook, QUOTE).map((x) => x.id)).toEqual(["C", "D"]);
  });

  it("validity is judged against the LIBRARY's tags, never against what is in view", () => {
    // A tag that exists but matches nothing in this book must stay selected: clearing it would be the
    // control undoing the reader's choice the moment they looked at a book without that tag.
    const libraryTags = [IMPORTANT, CHARACTERS, QUOTE];
    expect(tagFilterStillValid(QUOTE, libraryTags)).toBe(true);
    // Only an actually-deleted tag is stale.
    expect(tagFilterStillValid("حُذف", libraryTags)).toBe(false);
  });

  it("this module exposes no way to derive options from the rows", async () => {
    // A structural guard: if someone re-adds a `tagNamesOf`/`tagNamesAcross` helper, the coupling this
    // bug came from is available again, and this test is where that decision gets noticed.
    const mod = await import("../../src/features/reader/noteTags");
    expect(Object.keys(mod).sort()).toEqual(["filterByTag", "tagFilterStillValid"]);
  });
});

// The worked example from the request, as a test: two notes and two highlights, one tag each.
describe("the requested behaviour, exactly", () => {
  const notes = [note("Note A", IMPORTANT), note("Note B", CHARACTERS)];
  const hls = [hl("Highlight C", IMPORTANT), hl("Highlight D", QUOTE)];

  it("selecting «مهم» shows Note A and Highlight C, and hides Note B and Highlight D", () => {
    expect(filterByTag(notes, IMPORTANT).map((n) => n.id)).toEqual(["Note A"]);
    expect(filterByTag(hls, IMPORTANT).map((h) => h.id)).toEqual(["Highlight C"]);
    expect(filterByTag(notes, IMPORTANT).map((n) => n.id)).not.toContain("Note B");
    expect(filterByTag(hls, IMPORTANT).map((h) => h.id)).not.toContain("Highlight D");
  });

  it("the SAME function serves both kinds — there is one filter, not two", () => {
    // If notes and highlights were ever filtered by separate code paths they could disagree; this
    // asserts they cannot, by filtering both through one call each with identical semantics.
    const together = [...filterByTag(notes, IMPORTANT), ...filterByTag(hls, IMPORTANT)].map((x) => x.id);
    expect(together).toEqual(["Note A", "Highlight C"]);
  });
});

describe("what the filter shows", () => {
  const notes = [note("untagged"), note("one", IMPORTANT), note("both", IMPORTANT, CHARACTERS)];
  const hls = [hl("h-untagged"), hl("h-quote", QUOTE), hl("h-both", IMPORTANT, QUOTE)];

  it("no tag selected leaves both lists completely unchanged", () => {
    expect(filterByTag(notes, null).map((n) => n.id)).toEqual(["untagged", "one", "both"]);
    expect(filterByTag(hls, null).map((h) => h.id)).toEqual(["h-untagged", "h-quote", "h-both"]);
  });

  it("an annotation with several tags appears under EACH of them", () => {
    expect(filterByTag(notes, IMPORTANT).map((n) => n.id)).toContain("both");
    expect(filterByTag(notes, CHARACTERS).map((n) => n.id)).toContain("both");
    expect(filterByTag(hls, IMPORTANT).map((h) => h.id)).toContain("h-both");
    expect(filterByTag(hls, QUOTE).map((h) => h.id)).toContain("h-both");
  });

  it("untagged annotations of BOTH kinds are hidden while a tag is active", () => {
    expect(filterByTag(notes, IMPORTANT).map((n) => n.id)).not.toContain("untagged");
    expect(filterByTag(hls, QUOTE).map((h) => h.id)).not.toContain("h-untagged");
  });

  it("and both return when the filter is cleared", () => {
    expect(filterByTag(notes, null).map((n) => n.id)).toContain("untagged");
    expect(filterByTag(hls, null).map((h) => h.id)).toContain("h-untagged");
  });

  it("a tag nothing carries yields an empty list rather than everything", () => {
    // The dangerous failure is a filter that silently stops filtering.
    expect(filterByTag(notes, "لا أحد")).toEqual([]);
  });

  it("never mutates the list it was given, and keeps its order", () => {
    const before = [...notes];
    expect(filterByTag(notes, IMPORTANT).map((n) => n.id)).toEqual(["one", "both"]);
    expect(notes).toEqual(before);
  });
});

describe("when a chosen tag stops being valid", () => {
  // The list handed to this is the LIBRARY's tags, so it answers one question only: does this tag
  // still exist? Scope has nothing to do with it — a tag with no annotations in the current book is
  // still a perfectly good choice, and the empty list is the answer to it.
  it("a tag that still exists stays chosen, whatever the current book holds", () => {
    expect(tagFilterStillValid(IMPORTANT, [IMPORTANT, QUOTE])).toBe(true);
    expect(tagFilterStillValid(QUOTE, [IMPORTANT, QUOTE])).toBe(true);
  });

  it("only a DELETED tag is stale — then there is no chip left to clear it with", () => {
    expect(tagFilterStillValid("حُذف", [IMPORTANT, QUOTE])).toBe(false);
  });

  it("«all tags» is always valid, including in a library with no tags at all", () => {
    expect(tagFilterStillValid(null, [])).toBe(true);
    expect(tagFilterStillValid(null, [IMPORTANT])).toBe(true);
  });
});

describe("annotations that predate tags", () => {
  it("an empty tag list behaves exactly as it always did — no migration, no null checks", () => {
    const legacy = [note("old"), hl("older")];
    expect(filterByTag(legacy, null).map((x) => x.id)).toEqual(["old", "older"]);
    // and they are simply not matched by any tag, rather than erroring on an absent field
    expect(filterByTag(legacy, IMPORTANT)).toEqual([]);
  });
});
