// PDF SCROLL MODE — the rules the architecture rests on.
//
// THE DEFECT IT REPLACES, measured in the running application on a 567-page PDF at a 705px viewport:
//
//     fit-page (the default)     0 px of scrollable travel  ->  the FIRST wheel notch turns the page
//     fit-width                314 px                       ->  four notches cross it, the fifth turns
//     zoom 2                   635 px                       ->  seven
//     zoom 3                  1305 px                       ->  twelve
//
// The wheel handling itself measured CORRECT at every delta from 4px to 400px, the event reached
// exactly one document, and the 280 ms turn guard held a ten-notch burst to one turn. Nothing about
// the delta arithmetic was wrong. What was wrong is that the amount a gesture MEANT was a function of
// the zoom, because the only thing there was to scroll was the one page on screen — so at the default
// fit an ordinary gesture jumped a whole page. A threshold or a debounce would only have changed how
// big that jump felt.
//
// The fix gives the reader a document to scroll and then GETS OUT OF THE WAY. What is pinned here is
// that "gets out of the way" stays true: no wheel listener, no delta arithmetic, no page-turn
// threshold anywhere in the scroll path.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const scroll = readFileSync(join(root, "public/foliate-js/fixed-layout-scroll.js"), "utf8");
const paged = readFileSync(join(root, "public/foliate-js/fixed-layout.js"), "utf8");
const viewJs = readFileSync(join(root, "public/foliate-js/view.js"), "utf8");
const pdfJs = readFileSync(join(root, "public/foliate-js/pdf.js"), "utf8");
const pdfView = readFileSync(join(root, "src/reader-engine/pdfView.ts"), "utf8");
const controller = readFileSync(join(root, "src/reader-engine/FoliateController.ts"), "utf8");
const reader = readFileSync(join(root, "src/features/reader/Reader.tsx"), "utf8");

/** The file with its comments removed — prose may quote the defect; the CODE must not contain it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the scroll renderer does not interpret gestures", () => {
  const src = code(scroll);

  it("registers no wheel listener at all", () => {
    expect(src).not.toMatch(/addEventListener\(\s*['"]wheel['"]/);
    expect(src).not.toContain("onwheel");
  });

  it("carries no delta arithmetic, no threshold and no page-turn guard", () => {
    expect(src).not.toMatch(/deltaY|deltaX|deltaMode/);
    expect(src).not.toMatch(/lastPageWheel|THRESHOLD|debounce/i);
    // The words a symptom-fix would need: a turn decided by a scroll edge.
    expect(src).not.toMatch(/scrollHeight - .*clientHeight\s*<=?\s*\d/);
  });

  it("scrolls with a real scroller rather than moving pages itself", () => {
    expect(src).toMatch(/overflow-y:\s*scroll/);
    expect(src).toContain("addEventListener('scroll'");
  });
});

describe("what the scroll renderer must keep compatible", () => {
  it("emits the same events the paged renderer does, with the same detail", () => {
    for (const ev of ["load", "relocate", "create-overlayer"]) {
      expect(scroll, `${ev} must still be dispatched`).toContain(`new CustomEvent('${ev}'`);
    }
    // `load` and `relocate` are the paged renderer's too, and must keep the same names.
    for (const ev of ["load", "relocate"]) expect(paged, `${ev} is the paged renderer's too`).toContain(ev);
    // `create-overlayer` is the one the paged fixed-layout renderer never dispatched; the scroller
    // does, so an annotation overlay can attach to each mounted page.
    expect(viewJs).toContain("'create-overlayer'");
    // `load` is what every per-page consumer in Sard hangs off — theme, highlights, read-aloud, keys.
    expect(scroll).toContain("detail: { doc, index: slot.index }");
  });

  it("offers the renderer contract view.js calls", () => {
    for (const member of ["open(book)", "get index()", "async goTo(", "async next()", "async prev()", "getContents()", "destroy()"]) {
      expect(scroll, `${member} is part of the contract`).toContain(member);
    }
  });

  it("mirrors the scroller's geometry, so anything reading the host still can", () => {
    for (const g of ["get scrollTop()", "set scrollTop(", "get scrollHeight()", "get clientHeight()"]) {
      expect(scroll).toContain(g);
    }
  });

  it("returns the CURRENT page first from getContents()", () => {
    // Everything downstream reads `getContents()[0]` and means "the page being read". With more than
    // one page mounted that is no longer "the only one", so the order has to state it.
    const body = scroll.slice(scroll.indexOf("getContents()"), scroll.indexOf("destroy()"));
    expect(body).toContain("const cur = this.#slots[this.#index]");
    expect(body).toMatch(/push\(cur\)/);
  });

  it("reports the SAME fraction the paged renderer does, so saved positions still mean what they meant", () => {
    // Sard persists a PDF's position as the section midpoint (RAWY-86). Both renderers report
    // `fraction: 0` with an index and let view.js's section progress do the arithmetic.
    expect(scroll).toContain("fraction: 0");
    expect(paged).toContain("fraction: 0");
  });
});

describe("only a window of pages is ever mounted", () => {
  it("bounds the window to a small radius", () => {
    const radius = Number(scroll.match(/const MOUNT_RADIUS = (\d+)/)?.[1]);
    expect(radius).toBeGreaterThanOrEqual(1);
    expect(radius).toBeLessThanOrEqual(3);
  });

  it("unmounts by dropping the page's document, not merely by hiding it", () => {
    const un = scroll.slice(scroll.indexOf("    #unmount(slot) {"), scroll.indexOf("    // ---- where the reader is"));
    expect(un).toContain("removeAttribute('src')");
    expect(un).toContain("slot.frame = null");
  });

  it("lays out from page sizes read WITHOUT rendering", () => {
    expect(pdfJs).toContain("book.pageSize = async i =>");
    expect(pdfJs).toContain("getViewport({ scale: 1 })");
    expect(scroll).toContain("book.pageSize(index)");
  });

  it("a height correction keeps the reader where they were", () => {
    expect(scroll).toContain("keepCurrentPage: true");
    // The anchor takes the view height as a parameter now (a resize measures in the OLD view).
    expect(scroll).toContain("#pagePosition(viewH");
    expect(scroll).toContain("#restorePagePosition(");
  });
});

describe("the two renderers are chosen, never mixed", () => {
  it("view.js builds one or the other from the application's mode", () => {
    expect(viewJs).toContain("this.fxlMode === 'scroll'");
    expect(viewJs).toContain("foliate-fxl-scroll");
    expect(viewJs).toContain("foliate-fxl'");
  });

  it("the paged renderer is untouched by this work", () => {
    // Pages mode must keep behaving exactly as it did; its file should still be the one-spread model.
    expect(paged).toContain("#showSpread");
    expect(paged).toContain("this.#root.replaceChildren()");
  });

  it("the wheel path stands down in scroll mode, in BOTH places it exists", () => {
    // The in-frame listener must not preventDefault, or the gesture never reaches the scroller…
    expect(controller).toContain('if (this.fxlMode === "scroll") return;');
    // …and `pageByWheel` itself must refuse, so nothing can double-move the document.
    const at = controller.indexOf("  pageByWheel(deltaY: number");
    expect(at, "pageByWheel should exist").toBeGreaterThan(-1);
    const pbw = controller.slice(at, at + 1400);
    expect(pbw).toContain('if (this.fxlMode === "scroll") return;');
  });

  it("the desk margin forwards the platform's delta rather than interpreting it", () => {
    const fwd = controller.slice(controller.indexOf("  scrollPdfBy(deltaY"), controller.indexOf("  pageByWheel(deltaY: number"));
    expect(fwd).toContain("r.scrollTop = r.scrollTop + deltaY");
    expect(fwd).not.toMatch(/280|threshold|Math\.sign/);
  });
});

describe("the setting", () => {
  it("defaults to Scroll", () => {
    expect(pdfView).toContain('export const PDF_VIEW_MODE_DEFAULT: PdfViewMode = "scroll"');
    expect(pdfView).toContain('export const PDF_VIEW_MODE_KEY = "pdf_view_mode"');
  });

  it("is ONE global key — no new scope, no new table", () => {
    // Sard deliberately has one level of reading preference; a per-book mode would reintroduce the
    // two-owners problem `perBookSettings.ts` exists to describe.
    expect(pdfView).not.toMatch(/pdf_view_mode:\$\{|pdf_view_mode.*bookId/);
  });

  it("an absent or unrecognised value reads as the default, so nothing needs migrating", () => {
    expect(pdfView).toContain("isPdfViewMode(v) ? v : PDF_VIEW_MODE_DEFAULT");
  });

  it("is decided before the view opens, because it chooses the renderer", () => {
    expect(reader).toContain("fxlMode: pdfModeRef.current");
    expect(controller).toContain('view.fxlMode = opts.fxlMode === "pages" ? "pages" : "scroll";');
  });

  it("switching it reopens the book, having flushed the position first", () => {
    const fn = reader.slice(reader.indexOf("const choosePdfMode"), reader.indexOf("}, [initial]);", reader.indexOf("const choosePdfMode")));
    expect(fn).toContain("settingsSet(PDF_VIEW_MODE_KEY, m)");
    expect(fn).toContain("progressSave(bookRef.current");
    expect(fn).toContain("openBook(initial)");
    // The flush must come BEFORE the reopen, or the reopen resumes from a stale row.
    expect(fn.indexOf("progressSave")).toBeLessThan(fn.indexOf("openBook(initial)"));
  });
});
