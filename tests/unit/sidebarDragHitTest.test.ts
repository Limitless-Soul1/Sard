// THE TEST THAT WOULD HAVE CAUGHT A GESTURE THAT NEVER REACHED ITS HANDLER.
//
// WHAT WENT WRONG. The first runtime probe for this interaction dispatched `pointerdown` ON THE ROW
// DIV. That asserts "the handler works when it is called" while assuming the half that actually
// broke: that a press lands somewhere the handler ever hears about. A real press lands on whatever
// is topmost at that point — inside a shelf row, a `<span>` inside the navigate `<button>` — and only
// reaches the row by bubbling. A probe that skips the hit test cannot see a row that is covered,
// clipped, or `pointer-events: none`.
//
// It was covered. Every early run was made against a fresh profile, which shows the legal gate —
// `position: fixed; inset: 0; z-index: 400` across the whole window — so `elementFromPoint` at a
// shelf row returned the gate and no human could have touched the row at all. Eighteen checks passed
// against a UI nobody could use.
//
// WHAT THIS FILE CAN AND CANNOT DO. The suite runs in `node` with no DOM and no layout engine, by the
// deliberate choice recorded in vitest.config.ts — jsdom cannot answer a hit test any more honestly
// than dispatching directly would. So this does NOT reproduce hit-testing. It pins the CONTRACT the
// runtime probe must satisfy, so the probe cannot quietly go back to the shortcut that hid this:
// the press must be aimed through `document.elementFromPoint`, and the legal gate must be cleared
// before anything is measured. The hit test itself is answered by the runtime pass, in the engine.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const DRAG = read("src/features/library/design/rowDrag.ts");
const CHROME = read("src/features/library/design/Chrome.tsx");
const GATE = read("src/features/legal/LegalGate.tsx");

describe("what a press has to travel through to reach the drag", () => {
  it("the shelf row is the handle, so the press must bubble from a child", () => {
    // There is no grip on a shelf row — the row itself answers the press. Every pixel a reader can
    // aim at is therefore a descendant, and the gesture depends entirely on bubbling.
    expect(CHROME).toContain("onPointerDown={draggable ? (e) => rowDrag.begin(e, s.id, siblings!) : undefined}");
    // The row's own children must not stop it on the way up. They handle `click`, never `pointerdown`.
    const row = CHROME.slice(CHROME.indexOf("const shelfRow ="), CHROME.indexOf("return (", CHROME.indexOf("const shelfRow =")) + 12000);
    const pointerHandlers = row.match(/onPointerDown=/g) ?? [];
    expect(pointerHandlers).toHaveLength(1); // the row's own, and nothing inside it
  });

  it("the case grip is pressed directly, which is why it never had this failure", () => {
    // Stated so the asymmetry is on the record: the case path cannot be broken by a covering layer
    // in the way the shelf path can, because its handle is the thing under the pointer.
    expect(CHROME).toContain("rowDrag.begin(e, c.id, props.cases.map((x) => x.id))");
  });

  it("nothing in the hook depends on the press landing on the row itself", () => {
    // `begin` resolves the row from the registered map by id, not from the event's target — so a
    // press on a child is as good as a press on the row, which is what makes bubbling sufficient.
    expect(DRAG).toContain("const self = rows.current.get(id);");
    expect(DRAG).not.toMatch(/e\.target as HTML/);
  });
});

describe("the legal gate, which hid all of this", () => {
  it("really does cover the whole window when it is up", () => {
    // If this ever stops being true the note above becomes misleading, so it is pinned.
    expect(GATE).toContain('className="libd-root"');
    expect(GATE).toMatch(/position:\s*"fixed",\s*inset:\s*0,\s*zIndex:\s*400/);
  });

  it("is cleared by a setting the runtime probe can write", () => {
    expect(GATE).toContain('export const LEGAL_KEY = "legal_accepted_revision";');
  });
});

// ── the runtime probe's own contract ─────────────────────────────────────────────────────────────
//
// The probe lives outside the repository (it drives a built binary), so this checks it only when it
// is present. That keeps the suite honest on a clean checkout rather than failing for a file that
// was never meant to be committed.
const PROBE = join(
  process.env.TEMP ?? "",
  "claude/m--eRawy/7bde0a64-5426-4737-a2f6-a538db3c2590/scratchpad/shelf-real.mjs",
);

describe("the runtime probe aims the way a mouse does", () => {
  it.skipIf(!existsSync(PROBE))("presses through elementFromPoint, and clears the gate first", () => {
    const probe = readFileSync(PROBE, "utf8");
    expect(probe).toContain("document.elementFromPoint");
    expect(probe).toContain("legal_accepted_revision");
    // and it must NOT go back to dispatching on the row
    expect(probe).not.toMatch(/el\.dispatchEvent\(mk\("pointerdown"/);
  });
});
