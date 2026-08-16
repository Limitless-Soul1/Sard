// The Book Details edit buffer.
//
// The dialog used to write on every click, so there was nothing to Save and nothing to Cancel —
// closing it was the only outcome and every stray click was already permanent. This holds the
// pending edits instead, so the dialog can offer the two endings an editor owes a reader.
//
// Kept pure and free of React on purpose: it is the part with rules worth testing, and this
// repository's test runner has no DOM (see vitest.config.ts).

import type { BookPatch, BookRow } from "../../../lib/ipc";

/** The fields the dialog buffers. Everything here is an override with no extracted base. */
export interface BookDraft {
  title: string;
  author: string;
  /** `null` = follow the library default (the dialog's "Default" state). */
  coverFit: "crop" | "fit" | null;
  /** `null` = no chosen paint; the jacket uses the colour derived from the title. */
  coverPaint: string | null;
  /** `null` = show the file's cover when there is one. */
  coverMode: "typeset" | "file" | null;
  spineMode: "typeset" | "none";
}

const str = (v: string | null | undefined) => (v ?? "").trim();

/** The draft a freshly-opened dialog starts from — exactly what the book currently is. */
export function draftFromBook(book: BookRow): BookDraft {
  return {
    title: str(book.title),
    author: str(book.author),
    coverFit: book.cover_fit === "crop" || book.cover_fit === "fit" ? book.cover_fit : null,
    coverPaint: book.cover_paint ?? null,
    coverMode: book.cover_mode === "typeset" || book.cover_mode === "file" ? book.cover_mode : null,
    spineMode: book.spine_mode === "none" ? "none" : "typeset",
  };
}

/** Has the reader changed anything that Save would write? */
export function isDirty(draft: BookDraft, book: BookRow): boolean {
  const base = draftFromBook(book);
  return (
    draft.title !== base.title ||
    draft.author !== base.author ||
    draft.coverFit !== base.coverFit ||
    draft.coverPaint !== base.coverPaint ||
    draft.coverMode !== base.coverMode ||
    draft.spineMode !== base.spineMode
  );
}

/**
 * The patch Save sends.
 *
 * The empty string is how this API says "forget this override" — `update_book` clears the row
 * rather than storing a blank — so a cleared paint, a cleared fit and a cleared mode all travel
 * as `""` and come back as NULL. Only changed fields are included, so saving an untouched dialog
 * writes nothing.
 */
export function patchFromDraft(draft: BookDraft, book: BookRow): BookPatch {
  const base = draftFromBook(book);
  const patch: BookPatch = {};
  if (draft.title !== base.title) patch.title = draft.title;
  if (draft.author !== base.author) patch.author = draft.author;
  if (draft.coverFit !== base.coverFit) patch.coverFit = draft.coverFit ?? "";
  if (draft.coverPaint !== base.coverPaint) patch.coverPaint = draft.coverPaint ?? "";
  if (draft.coverMode !== base.coverMode) patch.coverMode = draft.coverMode ?? "";
  if (draft.spineMode !== base.spineMode) patch.spineMode = draft.spineMode;
  return patch;
}

/**
 * "Restore original" — put the jacket back to what Sard derives for this book.
 *
 * It clears every jacket override at once. Reverting only the cover FILE, which is what the
 * action did before, left a chosen paint, a chosen mode and a chosen fit still in force, so the
 * jacket visibly did not return to its original state and the control read as broken.
 */
export function draftWithOriginalCover(draft: BookDraft): BookDraft {
  return { ...draft, coverFit: null, coverPaint: null, coverMode: null };
}

/** Clearing the palette selection — the state the struck-through swatch selects. */
export function draftWithNoPaint(draft: BookDraft): BookDraft {
  return { ...draft, coverPaint: null };
}

/** Choosing a paint implies drawing the typeset jacket, which is the thing the paint colours. */
export function draftWithPaint(draft: BookDraft, paint: string): BookDraft {
  return { ...draft, coverPaint: paint, coverMode: "typeset" };
}

/**
 * A row that reflects the draft, for the dialog's own preview.
 *
 * The preview must show the pending edit, not the saved book — otherwise Crop, Contain and
 * Default look inert until Save, which is exactly the "visual-only button" complaint.
 */
export function previewRow(book: BookRow, draft: BookDraft): BookRow {
  return {
    ...book,
    title: draft.title || book.title,
    author: draft.author || null,
    cover_fit: draft.coverFit,
    cover_paint: draft.coverPaint,
    cover_mode: draft.coverMode,
    spine_mode: draft.spineMode,
  };
}
