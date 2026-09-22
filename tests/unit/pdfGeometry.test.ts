// PDF PAGE GEOMETRY — three defects that made a page look cropped, and the rule that removes each.
//
// All three were MEASURED in the running application on three real PDFs before being changed:
//
//   1. DOUBLE SCALING (Scroll renderer). pdf.js re-renders a page at the zoom scale, and the frame
//      holding it was ALSO CSS-scaled by the same factor, so the page was painted at scale². At fit-page
//      a page meant for a 423×684 slot was drawn 612×990 and lost 189px on the right and 306px at the
//      bottom; at 0.75 it shrank to 0.56 and left an 88px empty strip. Only zoom 1 looked right.
//
//   2. THE READING AREA RAN OFF THE WINDOW. `.page-host` is absolutely positioned with
//      `inset-block: <top> 0`; a PDF rule added `block-size: 100%`, which over-constrains it — the
//      height wins and the bottom inset is ignored. The host was the full sheet height starting BELOW
//      its top inset, so 32px (reading) to 102px (toolbar shown) of every page was off-screen, and
//      "fit page" fitted a box taller than the window.
//
//   3. THE READING AREA MOVED WITH THE TOOLBAR. The PDF host's top inset followed the toolbar
//      (102px shown, 32px hidden), so the whole document jumped 70px each time the pointer reached
//      the top of the window, and "fit page" re-derived its scale from the changing height.
//
// Plus one behaviour the reader asked for explicitly: in Pages mode the wheel must never change the
// page. It moves within the page and stops at its edges.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const scroll = readFileSync(join(root, "public/foliate-js/fixed-layout-scroll.js"), "utf8");
const css = readFileSync(join(root, "src/styles/global.css"), "utf8");
const controller = readFileSync(join(root, "src/reader-engine/FoliateController.ts"), "utf8");
const reader = readFileSync(join(root, "src/features/reader/Reader.tsx"), "utf8");
/** Rules only — the prose above each rule may quote the defect it replaced. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("1 · a PDF page is scaled once", () => {
  const place = scroll.slice(scroll.indexOf("    #placeSlot(slot) {"), scroll.indexOf("    /** Where the reader is"));

  it("a page that re-renders itself sits in an UNSCALED frame the size of its slot", () => {
    expect(place).toContain("const renders = !!slot.onZoom");
    expect(place).toMatch(/renders\s*\?\s*\{\s*width: `\$\{slot\.width\}px`, height: `\$\{slot\.height\}px`, transform: 'none' \}/);
  });

  it("only a page that cannot re-render is magnified — the paged renderer's own rule", () => {
    expect(place).toContain("transform: `scale(${this.#scale})`");
    const paged = readFileSync(join(root, "public/foliate-js/fixed-layout.js"), "utf8");
    expect(paged).toContain("const iframeScale = onZoom ? scale : 1");
  });

  it("the slot is exactly what pdf.js paints, to the device pixel — no hairline of desk", () => {
    expect(scroll).toContain("slot.width = this.#painted(s.width)");
    expect(scroll).toContain("slot.height = this.#painted(s.height)");
    expect(scroll).toContain("return Math.floor(d * this.#scale * dpr) / dpr");
  });
});

describe("2 · the PDF reading area ends at the window", () => {
  it("is bounded by its insets, never by an explicit height", () => {
    const rule = rules.match(/\.reader-desk\.pdf-view \.page-host \{[^}]*\}/g) ?? [];
    expect(rule.length).toBeGreaterThan(0);
    for (const r of rule) expect(r, "an explicit height here ignores the bottom inset").not.toMatch(/block-size:\s*100%|height:\s*100%/);
  });

  it("still cannot grow to fit the page, so a zoomed page keeps its own scroll", () => {
    expect(rules).toMatch(/\.reader-desk\.pdf-view \.page-host \{ min-block-size: 0; overflow: hidden; \}/);
  });
});

describe("3 · the toolbar overlays a PDF instead of moving it", () => {
  it("the PDF host joins the overlay pin scrolled EPUB reading already uses", () => {
    expect(rules).toMatch(/\.reader-root\.flow-scrolled \.page-host,\s*\.reader-desk\.pdf-view \.page-host \{ inset-block-start: 0; \}/);
  });

  it("and the same pin applies under the custom window frame", () => {
    expect(rules).toMatch(/:root\[data-chrome="sard"\] \.reader-desk\.pdf-view \.page-host,[\s\S]*?\{ inset-block-start: var\(--sard-titlebar\); \}/);
  });
});

describe("one page gutter in both modes", () => {
  it("Pages mode pads its renderer by the gutter Scroll mode keeps", () => {
    const gap = Number(scroll.match(/const PAGE_GAP = (\d+)/)?.[1]);
    expect(rules).toContain(`.reader-desk.pdf-view[data-pdf-mode="pages"] .page-host foliate-view { box-sizing: border-box; padding: ${gap}px; }`);
    expect(reader).toContain("data-pdf-mode={isPdf ? pdfMode : undefined}");
  });
});

describe("Pages mode: the wheel never changes the page", () => {
  const at = controller.indexOf("  pageByWheel(deltaY: number");
  const body = controller.slice(at, controller.indexOf("\n  }\n", at));

  it("pageByWheel no longer turns a page in any branch", () => {
    expect(body).not.toMatch(/view\?\.next|view\?\.prev|\.next\?\.\(|\.prev\?\.\(/);
    expect(body).not.toContain("lastPageWheel");
  });

  it("it still scrolls within the page, vertically and across", () => {
    expect(body).toContain("r.scrollTop = next");
    expect(body).toContain("r.scrollLeft = next");
  });

  it("the throttle that existed only to pace page turns is gone with them", () => {
    expect(controller).not.toContain("private lastPageWheel");
  });
});
