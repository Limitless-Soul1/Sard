// How a book's jacket should be drawn — decided here, in one pure function, rather than in each
// view's JSX.
//
// This exists because the Book Details controls were writing settings that nothing read: the
// crop/contain/default buttons persisted a `cover_fit` no view consulted, so they were real
// storage behind a dead control. Putting the decision in one place means a control is wired to
// the views by construction, and means the rule can be tested without a DOM — which is the only
// kind of test this repository runs (see vitest.config.ts).

import type { BookRow } from "../../../lib/ipc";

/** The library-wide default the Grid view's Crop/Fit toggle sets. */
export type CoverMode = "crop" | "fit";

export interface CoverPresentation {
  /** `typeset` = draw Sard's jacket; `image` = show the book's own cover file. */
  kind: "typeset" | "image";
  /** The CSS `object-fit` for an image cover. Meaningless when `kind` is `typeset`. */
  objectFit: "cover" | "contain";
  /** The ground colour for a typeset jacket, and for a spine. */
  paint: string;
  /** The ink that reads on `paint`. */
  ink: string;
}

/**
 * Resolve the fit for one book.
 *
 * A per-book `cover_fit` wins; `null` means "no per-book choice", which follows the library's own
 * Crop/Fit default. That is what makes the dialog's third button — Default — a real state rather
 * than a synonym for Crop.
 */
export function resolveObjectFit(coverFit: string | null, libraryDefault: CoverMode): "cover" | "contain" {
  const effective = coverFit === "crop" || coverFit === "fit" ? coverFit : libraryDefault;
  return effective === "fit" ? "contain" : "cover";
}

/** True when the book has no per-book fit and is therefore following the library default. */
export const isDefaultFit = (coverFit: string | null) => coverFit !== "crop" && coverFit !== "fit";

/**
 * Whether to draw the typeset jacket rather than the file's cover.
 *
 * `"typeset"` is an explicit choice. `"file"` is only honourable when a file exists — a book with
 * no cover image falls back to the typeset jacket rather than to an empty box.
 */
export function resolveCoverKind(
  coverMode: string | null,
  hasImage: boolean,
): "typeset" | "image" {
  if (coverMode === "typeset") return "typeset";
  return hasImage ? "image" : "typeset";
}

/**
 * The jacket's colours. A chosen paint wins over the one derived from the title; the derived ink
 * is kept either way, because the palette chooses a ground, not a pair.
 */
export function resolvePaint(
  coverPaint: string | null,
  derived: { bg: string; ink: string },
): { paint: string; ink: string } {
  return coverPaint ? { paint: coverPaint, ink: inkFor(coverPaint, derived.ink) } : { paint: derived.bg, ink: derived.ink };
}

/** Light grounds take dark ink; everything else takes the warm light ink. */
export function inkFor(bg: string, fallback: string): string {
  const light = new Set(["#D8C29A", "#F1E4C8"]);
  if (light.has(bg.toUpperCase())) return "#3A2E14";
  return fallback || "#F1E7D4";
}

/** Everything a view needs to draw one book's cover, in one call. */
export function coverPresentation(
  book: Pick<BookRow, "cover_mode" | "cover_paint" | "cover_fit">,
  hasImage: boolean,
  derived: { bg: string; ink: string },
  libraryDefault: CoverMode,
): CoverPresentation {
  const { paint, ink } = resolvePaint(book.cover_paint, derived);
  return {
    kind: resolveCoverKind(book.cover_mode, hasImage),
    objectFit: resolveObjectFit(book.cover_fit, libraryDefault),
    paint,
    ink,
  };
}
