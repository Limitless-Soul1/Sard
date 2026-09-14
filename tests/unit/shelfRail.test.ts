// THE STRUCTURE OF THE SHELF TREE: A RAIL, AND A FIXING ATTACHED TO IT.
//
// Two devices carry the whole idea. A group of shelves hangs from one vertical rail, and each shelf
// has a horizontal fixing bolted to it. Both are a few pixels of background, and both turned out to
// be very easy to break in ways no stylesheet reading would reveal — photographed at 8x in the
// running application, the tree had FOUR separate fractures in it, only one of which anybody had
// designed:
//
//   · the rail changed colour in mid-run, where the parent cabinet's ink handed over to a neutral;
//   · on the group with no cabinet behind it that ink resolved to `transparent`, so the rail did
//     not exist for its first 18px and the first shelf's fixing floated in space;
//   · the neutral's start and the foot fade's start crossed over on any group under 38px tall, so a
//     one-row group was a different object from a five-row one;
//   · a row is positioned and comes after the rail in the DOM, so a SELECTED row's opaque ground
//     punched a hole straight through the connector.
//
// What follows pins the shape of the answer, not its pixel values: one colour, stops that cannot
// cross, a rail that outranks the rows, a fixing that is square where it meets the rail, and a
// break that is anchored to the ends rather than measured from one of them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");
const CSS = read("src/styles/library-design.css");
const CHROME = read("src/features/library/design/Chrome.tsx");

/** One rule's declarations, by a selector that appears verbatim in the stylesheet. */
const ruleFor = (selector: string): string => {
  const at = CSS.indexOf(selector + " {");
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf("}", at));
};

/** Everything the rule shelf's fixing is made of: its own rule and both segment rules. */
const ruleMark = CSS.slice(CSS.indexOf(".libd-shelfmark.is-rule"), CSS.indexOf(".libd-shelfcount {"));

describe("the rail a group of shelves hangs from", () => {
  it("is one colour for its whole length", () => {
    const rail = ruleFor(".libd-shelfgroup::before");
    // The cabinet's ink is no longer spent on the head of the line. A group says whose it is by
    // sitting indented under its cabinet; the cabinet says who it is with its own bar and disc.
    expect(rail).not.toContain("--shelf-drop");
    expect(CSS).not.toContain("--shelf-drop");
    expect(CHROME).not.toContain("--shelf-drop");

    // Every stop that paints is the same ink; the only other stop is the transparent one it fades
    // into. Two different painted colours in here is precisely what read as a break.
    const painted = [...rail.matchAll(/color-mix\([^)]*\)[^)]*\)/g)].map((m) => m[0]);
    expect(painted.length).toBeGreaterThan(0);
    expect(new Set(painted).size).toBe(1);
  });

  it("has stops that cannot cross, however short the group", () => {
    // The old gradient began its neutral at a fixed 18px and its fade at calc(100% - 20px). On a
    // 36px group those are the wrong way round, and the segment between them collapsed to nothing.
    // A gradient whose only offset is the fade cannot do that at any height.
    const rail = ruleFor(".libd-shelfgroup::before");
    const offsets = [...rail.matchAll(/\)\s+(calc\([^)]*\)|\d+px)/g)].map((m) => m[1]);
    expect(offsets.filter((o) => o.startsWith("calc"))).toHaveLength(1);
    expect(offsets.filter((o) => /^\d+px$/.test(o))).toHaveLength(0);
  });

  it("outranks the rows, so being selected cannot punch a hole in it", () => {
    // Both the rail and every row are positioned, so they paint in DOM order and the row wins.
    // A structural connector cannot be interrupted by which row you happen to be standing on.
    expect(ruleFor(".libd-shelfgroup::before")).toMatch(/z-index:\s*[1-9]/);
    // Still far below the shelf menu, which would be a real bug to draw a line across.
    const z = Number(ruleFor(".libd-shelfgroup::before").match(/z-index:\s*(\d+)/)![1]);
    expect(z).toBeLessThan(200);
  });
});

describe("the fixing each shelf sits on", () => {
  it("is square where it meets the rail and round at its free end", () => {
    // A 1.5px radius on a 3px bar makes both ends half-circles, and a half-circle butting a 1px
    // hairline reads as a dash that stops near a line rather than a board bolted to it.
    const mark = ruleFor(".libd-shelfmark");
    expect(mark).toMatch(/border-start-start-radius:\s*0/);
    expect(mark).toMatch(/border-end-start-radius:\s*0/);
    expect(mark).toMatch(/border-start-end-radius:\s*[1-9]/);
    expect(mark).toMatch(/border-end-end-radius:\s*[1-9]/);
    // Logical, so "the end that touches the rail" means the same thing in Arabic and in English.
    expect(mark).not.toMatch(/border-(top|bottom)-(left|right)-radius/);
  });

  it("breaks a rule shelf's fixing with a parting that cannot drift", () => {
    // The break used to be gradient stops in absolute pixels, inside a box whose width changes:
    // selecting the row grew the bar to 19px and the last colour ran on, taking the segment against
    // the rail from 5px to 10px. Each piece is now anchored to its OWN end instead.
    expect(ruleMark).not.toContain("linear-gradient");
    expect(ruleMark).not.toMatch(/\bto (right|left|top|bottom)\b/);
    expect(ruleMark).toMatch(/inset-inline:\s*0 \d+px/);   // the run, from the rail
    expect(ruleMark).toMatch(/inset-inline-end:\s*0/);      // the tick, at the free end
    // The distinction itself is kept — this is about how it is drawn, not whether it exists.
    expect(CHROME).toContain('s.auto_rule ? " is-rule" : ""');
  });

  it("does not compete with the name, the count or the menu", () => {
    // Three pixels tall, and the only thing that moves is the one row whose state changed. If the
    // fixing ever grew a weight of its own it would become a fourth column of specks, which is the
    // problem the whole treatment was built to solve.
    const mark = ruleFor(".libd-shelfmark");
    expect(mark).toMatch(/block-size:\s*3px/);
    expect(mark).not.toMatch(/box-shadow|outline|border-width/);
    expect(CSS).toMatch(/\.is-on \.libd-shelfmark \{ inline-size: \d+px; \}/);
  });
});
