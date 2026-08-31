// PRIORITY 6 — a menu item's activation key must not reach the card behind it.
//
// WHAT THIS DEFENDS. `<BookActions>` renders its menu with `createPortal` into the overlay host, so
// in the DOM it is nowhere near the book card. React nevertheless propagates events through the
// REACT tree, and `<BookActions>` is a child of the card — whose own `onKeyDown` claims Enter and
// Space for "open this book" and calls `preventDefault()`.
//
// MEASURED, in the real application, before the fix: `End` focused «حذف الكتاب» correctly, and Enter
// then opened the BOOK. No confirmation, no deletion, and the card's `preventDefault()` had killed
// the button's own activation on the way past. A CLICK on the identical item in the identical state
// opened the dialog. It was not specific to delete — the first item did it too, so a keyboard user
// could not reach ANY item in this menu.
//
// It reads the component as a FILE, like `readerNavGuard`/`paginatorTurnLock`, because the defect is
// a property of the source that no type or lint rule can see: the two handlers are in different
// files and look independent. A private test-harness probe proves the behaviour against the real UI.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "src", "features", "library");
const MENU = readFileSync(join(ROOT, "design", "BookActions.tsx"), "utf8");
const CARD = readFileSync(join(ROOT, "Library.tsx"), "utf8");

/** Source with `//` comment lines removed, so an assertion about CODE cannot match prose. */
const codeOnly = (src: string) =>
  src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("//")).join(String.fromCharCode(10));

/** The body of the menu container's keydown handler. */
const menuKeydown = () => {
  const at = MENU.indexOf("onKeyDown={(e) => {");
  expect(at, "the menu must still have its keydown handler").toBeGreaterThan(-1);
  return MENU.slice(at, at + 2600);
};

describe("the activation keys stop at the menu", () => {
  it("Enter and Space have their propagation stopped", () => {
    const body = menuKeydown();
    const at = body.indexOf('e.key === "Enter"');
    expect(at, "Enter must be handled").toBeGreaterThan(-1);
    expect(body.slice(at, at + 1600)).toContain("e.stopPropagation()");
  });

  it("and are NOT preventDefault-ed, which would cancel the button's own activation", () => {
    // This is the whole subtlety. `preventDefault` here would reproduce the defect from the other
    // side: the card would no longer open the book, and the item still would not activate.
    //
    // COMMENTS ARE STRIPPED FIRST. The branch's own explanation contains the words
    // "NOT `preventDefault`", and the first version of this test matched that prose and failed —
    // a test that reads documentation as if it were code.
    const branch = codeOnly(menuKeydown().slice(menuKeydown().indexOf('e.key === "Enter"')));
    expect(branch.slice(0, branch.indexOf("}"))).not.toContain("preventDefault");
  });

  it("Tab keeps its own behaviour — preventDefault and close", () => {
    const body = menuKeydown();
    const at = body.indexOf('e.key === "Tab"');
    expect(at).toBeGreaterThan(-1);
    const branch = body.slice(at, at + 320);
    expect(branch).toContain("e.preventDefault()");
    expect(branch).toContain("close()");
  });

  it("Escape is not touched here — it belongs to openTransient", () => {
    // Escape closing the menu and restoring focus already passes its own checks. If it were ever
    // moved into this handler, stopping propagation could silently break the view behind.
    expect(menuKeydown()).not.toContain('"Escape"');
    expect(MENU).toContain("openTransient(close");
  });
});

describe("the conditions that make the collision possible are still true", () => {
  it("the menu is portalled, so the DOM gives no protection", () => {
    // If this ever stops being a portal the fix is still correct, but the REASON changes — and the
    // comment explaining it would then be wrong, which is worse than no comment.
    expect(MENU).toContain("createPortal");
    expect(MENU).toContain("overlayHost()");
  });

  it("the card still claims Enter and Space for opening a book", () => {
    // The other half of the collision. If this handler is ever removed, this whole test becomes
    // vacuous and should be revisited rather than left passing for the wrong reason.
    const at = CARD.indexOf('if (e.key === "Enter" || e.key === " ")');
    expect(at, "the card's open-on-Enter handler").toBeGreaterThan(-1);
    const branch = CARD.slice(at, at + 220);
    expect(branch).toContain("e.preventDefault()");
    expect(branch).toContain("onOpen()");
  });

  it("the menu items are real buttons, so Enter activates them natively", () => {
    // The fix relies on the default action surviving. A div with role=menuitem would need its own
    // key handling and this test would be defending something that no longer exists.
    expect(MENU).toContain('role="menuitem"');
    const at = MENU.indexOf('role="menuitem"');
    expect(MENU.slice(Math.max(0, at - 300), at)).toContain("<button");
  });
});
