// RESILIENCE-1 / WP-1 — import diagnostics.
//
// The behaviour under test is the one that was missing: a refused file must reach the user with a
// REASON, and a refusal caused by the machine must not be blamed on the book.

import { describe, it, expect } from "vitest";
import { buildImportReport, isCleanImport, splitByCapability } from "../../src/features/library/importReport";
import type { ImportResult } from "../../src/lib/ipc";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const r = (status: ImportResult["status"], title: string, message: string | null = null): ImportResult => ({
  id: "",
  title,
  status,
  message,
});

describe("buildImportReport", () => {
  it("counts what was added and what was already there", () => {
    const rep = buildImportReport([r("imported", "A"), r("imported", "B"), r("duplicate", "C")]);
    expect(rep.added).toBe(2);
    expect(rep.duplicates).toBe(1);
    expect(rep.problems).toHaveLength(0);
    expect(isCleanImport(rep)).toBe(true);
  });

  it("a duplicate is NOT a problem — the book is in the library either way", () => {
    expect(isCleanImport(buildImportReport([r("duplicate", "C")]))).toBe(true);
  });

  it("keeps Rust's own message for Details — the field that used to be discarded", () => {
    // `summarize()` counted statuses and threw `message` away, so a refused book gave the user
    // "1 unsupported" and no route at all to why.
    const rep = buildImportReport([r("unsupported", "broken", "Not an EPUB (missing epub mimetype)")]);
    expect(rep.problems).toHaveLength(1);
    expect(rep.problems[0].raw).toBe("Not an EPUB (missing epub mimetype)");
    expect(rep.problems[0].name).toBe("broken");
  });

  it("blames the BOOK for an unsupported or failed file", () => {
    const rep = buildImportReport([r("unsupported", "a"), r("error", "b", "Couldn't store the file: …")]);
    expect(rep.problems.map((p) => p.fault)).toEqual(["book", "book"]);
  });

  it("blames the ENVIRONMENT for a runtime-blocked PDF, never the file", () => {
    // The attribution that matters most here: the PDF is fine. Telling the user their file is
    // broken could make them delete a good book over a Windows component being out of date.
    const rep = buildImportReport([], ["C:\\books\\manual.pdf"]);
    expect(rep.problems).toHaveLength(1);
    expect(rep.problems[0].fault).toBe("environment");
    expect(rep.problems[0].reasonKey).toBe("lib.import.reason.runtime");
    expect(rep.problems[0].name).toBe("manual"); // the filename, not a path
  });

  it("handles a mixed batch without losing anything", () => {
    const rep = buildImportReport(
      [r("imported", "ok"), r("duplicate", "dup"), r("unsupported", "bad"), r("error", "worse", "Database error")],
      ["D:\\x\\scan.pdf"],
    );
    expect(rep.added).toBe(1);
    expect(rep.duplicates).toBe(1);
    expect(rep.problems).toHaveLength(3);
    expect(isCleanImport(rep)).toBe(false);
  });

  it("falls back to the generic reason for an unknown status rather than dropping the file", () => {
    const rep = buildImportReport([{ id: "", title: "odd", status: "weird" as never, message: "?" }]);
    expect(rep.problems).toHaveLength(1);
    expect(rep.problems[0].reasonKey).toBe("lib.import.reason.error");
  });

  it("every reason key exists in BOTH locales", () => {
    const rep = buildImportReport([r("unsupported", "a"), r("error", "b")], ["c.pdf"]);
    for (const p of rep.problems) {
      expect(en[p.reasonKey], `${p.reasonKey} missing from en`).toBeTruthy();
      expect(ar[p.reasonKey], `${p.reasonKey} missing from ar`).toBeTruthy();
    }
  });
});

describe("splitByCapability", () => {
  const paths = ["a.epub", "b.PDF", "c.pdf", "d.epub"];

  it("passes everything through when PDFs are renderable", () => {
    const { accepted, blocked } = splitByCapability(paths, true);
    expect(accepted).toHaveLength(4);
    expect(blocked).toHaveLength(0);
  });

  it("refuses PDFs — case-insensitively — when they are not renderable", () => {
    const { accepted, blocked } = splitByCapability(paths, false);
    expect(accepted).toEqual(["a.epub", "d.epub"]);
    expect(blocked).toEqual(["b.PDF", "c.pdf"]);
  });

  it("never refuses an EPUB over a missing PDF capability", () => {
    // The regression this guards: an over-broad filter would lock a user out of their whole library
    // because of a feature only PDFs need.
    const { accepted, blocked } = splitByCapability(["only.epub"], false);
    expect(accepted).toEqual(["only.epub"]);
    expect(blocked).toEqual([]);
  });

  it("handles an empty batch", () => {
    expect(splitByCapability([], false)).toEqual({ accepted: [], blocked: [] });
  });
});
