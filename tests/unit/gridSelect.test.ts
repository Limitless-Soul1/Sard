import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE REINTRODUCTION GUARD FOR «تحديد» IN GRID.
 *
 * Grid is the one format the design surface does not draw. It arrives through the `renderGrid` render
 * prop and is built from `BookCard`, so everything a card needs has to cross that boundary explicitly —
 * and selection did not. The grouped views, Details and Vista were each handed `selected`, `selectOn`
 * and `onToggleSelect`; Grid was handed the order and the actions and nothing about selection, so its
 * cards built `useBookPickup` with `selectOn: false`.
 *
 * What that cost, measured in the running application before the fix: «تحديد» on, 47 books drawn, one
 * click — nothing marked, and the library replaced by the reader, because the click fell past the
 * selection branch into `onOpen`. Covers, with the same gesture and the same state, marked the book.
 *
 * The shared hook was never at fault and is not touched: `useBookPickup` has always answered for
 * selection when told the mode is on. Nor is Manual Ordering, which is a separate mode and keeps its
 * own fields in the same call — asserted below, because this is exactly the sort of edit that could
 * quietly take one of them with it.
 */
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
const DESIGN = read("src/features/library/design/LibraryDesign.tsx");
const LIBRARY = read("src/features/library/Library.tsx");

/** The `useBookPickup({ … })` call a Grid card builds for itself. */
const cardPickup = (() => {
  const from = LIBRARY.indexOf("const pickup = useBookPickup({");
  expect(from, "BookCard no longer builds a pickup").toBeGreaterThan(-1);
  const to = LIBRARY.indexOf("});", from);
  return LIBRARY.slice(from, to);
})();

describe("Grid is told when selection mode is on", () => {
  it("the renderGrid contract carries selection across the boundary", () => {
    expect(DESIGN).toMatch(/select: \(b: BookRow\) => CardSelect;/);
  });

  it("and the shell fills it in from the same state the other views read", () => {
    const from = DESIGN.indexOf("props.renderGrid({");
    const call = DESIGN.slice(from, DESIGN.indexOf("})}", from));
    expect(call).toMatch(/select: \(b\) => \(\{/);
    expect(call).toMatch(/on: mode === "select"/);
    expect(call).toMatch(/selected: selected\.has\(b\.id\)/);
  });

  it("the grid hands each card its own descriptor", () => {
    expect(LIBRARY).toMatch(/select=\{g\?\.select\?\.\(b\)\}/);
  });

  it("the card passes the mode and the toggle to the shared pickup", () => {
    expect(cardPickup).toMatch(/selectOn: select\?\.on \?\? false/);
    expect(cardPickup).toMatch(/onToggleSelect: select\?\.onToggle/);
  });

  it("a marked card says so, which is what the caption rule already reads", () => {
    expect(LIBRARY).toMatch(/data-selected=\{select\?\.selected \? "1" : undefined\}/);
  });

  it("and the click goes through the pickup whenever either mode has something to say", () => {
    expect(LIBRARY).toMatch(/onClick=\{order \|\| select \? pickup\.onClick : onOpen\}/);
  });

  // ── MANUAL ORDERING MUST SURVIVE THIS UNCHANGED ───────────────────────────────────────────────
  it("Manual Ordering keeps every field it had in that same call", () => {
    expect(cardPickup).toMatch(/arrangeOn: order\?\.arrangeOn \?\? false/);
    expect(cardPickup).toMatch(/orderable: order\?\.orderable \?\? false/);
    expect(cardPickup).toMatch(/onArrangeDown: order\?\.onArrangeDown/);
    expect(cardPickup).toMatch(/onPickUp: order\?\.onPickUp/);
  });

  it("and the press is still armed by the ordering descriptor alone", () => {
    // `wantsPress` decides whether a hold can begin. Selection deliberately does not arm it: the hook
    // returns out of `onPointerDown` while the mode is on, so a marked card is never also lifted.
    expect(LIBRARY).toMatch(/const wantsPress = !!order && \(order\.orderable \|\| order\.arrangeOn\);/);
  });
});
