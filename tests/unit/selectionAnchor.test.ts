// RAWY-FM2 — the selection toolbar is tied to the SELECTION, not to the viewport it was raised in.
//
// THE REPORTED DEFECT. Selecting text raises the toolbar above it, correctly. Scrolling then moved the
// text and left the toolbar behind. MEASURED on a long section, wheeling down and back up: the selected
// text's top ran 222 → 22 → −178 → −578 → 222 with the scroll while the toolbar's bottom stayed at 212
// throughout, so a gap that should have been a constant −10 px reached +790 px.
//
// THE CAUSE was that `SelectionInfo.rect` was computed once, at `pointerup`, and never again — the
// toolbar is `position: fixed` and that rect is in viewport coordinates, so the two agree exactly at
// the moment of selection and diverge from the first scroll onward. The engine now recomputes the rect
// from the selection's own (cloned, still-live) range whenever the reader moves.
//
// WHICH SIGNAL took two attempts. The first measurement found no scroll event and concluded there was
// none — it had listened on the content document, its window, the parent window and every DESCENDANT
// of the renderer, and missed the renderer element itself, which is where the paginator re-dispatches
// it. `relocate` behind that is `debounce(…, 250)`, so it arrives only after scrolling stops.
//
// WHAT IS TESTED HERE is the wiring: which signals drive the refresh, that the geometry comes from the
// range, and that one emit path owns "is a selection live". The placement rule lives in
// `toolbarFreeze.test.ts`; the anchoring itself is geometry in a live engine and is measured at
// runtime, because this runner is `node` by deliberate policy (vitest.config.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";


// THE STAND-DOWN RULE THAT USED TO BE TESTED HERE IS GONE, deliberately. It hid the toolbar once the
// selection left the viewport, which took the actions away from a selection that was still real and
// still where the reader left it. The toolbar now HOLDS its last honoured position instead, and
// `toolbarFreeze.test.ts` covers that rule — tracking, the freeze at each edge, holding while the
// selection is away, resuming without a jump, and the document change that does dismiss it.

describe("the geometry is recomputed, and it is recomputed from the selection", () => {
  const ENGINE = readFileSync("src/reader-engine/FoliateController.ts", "utf8");

  it("refreshes the anchor on the engine's IMMEDIATE movement signal", () => {
    // The renderer re-dispatches its container's scroll on itself, undebounced (paginator.js:597).
    // That is the signal that fires in the frame the text moves. MEASURED with a per-frame sampler:
    // driven by `relocate` alone the toolbar sat still through a whole five-step gesture, because
    // `relocate` comes from a `debounce(…, 250)` and arrives only after scrolling stops.
    expect(ENGINE).toContain("private refreshSelectionRect()");
    expect(ENGINE).toContain(`view.renderer?.addEventListener("scroll", () => this.refreshSelectionRect());`);
  });

  it("keeps `relocate` as well, for movement that is not a scroll", () => {
    // A paged-flow page turn translates the columns without scrolling the container, and chapter
    // navigation replaces the document — neither produces a scroll event.
    // Not `…();` — the scroll listener calls it inside an arrow, so it carries no semicolon.
    const calls = [...ENGINE.matchAll(/this\.refreshSelectionRect\(\)/g)].map((m) => m.index ?? -1);
    expect(calls.length).toBe(2); // the scroll listener, and the relocate handler
    const relocateAt = ENGINE.indexOf('view.addEventListener("relocate"');
    expect(relocateAt).toBeGreaterThan(0);
    expect(calls.some((i) => i > relocateAt)).toBe(true);
  });

  it("takes the new rect from the selection's own range, not from the viewport", () => {
    // The whole point: a clone of the range still references the live nodes, so its rect is where the
    // text IS. Anything computed from the scroll offset instead would drift again the moment the
    // engine changed how it moves the text.
    const body = ENGINE.slice(ENGINE.indexOf("private refreshSelectionRect()"));
    // The whole method — the document-change guard sits above these lines now.
    const method = body.slice(0, body.indexOf("\n  }") + 4);
    expect(method).toContain("range.getBoundingClientRect()");
    expect(method).toContain("rectInParent");
  });

  it("keeps ONE emit path, so 'is a selection live' has a single answer", () => {
    // The refresh needs to know whether a toolbar is up. That is only trustworthy if every raise and
    // every dismissal goes through the same place — a stray `selectionCb?.(…)` would leave the engine
    // believing in a selection the reader had already dismissed, and re-raise it on the next scroll.
    expect(ENGINE).toContain("private emitSelection(");
    // Exactly one call of the raw callback, and it is the one INSIDE `emitSelection`.
    const raw = ENGINE.match(/this\.selectionCb\?\.\(/g) ?? [];
    expect(raw.length).toBe(1);
    const body = ENGINE.slice(ENGINE.indexOf("private emitSelection("));
    expect(body.slice(0, 200)).toContain("this.selectionCb?.(sel);");
  });
});

describe("one canonical section label for every annotation type (RAWY-FM1)", () => {
  const ENGINE = readFileSync("src/reader-engine/FoliateController.ts", "utf8");
  const STORE = readFileSync("src/features/reader/annotationsStore.ts", "utf8");

  it("files a highlight by the same rule the reader captions with", () => {
    // Not a second labelling system: the engine's annotation label falls through to the very functions
    // `relocate` uses, so a bookmark and a highlight at one position cannot disagree.
    expect(ENGINE).toContain("private async annotationLabel(");
    const body = ENGINE.slice(ENGINE.indexOf("private async annotationLabel("));
    expect(body.slice(0, 600)).toContain("frontMatterName(");
    expect(body.slice(0, 600)).toContain("sectionHeading(");
  });

  it("no longer lets an empty engine label pass through as the stored value", () => {
    // MEASURED before this: a bookmark on front matter recorded "The Title of the Book" while a
    // highlight on the same page recorded "" — foliate answers `''` for a section no entry describes
    // (view.js:396) and `??` falls back only from null.
    expect(STORE).not.toContain("const fallback = label ?? useReader.getState().chapterLabel;");
    expect(STORE).toContain("label === undefined ? useReader.getState().chapterLabel : label");
  });
});
