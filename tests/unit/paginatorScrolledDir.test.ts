// THE SCROLLED-FLOW READING DIRECTION — a vendored patch that must survive re-vendoring.
//
// THE BUG THIS PINS. `paginator.js` decides the reading host's `dir` in two places. The PAGED branch
// derives it from the book:
//
//     this.setAttribute('dir', rtl ? 'rtl' : 'ltr')
//
// while the SCROLLED branch, upstream, derived it from `vertical` alone and dropped `rtl` entirely:
//
//     this.setAttribute('dir', vertical ? 'rtl' : 'ltr')      // <- upstream
//
// So a right-to-left book read in scrolled flow — Sard's default — got `dir="ltr"`, and the
// paginator's `#container` (overflow:auto, inside a CLOSED shadow root) put its vertical scrollbar on
// the RIGHT: the side an RTL line STARTS on. The iframe is `width:100%` of that container's CLIENT
// box, so the text column ends exactly where the scrollbar begins, with no gutter between them.
// Pressing just before a line's first character therefore landed on the scrollbar TRACK, which pages
// by one viewport — the reader appeared to jump, and no selection was made.
//
// MEASURED in the running app (Arabic book, 1400x900, scrolled flow): a press at x=1228 placed a
// caret and moved nothing; at x=1230 and x=1238 it produced no selection and scrolled `#container`
// 0 -> 984 -> 1771. No navigation API was called and no `relocate` fired, because the browser was
// scrolling a container rather than foliate navigating — which is why it stayed invisible to every
// public-API probe. The same matrix in an LTR book moved nothing at any of fifteen points.
//
// A runtime check proves the geometry in real Chromium. This file guards the one thing a unit test
// can guard: that the vendored source still honours `rtl` in the scrolled branch, so a future
// re-vendor cannot silently restore the defect. See LOCAL MODIFICATION 8 in VENDOR.txt.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const paginator = readFileSync(resolve(__dirname, "../../public/foliate-js/paginator.js"), "utf8");

/** The body of the `flow === 'scrolled'` branch, up to its `return`. */
const scrolledBranch = (() => {
  const i = paginator.indexOf("if (flow === 'scrolled')");
  expect(i, "the scrolled-flow branch should still exist in the vendored paginator").toBeGreaterThan(0);
  const end = paginator.indexOf("return { flow, margin, gap, columnWidth }", i);
  expect(end, "the scrolled branch should still end with its layout return").toBeGreaterThan(i);
  return paginator.slice(i, end);
})();

describe("the vendored paginator sets the reading direction from the book", () => {
  it("reads the book's rtl flag in SCROLLED flow, not only vertical", () => {
    const i = scrolledBranch.indexOf("setAttribute('dir'");
    expect(i, "the scrolled branch should still set dir").toBeGreaterThan(0);
    const call = scrolledBranch.slice(i, scrolledBranch.indexOf(")", i) + 1);
    // `'rtl'` is an ARGUMENT either way, so its presence proves nothing; what must survive is a read
    // of the `rtl` binding. Upstream's expression tests `vertical` alone.
    const readsFlag = call.includes("|| rtl") || call.includes("rtl ?");
    expect(readsFlag, "expected the dir expression to consult rtl, got: " + call).toBe(true);
  });

  it("does not carry upstream's rtl-blind expression", () => {
    // The exact upstream line. Its return would put the scrollbar back on an RTL line's start edge.
    expect(scrolledBranch).not.toContain("this.setAttribute('dir', vertical ? 'rtl' : 'ltr')");
  });

  it("still leaves an LTR book LTR", () => {
    // `vertical || rtl` is false for a horizontal left-to-right book, so the attribute resolves to
    // 'ltr' exactly as before the patch — the guard is that the ternary's false arm is untouched.
    expect(scrolledBranch).toContain("'ltr'");
  });

  it("leaves the paged branch deriving dir from the book, as it always did", () => {
    const paged = paginator.slice(paginator.indexOf("return { flow, margin, gap, columnWidth }"));
    expect(paged).toContain("this.setAttribute('dir', rtl ? 'rtl' : 'ltr')");
  });

  it("keeps the modification recorded for the next re-vendor", () => {
    const vendor = readFileSync(resolve(__dirname, "../../public/foliate-js/VENDOR.txt"), "utf8");
    expect(vendor).toContain("LOCAL MODIFICATIONS");
    expect(vendor).toContain("SCROLLED FLOW HONOURS THE BOOK'S DIRECTION");
  });
});
