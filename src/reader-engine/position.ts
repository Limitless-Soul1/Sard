// RESILIENCE-1 / WP-4F — WHAT THE POSITION READOUT SAYS.
//
// The reported issue was "there is no page counter". The obvious answer — count pages — is the wrong
// one for a reflowable book, and stating why is the whole point of this module.
//
// A synthetic whole-book page count requires laying the entire book out at the CURRENT settings.
// Sard's typography controls are rich (zoom, line height, margins, page width, font, flow mode), so
// "421 pages" becomes "509" on one slider drag, and the number the reader wrote down yesterday is
// wrong today. A counter that moves under the reader is worse than none. This is why Kindle shows
// locations, and why foliate already computes them.
//
// So, in order of preference:
//   1. pageLabel — the REAL printed page of the source edition, when the book ships a `page-list`.
//      Called "page" because it IS one. (0 of 17 books in the corpus provide it — a bonus tier.)
//   2. location  — byte-derived, therefore STABLE under every typography control. Called "location",
//      never "page", because honesty about the unit is what makes it trustworthy.
//   3. nothing   — if foliate gave us neither, show nothing rather than invent a number.
//
// Pure, so the rule is testable without a renderer.

import type { TKey } from "../i18n/locales/en";

export interface PositionInput {
  location: { current: number; total: number } | null;
  pageLabel: string | null;
}

export type PositionKind = "page" | "location";

export interface PositionReadout {
  kind: PositionKind;
  /** Already-formatted numbers, so the caller does the locale digits once and this stays pure. */
  current: string;
  total: string | null;
  labelKey: TKey;
}

/**
 * Decide what to show, or null when the book has told us nothing worth showing.
 *
 * `fmt` formats a number for the active locale (Arabic-Indic digits in an Arabic UI) — passed in so
 * this module has no dependency on the i18n runtime and can be unit-tested with `String`.
 */
export function positionReadout(
  info: PositionInput,
  fmt: (n: number) => string,
): PositionReadout | null {
  // Tier 1 — the source edition's own page. A label is text ("xii", "42"), not a number, so it is
  // shown verbatim: renumbering a roman-numeral front matter would be a lie about the edition.
  const label = (info.pageLabel ?? "").trim();
  if (label) return { kind: "page", current: label, total: null, labelKey: "reader.pos.page" };

  // Tier 2 — locations. `current` is 0-based in foliate; readers count from 1.
  const loc = info.location;
  if (loc && loc.total > 0 && Number.isFinite(loc.current)) {
    const current = Math.min(Math.max(loc.current + 1, 1), loc.total);
    return { kind: "location", current: fmt(current), total: fmt(loc.total), labelKey: "reader.pos.location" };
  }

  return null;
}

/**
 * Is this readout allowed to go backwards on a forward move?
 *
 * It is not — and this exists so the property has a name a test can assert. A byte-derived location
 * is monotonic in reading order, so a decrease while paging forward means the wrong field was
 * plumbed through, which is precisely the sort of mistake that looks fine in a screenshot.
 */
export function isForwardConsistent(before: PositionInput, after: PositionInput): boolean {
  if (!before.location || !after.location) return true; // nothing comparable — not a violation
  if (before.location.total !== after.location.total) return true; // a re-layout re-based the scale
  return after.location.current >= before.location.current;
}
