// THE COMPOSER AT NARROW WIDTHS — the geometry, and the state it drives.
//
// THE DEFECT, measured in the running composer (RTL, a text element selected). The workspace is a
// two-column grid — 288px rail, then the rest — with the inspector as an overlay pinned to the
// inline end and its room held open by a STATIC `padding-inline-end: 372px` on `.pcx-work`. The card
// was fitted to the leftover through `Math.max(240, …)`, so below 240px of leftover it stopped
// shrinking while the box kept shrinking, and the difference spilled back out of the content box
// underneath the panel the padding was reserving for:
//
//     viewport   content   stage   overflow   consequence
//       1004       238      240        2      the floor engages
//        950       187      240       53      the toolbar's colour swatch is unreachable
//        820        65      240      175      the card cannot be selected at all
//        760         8      240      232
//
// Width alone: 1280×600 was clean, 900×1000 failed exactly as 900×700 did.
//
// What is asserted here is the arithmetic that now decides it. The rendered result — panel away,
// reservation released, card and toolbar reachable at every width from 1440 down to 760 — is proved
// by the harness against the real composer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectorFits, stageRoom, STAGE_MIN, STAGE_MIN_HYST } from "../../src/features/photo/workspace";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");

/** The stylesheet's own numbers, and the rail the grid gives away before either of them. */
const RESERVE = 372;
const GUTTER = 44;
const RAIL = 288;
/** The workspace's border box at a given window width — modal is `min(1840px, 94vw)`. */
const workAt = (viewport: number) => Math.min(1840, viewport * 0.94) - RAIL;
/**
 * The model leaves out the hairlines the real layout carries — the rail's `border-inline-end`, the
 * modal's own edge — so it lands within a couple of pixels of the browser rather than exactly on it.
 * Asserting to the pixel would be asserting the borders, which is not what these numbers are for.
 */
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(3);

describe("when the inspector still fits beside the card", () => {
  it("keeps it at every width that works today", () => {
    // 1440/1280/1120/1024 were all measured working before the change and must be untouched.
    for (const v of [1440, 1280, 1120, 1024]) {
      expect(inspectorFits(workAt(v), RESERVE, GUTTER, true), `${v}px`).toBe(true);
    }
  });

  it("gives it up exactly where the room runs out, not before", () => {
    // The card began overflowing at 1004px; that is the threshold and nothing earlier.
    expect(inspectorFits(workAt(1024), RESERVE, GUTTER, true)).toBe(true);
    expect(inspectorFits(workAt(1000), RESERVE, GUTTER, true)).toBe(false);
    for (const v of [950, 900, 820, 760]) {
      expect(inspectorFits(workAt(v), RESERVE, GUTTER, true), `${v}px`).toBe(false);
    }
  });

  it("asks for more room to come back than it took to leave", () => {
    // Without this a window dragged along the boundary flaps the panel on every frame. Measured in
    // the running composer: 1024 keeps the panel on the way down and stays closed on the way up.
    const w = workAt(1024);
    expect(inspectorFits(w, RESERVE, GUTTER, true), "already open").toBe(true);
    expect(inspectorFits(w, RESERVE, GUTTER, false), "currently closed").toBe(false);
    expect(STAGE_MIN_HYST).toBeGreaterThan(0);
  });

  it("is decided by width alone", () => {
    // The same width answers the same way whatever the height is — height never enters the sum.
    expect(inspectorFits(workAt(900), RESERVE, GUTTER, true)).toBe(false);   // 900×700 and 900×1000
    expect(inspectorFits(workAt(1280), RESERVE, GUTTER, true)).toBe(true);   // 1280×800 and 1280×600
  });
});

describe("the room the stage actually gets", () => {
  it("is unchanged while the panel is there", () => {
    // The measured content boxes before the change, which must still be the content boxes after it.
    near(stageRoom(workAt(1440), RESERVE, GUTTER, true), 648);
    near(stageRoom(workAt(1280), RESERVE, GUTTER, true), 497);
    near(stageRoom(workAt(1120), RESERVE, GUTTER, true), 347);
    near(stageRoom(workAt(1024), RESERVE, GUTTER, true), 257);
  });

  it("reclaims the reservation once the panel steps aside", () => {
    // 760px was 8px of usable stage. It is not any more.
    expect(stageRoom(workAt(760), RESERVE, GUTTER, true)).toBeLessThan(STAGE_MIN);
    near(stageRoom(workAt(760), RESERVE, GUTTER, false), 336);
    near(stageRoom(workAt(900), RESERVE, GUTTER, false), 468);
  });

  it("never leaves a stage too small to work on, at any width it hands over at", () => {
    // The pairing is the point: wherever `inspectorFits` says no, the SOLO room must be usable.
    for (let v = 760; v <= 1440; v += 20) {
      const w = workAt(v);
      const open = inspectorFits(w, RESERVE, GUTTER, true);
      const room = stageRoom(w, RESERVE, GUTTER, open);
      expect(room, `${v}px (panel ${open ? "open" : "away"})`).toBeGreaterThanOrEqual(STAGE_MIN);
    }
  });

  it("has no floor of its own — an honest box, or nothing", () => {
    // `Math.max(240, …)` is what let the card claim room it did not have. A tiny box now returns a
    // tiny number rather than a comfortable lie; only a non-positive one is clamped.
    expect(stageRoom(300, RESERVE, GUTTER, true)).toBe(1);
    expect(stageRoom(0, RESERVE, GUTTER, false)).toBe(1);
    expect(stageRoom(500, RESERVE, GUTTER, false)).toBe(412);
  });
});

describe("the layout and the component agree about all this", () => {
  const CSS = read("src/styles/global.css");
  const COMPOSER = read("src/features/photo/PhotoComposer.tsx");
  const STRIP = read("src/features/photo/ObjectsStrip.tsx");

  it("declares the reservation once, and reads it back rather than repeating it", () => {
    expect(CSS).toContain("--pcx-insp-reserve: 372px");
    expect(CSS).toContain("--pcx-gutter: 44px");
    expect(CSS).toContain("padding-inline: var(--pcx-gutter) var(--pcx-insp-reserve)");
    expect(COMPOSER).toContain('getPropertyValue("--pcx-insp-reserve")');
    expect(COMPOSER).toContain('getPropertyValue("--pcx-gutter")');
  });

  it("releases the reservation when the panel is away", () => {
    expect(CSS).toContain(".pcx-work.solo { padding-inline: var(--pcx-gutter); }");
    expect(COMPOSER).toContain('`pcx-work${inspectorOpen ? "" : " solo"}`');
  });

  it("wires the inspectorOpen prop that was passed a literal", () => {
    expect(COMPOSER).toContain("inspectorOpen={inspectorOpen}");
    expect(COMPOSER).not.toMatch(/^\s+inspectorOpen$/m);
    expect(COMPOSER).toContain("const inspectorOpen = inspectorChoice ?? inspectorHasRoom;");
  });

  it("offers the way back only where the room is tight, and never traps the reader", () => {
    expect(COMPOSER).toContain("onToggleInspector={inspectorHasRoom ? undefined : ");
    expect(STRIP).toContain("onToggleInspector &&");
    expect(STRIP).toContain('className={`pcx-insp-toggle${inspectorOpen ? " on" : ""}`}');
  });

  it("does not carry a narrow choice back into a wide window", () => {
    expect(COMPOSER).toContain("useEffect(() => { setInspectorChoice(null); }, [inspectorHasRoom]);");
  });

  it("keeps the inspector an overlay rather than making it a column", () => {
    // The design decision this change had to respect. `.pcx-insp` stays absolutely positioned; only
    // whether it is rendered changed.
    const rule = CSS.slice(CSS.indexOf(".pcx-insp {"), CSS.indexOf(".pcx-insp {") + 200);
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("inset-inline-end: 0");
    expect(CSS).not.toContain("grid-template-columns: 288px 1fr 348px");
  });
});
