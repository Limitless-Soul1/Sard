// WP-0 (RESILIENCE-1) — the regression corpus, as vitest sees it.
//
// These tests assert properties of the CORPUS DEFINITION (which is in the repo) unconditionally,
// and properties of the BOOK FILES (which are not) only when the corpus is present. A machine
// without the corpus must SKIP the file checks loudly — never silently pass them.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error — .mjs helper, intentionally untyped
import { corpusAvailable, corpusDir, diffTraits, pickTraits, readManifest, sha256, slotCoverage } from "./corpus-lib.mjs";
// @ts-expect-error — .mjs helper
import { describeEpub } from "../lib/epub-read.mjs";

const manifest = readManifest();
const available = corpusAvailable();

describe("corpus definition (always checked — lives in the repo)", () => {
  it("declares at least one slot and names every gap", () => {
    expect(Object.keys(manifest.slots).length).toBeGreaterThan(0);
    const { gaps } = slotCoverage(manifest);
    for (const g of gaps) {
      expect(manifest.gaps?.[g], `gap "${g}" must say what is needed to close it`).toBeTruthy();
    }
  });

  it("gives every book at least one coverage tag drawn from the declared slots", () => {
    for (const b of manifest.books) {
      expect(b.tags.length, `${b.file} has no tags`).toBeGreaterThan(0);
      for (const t of b.tags) {
        expect(Object.keys(manifest.slots), `${b.file} uses undeclared tag "${t}"`).toContain(t);
      }
    }
  });

  it("has no duplicate files and no duplicate content", () => {
    const files = manifest.books.map((b: any) => b.file);
    expect(new Set(files).size, "duplicate filename").toBe(files.length);
    const hashes = manifest.books.map((b: any) => b.sha256);
    expect(new Set(hashes).size, "the same book admitted twice under two names").toBe(hashes.length);
  });

  it("covers the slots the milestone depends on", () => {
    // These are the slots without which specific work packages cannot be verified at all. `no-toc`
    // and `pdf-normal` are deliberately absent: both are open, documented gaps (see `gaps`), and
    // both have a generated fixture standing in for the code path meanwhile.
    const { covered } = slotCoverage(manifest);
    for (const required of [
      "control-wellformed", // every rendering change is measured against it
      "word-generated", // the reported defect class
      "broken-toc", // WP-6
      "rtl-undeclared", // WP-2D — the RAWY-189 sniff
      "css-heavy", // WP-7
      "very-large", // performance / section-crossing cost
      "placeholder-metadata", // WP-2C
    ]) {
      expect(covered.get(required), `slot "${required}" must be covered`).toBeGreaterThan(0);
    }
  });

  it("records the reported book with the exact shape the investigation measured", () => {
    // A guard on the evidence itself: if this book is ever swapped or re-exported, the numbers the
    // whole investigation rests on would quietly stop being true.
    const b = manifest.books.find((x: any) => x.file === "word-generated--unknown-title.epub");
    expect(b, "the reported book must stay in the corpus").toBeTruthy();
    expect(b.traits.title).toBe("Unknown");
    expect(b.traits.creator).toBe("word");
    expect(b.traits.language).toBe("en");
    expect(b.traits.spineCount).toBe(116);
    expect(b.traits.tocEntries).toBe(1);
    expect(b.traits.tocSource).toBe("ncx");
    expect(b.traits.arabicRatio).toBeGreaterThan(0.9); // Arabic content declaring `en`
  });
});

describe.skipIf(!available)("corpus files (skipped when the corpus is absent)", () => {
  const dir = corpusDir();

  it("is present — and this suite did not silently skip", () => {
    expect(available).toBe(true);
  });

  for (const book of manifest.books.filter((b: any) => !b.retired)) {
    it(`${book.file}: present, hash matches, traits match`, () => {
      const path = join(dir, book.file);
      expect(existsSync(path), `${book.file} missing from ${dir}`).toBe(true);
      const buf = readFileSync(path);
      expect(sha256(buf), `${book.file} content changed — the corpus is immutable`).toBe(book.sha256);
      expect(buf.length).toBe(book.bytes);
      if (book.format === "epub" && book.traits) {
        expect(diffTraits(book.traits, pickTraits(describeEpub(buf))).join("\n")).toBe("");
      }
    });
  }
});
