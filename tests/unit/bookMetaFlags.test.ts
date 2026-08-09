// RESILIENCE-1 / WP-6 — the structural flags, as the frontend reads them.
//
// MEASURED across a real book set, values read from the database:
//
//   word-generated--a4.epub             196 sections /   1 TOC entry   degenerate
//   word-generated--unknown-title.epub  116 sections /   1 TOC entry   degenerate + FRAGMENTED
//   every other book (14)                                             neither flag
//
// The 1433-section Calibre book is deliberately NOT fragmented: the flag tests the MEDIAN SECTION
// SIZE, not the section count, so a long book with real chapters is untouched. These tests pin the
// reading of those flags, because 6B changes how a flagged book OPENS and a false positive would
// silently override a reader's flow on a book that never needed it.

import { describe, expect, it } from "vitest";
import { resolveBookMeta, hintMeta } from "../../src/lib/bookMeta";
import type { BookRow } from "../../src/lib/ipc";

function row(over: Partial<BookRow> = {}): BookRow {
  return {
    id: "b1", file_path: "x.epub", title: "T", author: null, language: null, dir: null,
    cover_path: null, added_at: 0, read_at: null, fraction: null, cfi: null, cover_fit: null,
    format: "epub", meta_provenance: null, script_detected: null,
    toc_degenerate: null, spine_fragmented: null,
    ...over,
  } as BookRow;
}

describe("WP-6 — reading the structural flags", () => {
  it("reads 1 as set", () => {
    const m = resolveBookMeta(row({ toc_degenerate: 1, spine_fragmented: 1 }));
    expect(m.tocDegenerate).toBe(true);
    expect(m.spineFragmented).toBe(true);
  });

  it("reads 0 as clear — the book WAS examined and found sound", () => {
    const m = resolveBookMeta(row({ toc_degenerate: 0, spine_fragmented: 0 }));
    expect(m.tocDegenerate).toBe(false);
    expect(m.spineFragmented).toBe(false);
  });

  it("treats NULL as clear, never as set", () => {
    // A row imported before WP-2 has no verdict. "Not examined" must never be read as "broken":
    // 6B would flip that book's flow mode on the strength of a value nobody ever measured.
    const m = resolveBookMeta(row());
    expect(m.tocDegenerate).toBe(false);
    expect(m.spineFragmented).toBe(false);
  });

  it("treats an unexpected value as clear", () => {
    // Defensive, and cheap: only an exact 1 means the flag was set. Anything else — a hand-edited
    // database, a future encoding — degrades to leaving the book alone.
    const m = resolveBookMeta(row({ toc_degenerate: 2 as unknown as number, spine_fragmented: -1 }));
    expect(m.tocDegenerate).toBe(false);
    expect(m.spineFragmented).toBe(false);
  });

  it("the fallback meta claims no flags", () => {
    // `hintMeta` is used when the row could not be read at all. It must not assert a structural
    // verdict it does not have — the book opens with its normal defaults.
    const m = hintMeta("b1", "Title", null);
    expect(m.tocDegenerate).toBe(false);
    expect(m.spineFragmented).toBe(false);
  });

  it("the two flags are independent", () => {
    // a4 is degenerate but NOT fragmented; unknown-title is both. Reading one from the other would
    // put a4 into scrolled flow for no reason.
    const a4 = resolveBookMeta(row({ toc_degenerate: 1, spine_fragmented: 0 }));
    expect(a4.tocDegenerate).toBe(true);
    expect(a4.spineFragmented).toBe(false);
  });
});
