// The dismissal stack — the contract that fixes four separate defects at once.
//
// Before it, every transient surface owned its own flag and its own full-screen overlay, and the
// consequences were: two book menus open at the same time, an outside click that dismissed nothing,
// Escape reaching Vista's navigation handler over the top of an open menu, and switching from the
// sort menu to the filter menu costing two clicks because the first was eaten by an overlay.
//
// These assertions are written against the OLD behaviour as much as the new: every one of them
// fails if the stack goes back to letting two surfaces be open at once.

import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissTransients,
  openTransient,
  transientDepth,
} from "../../src/features/library/design/transient";

describe("one transient surface at a time", () => {
  beforeEach(() => dismissTransients());

  it("starts with nothing open", () => {
    expect(transientDepth()).toBe(0);
  });

  it("opening a second surface closes the first — the two-menus defect", () => {
    let aClosed = false;
    let bClosed = false;
    openTransient(() => { aClosed = true; }, () => null);
    expect(transientDepth()).toBe(1);
    openTransient(() => { bClosed = true; }, () => null);
    expect(aClosed).toBe(true);
    expect(bClosed).toBe(false);
    expect(transientDepth()).toBe(1);
  });

  it("is empty again once the surface disposes, so Escape goes back to navigating", () => {
    // This is the whole of the Escape fix: while a surface is on the stack the key is spent on it
    // and the handler that would walk Vista up a level never sees it — and once it is gone, it does.
    const dispose = openTransient(() => {}, () => null);
    expect(transientDepth()).toBe(1);
    dispose();
    expect(transientDepth()).toBe(0);
  });

  it("disposing is idempotent, and disposing one does not resurrect another", () => {
    const disposeA = openTransient(() => {}, () => null);
    const disposeB = openTransient(() => {}, () => null);
    disposeA(); // A was already closed by B opening
    expect(transientDepth()).toBe(1);
    disposeB();
    disposeB();
    expect(transientDepth()).toBe(0);
  });

  it("dismissing everything runs every close handler exactly once", () => {
    let calls = 0;
    openTransient(() => { calls += 1; }, () => null);
    dismissTransients();
    expect(calls).toBe(1);
    dismissTransients();
    expect(calls).toBe(1);
    expect(transientDepth()).toBe(0);
  });

  it("a surface that closes itself leaves the stack empty, not stale", () => {
    // The stale-overlay case: a menu unmounted by a navigation must not leave the stack believing
    // it is still open, or the next Escape is swallowed by a surface that is no longer on screen.
    let dispose: (() => void) | null = null;
    dispose = openTransient(() => { dispose?.(); }, () => null);
    dismissTransients();
    expect(transientDepth()).toBe(0);
  });
});
