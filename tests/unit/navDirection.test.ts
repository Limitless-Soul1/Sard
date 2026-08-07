// RESILIENCE-1 — → IS ALWAYS THE NEXT PAGE, ← IS ALWAYS THE PREVIOUS ONE.
//
// Reported from real reading: in an Arabic book the arrows were reversed. MEASURED in the shipping
// binary, on real books, before the fix:
//
//     book   ArrowRight   ArrowLeft
//     ltr    FORWARD      BACKWARD     ← already correct
//     rtl    BACKWARD     FORWARD      ← the defect
//
// The cause was the mapping, not RTL layout: the controller called foliate's `goLeft()`/`goRight()`,
// which are direction-aware (`goLeft() { return dir === 'rtl' ? next() : prev() }`), so the arrows
// moved the page by SCREEN GEOMETRY and their meaning inverted with the script.
//
// These tests pin the rule against the real risk, which is not a typo — it is someone reading
// `goLeft` and "correcting" the mapping back to physical movement for an RTL book. The controller
// needs a live foliate view and a DOM, so what is tested here is the DECISION TABLE, extracted as a
// pure function that the controller and these tests both use. The end-to-end proof runs on real
// books in `tests/harness/interaction.mjs`, which fails the build if either direction inverts.

import { describe, expect, it } from "vitest";
import { navIntent } from "../../src/reader-engine/navIntent";

describe("the arrow → intent table", () => {
  it("maps → and its companions to FORWARD", () => {
    for (const k of ["ArrowRight", "ArrowDown", "PageDown"]) {
      expect(navIntent(k), `${k} must go forward`).toBe("forward");
    }
  });

  it("maps ← and its companions to BACKWARD", () => {
    for (const k of ["ArrowLeft", "ArrowUp", "PageUp"]) {
      expect(navIntent(k), `${k} must go backward`).toBe("backward");
    }
  });

  it("claims nothing else", () => {
    for (const k of ["Space", " ", "Enter", "Escape", "a", "Home", "End", "F11"]) {
      expect(navIntent(k), `${k} must not be treated as navigation`).toBeNull();
    }
  });
});

describe("the rule does not depend on the book's direction", () => {
  // THE REGRESSION GUARD. The table takes no direction argument AT ALL, which is the property that
  // makes the defect unrepresentable: there is nothing to branch on. If someone reintroduces a
  // direction parameter, this file stops compiling — which is the intended failure.
  it("takes only a key, so a script direction cannot enter the decision", () => {
    expect(navIntent.length).toBe(1);
  });

  it("gives the same answer however often it is asked", () => {
    expect(navIntent("ArrowRight")).toBe(navIntent("ArrowRight"));
    expect(navIntent("ArrowLeft")).toBe(navIntent("ArrowLeft"));
  });

  it("never maps the two arrows to the same intent", () => {
    // The precise shape of the reported bug was the pair being swapped; equal would be a different
    // failure, but both mean the reader cannot move in one direction.
    expect(navIntent("ArrowRight")).not.toBe(navIntent("ArrowLeft"));
  });
});
