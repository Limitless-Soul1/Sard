// A BOOK THAT IS ALREADY HERE IS ASKED ABOUT: «Keep existing» or «Replace».
//
// What «Replace» does to the book is held by the Rust tests (`books::replace_tests`): same id, same
// row, same annotations and shelves, only a missing or damaged stored copy rewritten. These hold the
// frontend half — which results are offered, that every import path asks the same question, and that
// the question cannot be answered «Replace» by accident.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { duplicatesToOffer } from "../../src/features/library/importReport";
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

describe("every import path asks the same question", () => {
  it("the batch import and the folder import both ask before summarising", () => {
    const asks = [...LIB.matchAll(/const \{ replaced, failed \} = await offerReplace\(results\);/g)];
    expect(asks).toHaveLength(2);
    // ...and the summary then reports what the answer did.
    expect([...LIB.matchAll(/summarize\(results, t, lang, replaced\)/g)]).toHaveLength(2);
  });

  it("a double-clicked book goes through the same import, then opens — a kept duplicate opens the copy already here", () => {
    expect(LIB).toContain('const results = await runImport(paths, "open");');
    expect(LIB).toMatch(/r\.status === "imported" \|\| r\.status === "duplicate"/);
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
