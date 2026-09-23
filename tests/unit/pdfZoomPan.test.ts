// PDF ZOOM RANGE, PANNING, AND THE READING CHROME IN A PDF.
//
// Four things were MEASURED in the running application before any of this changed:
//   1. The zoom range was 0.5x–6x of the PDF's own size, in the interface only. 0.5x was 64% of
//      "whole page" in an 1100x720 window and ~32% on a 2560x1440 screen; the renderer itself took any
//      number (0.25x drew a 149px page).
//   2. In Pages mode, at 300%, the left 384px of an A4 page could never be scrolled to: the paged
//      renderer centred an oversized page with plain `center`, so it overflowed past the scroll origin.
//   3. A mouse could not grab a zoomed page; Shift+wheel did not move a Pages-mode page sideways.
//   4. In a PDF, scrolling never hid or restored the reading chrome (EPUB scrolled mode did both).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — a plain ES module served from public/, with no type declarations.
import { zoomBounds, clampZoom, MIN_OF_FIT_PAGE, MAX_PAGE_DEVICE_PIXELS } from "../../public/foliate-js/sard-zoom.js";
import { wheelAxes } from "../../src/reader-engine/FoliateController";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const scroll = read("public/foliate-js/fixed-layout-scroll.js");
const paged = read("public/foliate-js/fixed-layout.js");
const controller = read("src/reader-engine/FoliateController.ts");
const reader = read("src/features/reader/Reader.tsx");
const css = read("src/styles/global.css");
const vendor = read("public/foliate-js/VENDOR.txt");

// An A4 page (595x842 pt) in the two windows the measurements were taken in.
const A4 = { width: 594.96, height: 841.92 };
const small = { ...A4, fitPage: 0.7744, fitWidth: 1.7178, dpr: 1 };
const large = { ...A4, fitPage: 1.58, fitWidth: 2.24, dpr: 1 };

describe("one zoom range, stated in what the reader sees", () => {
  it("the floor is half of 'whole page' — the same fraction of the screen on any window", () => {
    expect(MIN_OF_FIT_PAGE).toBe(0.5);
    expect(zoomBounds(small).min).toBeCloseTo(0.3872, 4);
    expect(zoomBounds(large).min).toBeCloseTo(0.79, 4);
  });

  it("the ceiling is a bitmap budget: one page never paints more than 2^24 device pixels", () => {
    expect(MAX_PAGE_DEVICE_PIXELS).toBe(2 ** 24);
    const { max } = zoomBounds(small);
    expect(A4.width * max * A4.height * max).toBeLessThanOrEqual(2 ** 24 + 1);
    // The measured case: 5.787x for A4 at density 1.
    expect(max).toBeCloseTo(5.787, 2);
  });

  it("a denser screen reaches the budget at a lower zoom, because that is where the cost is", () => {
    expect(zoomBounds({ ...small, dpr: 2 }).max).toBeCloseTo(zoomBounds(small).max / 2, 4);
  });

  it("a small page may be magnified further than a large one", () => {
    const postcard = { width: 300, height: 420, fitPage: 1.5, fitWidth: 3, dpr: 1 };
    const poster = { width: 1191, height: 1684, fitPage: 0.4, fitWidth: 0.9, dpr: 1 };
    expect(zoomBounds(postcard).max).toBeGreaterThan(zoomBounds(poster).max);
  });

  it("both fits always lie inside the range, so neither is ever clamped", () => {
    // A page so wide that "fit width" would exceed the budget: the range widens to contain it.
    const strip = { width: 100, height: 20000, fitPage: 0.03, fitWidth: 25, dpr: 1 };
    const b = zoomBounds(strip);
    expect(b.max).toBeGreaterThanOrEqual(25);
    expect(b.min).toBeLessThanOrEqual(0.03);
    for (const p of [small, large]) {
      const r = zoomBounds(p);
      expect(r.min).toBeLessThanOrEqual(p.fitPage);
      expect(r.max).toBeGreaterThanOrEqual(p.fitWidth);
    }
  });

  it("clamping holds a number to it", () => {
    const b = zoomBounds(small);
    expect(clampZoom(0.01, b)).toBe(b.min);
    expect(clampZoom(100, b)).toBe(b.max);
    expect(clampZoom(2, b)).toBe(2);
  });
});

describe("both renderers apply it — every zoom path lands inside the range", () => {
  it("Scroll renderer: a numeric zoom is clamped where the page and viewport are known", () => {
    expect(scroll).toContain("import { zoomBounds, clampZoom } from './sard-zoom.js'");
    expect(scroll).toContain("return clampZoom(this.#zoom, zoomBounds(f))");
    expect(scroll).toContain("get zoomBounds()");
  });

  it("Scroll renderer: 'whole page' is measured against the reading area, not what a scrollbar leaves", () => {
    const fits = scroll.slice(scroll.indexOf("    #fits() {"), scroll.indexOf("    get zoomBounds()"));
    expect(fits).toContain("this.#scroller.offsetHeight");
    expect(fits).not.toContain("clientHeight");
  });

  it("Pages renderer (vendored): the same rule, as a registered local patch", () => {
    expect(paged).toContain("import { zoomBounds, clampZoom } from './sard-zoom.js'   // SARD LOCAL PATCH 14a");
    expect(paged).toContain("? clampZoom(this.#zoom, zoomBounds(this.#fits))");
    expect(paged).toContain("get zoomBounds()");
    expect(vendor).toMatch(/^ 14\. .*fixed-layout\.js/m);
  });

  it("the interface reads the range back instead of keeping its own", () => {
    expect(controller).toContain("pdfZoomBounds(): PdfZoomBounds | null");
    expect(reader).toContain("zoomForWheel(from, deltaY, ctrlRef.current?.pdfZoomBounds())");
    expect(reader).toContain("const z = clampPdfZoom(raw, ctrlRef.current?.pdfZoomBounds());");
  });
});

describe("a zoomed page can be reached everywhere", () => {
  it("Pages renderer centres with `safe center`, so an oversized page starts at the scroll origin", () => {
    expect(paged).toContain("justify-content: safe center;");
    expect(paged).toContain("align-items: safe center;");
    expect(paged).not.toMatch(/justify-content: center;\s*align-items: center;/);
  });

  it("a zoom keeps what was in the middle of the view in the middle", () => {
    const fn = controller.slice(controller.indexOf("  setPdfZoom(zoom: number"), controller.indexOf("  private pdfScroller()"));
    expect(fn).toContain("sc.scrollLeft = fx * sc.scrollWidth - sc.clientWidth / 2");
    expect(fn).toContain('if (fy != null && this.fxlMode === "pages")');
  });

  it("Shift+wheel is sideways on every path Sard forwards", () => {
    expect(wheelAxes(100, 0, true)).toEqual([0, 100]);
    expect(wheelAxes(100, 0, false)).toEqual([100, 0]);
    // A trackpad already carries a horizontal delta — it is left alone.
    expect(wheelAxes(5, 40, true)).toEqual([5, 40]);
    expect(controller).toContain("this.pageByWheel(ev.deltaY, ev.deltaX, ev.shiftKey)");
  });
});

describe("drag to pan", () => {
  const fn = controller.slice(controller.indexOf("  private attachPdfPan(doc: Document): void {"), controller.indexOf("  pdfRenderedScale(): number {"));

  it("is attached to every PDF page", () => {
    expect(controller).toContain("this.attachPdfPan(doc);");
  });

  it("engages only when the page is larger than the reading area (Scroll mode: wider)", () => {
    expect(fn).toContain('if (this.fxlMode === "scroll") return wide;');
    expect(fn).toContain("if (!sc || !pannable(sc) || onContent(ev.target)) return;");
  });

  it("never takes a press on a word or a link, and leaves touch to the platform", () => {
    expect(fn).toContain(".textLayer span, .textLayer br, .annotationLayer a, .annotationLayer section, a,");
    expect(fn).toContain('ev.pointerType === "touch"');
  });

  it("moves 1:1 in screen coordinates, which do not shift as the frame moves under the pointer", () => {
    expect(fn).toContain("ev.screenX - drag.x");
    expect(fn).toContain("drag.sc.scrollLeft = drag.left - dx");
    expect(fn).not.toContain("clientX");
  });
});

describe("the page-turn controls belong to Pages mode", () => {
  it("are not rendered in PDF Scroll mode", () => {
    expect(reader).toContain('const showChevrons = isPaged || (isPdf && pdfMode === "pages");');
  });
});

describe("the reading chrome follows the scroll in a PDF, as in a scrolled EPUB", () => {
  const note = controller.slice(controller.indexOf("  private noteScrollDirection(deltaY: number): void {"));

  it("every PDF wheel path reports its direction to the SAME accumulator", () => {
    expect(controller).toContain("if (!ev.shiftKey) this.noteScrollDirection(ev.deltaY);");
    const scrollBy = controller.slice(controller.indexOf("  scrollPdfBy(deltaY: number"), controller.indexOf("  pageByWheel(deltaY: number"));
    expect(scrollBy).toContain("this.noteScrollDirection(deltaY);");
    const pageBy = controller.slice(controller.indexOf("  pageByWheel(deltaY: number"));
    expect(pageBy.slice(0, 1200)).toContain("this.noteScrollDirection(deltaY);");
  });

  it("the EPUB funnel is unchanged: it still stamps the manual scroll, then reports the direction", () => {
    const fn = controller.slice(controller.indexOf("  private onWheelScrollIntent(deltaY: number): void {"), controller.indexOf("  private noteScrollDirection"));
    expect(fn).toContain("if (deltaY) this.lastUserScrollTs = performance.now();");
    expect(fn).toContain("this.noteScrollDirection(deltaY);");
  });

  it("the PDF path does not touch the read-aloud follow stamp", () => {
    expect(note.slice(0, 1400)).not.toContain("lastUserScrollTs");
  });

  it("immersive hides a PDF's scrollbar the way it hides an EPUB's", () => {
    expect(css).toContain(".reader-root.immersive.scrolled-away.im-hide-scrollbar { --sard-pdf-scrollbar: transparent transparent; }");
    expect(scroll).toContain("scrollbar-color: var(--sard-pdf-scrollbar, rgba(128, 128, 128, 0.5) transparent);");
  });
});
