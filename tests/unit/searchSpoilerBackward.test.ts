// SPOILER-SAFE SEARCH — IT WALKS BACKWARD, AND IT NEVER COUNTS WHAT IT DID NOT READ.
//
// ## What changed, and why it is not merely a filter
//
// Search used to scan the whole book forward and then TAG each match `ahead` if it lay beyond the
// reader. The panel sealed those, but the scan had already opened every section after them and the
// summary had already counted them — and a total beside a to-here count is a subtraction:
//
//     "14 matches · 4 up to your position"   ->   ten ahead, told plainly
//
// So sealed searching is now a different walk, not a different display: the boundary's own section
// first, then the one before it, down to the first. The sections ahead are never handed to the
// engine, so nothing about them is learned and there is no number to leak by any route — including
// the one the old sealed card printed on its face.
//
// ## What these cover
//
// The walk itself needs a book, a renderer and a parsed spine, so its STRUCTURE is pinned against the
// controller's source; the arithmetic that decides where the walk begins is a real function and is
// exercised as one. The promise that no count survives is checked in the strings and in the panel.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sectionIndexOfCfi } from "../../src/reader-engine/FoliateController";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const controller = read("src/reader-engine/FoliateController.ts");
const panel = read("src/features/reader/SearchPanel.tsx");
const reader = read("src/features/reader/Reader.tsx");
/** Source with comment lines stripped — the prose names the old shapes on purpose. */
const code = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

/** A CFI naming spine child `2*(i+1)` — the shape foliate produces for section `i`. */
const cfiForSection = (i: number, tail = "!/4/2/1:0") => `epubcfi(/6/${2 * (i + 1)}${tail})`;

describe("where the walk begins — the boundary's own section", () => {
  it("reads the spine step out of a real CFI", () => {
    expect(sectionIndexOfCfi(cfiForSection(0), 1000)).toBe(0);
    expect(sectionIndexOfCfi(cfiForSection(1), 1000)).toBe(1);
    expect(sectionIndexOfCfi(cfiForSection(499), 1000)).toBe(499);
    expect(sectionIndexOfCfi(cfiForSection(890), 1000)).toBe(890);
  });

  it("never lets an unreadable boundary become section zero", () => {
    // THE FAILURE THIS FORBIDS: falling back to 0 would search ONE chapter and call it the book
    // behind the reader — a silent, total loss of results that looks like "no matches".
    // It answers the LAST section, so the walk still covers the book — and every match is compared
    // against the boundary anyway, so starting too far forward can only cost work, never spoil.
    for (const bad of ["", "   ", "not a cfi", "epubcfi(", "epubcfi(/)", "epubcfi(/6)", "epubcfi(/6/0)"]) {
      expect(sectionIndexOfCfi(bad, 1000), bad).toBe(999);
    }
  });

  it("is clamped to the book it is given", () => {
    expect(sectionIndexOfCfi(cfiForSection(5000), 10)).toBe(9);
    expect(sectionIndexOfCfi(cfiForSection(3), 1)).toBe(0);
    expect(sectionIndexOfCfi(cfiForSection(3), 0)).toBe(0);
  });

  it("the walk that follows it is the boundary's section down to the first, once each", () => {
    // The order the loop produces, stated as the loop states it.
    const end = sectionIndexOfCfi(cfiForSection(499), 1000);
    const order: number[] = [];
    for (let i = end; i >= 0; i--) order.push(i);
    expect(order[0]).toBe(499);
    expect(order[1]).toBe(498);
    expect(order[2]).toBe(497);
    expect(order[order.length - 1]).toBe(0);
    expect(order.length).toBe(500);
    expect(new Set(order).size).toBe(order.length);   // once each: no section can answer twice
    expect(Math.max(...order)).toBe(499);             // and nothing after the reader is ever visited
  });
});

describe("the walk in the controller", () => {
  const src = code(controller);

  it("is taken only when the seal is on and there is a boundary to walk back from", () => {
    expect(src).toContain("if (opts.spoilerSafe && boundary && compare) {");
    expect(src).toContain("const end = sectionIndexOfCfi(boundary, n);");
  });

  it("counts down, and asks the engine for ONE section at a time", () => {
    expect(src).toContain("for (let i = end; i >= 0; i--) {");
    // `index` is what makes foliate scan a single section (view.js `#searchSection`).
    expect(src).toMatch(/view\.search\(\{ query: term, draw: drawNothing, sardWholeWords: !!opts\.wholeWord, index: i \}\)/);
  });

  it("keeps nothing past the boundary, in ANY section it walks", () => {
    // Total, not only in the section the walk began in: `end` is an estimate off the boundary's CFI,
    // and an estimate that came out too high would otherwise pass a whole section of unread text.
    expect(src).toContain("if (compare(one.cfi, boundary) > 0) continue;");
    expect(src).not.toContain("if (i === end && compare(one.cfi, boundary) > 0)");
  });

  it("marks nothing as ahead, because nothing ahead was opened", () => {
    const walk = src.slice(src.indexOf("if (opts.spoilerSafe && boundary && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("ahead: false,");
    expect(walk).not.toMatch(/ahead: .*compare\(/);
  });

  it("de-duplicates on the same set the forward scan uses", () => {
    const walk = src.slice(src.indexOf("if (opts.spoilerSafe && boundary && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("if (seen.has(one.cfi)) continue;");
    expect(walk).toContain("seen.add(one.cfi);");
  });

  it("still expands the query, so replacements and whole-word are unchanged", () => {
    expect(src).toContain("const terms = expandQuery(q, this.reps, foldPhrase);");
    const walk = src.slice(src.indexOf("if (opts.spoilerSafe && boundary && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("for (const term of terms) {");
    expect(walk).toContain("sardWholeWords: !!opts.wholeWord");
  });

  it("one unreadable section does not end the walk", () => {
    const walk = src.slice(src.indexOf("if (opts.spoilerSafe && boundary && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("} catch { /* one section that will not parse must not end the walk */ }");
  });

  it("and the forward scan is still there, for when the seal is off", () => {
    // The unsealed path must remain the scan it always was: whole book, `ahead` computed per match.
    expect(src).toMatch(/for \(const term of terms\) \{\s*\n\s*for await \(const r of view\.search\(\{ query: term, draw: drawNothing, sardWholeWords: !!opts\.wholeWord \}\)\)/);
    expect(src).toContain("ahead: boundary && compare ? compare(s.cfi, boundary) > 0 : false,");
  });
});

describe("the reader hands the seal to the search, not only to the panel", () => {
  const src = code(reader);

  it("passes it, and lets «show them anyway» re-run the scan unsealed", () => {
    expect(src).toContain("spoilerSafe: spoilerSafe && !revealAhead,");
    expect(src).toContain("}, [searchQuery, searchWholeWord, spoilerSafe, revealAhead]);");
  });
});

describe("no count of what lies ahead survives, anywhere", () => {
  it("the sealed summary carries ONE number, and it is the one the reader has reached", () => {
    expect(en["search.countUpTo"]).toBe("{n} matches up to your position");
    // The total must not appear beside it: total minus to-here IS the hidden count.
    expect(en["search.countUpTo"]).not.toContain("{m}");
    expect(ar["search.countUpTo"]).not.toContain("{m}");
    expect(code(panel)).toContain('t("search.countUpTo", { n: localeNum(upTo.length, lang) })');
  });

  it("the sealed card names no number, in either language", () => {
    expect(en["search.hidden"]).toBe("Matches ahead are hidden");
    for (const s of [en["search.hidden"], ar["search.hidden"]]) {
      expect(s).not.toMatch(/\{n\}|\{m\}|\d/);
    }
    // and the call site passes nothing for it to interpolate
    expect(code(panel)).toContain('{t("search.hidden")}');
    expect(code(panel)).not.toMatch(/t\("search\.hidden",/);
  });

  it("the promise beneath it is unchanged", () => {
    expect(en["search.hiddenBody"]).toBe("Sard won’t show you text you haven’t reached yet.");
    expect(ar["search.hiddenBody"]).toBeTruthy();
  });

  it("the unsealed summary is exactly what it was", () => {
    expect(en["search.count"]).toBe("{n} matches · {m} up to your position");
    expect(en["search.countAll"]).toBe("{n} matches · all shown");
    expect(code(panel)).toContain('t("search.countAll", { n: localeNum(hits.length, lang) })');
  });

  it("nothing in the sealed path can be derived into a hidden total", () => {
    // The whole-book total is `hits.length`. Sealed, it may not be rendered at all — and sealed,
    // `hits` holds only what lies behind the reader, so even that would not be a book total.
    const sealedLine = code(panel).slice(code(panel).indexOf("const upTo ="), code(panel).indexOf("</aside>"));
    const rendered = [...sealedLine.matchAll(/t\("search\.count[A-Za-z]*",[^)]*\)/g)].map((m) => m[0]);
    for (const call of rendered) {
      if (call.includes("countUpTo")) expect(call).toContain("upTo.length");
      else expect(call).toContain("hits.length"); // only ever on the revealed branch
    }
    expect(rendered.some((c) => c.includes("countUpTo"))).toBe(true);
  });
});

describe("what must NOT have moved", () => {
  it("the whole-word switch still reaches the engine the same way", () => {
    expect(code(controller)).toContain("sardWholeWords: !!opts.wholeWord");
    expect(code(reader)).toContain("wholeWord: searchWholeWord,");
  });

  it("the reading toolbar is untouched by this work", () => {
    // A Copy action in the reading toolbar is a separate, later task; nothing here may anticipate it.
    const toolbar = read("src/features/reader/AnnotationLayer.tsx");
    expect(toolbar).not.toMatch(/hl-pop-copy|onCopySelection|search\.copy/);
  });
});
