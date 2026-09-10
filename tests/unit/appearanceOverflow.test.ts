// TWO SURFACES THAT COULD GROW PAST THE WINDOW, AND THE TWO RULES THAT STOP THEM.
//
// Both defects were reported by a tester and both have the same shape: a box with no height ceiling,
// mounted somewhere that cannot scroll to what overflows.
//
// THE QUICK SWITCHER. Its menu opens UPWARD from a trigger in the sidebar foot, so its height is spent
// against the distance to the top edge — and `.lib-menu` carries neither a max-height nor an overflow.
// Measured in the running app with 38 هيئات:
//
//     1280x900   menu top y = -510   16 rows wholly above the edge
//     1100x720   menu top y = -688   21 rows
//     1000x620   menu top y = -788   24 rows
//      905x1349  menu top y =  -59    2 rows      (the tester's own window)
//
// and a wheel over the menu moved nothing, because nothing in the chain scrolls. The rows were all
// rendered; they were simply unreachable.
//
// THE RECEIVED-هيئة SHEET. `.pf-dialog-scrim` centres with `align-items: center`, and a centred flex
// item taller than its container overflows EQUALLY in both directions — so the half that goes off the
// TOP cannot be scrolled to. Measured on the import card, which is 846px tall:
//
//     1280x900   fits            1100x720   top y = -57    1000x620   top y = -107
//     1280x560   top y = -143    1280x460   top y = -193
//
// with the title AND the actions off screen at every size below 900.
//
// WHY THESE ARE ASSERTED AGAINST THE STYLESHEET. The rules are geometry, and this suite has no DOM;
// what can be pinned here is that the ceiling and the scroll exist at all, and that the switcher's
// ceiling is a VARIABLE rather than a number — a constant would only be right on one window. The
// rendered result is verified in the app, at the sizes above.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(R, "src/styles/profiles.css"), "utf8");

/** One rule's body, by selector — enough for these assertions and no CSS parser needed. */
function rule(selector: string): string {
  const i = css.indexOf(selector + " {");
  if (i < 0) return "";
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("the quick switcher's menu cannot grow past the window", () => {
  it("the menu carries a height ceiling", () => {
    const body = rule(".lib-sidefoot .pf-switch-menu");
    expect(body).toContain("max-height");
  });

  it("…and the ceiling is a VARIABLE, not a number picked for one window", () => {
    // The component writes it from the trigger's measured rect. A literal here would be the bug the
    // owner explicitly ruled out: a max-height that only works on one viewport.
    const body = rule(".lib-sidefoot .pf-switch-menu");
    expect(body).toMatch(/max-height:\s*var\(--pf-switch-max/);
    // …and it falls back to `none`, so an unmeasured menu behaves exactly as it did before.
    expect(body).toMatch(/var\(--pf-switch-max,\s*none\)/);
  });

  it("the LIST scrolls — not the menu, and not the sidebar", () => {
    const body = rule(".pf-switch-list");
    expect(body).toContain("overflow-y: auto");
    // Without this a flex child refuses to be shorter than its content and the overflow never engages.
    expect(body).toContain("min-height: 0");
    // The wheel stays in the list once its ends are reached, so the Library behind it never takes over.
    expect(body).toContain("overscroll-behavior: contain");
  });

  it("the rows are the only part that scrolls, so «إدارة الهيئات» stays reachable", () => {
    // The list is a separate box inside the menu; the rule and the manage row are its siblings, so a
    // long list cannot carry them off screen with it.
    expect(css).toContain(".pf-switch-list");
    expect(rule(".pf-switch-list")).toContain("flex-direction: column");
  });
});

describe("a dialog cannot be centred off the top of the window", () => {
  it("the dialog reserves height the same way it already reserved width", () => {
    const body = rule(".pf-dialog");
    expect(body).toMatch(/max-width:\s*calc\(100vw - 32px\)/);
    expect(body).toMatch(/max-height:\s*calc\(100vh - 32px\)/);
  });

  it("…and can be read when it is capped", () => {
    const body = rule(".pf-dialog");
    expect(body).toContain("overflow-y: auto");
  });

  it("the scrim still centres, which is what made the overflow unreachable", () => {
    // Kept deliberately: the fix is the ceiling, not a change of alignment. If this ever becomes
    // `flex-start` the assertions above stop being the thing that protects the top edge.
    expect(rule(".pf-dialog-scrim")).toContain("align-items: center");
  });
});
