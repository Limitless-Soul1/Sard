// THREE READER FIXES, each MEASURED in the running application before it was made.
//
//   1. PDF Appearance did nothing visible in Scroll mode. The appearance is written into each page's own
//      document, but only into `pdfPageDoc` — the page loaded LAST. Pages mode shows one page, so that
//      was the page on screen; Scroll mode keeps up to three, and "night" filtered page 4 (off-screen)
//      while the page being read stayed untouched.
//   2. "Around the page" gains a size: a frame of surround on each side of the page, following it at
//      every zoom, drawn by the same sheet as a band. Untouched, the sheet spans its column as before.
//   3. An EPUB switched from Scroll to Pages turned dark over a wallpaper until a background slider was
//      moved. The mode switch re-opened the book with three of the five flags: without `pageOpacity` the
//      book document painted its page colour opaque (body `transparent` -> `rgb(17, 26, 27)`).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pdfBand, parsePdfFrame, PDF_FRAME_KEY } from "../../src/reader-engine/pdfView";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const controller = read("src/reader-engine/FoliateController.ts");
const reader = read("src/features/reader/Reader.tsx");
const panel = read("src/features/reader/SettingsPanel.tsx");
const css = read("src/styles/global.css");
const scroll = read("public/foliate-js/fixed-layout-scroll.js");
const paged = read("public/foliate-js/fixed-layout.js");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("1 · the PDF appearance reaches every page on the desk", () => {
  const fn = controller.slice(controller.indexOf("  setPdfTheme(filter: string, tint: string): void {"), controller.indexOf("  private applyPdfThemeTo("));

  it("setPdfTheme styles every mounted page document, not only the last one loaded", () => {
    expect(fn).toContain("for (const x of r?.getContents?.() ?? []) if (x.doc) docs.add(x.doc);");
    expect(fn).toContain("for (const doc of docs) this.applyPdfThemeTo(doc, filter, tint);");
  });

  it("a page that mounts later is styled as it loads — only that page", () => {
    expect(controller).toContain("if (this.pdfTheme) this.applyPdfThemeTo(doc, this.pdfTheme.filter, this.pdfTheme.tint);");
  });

  it("a frame that has not loaded yet is skipped, not thrown on, so the pages after it are still styled", () => {
    const apply = controller.slice(controller.indexOf("  private applyPdfThemeTo("), controller.indexOf("  private pdfTheme:"));
    expect(apply).toContain("const host = doc.head ?? doc.documentElement;");
    expect(apply).toContain("if (!host) return;");
  });

  it("the appearance stays a display layer inside the page document; the raster is never repainted", () => {
    const apply = controller.slice(controller.indexOf("  private applyPdfThemeTo("), controller.indexOf("  private pdfTheme:"));
    expect(apply).toContain("#canvas img { filter: ${f}; display: block; }");
    expect(apply).not.toMatch(/getContext|toDataURL|putImageData/);
  });
});

describe("2 · the frame around the page", () => {
  // A 1004 px column in a 1004 px reading area, a 582 px page centred in a 972 px host (measured).
  const base = { areaLeft: 380, areaRight: 1384, sheetLeft: 380, sheetWidth: 1004, hostLeft: 396, hostWidth: 972, boxWidth: 972, pageWidth: 582, pageCenterX: 486 };

  it("untouched, it sits where the whole column already is — nothing moves until the reader does", () => {
    const b = pdfBand({ ...base, frame: null });
    expect(b.current).toBe(Math.floor((1004 - 582) / 2));
    expect(b.width).toBe(582 + 2 * b.current);
  });

  it("a frame is that many px of surround on each side of the page, centred on the page", () => {
    const b = pdfBand({ ...base, frame: 24 });
    expect(b.width).toBe(582 + 48);
    expect(b.x + base.sheetLeft).toBe(396 + 486); // the page's centre, in viewport px
  });

  it("the far end is the whole reading area, and a frame never pushes past it", () => {
    const b = pdfBand({ ...base, frame: 10_000 });
    expect(b.max).toBe(Math.floor((1004 - 582) / 2));
    expect(b.width).toBe(1004);
  });

  it("follows the page where it really is: a scrollbar that shifts the page shifts the frame too", () => {
    // Scroll mode centres the page in the client width, which excludes the scrollbar.
    const b = pdfBand({ ...base, boxWidth: 972, pageCenterX: 482, frame: 8 });
    expect(b.x + base.sheetLeft).toBe(396 + 482);
  });

  it("a zoomed page wider than the area: the frame is the whole area, held inside it", () => {
    const b = pdfBand({ ...base, pageWidth: 1800, pageCenterX: 300, frame: 40 });
    expect(b.max).toBe(0);
    expect(b.width).toBe(1004);
    expect(b.x).toBe(1004 / 2);
  });

  it("is stored as whole px, and an absent row means the untouched column", () => {
    expect(PDF_FRAME_KEY).toBe("pdf_surround_frame");
    expect(parsePdfFrame(null)).toBeNull();
    expect(parsePdfFrame("")).toBeNull();
    expect(parsePdfFrame("abc")).toBeNull();
    expect(parsePdfFrame("-4")).toBeNull();
    expect(parsePdfFrame("37.6")).toBe(38);
  });

  it("the renderers report where the page sits, and that report moves nothing", () => {
    for (const src of [scroll, paged]) {
      expect(src).toContain("pageWidth, pageCenterX, boxWidth:");
    }
  });

  const frameRules = [...rules.matchAll(/([^{}]*data-pdf-frame[^{}]*)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

  it("paints only: the sheet keeps its box, the page-host and renderer are never styled", () => {
    expect(frameRules.length).toBeGreaterThan(3);
    for (const r of frameRules) {
      expect(r.sel).toMatch(/\.reader-desk\.pdf-view(\[data-pdf-surround="reduced"\])?\[data-pdf-frame\]/);
      expect(r.sel).toMatch(/\.page-sheet(::before)?$|\.page-grain$/);
      expect(r.sel).not.toMatch(/page-host|foliate-view/);
    }
    const sheet = frameRules.filter((r) => r.sel.endsWith(".page-sheet"));
    for (const r of sheet) {
      const props = r.body.split(";").map((d) => d.split(":")[0].trim()).filter(Boolean);
      for (const p of props) expect(["background", "box-shadow", "overflow", "isolation"]).toContain(p);
    }
  });

  it("the band is a pseudo-element behind the page, placed by the two measured variables", () => {
    const band = frameRules.find((r) => r.sel === ".reader-desk.pdf-view[data-pdf-frame] .page-sheet::before")!;
    expect(band.body).toContain("left: var(--pdf-band-x, 50%)");
    expect(band.body).toContain("width: var(--pdf-band-w, 100%)");
    expect(band.body).toContain("z-index: -1");
    expect(band.body).toContain("pointer-events: none");
  });

  it("the frame applies only when there IS a surround and the reader has set a size", () => {
    expect(reader).toContain('data-pdf-frame={isPdf && pdfSurround !== "none" && pdfFrame != null ? "" : undefined}');
    expect(panel).toContain('(pdfSurround ?? "normal") !== "none" && pdfFrameInfo && pdfFrameInfo.max > 0 && (');
  });

  it("it follows the page on scroll, page turn, zoom and resize", () => {
    expect(reader).toContain("pdfBandRef.current();");            // relocate (scroll, turn) and zoom
    expect(reader).toContain("const ro = new ResizeObserver(() => layoutPdfBand());");
  });

  it("costs nothing while no frame is drawn, and writes only when the band moved", () => {
    const fn = reader.slice(reader.indexOf("  const layoutPdfBand = useCallback(() => {"), reader.indexOf("  pdfBandRef.current = isPdf ? layoutPdfBand"));
    const guard = fn.indexOf('if (!deskRef.current?.hasAttribute("data-pdf-frame")) return;');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(fn.indexOf("measurePdfBand()"));
    expect(fn).toContain('if (m.sheet.style.getPropertyValue("--pdf-band-w") !== w)');
    expect(fn).toContain('if (m.sheet.style.getPropertyValue("--pdf-band-x") !== x)');
  });
});

describe("3 · a reading-mode switch hands the engine the same flags as an open", () => {
  it("one builder, with all five flags", () => {
    const fn = reader.slice(reader.indexOf("function currentBookFlags() {"), reader.indexOf("export function Reader({"));
    for (const k of ["overrideBookColor", "hideChapterTitles", "hideFirstLine", "pageOpacity: effectivePageOpacity()", "deskScrim: currentDeskScrim()"]) expect(fn).toContain(k);
  });

  it("both places that open the book use it, and no hand-built three-field copy remains", () => {
    expect(reader.match(/flags: currentBookFlags\(\),/g)?.length).toBe(2);
    expect(reader).not.toMatch(/flags: \{\s*overrideBookColor: useTheme\.getState\(\)\.overrideBookColor,/);
  });
});
