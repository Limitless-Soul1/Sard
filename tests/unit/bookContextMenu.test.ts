// A RIGHT-CLICK ON A BOOK OPENS THE BOOK'S OWN MENU — the same one, not a second one.
//
// The failure this guards against is not a crash; it is DRIFT. A context menu is the easiest thing
// in a codebase to build twice: a second item list, a second dismissal, a second idea of what
// "delete" looks like — and then one of them gains an action and the other does not. Sard already
// paid that bill once, when Grid's ⋯ was wired to a different editor from Covers' and three actions
// simply did not exist in one of them (see the note at the top of `BookActions.tsx`).
//
// So what is pinned here is the SHARE: every surface that draws a book opens `BookActions` by ref,
// and no surface assembles items of its own. Plus the one piece of arithmetic that a right-click
// genuinely adds — a menu hanging from a POINT rather than from a control — which has to stay on
// screen at every edge, in both reading directions.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { placeMenu } from "../../src/features/library/design/BookActions";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", "src", p), "utf8");

/** The four surfaces that draw a book and must answer a right-click. */
const SURFACES = [
  "features/library/Library.tsx",               // Grid
  "features/library/design/BookTile.tsx",       // Covers, Spines, Vista
  "features/library/design/ViewDetails.tsx",    // Details rows
];

describe("one menu, opened two ways", () => {
  it("the shared menu can be opened at a point", () => {
    const src = read("features/library/design/BookActions.tsx");
    expect(src).toContain("export interface BookActionsHandle");
    expect(src).toMatch(/openAt:\s*\(/);
    // It is the SAME open: one `open` state, one `items` list, one portal.
    expect(src.match(/const items:/g) ?? []).toHaveLength(1);
    expect(src.match(/role="menu"/g) ?? []).toHaveLength(1);
  });

  it("every surface that draws a book wires the gesture to that menu, and to nothing else", () => {
    for (const f of SURFACES) {
      const src = read(f);
      expect(src, `${f} does not use the shared gesture`).toContain("useBookContextMenu");
      expect(src, `${f} does not hand the menu its ref`).toContain("ref={ctx.ref}");
      expect(src, `${f} does not answer the right-click`).toContain("onContextMenu={ctx.onContextMenu}");
      // No second menu: a surface must not be building its own item list or its own popup role.
      expect(src, `${f} draws a menu of its own`).not.toMatch(/role="menu"/);
    }
  });

  it("the gesture defers to the menu rather than reimplementing it", () => {
    const src = read("features/library/design/bookContextMenu.ts");
    expect(src).toContain("h.openAt(e.clientX, e.clientY");
    // It carries no labels, no actions and no ordering of its own — that is the component's.
    expect(src).not.toMatch(/lib\.editDetails|lib\.openBook|edit\.delete|\bt\(/);
    // A right-click inside the open menu is the menu's, not the book's.
    expect(src).toContain('[data-book-menu="1"]');
  });

  it("a non-primary press never lifts a book", () => {
    // A right-press lasting a third of a second used to arm the press-and-hold, so the book was
    // picked up into manual movement behind the menu it had just opened.
    expect(read("features/library/design/bookPickup.ts")).toContain("if (e.button !== 0) return;");
  });
});

describe("a menu opened at a point stays on screen", () => {
  const VP = { w: 1200, h: 800 };
  const SZ = { w: 206, h: 260 };
  const at = (x: number, y: number) => ({ left: x, right: x, bottom: y });

  it("opens forward from the click in LTR and back from it in RTL", () => {
    expect(placeMenu(at(500, 300), SZ, VP, { rtl: false, gap: 2 }).left).toBe(500);
    expect(placeMenu(at(500, 300), SZ, VP, { rtl: true, gap: 2 }).left).toBe(500 - SZ.w);
  });

  it("is never clipped by the trailing edge", () => {
    const p = placeMenu(at(1190, 300), SZ, VP, { rtl: false, gap: 2 });
    expect(p.left + SZ.w).toBeLessThanOrEqual(VP.w - 8);
  });

  it("is never clipped by the leading edge, in either direction", () => {
    expect(placeMenu(at(4, 300), SZ, VP, { rtl: false, gap: 2 }).left).toBeGreaterThanOrEqual(8);
    expect(placeMenu(at(4, 300), SZ, VP, { rtl: true, gap: 2 }).left).toBeGreaterThanOrEqual(8);
  });

  it("moves up rather than off the bottom", () => {
    const p = placeMenu(at(500, 790), SZ, VP, { rtl: false, gap: 2 });
    expect(p.top + SZ.h).toBeLessThanOrEqual(VP.h - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it("sits AT the pointer, and below the control", () => {
    // The gap is the only thing that differs between the two ways of opening it.
    expect(placeMenu(at(500, 300), SZ, VP, { rtl: false, gap: 2 }).top).toBe(302);
    expect(placeMenu({ left: 500, right: 530, bottom: 300 }, SZ, VP, { rtl: false, gap: 6 }).top).toBe(306);
  });

  it("a window smaller than the menu still places it on screen", () => {
    const tiny = { w: 180, h: 200 };
    const p = placeMenu(at(90, 100), SZ, tiny, { rtl: false, gap: 2 });
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
  });
});
