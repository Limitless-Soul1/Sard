// Book Details' edit buffer and jacket resolution.
//
// These are the rules behind the controls the reader reported as dead: crop/contain/default,
// the palette's reset, Restore original, and Save/Cancel. They live in pure modules precisely so
// they can be checked here — this runner has no DOM by design (see vitest.config.ts), so the
// alternative was to check nothing.

import { describe, it, expect } from "vitest";
import type { BookRow } from "../../src/lib/ipc";
import {
  draftFromBook,
  draftWithNoPaint,
  draftWithOriginalCover,
  draftWithPaint,
  isDirty,
  patchFromDraft,
  previewRow,
} from "../../src/features/library/design/bookEdits";
import {
  coverPresentation,
  isDefaultFit,
  resolveCoverKind,
  resolveObjectFit,
  resolvePaint,
} from "../../src/features/library/design/coverPresentation";

function book(over: Partial<BookRow> = {}): BookRow {
  return {
    id: "b1",
    file_path: "M:/books/b1.epub",
    format: "epub",
    title: "A Title",
    author: "An Author",
    language: null,
    dir: null,
    cover_path: null,
    added_at: 0,
    last_opened_at: null,
    fraction: null,
    read_at: null,
    cover_fit: null,
    meta_provenance: null,
    script_detected: null,
    toc_degenerate: null,
    spine_fragmented: null,
    size_bytes: 400_000,
    cover_paint: null,
    cover_mode: null,
    spine_mode: null,
    spine_image: null,
    ...over,
  };
}

describe("the edit buffer", () => {
  it("starts clean, so opening and closing writes nothing", () => {
    const b = book();
    const d = draftFromBook(b);
    expect(isDirty(d, b)).toBe(false);
    expect(patchFromDraft(d, b)).toEqual({});
  });

  it("sends only the fields that changed", () => {
    const b = book();
    const d = { ...draftFromBook(b), title: "Renamed" };
    expect(patchFromDraft(d, b)).toEqual({ title: "Renamed" });
  });

  it("carries a cleared title as an empty string, which is how the API says 'forget it'", () => {
    const b = book({ title: "A Title" });
    const d = { ...draftFromBook(b), title: "" };
    expect(patchFromDraft(d, b)).toEqual({ title: "" });
  });

  it("treats Cancel as discarding — the draft is rebuilt from the book", () => {
    const b = book();
    const dirty = { ...draftFromBook(b), title: "Scribbled", coverPaint: "#8C2F39" };
    expect(isDirty(dirty, b)).toBe(true);
    expect(isDirty(draftFromBook(b), b)).toBe(false);
  });
});

describe("the palette reset", () => {
  it("clears a chosen paint and sends the clearing token", () => {
    const b = book({ cover_paint: "#8C2F39" });
    const cleared = draftWithNoPaint(draftFromBook(b));
    expect(cleared.coverPaint).toBeNull();
    // "" is what `update_book` turns into a DELETE of the override row.
    expect(patchFromDraft(cleared, b)).toEqual({ coverPaint: "" });
  });

  it("is a no-op on a book that never had one, so Save stays empty", () => {
    const b = book();
    expect(patchFromDraft(draftWithNoPaint(draftFromBook(b)), b)).toEqual({});
  });

  it("picking a paint implies the typeset jacket, which is the thing it colours", () => {
    const b = book({ cover_path: "/covers/x.jpg" });
    const picked = draftWithPaint(draftFromBook(b), "#2E5A55");
    expect(picked).toMatchObject({ coverPaint: "#2E5A55", coverMode: "typeset" });
  });
});

describe("restore original", () => {
  it("clears every jacket override at once, not just the cover file", () => {
    const b = book({ cover_paint: "#16140F", cover_mode: "typeset", cover_fit: "fit" });
    const restored = draftWithOriginalCover(draftFromBook(b));
    expect(restored).toMatchObject({ coverPaint: null, coverMode: null, coverFit: null });
    expect(patchFromDraft(restored, b)).toEqual({
      coverPaint: "",
      coverMode: "",
      coverFit: "",
    });
  });
});

describe("cover fit", () => {
  it("crop fills and contain preserves", () => {
    expect(resolveObjectFit("crop", "fit")).toBe("cover");
    expect(resolveObjectFit("fit", "crop")).toBe("contain");
  });

  it("default is a real third state that follows the library, not a synonym for crop", () => {
    expect(isDefaultFit(null)).toBe(true);
    expect(resolveObjectFit(null, "fit")).toBe("contain");
    expect(resolveObjectFit(null, "crop")).toBe("cover");
    expect(isDefaultFit("crop")).toBe(false);
  });

  it("round-trips through the draft, so reopening shows what was saved", () => {
    const saved = book({ cover_fit: "fit" });
    expect(draftFromBook(saved).coverFit).toBe("fit");
    const cleared = book({ cover_fit: null });
    expect(draftFromBook(cleared).coverFit).toBeNull();
  });
});

describe("which jacket is drawn", () => {
  it("falls back to the typeset jacket when the book has no cover file", () => {
    expect(resolveCoverKind(null, false)).toBe("typeset");
    expect(resolveCoverKind("file", false)).toBe("typeset");
  });

  it("honours an explicit typeset choice even when a file exists", () => {
    expect(resolveCoverKind("typeset", true)).toBe("typeset");
    expect(resolveCoverKind(null, true)).toBe("image");
  });

  it("prefers a chosen paint over the one derived from the title", () => {
    const derived = { bg: "#2C3A42", ink: "#EFE3CC" };
    expect(resolvePaint(null, derived).paint).toBe("#2C3A42");
    expect(resolvePaint("#D8C29A", derived)).toEqual({ paint: "#D8C29A", ink: "#3A2E14" });
  });

  it("resolves the whole presentation in one call", () => {
    const b = book({ cover_fit: "fit", cover_paint: "#5E6B49", cover_mode: "typeset" });
    const p = coverPresentation(b, true, { bg: "#2C3A42", ink: "#EFE3CC" }, "crop");
    expect(p).toEqual({ kind: "typeset", objectFit: "contain", paint: "#5E6B49", ink: "#EFE3CC" });
  });
});

describe("the dialog preview", () => {
  it("reflects the pending edit, so the controls are not inert until Save", () => {
    const b = book({ cover_fit: null, cover_paint: null });
    const d = { ...draftFromBook(b), coverFit: "fit" as const, coverPaint: "#8C2F39" };
    const p = previewRow(b, d);
    expect(p.cover_fit).toBe("fit");
    expect(p.cover_paint).toBe("#8C2F39");
    // …while the saved book is untouched until Save runs.
    expect(b.cover_fit).toBeNull();
    expect(b.cover_paint).toBeNull();
  });
});
