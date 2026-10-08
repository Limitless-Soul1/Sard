// THE "EXTRA BLUR IN IMMERSIVE MODE" CONTROL IS RETIRED — AND NOTHING ELSE IS.
//
// It sat under All Books › Reading desk and wrote `bg.reading.params.immersiveBlur`. That value stopped
// governing anything when the immersive recede stopped asking the هيئة; whether immersive mode dims the
// reading background is now the Background Dimming preference on the Layout tab. So the row was a switch
// wired to nothing, and its hover-preview — the only thing that ever raised `data-bg-imm-preview` —
// previewed an effect the row no longer controlled.
//
// What these tests hold, in both directions:
//   · the row, its strings and its preview wiring are gone;
//   · its neighbours in the reading-desk section are all still there, in their order;
//   · the immersive system on the Layout tab — master, its sub-options, Background Dimming, the shared
//     "immersive is off" note — is untouched (its behaviour is pinned in immersiveBackgroundDimming.test.ts);
//   · the stored field is NOT removed: existing هيئات and packages carry it, and the two tests that keep
//     it parsed and stored (immersiveBackgroundDimming / immersiveRecedeOwnership) still stand.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const PANEL = read("src/features/reader/ReadingSettings.tsx");
const CSS = read("src/styles/global.css");

// The All Books reading-desk section: its own component, up to the next top-level function.
const start = PANEL.indexOf("function ReadingBackgroundSection()");
const DESK = PANEL.slice(start, PANEL.indexOf("\nfunction ", start + 1));

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

describe("All Books › Reading desk", () => {
  it("is found, so the checks below are about the real section", () => {
    expect(start).toBeGreaterThan(-1);
    expect(DESK).toContain('t("gs.bgReading")');
  });

  it("no longer offers the extra-blur control", () => {
    expect(DESK).not.toContain("gs.bg.immBlur");
    expect(DESK).not.toContain("immersiveBlur");
    expect(PANEL).not.toContain("gs.bg.immBlur");
  });

  it("leaves none of that control's wiring behind", () => {
    // The hover-preview existed for that one row: the handler, its unmount cleanup, ToggleRow's
    // optional `onPreview`, and the two stylesheet rules keyed on the attribute it raised.
    expect(PANEL).not.toContain("previewImmersiveBlur");
    expect(PANEL).not.toContain("bgImmPreview");
    expect(PANEL).not.toContain("onPreview");
    expect(CSS).not.toContain("data-bg-imm-preview");
  });

  it("keeps every other control of the section, in its order", () => {
    const order = ['t("gs.bg.presence")', 't("gs.bg.blur")', 't("gs.bg.pageOpacity")', 't("gs.bg.focal")']
      .map((k) => DESK.indexOf(k));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Blur is followed directly by page opacity now: no row is left between them.
    const between = DESK.slice(order[1], order[2]);
    expect(between).not.toContain("<ToggleRow");
  });

  it("the strings are gone from both locales", () => {
    for (const k of ["gs.bg.immBlur", "gs.bg.immBlurHint"]) {
      expect(has(en, k), `en ${k}`).toBe(false);
      expect(has(ar, k), `ar ${k}`).toBe(false);
    }
  });
});

describe("the immersive system on the Layout tab is untouched", () => {
  it("the master toggle is still bound to the global flag", () => {
    expect(PANEL).toContain('label={t("type.immersive")}');
    expect(PANEL).toContain("on={immersive}");
    expect(PANEL).toContain("setImmersive(!immersive)");
  });

  it("its three sub-options are all still there, inert while the master is off", () => {
    for (const k of ["type.immHidePill", "type.immHideScrollbar", "type.immDim"]) {
      const row = PANEL.split("\n").find((l) => l.includes(`t("${k}")`));
      expect(row, k).toBeDefined();
      expect(row!, k).toContain("sub disabled={!immersive}");
    }
    const dim = PANEL.split("\n").find((l) => l.includes('t("type.immDim")'))!;
    expect(dim).toContain("on={immersiveDim}");
    expect(dim).toContain("setImmersiveDim(!immersiveDim)");
  });

  it("the shared \"immersive is off\" note survives, once, on the Layout tab", () => {
    // It was shown twice — under the retired row too. The string stays; the Layout tab still uses it.
    expect(en["inert.immersiveOff"]).toBeTruthy();
    expect(ar["inert.immersiveOff"]).toBeTruthy();
    expect(count(PANEL, 't("inert.immersiveOff")')).toBe(1);
    expect(PANEL.indexOf('t("inert.immersiveOff")')).toBeGreaterThan(PANEL.indexOf('t("type.immDim")'));
  });
});
