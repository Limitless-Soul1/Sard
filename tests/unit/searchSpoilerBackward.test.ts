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

import { backwardSections, sectionIndexOfCfi } from "../../src/reader-engine/FoliateController";
import { advanceFurthest, resetFurthest, type FurthestMark } from "../../src/features/reader/furthestRead";
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

  it("is taken when a direction was chosen, and it starts where the reader STANDS", () => {
    // ONE boundary, and it is the caller's live position. Not the furthest-read point: that is a
    // reading-progress fact with a control of its own, and the engine no longer holds such a thing.
    expect(src).toContain("const boundary = opts.positionCfi && opts.positionCfi.length > 0 ? opts.positionCfi : null;");
    expect(src).toContain("const from = opts.backward ? boundary : null;");
    expect(src).toContain("if (from && compare) {");
    expect(src).toContain("const end = sectionIndexOfCfi(from, n);");
  });

  it("the engine keeps NO furthest-read boundary of its own — there is nothing to re-point", () => {
    // The strongest form of the independence: a boundary the engine cannot hold cannot be confused
    // with the reader's position, and no later edit can quietly reintroduce the conflation.
    expect(code(controller)).not.toMatch(/furthestCfi|setFurthestBoundary|furthestPosition/);
  });

  it("counts down, and asks the engine for ONE section at a time", () => {
    // The itinerary comes from the pure function, so what the walk visits is testable on its own.
    expect(src).toContain("for (const i of backwardSections(from, n)) {");
    // `index` is what makes foliate scan a single section (view.js `#searchSection`).
    expect(src).toMatch(/view\.search\(\{ query: term, draw: drawNothing, sardWholeWords: !!opts\.wholeWord, index: i \}\)/);
  });

  it("keeps nothing past where the reader stands, in ANY section it walks", () => {
    // Total, not only in the section the walk began in: `end` is an estimate off the position's CFI,
    // and an estimate that came out too high would otherwise pass a whole section of unread text.
    expect(src).toContain("if (compare(one.cfi, from) > 0) continue;");
    expect(src).not.toContain("if (i === end && compare(");
  });

  it("marks nothing as ahead, because nothing ahead was opened", () => {
    const walk = src.slice(src.indexOf("if (from && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("ahead: false,");
    expect(walk).not.toMatch(/ahead: .*compare\(/);
  });

  it("de-duplicates on the same set the forward scan uses", () => {
    const walk = src.slice(src.indexOf("if (from && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("if (seen.has(one.cfi)) continue;");
    expect(walk).toContain("seen.add(one.cfi);");
  });

  it("still expands the query, so replacements and whole-word are unchanged", () => {
    expect(src).toContain("const terms = expandQuery(q, this.reps, foldPhrase);");
    const walk = src.slice(src.indexOf("if (from && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("for (const term of terms) {");
    expect(walk).toContain("sardWholeWords: !!opts.wholeWord");
  });

  it("one unreadable section does not end the walk", () => {
    const walk = src.slice(src.indexOf("if (from && compare) {"), src.lastIndexOf("for (const term of terms) {"));
    expect(walk).toContain("} catch { /* one section that will not parse must not end the walk */ }");
  });

  it("and the forward scan is still there, for when the seal is off", () => {
    // The unsealed path must remain the scan it always was: whole book, `ahead` computed per match.
    expect(src).toMatch(/for \(const term of terms\) \{\s*\n\s*for await \(const r of view\.search\(\{ query: term, draw: drawNothing, sardWholeWords: !!opts\.wholeWord \}\)\)/);
    expect(src).toContain("ahead: boundary && compare ? compare(s.cfi, boundary) > 0 : false,");
  });
});

describe("direction is the reader's, and it is not the furthest-read control", () => {
  const src = code(reader);

  it("the search is handed the reader's CURRENT position, for the seal and the direction alike", () => {
    expect(src).toContain("positionCfi: cfi,");
    expect(src).toContain("backward: searchBackward,");
    // Never the furthest point: that belongs to the control that offers the way back to it.
    expect(src).not.toMatch(/positionCfi:.*furthest/i);
    expect(src).toContain("}, [searchQuery, searchWholeWord, searchBackward]);");
  });

  it("nothing pushes a furthest boundary into the engine any more", () => {
    expect(src).not.toContain("setFurthestBoundary");
  });

  it("«Furthest you've read» is untouched — still its own control, still its own job", () => {
    // It shows how deep this reader has been and offers the way back; it decides nothing about search.
    // It also names its OWN destination now: `furthestLabel`, not the seal's `positionLabel`.
    expect(code(panel)).toContain("<FurthestReturn label={furthestLabel} onGo={onGoFurthest} onReset={onResetFurthest} />");
    expect(code(panel)).toContain("{behindFurthest && furthestLabel && onGoFurthest && (");
  });

  it("turning the direction on or off does not write the furthest mark, and vice versa", () => {
    const dir = src.slice(src.indexOf("const onToggleBackward"), src.indexOf("const onToggleSpoiler"));
    expect(dir).toContain("search_backward:");
    expect(dir).not.toMatch(/furthest/i);
    expect(dir).not.toContain("setFurthestBoundary");
  });

  it("changing the direction drops a «show them anyway», exactly as the spoiler switch does", () => {
    // Backward finds nothing ahead, so a reveal answered for a forward search has nothing to reveal —
    // and left standing it would swap the count line for the wording that speaks of a total.
    const dir = src.slice(src.indexOf("const onToggleBackward"), src.indexOf("const onToggleSpoiler"));
    expect(dir).toContain("setRevealAhead(false);");
    // The seal's own switch has always done this; the two must not disagree.
    const spoil = src.slice(src.indexOf("const onToggleSpoiler"), src.indexOf("const onToggleSpoiler") + 400);
    expect(spoil).toContain("setRevealAhead(false);");
  });

  it("it is a per-book answer, loaded and restored like the two switches beside it", () => {
    expect(src).toContain("settingsGet(`search_backward:${target.id}`)");
    expect(src).toContain('setSearchBackward(backwardRaw === "1");');
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

describe("the direction control itself", () => {
  it("is the panel's third switch, in the shape the other two already have", () => {
    // Not a new visual pattern for a two-way choice the panel can already express.
    expect(code(panel)).toContain('<button className="sp-spoiler sp-opt" onClick={onToggleBackward} aria-pressed={backward}>');
    expect(code(panel)).toContain('<span className={`rp-switch${backward ? " on" : ""}`} aria-hidden><span className="rp-knob" /></span>');
  });

  it("names itself in both languages, and says where a backward search starts", () => {
    expect(en["search.backward"]).toBe("Search backward");
    expect(en["search.backwardSub"]).toBe("From where you are, back to the beginning");
    for (const k of ["search.backward", "search.backwardSub"] as const) {
      expect(ar[k], k).toBeTruthy();
      expect(ar[k], k).not.toBe(en[k]);
    }
    // The sub-line must promise the POSITION, not the furthest mark.
    expect(en["search.backwardSub"]).not.toMatch(/furthest/i);
  });

  it("reading backward, the seal offers no «show them anyway» — there is nothing found to un-hide", () => {
    expect(code(panel)).toContain("{!backward && (");
  });
});

describe("what must NOT have moved", () => {
  it("the whole-word switch still reaches the engine the same way", () => {
    expect(code(controller)).toContain("sardWholeWords: !!opts.wholeWord");
    expect(code(reader)).toContain("wholeWord: searchWholeWord,");
  });

  it("the search work put nothing of its own in the selection toolbar", () => {
    // This guard was written while a Copy action there was a separate, later task, and it read
    // "the reading toolbar is untouched". That task has since landed, so the claim is narrowed to what
    // it was always protecting: no SEARCH concern leaked into that row. Copy's own behaviour is
    // covered by tests/unit/readerCopyButton.test.ts.
    const toolbar = read("src/features/reader/AnnotationLayer.tsx");
    expect(toolbar).not.toMatch(/search\.copy|searchBackward|spoilerSafe|backwardFrom|positionCfi/);
  });
});

// THE FURTHEST-READ MARK IS NOT SEARCH STATE, AND NOTHING IN SEARCH MAY WRITE IT.
//
// Verified in the running reader before these were written: with the mark left in a late chapter and
// the reader standing in an earlier one, the control stayed exactly as it was — same label, same named
// chapter, same aria — across turning the direction on, turning it off, changing the query, and
// searching in both directions, and clicking it still returned the reader to the mark. These tests
// hold that shape in place, because the runtime evidence expires and the wiring does not.
describe("search cannot alter or remove the furthest-read state", () => {
  const src = code(reader);
  /** Every place the mark is written, by the three paths that are allowed to: reset, restore, advance. */
  const writers = [...src.matchAll(/^.*(?:furthestRef\.current = |setFurthestUi\(|furthest_read:).*$/gm)].map((m) => m[0]);

  it("the mark is written from the reading path only — never from a search handler", () => {
    expect(writers.length).toBeGreaterThan(0);
    for (const line of writers) {
      expect(line).not.toMatch(/search|backward|spoiler|reveal|query|hit/i);
    }
  });

  it("no search handler calls the engine's boundary setter", () => {
    // `setFurthestBoundary` is told the mark by the reading path. A search must never re-point it.
    const searchHandlers = [
      src.slice(src.indexOf("const onToggleBackward"), src.indexOf("const onToggleSpoiler")),
      src.slice(src.indexOf("const onToggleSpoiler"), src.indexOf("const onToggleSpoiler") + 600),
      src.slice(src.indexOf("const onToggleWholeWord"), src.indexOf("const onToggleWholeWord") + 400),
      src.slice(src.indexOf("const onJumpHit"), src.indexOf("const onJumpHit") + 500),
    ];
    for (const h of searchHandlers) {
      expect(h).not.toContain("setFurthestBoundary");
      expect(h).not.toContain("furthest_read:");
      expect(h).not.toContain("setFurthestUi");
    }
  });

  it("the direction and the mark are stored under different keys, and neither is inside the other", () => {
    expect(src).toContain("`search_backward:${target.id}`");
    expect(src).toContain("`furthest_read:${target.id}`");
    // The mark's serialised shape is position data only — no search setting rides along in it.
    // Identifiers, not prose: this module's comments discuss paging backward, which is the point of it.
    const furthest = code(read("src/features/reader/furthestRead.ts"));
    expect(furthest).not.toMatch(/searchBackward|backwardFrom|spoilerSafe|wholeWord/);
  });

  it("whether the way back is OFFERED cannot come to depend on the direction", () => {
    // The gate is the furthest-read condition and nothing else: a `searchBackward` term creeping in
    // here is what "enabling Search backward hides it" would look like. (`behindFurthest` is the
    // reader-is-behind-the-mark fact and has nothing to do with the direction switch.)
    const gate = "{behindFurthest && furthestLabel && onGoFurthest && (";
    expect(code(panel)).toContain(gate);
    expect(gate).not.toMatch(/searchBackward|spoiler/);
    // And the control itself knows nothing about searching. Identifiers again: it reads the READING
    // direction to choose its arrow, which is its own business.
    const ret = read("src/features/reader/FurthestReturn.tsx");
    expect(ret).not.toMatch(/searchBackward|backwardFrom|spoilerSafe|searchQuery/);
  });

  it("its wording is its own — the direction strings never reach it", () => {
    expect(en["toc.furthest"]).toBe("Furthest you've read");
    expect(en["toc.furthestAria"]).toBe("Return to the furthest point you have read in this book");
    expect(ar["toc.furthest"]).toBeTruthy();
    expect(en["search.backward"]).not.toMatch(/furthest/i);
    expect(ar["search.backward"]).not.toMatch(/أبعد/); // «أبعد» belongs to the mark's own label
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE OWNER'S CASE, PINNED: reached chapter 891, currently reading chapter 500.
//
// The two facts are deliberately far apart, so a boundary taken from the wrong one is not a near-miss
// but a 391-chapter spoiler. Spoiler-safe is bounded by the CURRENT position; the furthest-read mark is
// reading progress and the way back to it, and the search path takes it as no input anywhere — which is
// why this can be asserted against a real function rather than against a comment.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("furthest 891, reading 500 — the boundary is 500", () => {
  const SECTIONS = 1000;
  const reading500 = cfiForSection(499); // chapter 500, zero-based
  const furthest891 = cfiForSection(890); // chapter 891, zero-based
  const mark891: FurthestMark = { cfi: furthest891, fraction: 0.891, label: "Chapter 891", href: "c891.xhtml", sec: 890 };
  const here500: FurthestMark = { cfi: reading500, fraction: 0.5, label: "Chapter 500", href: "c500.xhtml", sec: 499 };

  it("the two are different places — the premise of the whole distinction", () => {
    expect(sectionIndexOfCfi(reading500, SECTIONS)).toBe(499);
    expect(sectionIndexOfCfi(furthest891, SECTIONS)).toBe(890);
  });

  it("a backward search reaches chapter 500 and every chapter before it", () => {
    const visited = backwardSections(reading500, SECTIONS);
    expect(visited[0]).toBe(499); // the reader's own chapter, first
    expect(visited[visited.length - 1]).toBe(0); // and on down to the first
    expect(visited).toHaveLength(500);
  });

  it("it CANNOT reach chapters 501–891", () => {
    const visited = new Set(backwardSections(reading500, SECTIONS));
    for (let chapter = 501; chapter <= 891; chapter++) expect(visited.has(chapter - 1)).toBe(false);
    expect(Math.max(...visited)).toBe(499);
  });

  it("the itinerary takes no furthest-read input, so chapter 891 cannot influence it", () => {
    // There is nowhere to pass a mark: the signature is (fromCfi, sections) and nothing else. An edit
    // that wanted to consult the mark here would have to change this, which is the point of asserting it.
    expect(backwardSections.length).toBe(2);
  });

  it("standing AT 891 it would walk 891 back to 1 — the boundary follows the reader", () => {
    const visited = backwardSections(furthest891, SECTIONS);
    expect(visited[0]).toBe(890);
    expect(visited).toHaveLength(891);
  });

  it("furthest-read remains 891: reading back at 500 cannot lower it", () => {
    expect(advanceFurthest(mark891, here500, -1)).toBeNull();
  });

  it("changing the mark cannot silently become the search boundary", () => {
    // Belt and braces on top of the signature: the engine holds no such field, the application pushes
    // none, and the seal reads the position it is handed.
    expect(code(controller)).not.toMatch(/furthestCfi|setFurthestBoundary/);
    expect(code(reader)).not.toContain("setFurthestBoundary");
    expect(code(controller)).toContain("const boundary = opts.positionCfi && opts.positionCfi.length > 0 ? opts.positionCfi : null;");
  });

  it("the seal names the reader's own position, and has no second wording to switch to", () => {
    expect(code(panel)).toContain('{t("search.spoilerSub", { pos: positionLabel })}');
    expect(code(panel)).not.toMatch(/furthestHere/);
    expect((en as Record<string, string>)["search.furthestHere"]).toBeUndefined();
    expect((ar as Record<string, string>)["search.furthestHere"]).toBeUndefined();
    expect(en["search.spoilerSub"]).toMatch(/your position/i);
    // And the Reader hands it the CURRENT chapter's name, keeping the mark's name separate.
    expect(code(reader)).toContain("positionLabel={searchPositionLabel}");
    expect(code(reader)).toContain("furthestLabel={furthestLabel}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RESET — the mark comes back to the reader, and nothing else moves.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("resetting the furthest-read mark", () => {
  const mark891: FurthestMark = { cfi: cfiForSection(890), fraction: 0.891, label: "Chapter 891", href: "c891.xhtml", sec: 890 };
  const here500: FurthestMark = { cfi: cfiForSection(499), fraction: 0.5, label: "Chapter 500", href: "c500.xhtml", sec: 499 };
  const handler = (() => {
    const src = code(reader);
    return src.slice(src.indexOf("const resetFurthestToHere"), src.indexOf("const resetFurthestToHere") + 500);
  })();

  it("takes the current position even though it is EARLIER than the mark held", () => {
    expect(resetFurthest(here500)).toEqual(here500);
    // The ordinary path refuses exactly this, which is why reset is an operation of its own.
    expect(advanceFurthest(mark891, here500, -1)).toBeNull();
  });

  it("is safe when the reader is already AT the furthest point — it stores what is already stored", () => {
    expect(resetFurthest(mark891)).toEqual(mark891);
  });

  it("writes nothing when there is no position to stand on", () => {
    expect(resetFurthest({ ...here500, cfi: "" })).toBeNull();
  });

  it("the handler writes the mark — and does not move the reader", () => {
    expect(handler).toContain("resetFurthest(posRef.current)");
    expect(handler).toContain("setFurthestUi(next)");
    expect(handler).toContain("furthest_read:");
    // No navigation, no panel dismissal, and NOT the reading position a resume depends on.
    expect(handler).not.toContain("goToLocator");
    expect(handler).not.toContain("goToSection");
    expect(handler).not.toContain("setLeftPanel");
    expect(handler).not.toContain("progressSave");
  });

  it("the handler changes nothing about searching", () => {
    expect(handler).not.toMatch(/searchBackward|spoilerSafe|setSearchQuery|setRevealAhead|searchBook|positionCfi/);
  });

  it("so no future chapter can become searchable by resetting", () => {
    // The seal and the walk read the live position only, and reset does not touch it. Both halves are
    // asserted above; this names the conclusion, so a regression fails under its own description.
    expect(code(controller)).toContain("const from = opts.backward ? boundary : null;");
    expect(handler).not.toContain("positionCfi");
  });

  it("both panels offer it, so the one control cannot drift between them", () => {
    expect(code(panel)).toContain("onReset={onResetFurthest}");
    expect(code(read("src/features/reader/ChaptersPanel.tsx"))).toContain("onReset={onResetFurthest}");
    expect(code(reader)).toContain("onResetFurthest={resetFurthestToHere}");
  });

  it("it is a separate action BESIDE the mark, not a nested button and not a rename", () => {
    const ret = read("src/features/reader/FurthestReturn.tsx");
    expect(ret).toContain('<div className="rp-furthest-row">');
    expect(ret).toContain('className="rp-furthest-reset"');
    expect(read("src/styles/global.css")).toContain(".rp-furthest-row {");
    // The mark keeps its own name; Reset did not replace it with "Current position".
    expect(en["toc.furthest"]).toBe("Furthest you've read");
    expect(en["toc.furthest"]).not.toMatch(/current position/i);
  });

  it("Reset is worded in both languages", () => {
    expect(en["toc.furthestReset"]).toBe("Reset");
    expect(ar["toc.furthestReset"]).toBeTruthy();
    expect(en["toc.furthestResetAria"]).toMatch(/where you are now/i);
    expect(ar["toc.furthestResetAria"]).toBeTruthy();
    // It says it does not move the reader, because that is the question it will be asked.
    expect(en["toc.furthestResetAria"]).toMatch(/without moving you/i);
  });
});
