// FLOATING SURFACES: WHERE THEY ARE DRAWN, AND WHERE THEY LAND.
//
// THE DEFECT, measured in the running photo composer. The colour picker opened underneath the
// inspector. It was not for want of a z-index — the picker already carried `z-index: 46` against the
// inspector's 34, and still lost, because it sits inside `.pcx-tb`, which is
// `position: absolute; z-index: 32` and therefore a stacking context of its own. 46 was being ranked
// among the toolbar's children, and the whole toolbar paints at 32.
//
// Measured with `elementsFromPoint` over the overlap, at four widths:
//   1440×900  overlap 112×286 → INSPECTOR      1120×760  overlap 236×283 → INSPECTOR
//   1280×800  overlap 187×285 → INSPECTOR      1024×700  overlap 236×283 → INSPECTOR
// and at 900×700 the inspector covered the toolbar's own swatch, so the picker could not be opened:
//   textarea.pcx-text · section.pcx-sec · aside.pcx-insp  ABOVE  button.pcx-tb-swatch.
//
// So the fix cannot be a number. A descendant cannot outrank its ancestor's context, and the answer
// Sard already had for this is `overlayHost` — the portal target the Library's menus use. What is
// guarded here is the ARITHMETIC half, which the portal does not solve: a panel freed from its
// parent can still be placed off the side of the window.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { placeAnchored } from "../../src/features/library/design/overlay";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");

const VIEW = { width: 1200, height: 800 };
const PANEL = { width: 236, height: 276 };
const trigger = (left: number, top: number) => ({ left, top, width: 29, height: 29 });

describe("an anchored panel is centred on its trigger", () => {
  it("sits centred, just below it, when there is room", () => {
    const a = trigger(600, 200);
    const p = placeAnchored(a, PANEL, VIEW);
    expect(p.left + PANEL.width / 2).toBe(a.left + a.width / 2);
    expect(p.top).toBe(a.top + a.height + 9);
    expect(p.flipped).toBe(false);
  });

  it("keeps the gap it was given", () => {
    const p = placeAnchored(trigger(600, 200), PANEL, VIEW, { gap: 20 });
    expect(p.top).toBe(200 + 29 + 20);
  });
});

describe("an anchored panel never leaves the window", () => {
  // The failure this prevents is the one a portal INTRODUCES: freed from the column that used to
  // contain it, a panel is free to hang off the window instead.
  const corners = [
    ["start edge", trigger(2, 200)],
    ["end edge", trigger(VIEW.width - 31, 200)],
    ["past the end", trigger(VIEW.width + 40, 200)],
    ["top", trigger(600, 0)],
    ["bottom", trigger(600, VIEW.height - 31)],
    ["bottom corner", trigger(VIEW.width - 31, VIEW.height - 31)],
  ] as const;

  for (const [where, a] of corners) {
    it(`stays inside from the ${where}`, () => {
      const p = placeAnchored(a, PANEL, VIEW);
      expect(p.left, "left").toBeGreaterThanOrEqual(8);
      expect(p.top, "top").toBeGreaterThanOrEqual(8);
      expect(p.left + PANEL.width, "right").toBeLessThanOrEqual(VIEW.width - 8);
      expect(p.top + PANEL.height, "bottom").toBeLessThanOrEqual(VIEW.height - 8);
    });
  }

  it("flips above the trigger when there is no room below and there is room above", () => {
    const a = trigger(600, VIEW.height - 60);
    const p = placeAnchored(a, PANEL, VIEW);
    expect(p.flipped).toBe(true);
    expect(p.top + PANEL.height).toBeLessThanOrEqual(a.top - 9 + 1);
  });

  it("does not flip when below still fits", () => {
    expect(placeAnchored(trigger(600, 100), PANEL, VIEW).flipped).toBe(false);
  });

  it("pins a panel taller than the window to the top rather than centring it out of reach", () => {
    const tall = { width: 236, height: VIEW.height + 200 };
    const p = placeAnchored(trigger(600, 400), tall, VIEW);
    expect(p.top).toBe(8);
  });

  it("pins a panel wider than the window to the start edge", () => {
    const wide = { width: VIEW.width + 100, height: 200 };
    expect(placeAnchored(trigger(600, 200), wide, VIEW).left).toBe(8);
  });
});

describe("the composer's floating surfaces leave its stacking contexts", () => {
  const COMPOSER = read("src/features/photo/PhotoComposer.tsx");
  const TOOLBAR = read("src/features/photo/CardToolbar.tsx");
  const PICKER = read("src/features/photo/ColourPicker.tsx");
  const CSS = read("src/styles/global.css");

  it("the composer offers a host of its own, inside its own token root", () => {
    // Inside `.pcx-modal`, because that is where `--pc-*` is defined. The Library's note records
    // what portalling outside the token root costs: a transparent, borderless panel.
    expect(COMPOSER).toContain("<div className={OVERLAY_HOST_CLASS} />");
    expect(COMPOSER).toContain('import { OVERLAY_HOST_CLASS } from "../library/design/overlay"');
  });

  it("the toolbar's picker is anchored, so it is drawn there", () => {
    expect(TOOLBAR).toContain("anchor={swatchRef}");
    expect(PICKER).toContain("createPortal(body, overlayHost(anchor?.current ?? null))");
  });

  it("asks for the NEAREST host, not the first in the document", () => {
    // A composer opened over the Library must not portal into the Library's host behind it.
    const OVERLAY = read("src/features/library/design/overlay.ts");
    expect(OVERLAY).toContain("for (let e: Element | null = from ?? null; e; e = e.parentElement)");
    expect(OVERLAY).toContain('e.querySelector<HTMLElement>(":scope > ." + OVERLAY_HOST_CLASS)');
  });

  it("does not answer a stacking problem with a bigger number", () => {
    // The floating variant carries NO z-index at all: the host is already the modal's top layer, and
    // a rank inside it would only restart the argument that produced this bug.
    const rule = CSS.slice(CSS.indexOf(".pcx-pick--float"), CSS.indexOf(".pcx-pick--float") + 120);
    expect(rule).toContain("position: fixed");
    expect(rule).not.toContain("z-index");
  });

  it("still places the panel with the shared arithmetic rather than its own", () => {
    expect(PICKER).toContain("placeAnchored(");
    // and not by hand-rolling the clamp again
    expect(PICKER).not.toMatch(/Math\.min\(top, window\.innerHeight/);
  });
});
