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

  it("keeps the 34×24 pad and takes no more room than that", () => {
    const btn = rule(".wc-btn");
    expect(btn).toMatch(/width:\s*34px/);
    expect(btn).toMatch(/height:\s*24px/);
    expect(btn).toMatch(/padding:\s*0/);
    expect(btn).toMatch(/margin:\s*0/);
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
    expect(rule(".wc-btn::before")).toMatch(/inset:\s*0/);
    expect(rule(".wc-btn:focus-visible")).not.toMatch(/border-radius/);
  });

  it("hover, pressed and focus are three different answers", () => {
    expect(rule(".wc-btn:hover::before")).toMatch(/background:\s*color-mix\(in srgb, var\(--text\) 10%/);
    expect(rule(".wc-btn:active::before")).toMatch(/background:\s*color-mix\(in srgb, var\(--text\) 18%/);
    expect(rule(".wc-btn:hover")).toMatch(/color:\s*var\(--text\)/);
    expect(rule(".wc-btn:focus-visible")).toMatch(/outline:.*var\(--accent\)/);
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
