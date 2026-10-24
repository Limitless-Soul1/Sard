// THE SELECTION RAISE, AND THE THREE EVENTS IT MUST BE REACHABLE FROM.
//
// Sard raises its selection toolbar from one place. That place used to be registered on `pointerup`
// alone, which is correct for a mouse and impossible for a finger.
//
// MEASURED ON CHROMIUM (133 and again on 151) with a real touch long-press driven through the input
// stack rather than a synthetic event, the whole sequence is:
//
//     pointerdown:touch  touchstart  contextmenu:touch  selectionchange  pointercancel:touch  touchcancel
//
// There is no `pointerup` anywhere in it. The engine's touch-selection controller takes the long-press
// over and cancels the pointer stream, so a raise registered only on `pointerup` can never fire from a
// touch: the platform selection exists, the word is highlighted on screen with native handles, and
// Sard's toolbar cannot appear however the UI above it is wired. Preventing `contextmenu` was tried
// against the same gesture and the sequence came back byte-identical, so suppressing the native menu
// is NOT the fix and no such switch exists.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. `FoliateController` has no test seam for this: the handlers are
// registered against a content `Document` that only exists once a real book has been loaded into a
// real iframe inside foliate's closed shadow root. There is no way to construct that here, and a
// hand-built stand-in would be a test of the stand-in.
//
// So this reads the source as a FILE, exactly as `paginatorTurnLock.test.ts` does and for the same
// reason, and defends the properties whose loss is otherwise invisible: that one helper exists, that
// all three events route to it, that the guard is the first thing it does, and that `pointerup` — the
// mouse path — still reaches it. The BEHAVIOUR was proven live: a touch long-press raised the
// selection, the selected Arabic word was quoted by the toolbar, and a highlight made from it was
// visibly painted over that word and survived a restart and an engine major-version upgrade.
//
// This exists because the single most likely way for the fix to disappear is someone tidying two
// "duplicate" listeners back into one. No compile error, no failing behaviour with a mouse — and
// touch selection silently dies again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "reader-engine", "FoliateController.ts"),
  "utf8",
);

/** The source from a marker onward — enough to assert what comes first inside a block. */
const after = (needle: string, chars = 700) => {
  const at = SRC.indexOf(needle);
  expect(at, needle + " should be present").toBeGreaterThan(-1);
  return SRC.slice(at, at + chars);
};

/** Index of a marker, for asserting the ORDER of two things. */
const at = (needle: string) => {
  const i = SRC.indexOf(needle);
  expect(i, needle + " should be present").toBeGreaterThan(-1);
  return i;
};

describe("the selection raise is one helper, not one event handler", () => {
  it("is extracted as `raiseSelection` rather than inlined into a listener", () => {
    expect(SRC).toContain("const raiseSelection = () => {");
  });

  it("still contains the selection logic itself, not a stub", () => {
    const body = after("const raiseSelection = () => {", 1400);
    // The four things the raise is: it reads the platform selection, refuses a collapsed one,
    // converts the range to a CFI, and emits. If any of these left the helper, the helper is no
    // longer the raise and this test is guarding an empty box.
    expect(body).toContain("doc.getSelection()");
    expect(body).toContain("sel.isCollapsed");
    expect(body).toContain("view.getCFI(index, range)");
    expect(body).toContain("this.emitSelection({ cfi, text,");
  });

  it("keeps RAWY-132's dismiss invariant inside the helper", () => {
    // An unchanged selection is a dismiss, never a raise. It moved with the body; if a future edit
    // drops it, the toolbar re-fires on the next tap — the RAWY-122 regression.
    const body = after("const raiseSelection = () => {", 1400);
    expect(body).toContain("if (sel.toString() === this.downSelText) {");
    expect(body).toContain("this.clearSelection();");
  });
});

describe("all three events reach the same raise", () => {
  it("pointerup — the MOUSE path, unchanged", () => {
    // A mouse drag ends in pointerup and always has. This is the assertion that the fix did not
    // trade the mouse for the touch.
    expect(SRC).toContain('doc.addEventListener("pointerup", raiseSelection);');
  });

  it("pointercancel — where a touch long-press actually ends", () => {
    expect(SRC).toContain('doc.addEventListener("pointercancel", raiseSelection);');
  });

  it("selectionchange — where the word actually appears during that long-press", () => {
    expect(SRC).toContain('doc.addEventListener("selectionchange", raiseSelection);');
  });

  it("all three name the SAME function, so they cannot drift apart", () => {
    // Three copies of the body would pass every assertion above and still rot independently.
    for (const ev of ["pointerup", "pointercancel", "selectionchange"]) {
      expect(SRC, ev + " must route to the shared helper").toContain(
        'doc.addEventListener("' + ev + '", raiseSelection);',
      );
    }
    expect(SRC.split("const raiseSelection = () => {")).toHaveLength(2);
  });
});

describe("one raise per gesture", () => {
  it("the guard is the FIRST statement in the helper", () => {
    // Anything before it — a read, a log, a state write — happens on every one of the three events
    // for a single gesture, which is the duplication this prevents.
    const body = after("const raiseSelection = () => {", 120);
    const firstLine = body.split(String.fromCharCode(10))[1] ?? "";
    expect(firstLine.trim()).toBe("if (this.gestureRaised) return;");
  });

  it("is set only after the raise has actually been decided", () => {
    // Set too early and a raise that returns (collapsed selection, failed CFI) would burn the
    // gesture's one chance, so a real selection arriving moments later on another event is dropped.
    expect(at("this.gestureRaised = true;")).toBeGreaterThan(at("view.getCFI(index, range)"));
    expect(at("this.gestureRaised = true;")).toBeLessThan(at("this.emitSelection({ cfi, text,"));
  });

  it("is reset when a new gesture starts, beside the existing downSelText bookkeeping", () => {
    // Anchored on the SELECTION gesture's own bookkeeping, not on `pointerdown` — the file registers
    // more than one pointerdown listener and the first is a different concern entirely. That
    // ambiguity was what this test caught on its first run.
    const down = after('this.downSelText = doc.getSelection()?.toString() ?? "";', 260);
    expect(down).toContain("this.gestureRaised = false;");
  });

  it("the flag is private to the controller", () => {
    expect(SRC).toContain("private gestureRaised = false;");
  });
});
