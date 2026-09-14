// THE LADDER THE LIBRARY TREE'S METADATA IS SPENT ON.
//
// Down the outer edge of the tree runs a column of small things: how many books a shelf holds, the
// ⋯ that opens its menu, the fixing it sits on. They are the least prominent things in the sidebar
// by design, and that makes them the easiest to make ILLEGIBLE by accident — which is what
// happened. Measured against the sidebar's own translucent ground, with every ancestor opacity
// folded in, the column read:
//
//     cabinet name 8.42 · shelf name 4.57 · count 2.89 · empty count 1.62 · ⋯ 1.54 · fixing 1.55
//
// Two faults, and this pins both of them shut.
//
// FIRST, `opacity` is not a colour. It multiplies whatever the element paints, so a rule that had
// already chosen a quiet ink and then took 45% of it landed at less than half the contrast the
// stylesheet appeared to promise. Every one of those elements now CHOOSES an ink instead.
//
// SECOND, contrast is a relationship. The count's colour never changed at all; the shelf NAME rose
// from `--mut` to 76% ink, and a value that had been one step behind its label became a hole beside
// it. So the rungs are named once, in one place, and spent in one order — which is the only way a
// later change to one of them can be seen to move the others.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");
const CSS = read("src/styles/library-design.css");
const CHROME = read("src/features/library/design/Chrome.tsx");

/**
 * The declarations of the rule a selector belongs to.
 *
 * NOT `selector + " {"`. That assumed a selector is always alone in its prelude, which stopped
 * being true the moment the cabinet's ⋯ joined the shelf's ⋯ in one comma-separated list — the
 * lookup then reported "no rule" for a rule that was still there, unchanged, three characters
 * further along. A selector followed by a comma is the same rule; only the brace ends it.
 */
const ruleFor = (selector: string): string => {
  const at = CSS.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  // Everything between the selector and the brace must be more selectors, or this is a match
  // inside some other rule's body rather than a prelude.
  expect(CSS.slice(at + selector.length, open), `${selector} is not part of a prelude`)
    .toMatch(/^[\s,.:[\]="a-zA-Z0-9_-]*$/);
  return CSS.slice(open, CSS.indexOf("}", open));
};

describe("the tree's metadata ladder", () => {
  it("names its rungs once, so they can only move together", () => {
    // Both are walked from `--faint` toward `--txt` rather than being an alpha of `--txt`. That
    // matters: an alpha of the ink was measured swinging from 3.6 on paper to 6.6 on a dark
    // ground, because a dark theme's text is nearly white and a light theme's is nearly black.
    // Mixing from a token that is already theme-derived is what keeps the rungs in step.
    expect(CSS).toMatch(/--tree-meta:\s*color-mix\(in srgb, var\(--txt\) \d+%, var\(--faint\)\)/);
    expect(CSS).toMatch(/--tree-quiet:\s*color-mix\(in srgb, var\(--txt\) \d+%, var\(--faint\)\)/);

    // The value rung must be the stronger of the two, or the ordering below is decoration.
    const pct = (name: string) =>
      Number(CSS.match(new RegExp(`--${name}:\\s*color-mix\\(in srgb, var\\(--txt\\) (\\d+)%`))![1]);
    expect(pct("tree-meta")).toBeGreaterThan(pct("tree-quiet"));
  });

  it("spends them in the order the tree is meant to say", () => {
    // count → the value rung; ⋯ and the fixing → the structural one. Measured after the change:
    //
    //     ivory  11.42 → 5.84 → 4.31 → 3.66      sepia      8.42 → 4.57 → 3.71 → 3.25
    //     noct.  12.90 → 7.89 → 4.90 → 4.00      trueblack 11.60 → 7.01 → 4.70 → 3.91
    expect(CHROME).toMatch(/libd-shelfcount\$\{[^}]*\}`\}[\s\S]{0,400}?color: "var\(--tree-meta\)"/);
    expect(ruleFor(".libd-chrome button.libd-shelfdots")).toContain("var(--tree-quiet)");
    expect(ruleFor(".libd-shelfmark")).toContain("var(--shelf-ink, var(--tree-quiet))");
  });

  it("never dilutes an ink it has already chosen", () => {
    // THE REGRESSION ITSELF. `opacity: .45` over a colour that was already quiet measured 1.54 —
    // fainter than anything else in the sidebar, on the control that opens a shelf's menu. A rest
    // state that recedes is right; reaching it by multiplication is not.
    for (const selector of [
      ".libd-chrome button.libd-shelfdots",
      ".libd-shelfcount",
      ".libd-shelfmark",
    ]) {
      expect(ruleFor(selector), `${selector} dilutes its own ink`).not.toMatch(/(^|[^-])opacity:/);
    }
    // And the nought is read like any other count: «0» answers the same question «3» does, and a
    // reader looking for an empty shelf to file into is looking for exactly that row.
    expect(CSS).not.toMatch(/\.libd-shelfcount\.is-empty\s*\{[^}]*opacity/);
  });

  it("puts a cabinet's count on the value rung too, because they share one column", () => {
    // A cabinet's count sits directly above its shelves' counts, on the same trailing edge, and a
    // reader scans that column downward. Left on `--faint` while the shelves' rose, the parent's
    // number measured WEAKER than its children's — 2.89 against 3.71 in sepia, 3.29 against 4.90
    // in nocturne, where it is plain to see. A cabinet outranks its shelves on its NAME; it does
    // not need to outrank them a second time on a number.
    expect(CHROME).toMatch(/color: "var\(--tree-meta\)" \}\}>\s*\{num\(c\.count\)\}/);

    // …and the name is still where the precedence actually lives. Read from the name's own span
    // rather than from a window before the count, so that writing a comment between the two — or
    // anything else that changes the distance — cannot decide whether this passes.
    const at = CHROME.indexOf("\n                    {c.name}");
    expect(at, "the cabinet name's span is no longer where this reads it").toBeGreaterThan(-1);
    const nameSpan = CHROME.slice(CHROME.lastIndexOf("<span", at), at);
    expect(nameSpan).toContain('font: "600 .8125rem var(--ui)"');
    expect(nameSpan).toContain('color: "var(--txt)"');
  });

  it("moves nothing else that was drawn in --faint", () => {
    // THE TRAP THIS PINS SHUT. The navigation count near the top of the sidebar is written
    // character-for-character like a cabinet's — `500 .6875rem var(--ui)` in `--faint` — so the
    // only thing separating them is the value each renders. A search-and-replace across the file
    // takes both, and the nav row is not part of any of this.
    expect(CHROME).toMatch(/color: "var\(--faint\)" \}\}>\s*\{num\(n\.count\)\}/);

    // The cabinet's ⋯ and its grip stay on the rung the tree's controls have always used. Rather
    // than pin each one's markup — which would break the first time either is refactored — this
    // pins the REACH of the new token: exactly two inks in the tree are drawn on the value rung,
    // and they are the two counts above. Spread it onto a third element and this fails.
    expect(CHROME.split('color: "var(--tree-meta)"').length - 1).toBe(2);
    expect(CSS).toContain("--faint: var(--lib-faint);");
    expect(CSS).toMatch(/--lib-faint:\s*color-mix\(in srgb, var\(--muted\) 62%, var\(--paper-bg\)\)/);

    // THIS USED TO PIN THE OPPOSITE, and it was right at the time: the shelf's ⋯ had its own class
    // and the cabinet's still wore `libd-hov` + `libd-hov-txt`. That difference was the defect —
    // both classes lose to the shell's button reset, so the cabinet's ⋯ had no hover ground, no
    // pressed state and no open state, beside a shelf's ⋯ that had all three. Same control, same
    // gesture, one class each and one rule between them. What is pinned now is that neither of them
    // goes back to the pair that cannot paint.
    expect(CHROME).toContain('className="libd-shelfdots"');
    expect(CHROME).toContain('className="libd-casedots"');
    expect(CHROME).not.toMatch(/libd-hov[^"\n]*"\s*\n\s*title=\{t\("lib\.manage"\)\}/);
    for (const cls of [".libd-chrome button.libd-shelfdots", ".libd-chrome button.libd-casedots"]) {
      expect(ruleFor(cls), `${cls} states its own rest ink`).toContain("var(--tree-quiet)");
    }
  });
});
