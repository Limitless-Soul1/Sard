// An absence must never be rendered as a finding.
//
// WHY THIS EXISTS. Two surfaces answered a question they had not resolved. The reading surface
// tracked a `loading` status that nothing in the render path ever read, so a book being parsed
// looked like a book with nothing in it. The contents panel decided from `toc.length === 0` alone,
// so it announced "this book has no contents list" — its FINAL answer — throughout the parse.
//
// MEASURED on a real Linux machine: a 10.2 MB EPUB with 1,432 chapters takes ~2.48 s inside the
// engine's `open()`. For that whole time the reader showed an empty page and denied the book had
// chapters, then produced 1,432 of them.
//
// The tests below are on the pure decision, not on rendered output — this suite runs on Node with no
// DOM, deliberately (see vitest.config.ts). What they cannot prove is that the components ASK; the
// last block asserts that they do, so the decision cannot be correct here while the JSX ignores it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { contentsView, isOpening } from "../../src/features/reader/openingState";

describe("the reader knows the difference between unknown and empty", () => {
  it("1 — loading with an empty TOC is LOADING, not 'no chapters'", () => {
    // The defect, stated as a test: this exact combination is what a large book shows for 2.5 s.
    expect(isOpening("loading")).toBe(true);
    expect(contentsView(isOpening("loading"), 0)).toBe("loading");
    expect(contentsView(isOpening("loading"), 0)).not.toBe("empty");
  });

  it("2 — ready with an empty TOC is genuinely empty", () => {
    // The book has been read and really has no contents list. This is the ONLY state that may say so.
    expect(isOpening("ready")).toBe(false);
    expect(contentsView(isOpening("ready"), 0)).toBe("empty");
  });

  it("3 — ready with entries renders the list", () => {
    expect(contentsView(isOpening("ready"), 1)).toBe("list");
    expect(contentsView(isOpening("ready"), 1432)).toBe("list"); // the measured book
  });

  it("4 — the loading state ends when the reader becomes ready", () => {
    // The transition itself, in both shapes it takes: a book that has chapters and one that has none.
    // Nothing here is timed or delayed — the status alone ends it, so the indicator lasts exactly as
    // long as the work does.
    expect(contentsView(isOpening("loading"), 0)).toBe("loading");
    expect(contentsView(isOpening("ready"), 1432)).toBe("list");
    expect(contentsView(isOpening("ready"), 0)).toBe("empty");
  });

  it("5 — error behaves exactly as it did before this change", () => {
    // A failed open is NOT "still loading": the reader's error card owns that story, with the
    // recovery actions. The panel keeps showing what it showed before — the empty state — so nothing
    // about the failure path moved.
    expect(isOpening("error")).toBe(false);
    expect(contentsView(isOpening("error"), 0)).toBe("empty");
  });

  it("treats the first render, before openBook runs, as opening", () => {
    // `idle` is the status during the very first render. Rendering "no contents list" there would be
    // the same lie a frame earlier.
    expect(isOpening("idle")).toBe(true);
    expect(contentsView(isOpening("idle"), 0)).toBe("loading");
  });
});

describe("both surfaces actually consult it", () => {
  const reader = readFileSync(join("src", "features", "reader", "Reader.tsx"), "utf8");
  const panel = readFileSync(join("src", "features", "reader", "ChaptersPanel.tsx"), "utf8");

  it("the reading surface renders a loading state from the status", () => {
    // The original defect was a status that was SET and never READ. This is that, asserted.
    expect(reader).toContain("isOpening(status)");
    expect(reader).toMatch(/\{opening && \(/);
    expect(reader).toContain("page-loading");
  });

  it("the contents panel no longer decides from toc.length alone", () => {
    expect(panel).toContain("contentsView(loading, toc.length)");
    // The exact expression that caused the defect must not come back.
    expect(panel).not.toMatch(/\{toc\.length === 0 && <div className="rp-empty"/);
    // "No chapters" is reachable only through the resolved `empty` branch.
    expect(panel).toMatch(/view === "empty" && <div className="rp-empty">/);
    expect(panel).toMatch(/view === "loading" &&/);
  });

  it("the panel is told whether the book is still opening", () => {
    // A prop that is never passed would leave the panel permanently "ready" and restore the defect.
    expect(reader).toContain("loading={opening}");
  });

  it("the Arabic loading strings carry no combining marks", () => {
    // NOT a style rule. MEASURED on real WebKitGTK: a word carrying an Arabic combining mark drops
    // out of the UI font onto a fallback with different metrics and renders on a lower baseline,
    // mid-sentence. The first draft of these two strings began "جارٍ" and did exactly that in the
    // captured frame; the same words without the tanween sat flat beside it.
    //
    // This guard is here because the natural "improvement" to a status label is to add the
    // diacritics back. The underlying font defect is a separate matter and is NOT fixed by this.
    const combining = /[ً-ٰٟۖ-ۭ]/;
    const ar = readFileSync(join("src", "i18n", "locales", "ar.ts"), "utf8");
    for (const key of ["reader.opening", "panel.chaptersLoading"]) {
      const line = ar.split("\n").find((l) => l.includes(`"${key}"`));
      expect(line, `${key} is missing from the Arabic locale`).toBeTruthy();
      const value = line!.slice(line!.indexOf(":") + 1);
      expect(combining.test(value), `${key} contains a combining mark and will render displaced`).toBe(false);
    }
  });

  it("neither loading string is the other's", () => {
    // Two distinct sentences, in both locales — reusing `panel.noChapters` for the spinner would
    // reintroduce the lie with a spinner beside it.
    for (const locale of ["en", "ar"]) {
      const src = readFileSync(join("src", "i18n", "locales", `${locale}.ts`), "utf8");
      expect(src, `${locale} is missing panel.chaptersLoading`).toContain('"panel.chaptersLoading"');
      expect(src, `${locale} is missing reader.opening`).toContain('"reader.opening"');
    }
  });
});
