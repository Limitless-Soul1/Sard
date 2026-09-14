// Which views can express a hand-made order.
//
// Arranging by hand means dropping a book into a place BETWEEN two others, so a view has to be able
// to draw that place. Measured before this predicate existed: the Arrange control switched ON in
// Grid and in Details and then did nothing at all — no book draggable, no landing place, nothing
// written. The toolbar now does not draw the control there, which is what it already does with the
// density steps in the same two views.

import { describe, expect, it } from "vitest";
import { canArrange, DESIGN_VIEWS, isGroupedView } from "../../src/features/library/design/model";

describe("canArrange", () => {
  it("is true exactly where a landing place can be drawn", () => {
    expect(canArrange("covers")).toBe(true);
    expect(canArrange("spines")).toBe(true);
    expect(canArrange("vista")).toBe(true);
  });

  it("is false where the order is not the reader's to set — THE REGRESSION", () => {
    // Details sorts by a column; Grid is Sard's original library grid, outside this surface and
    // holding no shelf structure to order within.
    expect(canArrange("details")).toBe(false);
    expect(canArrange("grid")).toBe(false);
  });

  it("answers for every view the switcher offers, and for no other", () => {
    // A view added to the switcher without a decision here would silently inherit "cannot arrange",
    // which is the safe direction but should be a choice someone made.
    for (const v of DESIGN_VIEWS) expect(typeof canArrange(v)).toBe("boolean");
    expect(DESIGN_VIEWS.filter(canArrange).sort()).toEqual(["covers", "spines", "vista"]);
  });

  it("covers every grouped view, and one that is not grouped", () => {
    // The grouped renderer draws the gaps; Vista draws its own. Both can, which is why this is a
    // predicate of its own rather than a synonym for `isGroupedView`.
    for (const v of DESIGN_VIEWS) if (isGroupedView(v)) expect(canArrange(v)).toBe(true);
    expect(isGroupedView("vista")).toBe(false);
    expect(canArrange("vista")).toBe(true);
  });
});
