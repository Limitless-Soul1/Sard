// P7-A — the four source states a reader can meet, and the four different things they are told.
//
// The brief's requirement is precision, not merely "show an error": a missing file, a file that
// exists and cannot be parsed, a reader still loading, and a loaded book with nowhere further to go
// are four different facts about the world, and collapsing them would tell someone their book was
// damaged when it was simply gone — or offer "re-import" for a file whose bytes can never work.
//
// The exception strings below are the ones the ENGINE actually produced, captured from a real run
// against real fixtures inside the sandbox (a private test-harness probe), not invented:
//
//   missing EPUB   ResponseError: 404 Not Found            (foliate fetchFile, view.js:74)
//   missing PDF    ResponseError: 404 Not Found            same path, other format
//   zero-byte file NotFoundError: File not found           (foliate makeBook, view.js:87)
//   corrupt EPUB   UnsupportedTypeError: File type not supported
import { describe, it, expect, afterEach } from "vitest";
import { classifyBookError } from "../../src/lib/bookErrors";
import { __setRuntimeForTests, type RuntimeEnv } from "../../src/lib/runtime";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const FULL: RuntimeEnv = {
  objectGroupBy: true, mapGroupBy: true, uint8ToHex: true, uint8ToBase64: true, uint8FromBase64: true,
};
const capable = () => __setRuntimeForTests(FULL);
afterEach(() => __setRuntimeForTests(null));

/** Verbatim from the sandbox run — see the header. */
const MEASURED = {
  missingEpub: "ResponseError: 404 Not Found",
  missingPdf: "ResponseError: 404 Not Found",
  emptyFile: "NotFoundError: File not found",
  corrupt: "UnsupportedTypeError: File type not supported",
};

describe("a missing file is reported as missing", () => {
  it("classifies the measured EPUB failure as file-missing", () => {
    capable();
    const c = classifyBookError(new Error(MEASURED.missingEpub), { format: "epub" });
    expect(c.kind).toBe("file-missing");
    expect(c.presentation.titleKey).toBe("err.missing.title");
  });

  it("classifies the measured PDF failure the same way — format must not change the answer", () => {
    capable();
    const c = classifyBookError(new Error(MEASURED.missingPdf), { format: "pdf" });
    expect(c.kind).toBe("file-missing");
  });

  it("treats a zero-byte managed copy as missing, not as damaged", () => {
    // A file with no bytes has no content to be damaged. Calling it "damaged" would send the reader
    // looking for a corrupted original that was never the problem.
    capable();
    expect(classifyBookError(new Error(MEASURED.emptyFile), { format: "epub" }).kind).toBe("file-missing");
  });

  it("offers re-import first, and never a bare retry", () => {
    capable();
    const p = classifyBookError(new Error(MEASURED.missingEpub), { format: "epub" }).presentation;
    expect(p.actions[0]).toBe("reimport");
    expect(p.actions).not.toContain("retry");   // the file will not reappear because you asked twice
    expect(p.actions).toContain("back");        // always a way back to the library
  });

  it("blames the environment, not the book and not Sard", () => {
    capable();
    expect(classifyBookError(new Error(MEASURED.missingEpub), {}).presentation.fault).toBe("environment");
  });
});

describe("a file that exists but cannot be read is NOT reported as missing", () => {
  it("classifies the measured corrupt EPUB as a format problem", () => {
    capable();
    const c = classifyBookError(new Error(MEASURED.corrupt), { format: "epub" });
    expect(c.kind).not.toBe("file-missing");
    expect(c.presentation.titleKey).toBe("err.unreadable.title");
  });

  it("does not offer re-import for bytes that can never work", () => {
    capable();
    const p = classifyBookError(new Error(MEASURED.corrupt), { format: "epub" }).presentation;
    expect(p.actions).not.toContain("reimport");
    expect(p.actions).toContain("back");
  });

  it("a damaged container is told apart from an unsupported one", () => {
    capable();
    // Both are "the file is there and unusable", but only one is worth re-importing.
    expect(classifyBookError(new Error("Invalid PDF structure"), { format: "pdf" }).kind).toBe("corrupt");
    expect(classifyBookError(new Error(MEASURED.corrupt), { format: "epub" }).kind).toBe("unsupported-format");
  });

  it("the two states cannot share a title", () => {
    capable();
    const missing = classifyBookError(new Error(MEASURED.missingEpub), {}).presentation.titleKey;
    const unreadable = classifyBookError(new Error(MEASURED.corrupt), {}).presentation.titleKey;
    expect(missing).not.toBe(unreadable);
    for (const L of [en, ar]) {
      expect(L[missing as keyof typeof L]).toBeTruthy();
      expect(L[unreadable as keyof typeof L]).toBeTruthy();
      expect(L[missing as keyof typeof L]).not.toBe(L[unreadable as keyof typeof L]);
    }
  });
});

describe("the copy tells the reader the truth about the state", () => {
  it("neither language dresses a missing file up as a damaged one", () => {
    // English is checked by word; Arabic by the fact that the two strings differ and both exist,
    // since asserting Arabic wording here would just re-state the locale file.
    expect(en["err.missing.body"].toLowerCase()).not.toContain("damaged");
    expect(en["err.missing.body"].toLowerCase()).not.toContain("corrupt");
    expect(ar["err.missing.title"]).not.toBe(ar["err.damaged.title"]);
  });

  it("no raw engine text reaches a title or a body", () => {
    capable();
    const c = classifyBookError(new Error(MEASURED.missingEpub), {});
    for (const L of [en, ar]) {
      expect(L[c.presentation.titleKey as keyof typeof L]).not.toContain("ResponseError");
      expect(L[c.presentation.bodyKey as keyof typeof L]).not.toContain("404");
    }
    // …and it is still available where a bug report can reach it.
    expect(c.raw).toContain("ResponseError");
  });
});

describe("the affected book is identified", () => {
  it("both locales carry the strings the card needs", () => {
    // The name itself comes from the reader store at render time (Reader.tsx passes `extra`); what a
    // test can defend here is that the surrounding copy exists in both languages.
    for (const L of [en, ar]) {
      expect(L["err.missing.title"]).toBeTruthy();
      expect(L["err.missing.body"]).toBeTruthy();
      expect(L["err.act.back"]).toBeTruthy();
    }
  });
});
