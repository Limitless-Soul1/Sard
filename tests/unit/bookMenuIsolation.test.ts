import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE REINTRODUCTION GUARD FOR THE BOOK'S ⋯ MENU.
 *
 * A book card starts a 340 ms hold on any `pointerdown` that reaches it (`useBookPickup`), and a press
 * held past that lifts the book into manual-movement mode. That is the gesture for the CARD.
 *
 * The ⋯ menu is rendered with `createPortal` into the overlay host, so in the DOM it stands nowhere
 * near the card — but React propagates events through the REACT tree, and `<BookActions>` is a child of
 * the card. Every event on a menu item therefore arrives at the card's own handlers unless the menu
 * stops it. The `keydown` half of this was found and fixed once already; `pointerdown` was left out,
 * and holding a menu option for half a second lifted the book standing behind the open menu.
 *
 * Measured in the running application, with the guard removed and then restored: a 700 ms press on a
 * menu option put a book in hand (`.libd-drag-ghost` present), and with the guard in place it did not,
 * while an ordinary long press on a book still lifted it.
 *
 * The defect is invisible to the type checker and to every behavioural test the public tree can run,
 * because nothing about it is wrong in isolation — the menu is correct, the card is correct, and only
 * the path between them is surprising. So the invariant is asserted against the source: the portalled
 * menu answers for the pointer as well as for the click and the key, and the trigger that opens it does
 * the same.
 */
const SRC = readFileSync(join(__dirname, "../../src/features/library/design/BookActions.tsx"), "utf8");
const STOP = /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/;

/** The opening tag of an element, from an attribute inside it to the start of its children. */
const openingTag = (marker: string, childAnchor: string) => {
  const from = SRC.indexOf(marker);
  expect(from, `${marker} is no longer in BookActions.tsx`).toBeGreaterThan(-1);
  const to = SRC.indexOf(childAnchor, from);
  expect(to, `no ${childAnchor} after ${marker}`).toBeGreaterThan(from);
  return SRC.slice(from, to);
};

describe("the book's ⋯ menu keeps its events to itself", () => {
  it("the portalled menu stops pointerdown, so a held press cannot lift the book behind it", () => {
    expect(openingTag('data-book-menu="1"', "{items.map(")).toMatch(STOP);
  });

  it("and still stops the click and the keydown it always stopped", () => {
    const tag = openingTag('data-book-menu="1"', "{items.map(");
    expect(tag).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(tag).toMatch(/onKeyDown=/);
  });

  it("the ⋯ trigger stops pointerdown too — pressing it is not pressing the card", () => {
    expect(openingTag('data-book-actions="1"', "style={")).toMatch(STOP);
  });
});
