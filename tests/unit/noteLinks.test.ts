// A LINK INSIDE A NOTE, AND WHAT IT MEANS.
//
// Measured against real book data before this was written: every link a note contains is a
// BACKLINK, in every book examined, and not one note anywhere references another note. So the
// case that had to be right was never the nested note; it was the arrow that says "return to the
// text".
//
// Following that arrow would be actively wrong. It points at the very reference the reader tapped,
// which is on screen behind the panel: the book would navigate to where it already is, and the return
// pill would arm for a journey nobody took.
//
// Two ways to know one, and no book-specific handling in either. A standards-compliant book says so
// outright, with `epub:type="backlink"` or `role="doc-backlink"`. A book that declares nothing is
// caught by what is true of a backlink regardless — it resolves into the document the reader is
// reading, its backlink being a bare `←1`.
//
// WHAT THIS TESTS. `resolveNoteLink` is arithmetic on three strings, so it is tested as such, against
// synthetic fixtures in the two layouts real books use: a flat split-file one, and a nested one. It
// cannot prove the panel wires it up correctly — the running application does that — but it is the
// one part of this feature with a right answer that a browser is not needed to check.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "src", "reader-engine", "FoliateController.ts");

/**
 * The method's own body, evaluated.
 *
 * `FoliateController.ts` cannot be imported here: the suite runs on Node with no DOM, and the module
 * reaches for `customElements` and a `<foliate-view>` at load. The body is extracted from the source
 * instead, so what runs below is the shipping text of the method and not a copy of it — if the method
 * changes and this stops matching, the extraction fails loudly rather than testing something stale.
 */
function loadResolver(): (hit: Hit, rawHref: string, declared: boolean) => { href: string; back: boolean } {
  const src = readFileSync(SRC, "utf8");
  const start = src.indexOf("  resolveNoteLink(hit: FootnoteHit, rawHref: string, declaredBacklink: boolean)");
  if (start < 0) throw new Error("resolveNoteLink is no longer declared as this test expects");
  // The LAST brace on the signature line, not the first: the return type is itself an object literal,
  // so `indexOf("{")` finds `{ href: string; back: boolean }` and reads the annotation as the body.
  const eol = src.indexOf("\n", start);
  const open = src.lastIndexOf("{", eol);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("could not read the body of resolveNoteLink");
  // The body carries no type annotations of its own, so it is already plain JavaScript.
  return new Function("hit", "rawHref", "declaredBacklink", src.slice(open + 1, end)) as never;
}

interface Hit { href: string; sourcePath: string }
const resolveNoteLink = loadResolver();

/** A FLAT, SPLIT-FILE layout: notes in their own document, backlinks undeclared and bare `←N`. */
const SPLIT: Hit = { href: "part_0037.html#note_1", sourcePath: "part_0005.html" };
/** A NESTED layout: declared endnotes gathered in one file, each ending in a marked backlink. */
const NESTED: Hit = { href: "book/text/endnotes.xhtml#note-1", sourcePath: "book/text/chapter-4.xhtml" };

describe("a link inside a note", () => {
  it("recognises an undeclared backlink by where it leads", () => {
    // The first note's own backlink. Nothing marks it; it is a backlink because it resolves into the
    // very document the reader is reading.
    const r = resolveNoteLink(SPLIT, "part_0005.html#back_note_1", false);
    expect(r.back).toBe(true);
  });

  it("recognises a declared backlink even before resolving it", () => {
    const r = resolveNoteLink(NESTED, "chapter-4.xhtml#noteref-1", true);
    expect(r.back).toBe(true);
  });

  it("recognises a declared backlink whose target is elsewhere", () => {
    // A book may split its text differently from where the note was written. The declaration is
    // believed on its own, without the path agreeing.
    const r = resolveNoteLink({ href: "notes.xhtml#n1", sourcePath: "ch3.xhtml" }, "ch9.xhtml#ref-1", true);
    expect(r.back).toBe(true);
  });

  it("resolves an undeclared backlink relative to the NOTE, not to the reader's section", () => {
    // The href was written in the notes file, so it is that file's neighbours it names. Resolving it
    // against the section the reader is in would land somewhere the book never mentioned.
    const r = resolveNoteLink(NESTED, "chapter-4.xhtml#noteref-1", false);
    expect(r.href).toBe("book/text/chapter-4.xhtml#noteref-1");
    expect(r.back).toBe(true);
  });

  it("treats a genuine cross-reference as real navigation", () => {
    // A note that points at some OTHER part of the book is not a return. It is followed for real,
    // which is what arms the return pill.
    const r = resolveNoteLink(SPLIT, "part_0060.html#appendix", false);
    expect(r.back).toBe(false);
    expect(r.href).toBe("part_0060.html#appendix");
  });

  it("does not mistake a link within the notes file itself for a return", () => {
    // `#note_2` resolves to the notes document, which is not where the reader is.
    const r = resolveNoteLink(SPLIT, "#note_2", false);
    expect(r.back).toBe(false);
  });

  it("resolves a relative step out of the notes folder", () => {
    const hit: Hit = { href: "OEBPS/notes/endnotes.xhtml#n5", sourcePath: "OEBPS/text/ch2.xhtml" };
    const r = resolveNoteLink(hit, "../text/ch2.xhtml#r5", false);
    expect(r.href).toBe("OEBPS/text/ch2.xhtml#r5");
    expect(r.back).toBe(true);
  });

  it("decodes a percent-encoded path so it can match the section it names", () => {
    const hit: Hit = { href: "notes.xhtml#n1", sourcePath: "text/chapter one.xhtml" };
    const r = resolveNoteLink(hit, "text/chapter%20one.xhtml#ref", false);
    expect(r.back).toBe(true);
  });

  it("is not fooled into a return by an href it cannot parse", () => {
    const r = resolveNoteLink(SPLIT, "", false);
    expect(r.back).toBe(false);
  });

  it("leaves an external link alone and does not call it a return", () => {
    const r = resolveNoteLink(SPLIT, "https://example.invalid/x", false);
    expect(r.back).toBe(false);
  });

  it("cannot claim a return when the reader's section is unknown", () => {
    // `sourcePath` is empty when the engine could not name the section the reference came from.
    // Guessing would dismiss a note the reader asked to follow, so the link is followed instead.
    const r = resolveNoteLink({ href: "notes.xhtml#n1", sourcePath: "" }, "notes.xhtml#n1", false);
    expect(r.back).toBe(false);
  });
});
