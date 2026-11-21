// «تنسيق الكتاب» — a book is shown in its own formatting unless the reader turned that off for it, and
// the book's alignment is judged against the direction its page is really laid out in.
//
// The "on for every book" assertions guard a PREFERENCE (the owner's decision of 2026-11-21), not a
// correctness rule. A deliberate redesign updates them; it does not fight them.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bookCssKey, bookCssMode, parseBookCss, takesBookCss } from "../../src/features/reader/bookCss";
import { alignedByBook, pageReadsRtl } from "../../src/reader-engine/FoliateController";

describe("the per-book switch", () => {
  it("is on for every book that has never been switched", () => {
    expect(parseBookCss(null)).toBe(true);
    expect(parseBookCss(undefined)).toBe(true);
    expect(parseBookCss("")).toBe(true);
  });

  it("is off only when the reader turned it off", () => {
    expect(parseBookCss("off")).toBe(false);
    expect(parseBookCss(" OFF ")).toBe(false);
    // Anything else — a value from another version, a damaged row — falls back to the owner's default.
    expect(parseBookCss("sanitised")).toBe(true);
    expect(parseBookCss("{}")).toBe(true);
  });

  it("maps to the engine's stylesheet filter", () => {
    expect(bookCssMode(true)).toBe("sanitised");
    expect(bookCssMode(false)).toBe("off");
  });

  it("is stored under its own key, never the removed per-book style rows", () => {
    expect(bookCssKey("abc")).toBe("book_css:abc");
    expect(bookCssKey("abc")).not.toContain("book_style");
  });

  it("is offered only where the engine filters a book's stylesheets", () => {
    expect(takesBookCss({ format: "epub", filePath: "/x/a" })).toBe(true);
    expect(takesBookCss({ format: null, filePath: "/x/a.EPUB" })).toBe(true);
    expect(takesBookCss({ format: "pdf", filePath: "/x/a.pdf" })).toBe(false);
    expect(takesBookCss({ format: "mobi", filePath: "/x/a.mobi" })).toBe(false);
  });
});

describe("the switch reaches the engine on every open", () => {
  // The controller resets the mode to `off` for an open that names none (fail-closed), so an open that
  // forgot it would silently drop the book's formatting — after a Scroll/Pages switch, say. And the mode
  // travels in the open options because the reader host (Linux, WebKit) runs its own engine copy, which a
  // module-level setter in the application never reaches.
  const reader = readFileSync("src/features/reader/Reader.tsx", "utf8");
  const controller = readFileSync("src/reader-engine/FoliateController.ts", "utf8");

  it("every ctrl.open() in the Reader passes this book's mode", () => {
    // `(?!\))` skips the comments that name `ctrl.open()` without arguments.
    const calls = [...reader.matchAll(/\b(?:ctrl|ctrlRef\.current\??)\.open\((?!\))([\s\S]*?)\}\)/g)].map((m) => m[1]);
    // openBook, the Scroll/Pages switch, and the formatting switch itself.
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toMatch(/\bbookCss:\s*bookCssRef\.current\b/);
  });

  it("the controller applies the mode at the top of open(), before the book is fetched", () => {
    const open = controller.slice(controller.indexOf("async open(source: string"));
    const set = open.indexOf('setBookCssMode(opts.bookCss ?? "off")');
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(open.indexOf("view.open("));
  });

  it("the Reader no longer reads the app-wide row", () => {
    expect(reader).not.toContain("loadBookCssMode");
  });
});

describe("which way the page reads, for judging the book's alignment", () => {
  it("takes the page's own direction when the book declares none", () => {
    // The reported books: no declared direction, `<html dir="rtl">`.
    expect(pageReadsRtl(undefined, "rtl")).toBe(true);
    expect(pageReadsRtl(undefined, "ltr")).toBe(false);
  });

  it("keeps a declared or corrected direction first", () => {
    expect(pageReadsRtl("ltr", "rtl")).toBe(false);
    expect(pageReadsRtl("rtl", "ltr")).toBe(true);
  });

  it("in a right-to-left page, `right` is where the text starts, not an intent", () => {
    // The defect: every paragraph of `body { text-align: right }` was spared, so justify did nothing.
    expect(alignedByBook("right", true)).toBe(false);
    expect(alignedByBook("left", true)).toBe(true);
    expect(alignedByBook("center", true)).toBe(true);
  });

  it("in a left-to-right page, the opposite edge is `right`", () => {
    expect(alignedByBook("right", false)).toBe(true);
    expect(alignedByBook("left", false)).toBe(false);
  });

  it("never counts the initial value or justify as the book's intent", () => {
    for (const rtl of [true, false]) {
      expect(alignedByBook("start", rtl)).toBe(false);
      expect(alignedByBook("justify", rtl)).toBe(false);
      expect(alignedByBook("end", rtl)).toBe(true);
      expect(alignedByBook("-webkit-center", rtl)).toBe(true);
    }
  });
});
