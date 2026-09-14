// RESILIENCE-1 (NAV-3, corrected) — COVER ≠ TOC ≠ CHAPTER 1.
//
// THE REPORTED DEFECT. A book whose spine begins with its own readable table of contents showed
// "Chapter 1" in the chrome and highlighted Chapter 1 in the Contents panel while the reader was
// plainly looking at the contents page. MEASURED in the running application on that page (199 list
// items, no prose): spine section 0 of 200, foliate's `tocItem` null, caption "Chapter 1", active
// contents row 0. Jumping to the real Chapter 1 moved the spine section from 0 to 1 and changed
// neither of them.
//
// THE CAUSE was a rule that looked FORWARD — "the reader is before the first entry that follows this
// section, so that entry is the one they are heading toward". Every other rule in the reader looks
// backward: foliate's `TOCProgress` inherits from the PRECEDING section (progress.js:29-33), and
// RAWY-287 resolves to "the last entry at or before your position, otherwise none". Because the
// forward rule published `chapterHref`, and RAWY-287 matches that first, it overrode RAWY-287 for
// exactly the sections RAWY-287 exists to answer honestly.
//
// WHAT THESE TESTS PIN is the replacement rule, and above all the invariant behind it: a position
// before the book's first contents entry is NEVER named after the entry that follows it. It is named
// after its own document, or not at all.
//
// NOT TESTED HERE: `sectionHeading`, which reads a Document. This runner is `node` by deliberate
// policy (see vitest.config.ts — "a test that passes in a fake DOM and lies about WebView2" is worth
// less than no test), so that half is verified against the real engine at runtime instead.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { frontMatterName } from "../../src/reader-engine/FoliateController";

/** The reproduction's shape: the contents document at spine 0, the first listed entry at spine 1. */
const FIRST_LISTED = 1;

describe("a position before the book's first contents entry", () => {
  it("is named after its OWN document, not after the chapter that follows it", () => {
    // The whole defect in one assertion: on the contents page, the answer is the contents page.
    expect(frontMatterName(0, FIRST_LISTED, () => "المحتويات")).toBe("المحتويات");
  });

  it("has NO name when its document carries no heading — nothing is invented to fill the gap", () => {
    // A cover is usually one full-page image. The chrome then shows its neutral caption; what it must
    // never do is borrow a name from elsewhere in the book.
    expect(frontMatterName(0, FIRST_LISTED, () => "")).toBeNull();
  });

  it("gives three different answers for a cover, a title page and a contents page", () => {
    // COVER ≠ TOC ≠ CHAPTER 1, as the three distinct answers the rule returns for three documents
    // that all precede the first contents entry — and none of them is the entry at spine 3.
    const cover = frontMatterName(0, 3, () => "");
    const title = frontMatterName(1, 3, () => "The Title of the Book");
    const contents = frontMatterName(2, 3, () => "Contents");
    expect(cover).toBeNull();
    expect(title).toBe("The Title of the Book");
    expect(contents).toBe("Contents");
    expect(new Set([title, contents]).size).toBe(2);
  });

  it("applies to EVERY section of a leading unlisted run, not merely the first", () => {
    for (const i of [0, 1, 2, 3]) {
      expect(frontMatterName(i, 4, () => "Front matter " + i)).toBe("Front matter " + i);
    }
  });

  it("passes the heading through verbatim — shaping it belongs to `sectionHeading`, not here", () => {
    // One definition of what a section is called. If this rule trimmed as well, a heading could be
    // shaped differently depending on which of the two callers asked for it.
    expect(frontMatterName(0, 1, () => " Contents ")).toBe(" Contents ");
  });
});

describe("everywhere else, foliate's own answer stands untouched", () => {
  it("declines the section the first contents entry itself points at", () => {
    expect(frontMatterName(1, FIRST_LISTED, () => "Chapter One")).toBeNull();
  });

  it("declines every later section", () => {
    for (const i of [2, 7, 199]) expect(frontMatterName(i, FIRST_LISTED, () => "x")).toBeNull();
  });

  it("declines a book whose contents begin at its very first section", () => {
    // The common case — no front matter at all. The rule must be inert for it.
    expect(frontMatterName(0, 0, () => "Chapter One")).toBeNull();
  });

  it("declines a book whose contents point nowhere, leaving it to the synthesised contents", () => {
    // `null` = no entry resolved to any spine section. Such a book is `getSynthesisedToc`'s to name,
    // and a second naming path here would give it two answers that could disagree.
    expect(frontMatterName(0, null, () => "Anything At All")).toBeNull();
  });

  it("does not even READ the document when the answer cannot depend on it", () => {
    // The thunk exists for this. `relocate` fires on every page turn, and for a book whose contents
    // point nowhere the answer is null without touching the DOM at all.
    const heading = vi.fn(() => "Chapter One");
    expect(frontMatterName(5, FIRST_LISTED, heading)).toBeNull();
    expect(frontMatterName(0, null, heading)).toBeNull();
    expect(heading).not.toHaveBeenCalled();
  });
});

describe("no rule anywhere may name a position after a LATER entry", () => {
  // DELIBERATELY A SOURCE-LEVEL GUARD. The rule this replaces was a PRIVATE method, so no behavioural
  // assertion could observe it: a test of the new rule alone would pass just as happily with the old
  // one still wired in beside it — which is the shape of the original defect, two rules for one
  // question. What must not come back is the QUESTION, and only the source can say it is not asked.
  const SOURCE = readFileSync("src/reader-engine/FoliateController.ts", "utf8");

  it("no longer carries the helper that answered 'which entry comes after this section?'", () => {
    // Both directions, so the guard cannot pass by reading the wrong file or an empty one.
    expect(SOURCE).toContain("frontMatterName"); // the rule that replaced it is live in this source
    expect(SOURCE).not.toContain("firstTocEntryAfterSection");
  });

  it("keeps ONE definition of what a section is called", () => {
    // `sectionHeading` is shared by the front-matter name and by the synthesised contents. If a second
    // heading-selection rule is ever written, the two can disagree about the same document — so what is
    // pinned is that only one of them exists and that the synthesiser goes through it.
    const matches = SOURCE.match(/querySelector\("h1,h2,h3,h4,h5,h6"\)/g) ?? [];
    expect(matches.length).toBe(1); // exactly one, inside `sectionHeading`
    expect(SOURCE).toContain("material.push({ heading: sectionHeading(doc) })");
  });

  it("gives front matter a NAME but never a contents row", () => {
    // The href is what makes something a contents entry. A front-matter name must reach `chapterLabel`
    // and must never reach `chapterHref`, or RAWY-287 would match it and highlight a row for a page
    // that is inside none of them.
    expect(SOURCE).toContain("?? frontMatter,");
    // The PUBLISH site, not the interface declaration a plain search finds first.
    const hrefLine = SOURCE.split("\n").find((l) => l.includes("chapterHref:") && l.includes("??")) ?? "";
    expect(hrefLine).toContain("?? null");
    expect(hrefLine).not.toContain("frontMatter");
  });

  it("resolves the active contents row by looking at or BEFORE the reader, never after", () => {
    // RAWY-287's rule, in the Reader. Asserted in BOTH directions, because a guard that only forbids
    // something passes just as well when the thing it was guarding has been deleted.
    const READER = readFileSync("src/features/reader/Reader.tsx", "utf8");
    expect(READER).toContain("sec <= curSec"); // the nearest-preceding rule is still there
    expect(READER).not.toContain("sec > curSec"); // and no forward rule sits beside it
  });
});
