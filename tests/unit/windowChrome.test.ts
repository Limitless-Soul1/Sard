// THE WINDOW'S OWN FRAME — when it is on screen at all.
//
// The defect this pins: a maximized frame-less window that went fullscreen kept the frame on screen
// and the surfaces offset under it, because the page never heard a resize (window_chrome.rs has the
// platform reason). The frame's decision is one pure function; the fullscreen transition itself is
// verified at runtime (tests/harness/fullscreen-frame.mjs), since no DOM shim can answer it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frameShown } from "../../src/components/windowChromeState";

describe("window frame · rendered only on a frame-less window that is not fullscreen", () => {
  it("normal and maximized windows carry the frame", () => {
    expect(frameShown({ decorated: false, fullscreen: false })).toBe(true);
  });
  it("native fullscreen withdraws it entirely", () => {
    expect(frameShown({ decorated: false, fullscreen: true })).toBe(false);
  });
  it("a window the OS decorates never gets one", () => {
    expect(frameShown({ decorated: true, fullscreen: false })).toBe(false);
    expect(frameShown({ decorated: true, fullscreen: true })).toBe(false);
  });
  it("draws nothing before the window has answered", () => {
    expect(frameShown({ decorated: null, fullscreen: false })).toBe(false);
  });
});

describe("window frame · no layout footprint without the frame", () => {
  const CSS = readFileSync(join(import.meta.dirname, "..", "..", "src/styles/global.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  it("every offset the surfaces take for the frame is keyed on the root attribute the frame sets", () => {
    // `--sard-titlebar` is declared under `[data-chrome="sard"]` only, and every consumer of it is
    // scoped the same way — so when the frame is not rendered, nothing reserves its height.
    const declared = [...CSS.matchAll(/([^{}]+)\{[^{}]*--sard-titlebar\s*:[^{}]*\}/g)].map((m) => m[1].trim());
    expect(declared.length).toBeGreaterThan(0);
    for (const sel of declared) expect(sel).toMatch(/\[data-chrome="sard"\]/);
    const consumers = [...CSS.matchAll(/([^{}]+)\{[^{}]*var\(--sard-titlebar[^{}]*\}/g)]
      .map((m) => m[1].trim())
      .filter((sel) => !/^\.wc\b/.test(sel)); // the frame's own height rule only applies while it exists
    expect(consumers.length).toBeGreaterThan(0);
    for (const sel of consumers) expect(sel, `${sel} reserves the frame's height unconditionally`).toMatch(/\[data-chrome="sard"\]/);
  });
});

describe("window frame · the controls read as window controls", () => {
  const CSS = readFileSync(join(import.meta.dirname, "..", "..", "src/styles/global.css"), "utf8");
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  /** The declarations of one rule, found by its exact selector — no regex escaping to get wrong. */
  const rule = (selector: string) => {
    for (const block of bare.split("}")) {
      const at = block.indexOf("{");
      if (at < 0) continue;
      const selectors = block.slice(0, at).split(",").map((s) => s.trim());
      if (selectors.includes(selector)) return block.slice(at + 1);
    }
    return "";
  };

  it("keeps the 34×24 pad, painted where it always was", () => {
    const btn = rule(".wc-btn");
    expect(btn).toMatch(/width:\s*34px/);
    expect(btn).toMatch(/padding:\s*0/);
    expect(btn).toMatch(/margin:\s*0/);
    // The PAINTED pad is the plate, and it is still 24px tall: the control's height minus 4px at the
    // top and 4px at the bottom. MEASURED after the change: the plate is 34×24 starting at y=4 on all
    // three controls, and a capture of the cluster at rest and under the pointer is byte-identical to
    // the one taken before it.
    expect(rule(".wc-btn::before")).toMatch(/inset:\s*calc\(\(var\(--sard-titlebar, 32px\) - 24px\) \/ 2\) 0/);
  });

  it("the control is as tall as the bar, so no strip above or below it belongs to the frame", () => {
    // THE DEFECT THIS FIXES. A 24px control centred in a 32px bar leaves 4px above and 4px below that
    // belong to `.wc`, a `deep` drag region — so a press there starts a window drag and no click is
    // ever delivered. MEASURED in the running window, pressing every pixel row of the bar at the left
    // edge, centre and right edge of each control: 72 of 288 points missed, all of them on rows 0–3
    // and 28–31, 24 per control, every one landing on a window drag. After: 0 of 288.
    expect(rule(".wc-btn")).toMatch(/height:\s*var\(--sard-titlebar, 32px\)/);
    // …and the control may never be taller than the bar, which would put its hit area over the page.
    expect(rule(".wc")).toMatch(/height:\s*var\(--sard-titlebar, 32px\)/);
  });

  it("Close reaches the window's edge, and its plate does not move to get there", () => {
    // The bar used to reserve 6px to its right, and that strip is `.wc`, a `deep` drag region — so a
    // press there dragged the window instead of closing, and on a maximised window that strip holds the
    // screen's top-right corner. The 6px is Close's own padding now: the control is 40px wide and ends
    // at the edge, its content box is still 34px so the glyph does not move, and the plate is inset by
    // the same 6px so it is painted exactly where it was. MEASURED after: Close answers on all 1280
    // points of its region including the last pixel column, the other two controls are unmoved and lose
    // nothing (2176 points), and captures of the bar's right end are byte-identical.
    expect(rule(".wc")).toMatch(/padding:\s*0\s*;/);        // never a strip of frame beside the cluster
    expect(rule(".wc-close")).toMatch(/width:\s*40px/);
    expect(rule(".wc-close")).toMatch(/padding-right:\s*6px/);
    expect(rule(".wc-close::before")).toMatch(/right:\s*6px/);
  });

  it("leaves no gap between adjacent controls", () => {
    // A gap is a strip that looks like the cluster but belongs to the frame: a press there drags the
    // window instead of pressing the control it appears to be part of.
    expect(rule(".wc-controls")).toMatch(/gap:\s*0\b/);
  });

  it("rest carries no plate at all", () => {
    expect(rule(".wc-btn")).toMatch(/background:\s*transparent/);
    expect(rule(".wc-btn::before")).toMatch(/background:\s*transparent/);
  });

  it("the hit area is the whole rectangle: the plate is painted, not hit-tested", () => {
    // A radius on the control clips its own hit area, and with the pads adjacent those corner notches
    // belong to the frame — a press a pixel inside the cluster would drag the window.
    expect(rule(".wc-btn")).toMatch(/border-radius:\s*0/);
    expect(rule(".wc-btn::before")).toMatch(/border-radius:\s*5px/);
    expect(rule(".wc-btn:focus-visible")).not.toMatch(/border-radius/);
    // The ring belongs to the PLATE, not to the control's box — the box is the full height of the bar
    // now, and a ring at its edges would be taller than the pad it marks.
    expect(rule(".wc-btn:focus-visible")).toMatch(/outline:\s*none/);
    expect(rule(".wc-btn:focus-visible::before")).toMatch(/outline:\s*1\.5px solid var\(--accent\)/);
  });

  it("hover, pressed and focus are three different answers", () => {
    expect(rule(".wc-btn:hover::before")).toMatch(/background:\s*color-mix\(in srgb, var\(--text\) 10%/);
    expect(rule(".wc-btn:active::before")).toMatch(/background:\s*color-mix\(in srgb, var\(--text\) 18%/);
    expect(rule(".wc-btn:hover")).toMatch(/color:\s*var\(--text\)/);
    expect(rule(".wc-btn:focus-visible::before")).toMatch(/outline:.*var\(--accent\)/);
  });

  it("a press is immediate and sinks the glyph a pixel, without moving the layout", () => {
    expect(rule(".wc-btn:active")).toMatch(/transition:\s*none/);
    expect(rule(".wc-btn:active::before")).toMatch(/transition:\s*none/);
    const glyph = rule(".wc-btn:active > svg");
    expect(glyph).toMatch(/transform:\s*translateY\(1px\)/);
    expect(glyph).toMatch(/transition:\s*none/);
    expect(rule(".wc-btn > svg")).toMatch(/transition:\s*transform 0\.1s/); // and returns over ~100 ms
    // nothing in any state changes the box the control occupies
    for (const sel of [".wc-btn:hover", ".wc-btn:active", ".wc-close:hover", ".wc-close:active",
      ".wc-btn:hover::before", ".wc-btn:active::before", ".wc-close:hover::before", ".wc-close:active::before"]) {
      expect(rule(sel), `${sel} must not resize or displace the control`).not.toMatch(/\b(width|height|padding|margin|inset|top|left|right|bottom)\s*:/);
    }
  });

  it("Close answers in Sard's own destructive reds, and only while it is being used", () => {
    expect(rule(".wc-close:hover::before")).toMatch(/background:\s*#b24a4a/);
    expect(rule(".wc-close:active::before")).toMatch(/background:\s*#9c3b3b/);
    expect(rule(".wc-close:hover")).toMatch(/color:\s*#fff/);
    // at rest it is the same quiet control as the other two: no red anywhere outside hover/active
    expect(bare).not.toMatch(/\.wc-close\s*\{[^{}]*#b24a4a/);
    expect(bare).not.toMatch(/\.wc-close\s*\{[^{}]*#9c3b3b/);
  });

  it("the frame itself stays the opaque chrome ground", () => {
    const wc = rule(".wc");
    expect(wc).toMatch(/background:\s*var\(--chrome-bg\)/);
    expect(wc).not.toMatch(/backdrop-filter/);
    expect(wc).not.toMatch(/rgba?\(/);
  });
});
