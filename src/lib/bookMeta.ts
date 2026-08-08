// RESILIENCE-1 / WP-3 — ONE authoritative source for a book's metadata.
//
// THE RULE: the DATABASE is the single source of truth; the metadata embedded in the file is an
// EXTRACTION INPUT to it, never a display source.
//
// WHAT WAS WRONG. Three surfaces already obeyed that rule — the Library, the cross-book Inbox and
// the Bookmarks shelf all read `COALESCE(override, extracted)` in SQL. Two did not: the reader's
// header and the photo-card composer read `FoliateController.title` / `.author`, i.e. the `dc:title`
// straight out of the file. Live proof in the owner's own library: book `cd27ab1d` is renamed
// "Lord Of The mysteries" in the Library, while the reader header showed the embedded
// "لورد الغوامض" and a shared photo card would have carried the embedded credit. A reader who fixes
// a title should see it fixed everywhere.
//
// This module is PURE — a row in, a decision out — so the rule is testable without a database or a
// rendered app, and so there is exactly one place to change if the rule ever changes.

import type { BookRow } from "./ipc";
import type { TKey } from "../i18n/locales/en";

/** How a stored field came to hold its value (WP-2 writes this at import and in its backfill). */
export type FieldProvenance = "declared" | "inferred" | "filename" | "default";

export interface BookMeta {
  id: string;
  /** The EFFECTIVE title: a reader's override if they set one, else what was extracted. */
  title: string | null;
  /** The EFFECTIVE author. `null` is a real state — the file named nobody. Never the word "Unknown". */
  author: string | null;
  language: string | null;
  dir: string | null;
  /** WP-5A: the script SNIFFED from the book's text at import — never its declared language. */
  script: "arabic" | "latin" | null;
  /** WP-6: WP-2 found far too few TOC entries for this spine — the Contents panel is useless. */
  tocDegenerate: boolean;
  /** WP-6B: many sections with a tiny median, so paged mode would be mostly blank pages. */
  spineFragmented: boolean;
  format: string | null;
  /** Where the stored title came from. `declared` = the file said so and it was believable. */
  titleFrom: FieldProvenance;
  authorFrom: FieldProvenance;
}

const PROVENANCE: readonly FieldProvenance[] = ["declared", "inferred", "filename", "default"];

function parseProvenance(json: string | null | undefined, field: "title" | "author"): FieldProvenance {
  if (!json) return "declared"; // never examined (pre-WP-2 row) — assume the file's own value
  try {
    const v = (JSON.parse(json) as Record<string, unknown>)?.[field];
    return PROVENANCE.includes(v as FieldProvenance) ? (v as FieldProvenance) : "declared";
  } catch {
    return "declared"; // a corrupt blob means "nothing recorded", never a throw
  }
}

/**
 * Resolve a library row into the metadata every surface should display.
 *
 * The row already carries the COALESCE'd effective values (`library_list_books`), so this does not
 * re-derive them — it names them, adds provenance, and gives every caller one shape to read.
 */
export function resolveBookMeta(row: BookRow): BookMeta {
  const clean = (v: string | null): string | null => {
    const t = (v ?? "").trim();
    return t ? t : null;
  };
  return {
    id: row.id,
    title: clean(row.title),
    author: clean(row.author),
    language: clean(row.language),
    dir: clean(row.dir),
    script: row.script_detected === "arabic" || row.script_detected === "latin" ? row.script_detected : null,
    tocDegenerate: row.toc_degenerate === 1,
    spineFragmented: row.spine_fragmented === 1,
    format: clean(row.format),
    titleFrom: parseProvenance(row.meta_provenance, "title"),
    authorFrom: parseProvenance(row.meta_provenance, "author"),
  };
}

/**
 * A stand-in built from values a caller already had, used ONLY when the database read failed.
 *
 * The reader must open even when the row cannot be fetched — a book is worth more than its name —
 * so the surface that launched it passes what it was displaying, and that is shown rather than
 * nothing. Provenance is unknown here, so nothing is claimed about where the values came from.
 */
export function hintMeta(id: string, title?: string | null, author?: string | null): BookMeta {
  return {
    id,
    title: (title ?? "").trim() || null,
    author: (author ?? "").trim() || null,
    language: null,
    dir: null,
    script: null,
    tocDegenerate: false,
    spineFragmented: false,
    format: null,
    titleFrom: "declared",
    authorFrom: "declared",
  };
}

/**
 * The title to SHOW. Never empty, never the literal "Unknown".
 *
 * A book with no usable title at all gets the localised "Untitled Book" as CHROME — the database
 * keeps `NULL`, so "nothing was known" stays distinguishable from "the file said Untitled".
 */
export function displayTitle(meta: Pick<BookMeta, "title">, t: (k: TKey) => string): string {
  return meta.title ?? t("meta.untitledBook");
}

/**
 * The author to SHOW, or `null` to show no author line at all.
 *
 * WP-2 changed the stored fallback from the literal string "Unknown" to `NULL`, because writing
 * "Unknown" made "the FILE said Unknown" indistinguishable from "Sard gave up" — and both states
 * exist in the real corpus. Surfaces that want a placeholder ask for one explicitly via
 * `displayAuthorOrUnknown`; surfaces that would rather omit the line (the library card) pass over a
 * `null` as they always have.
 */
export function displayAuthorOrUnknown(meta: Pick<BookMeta, "author">, t: (k: TKey) => string): string {
  return meta.author ?? t("meta.unknownAuthor");
}

/**
 * Is the shown title a GUESS rather than the book's own?
 *
 * True when WP-2 had to fall back past a placeholder — the reported book's `dc:title` is the literal
 * string "Unknown", so its title is the filename. The metadata editor presents that as a guess and
 * invites a correction, instead of showing it as fact.
 */
export function titleIsGuess(meta: Pick<BookMeta, "titleFrom">): boolean {
  return meta.titleFrom !== "declared";
}

/** The i18n key explaining where a guessed title came from, or null when it is the book's own. */
export function titleProvenanceKey(meta: Pick<BookMeta, "titleFrom">): TKey | null {
  switch (meta.titleFrom) {
    case "inferred":
      return "meta.titleFrom.inferred";
    case "filename":
      return "meta.titleFrom.filename";
    case "default":
      return "meta.titleFrom.default";
    default:
      return null;
  }
}
