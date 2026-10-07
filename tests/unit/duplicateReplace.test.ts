// A BOOK THAT IS ALREADY HERE IS ASKED ABOUT — WHEN THE READER IMPORTED IT: «Keep existing» or «Replace».
//
// What «Replace» does to the book is held by the Rust tests (`books::replace_tests`): same id, same
// row, same annotations and shelves, only a missing or damaged stored copy rewritten. These hold the
// frontend half — which results are offered, that every IMPORT path asks the same question while a
// double-click never does, and that the question cannot be answered «Replace» by accident.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { duplicatesToOffer, offersReplace } from "../../src/features/library/importReport";
import type { ImportResult } from "../../src/lib/ipc";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const LIB = read("src/features/library/Library.tsx");
const DIALOG = read("src/features/library/ConfirmReplace.tsx");

const r = (status: ImportResult["status"], id: string, title: string, source: string | null = `C:/books/${title}.epub`): ImportResult => ({
  id, title, status, message: null, source,
});

describe("duplicatesToOffer", () => {
  it("offers only the duplicates, with the file each came from", () => {
    const offer = duplicatesToOffer([r("imported", "a", "New"), r("duplicate", "b", "Old"), r("unsupported", "", "Bad")]);
    expect(offer).toEqual([{ id: "b", title: "Old", source: "C:/books/Old.epub" }]);
  });

  it("offers a book once even if two files in one batch were the same book", () => {
    const offer = duplicatesToOffer([r("duplicate", "b", "Old", "C:/x/Old.epub"), r("duplicate", "b", "Old", "C:/y/Old.epub")]);
    expect(offer).toHaveLength(1);
  });

  it("cannot offer a duplicate with no file to replace from", () => {
    expect(duplicatesToOffer([r("duplicate", "b", "Old", null)])).toEqual([]);
  });

  it("names a duplicate by its file when it has no title", () => {
    expect(duplicatesToOffer([r("duplicate", "b", "", "C:\\books\\Untitled thing.epub")])[0].title).toBe("Untitled thing");
  });
});

describe("the question, in both languages", () => {
  const KEYS = [
    "lib.replace.title", "lib.replace.titleMany", "lib.replace.question", "lib.replace.questionMany",
    "lib.replace.andMore", "lib.replace.keep", "lib.replace.replace", "lib.replace.failed", "lib.import.replaced",
  ] as const;
  it.each(KEYS)("%s exists in English and Arabic with the same placeholders", (k) => {
    expect(en[k].trim()).not.toBe("");
    expect(ar[k].trim()).not.toBe("");
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(holes(ar[k])).toEqual(holes(en[k]));
  });
});

// WHO IS ASKED. Keep / Replace is for a reader who IMPORTED a book they already have — the file picker,
// a folder, a drop. A double-click in Windows Explorer is a request to READ: an existing book opens
// directly, and a new one is imported and then opened, with no question in between.
describe("who is asked: an explicit import, never a double-click", () => {
  const RUN = LIB.slice(LIB.indexOf("const runImport = useCallback("), LIB.indexOf("runImportRef.current = (paths)"));
  const PICKER = LIB.slice(LIB.indexOf("const addBooks = useCallback("), LIB.indexOf("const addFolder = useCallback("));
  const FOLDER = LIB.slice(LIB.indexOf("const addFolder = useCallback("), LIB.indexOf("// DEV: import"));
  const OPEN = LIB.slice(LIB.indexOf("const pendingFiles = useOpenFileRequest"), LIB.indexOf("const addBooks = useCallback("));

  it("the rule: an import asks, a request to read does not", () => {
    expect(offersReplace("add")).toBe(true);
    expect(offersReplace("open")).toBe(false);
  });

  it("the batch import asks exactly when the rule says so; the folder import always asks", () => {
    expect(RUN).toMatch(/intent: ImportIntent = "add"/);
    expect(RUN).toContain("offersReplace(intent) ? await offerReplace(results) : { replaced: 0, failed: [] }");
    expect(FOLDER).toContain("const { replaced, failed } = await offerReplace(results);");
    // ...and both summaries then report what the answer did.
    expect([...LIB.matchAll(/summarize\(results, t, lang, replaced\)/g)]).toHaveLength(2);
  });

  it("explicit import (the file picker) of an existing book → Keep / Replace", () => {
    // No intent passed, so the import is an "add", which the rule asks about.
    expect(PICKER).toContain("runImport(Array.isArray(sel) ? sel : [sel]);");
  });

  it("drag and drop of an existing book → Keep / Replace", () => {
    expect(LIB).toContain('if (p.type === "drop") void routeDroppedPaths(p.paths, runImportRef.current);');
    expect(LIB).toContain("runImportRef.current = (paths) => void runImport(paths);"); // an "add"
  });

  it("double-click of an existing book → opens it directly, no Replace dialog", () => {
    expect(OPEN).toContain('const results = await runImport(paths, "open");');
    // The existing copy ("duplicate") is usable and is what opens.
    expect(OPEN).toMatch(/r\.status === "imported" \|\| r\.status === "duplicate"/);
    expect(OPEN).toContain("if (row) openBook(row);");
    // "open" is passed from the double-click path and from nowhere else.
    expect([...LIB.matchAll(/runImport\([^)]*"open"\)/g)]).toHaveLength(1);
  });

  it("double-click of a new book → imported normally, then opened", () => {
    // The same consumer: an "imported" result is usable too, and its row is looked up UNFILTERED,
    // so no shelf or search filter can stop the book the reader asked for from opening.
    expect(OPEN).toContain('libraryListBooks({ sort: "date_added", order: "desc" })');
    expect(OPEN).toContain("const row = rows.find((b) => b.id === usable[0].id);");
  });

  it("the question is asked while the import still holds `importing`, so a second arrival waits", () => {
    const body = LIB.slice(LIB.indexOf("const runImport = useCallback("), LIB.indexOf("runImportRef.current = (paths)"));
    expect(body.indexOf("await offerReplace(results)")).toBeGreaterThan(body.indexOf("setImporting(true)"));
    expect(body.indexOf("await offerReplace(results)")).toBeLessThan(body.indexOf("setImporting(false)"));
  });

  it("replacing goes through the one Rust command, which re-checks the book before touching it", () => {
    expect(LIB).toContain("await bookReplaceFile(b.id, b.source);");
    expect(read("src/lib/ipc.ts")).toContain('invoke<ReplaceOutcome>("book_replace_file", { id, path })');
    expect(read("src-tauri/src/lib.rs")).toContain("commands::book_replace_file,");
  });
});

describe("the dialog cannot replace by accident", () => {
  it("Escape and the scrim keep, and focus does not start on «Replace»", () => {
    expect(DIALOG).toContain('useDialog({ onDismiss: onKeep, initialFocus: "none" })');
    expect(DIALOG).toMatch(/onClick=\{onKeep\}\s*\n\s*style=\{\{\s*\n\s*position: "fixed"/);
  });

  it("is drawn inside the library's shell, where its colours are defined", () => {
    // Portalled to document.body, every design token resolved to nothing: a transparent sheet with
    // the covers showing through it. That is exactly what the first build of this dialog did.
    expect(DIALOG).toMatch(/,\s*overlayHost\(\),\s*\);/);
    expect(DIALOG).not.toContain("document.body");
  });

  it("one press of «Replace» answers once", () => {
    expect(DIALOG).toMatch(/if \(busy\) return;\s*\n\s*setBusy\(true\);\s*\n\s*onReplace\(\);/);
  });
});
