/**
 * THE ONE ORDERING ABSTRACTION — how a run reads, and where a book may go inside it.
 *
 * Every format consumes this. None of them may work out an order or a destination for itself; that
 * is how the five came to disagree about what a position meant in the first place.
 *
 * ── WHAT A REORDER CANNOT DO ────────────────────────────────────────────────────────────────
 *
 * A `RunGap` has one field: the book to land in front of. There is no container on it, no shelf, no
 * cabinet. So a reorder cannot file, unfile or move a book — not because the code is careful, but
 * because the value it carries has nowhere to say so.
 *
 * The fault this replaces: a flat view drew several containers as one sequence and took each gap's
 * container from its NEIGHBOUR. Measured on a real library, dragging the first visible book to the
 * last visible slot reported «وُضع على خارج الأرفف», changed the book's container, and persisted.
 * The reader had asked to reorder.
 *
 * ── THE RUN ─────────────────────────────────────────────────────────────────────────────────
 *
 * A run is what a reader rearranges as one block: `(format, scope, section)`.
 *
 *   format    the five keep independent orders on purpose
 *   scope     the MOST SPECIFIC part of where the reader stands — category, else shelf, else
 *             cabinet, else the root. Not the navigation triple: a shelf id is already unique, so
 *             keying on the triple would orphan a shelf's order the moment it changed cabinets.
 *   section   the block as drawn. `WHOLE_RUN` in the flat formats; in the grouped ones the id of
 *             the shelf section, WHICH MAY BE A RULE SHELF — measured, one such section held
 *             eighteen tiles and owned none of them. A section is not a container.
 */

import type { NavScope } from "./model";

/** The flat formats draw one run, and this is its name. Not a shelf id; nothing looks it up. */
export const WHOLE_RUN = "*";

/** A destination inside the current run. One field, and deliberately no more. */
export interface RunGap {
  /** The book to land in front of, or `null` for the end of the run. */
  before: string | null;
}

export interface RunKey {
  format: string;
  scope: string;
  section: string;
}

/**
 * WHERE THE READER IS STANDING, named by its most specific part.
 *
 * A shelf's order belongs to the shelf, not to the cabinet that happens to hold it today. Keying on
 * `case|shelf|category` would mean that moving a shelf between cabinets silently orphaned every
 * order made inside it — the reader would open it and find their arrangement gone, with nothing on
 * screen to explain why.
 */
export function scopeKey(scope: NavScope): string {
  return scope.categoryId ?? scope.shelfId ?? scope.caseId ?? "";
}

/**
 * A RUN'S SEQUENCE: what is saved, then whatever the saved order has not heard of.
 *
 * An unarranged run has no rows and keeps the order it is given — the default, which is the order
 * books arrived in. Once arranged, the saved sequence leads and any newcomer follows it, in the
 * default order among themselves. That is the whole rule for new books, and it needs no write: a
 * read that writes is a race waiting to happen. The newcomers are folded in for real the next time
 * the reader arranges the run.
 */
export function applyRunOrder<T extends { id: string }>(
  books: readonly T[],
  saved: readonly string[],
): T[] {
  if (saved.length === 0) return [...books];
  const at = new Map<string, number>();
  saved.forEach((id, i) => at.set(id, i));
  return books
    .map((b, i) => ({ b, i, k: at.has(b.id) ? at.get(b.id)! : Number.MAX_SAFE_INTEGER }))
    .sort((x, y) => x.k - y.k || x.i - y.i)
    .map((x) => x.b);
}

/**
 * EVERY PLACE A BOOK MAY GO IN THIS RUN — in front of each book, and at the end.
 *
 * N books offer N + 1 places, always, whoever is being carried. Two of them would leave a given
 * book exactly where it is; they are still offered, and releasing into one writes nothing. Leaving
 * them out was tried on the old model and it made the number of destinations depend on which book
 * was in hand — so the same shelf offered four places to one book and six to another, and the flat
 * formats disagreed with the grouped ones about which was right.
 */
export function gapsForRun(order: readonly string[]): RunGap[] {
  const out: RunGap[] = order.map((id) => ({ before: id }));
  out.push({ before: null });
  return out;
}

/**
 * Whether releasing here would leave the run exactly as it stands.
 *
 * Asked of NEIGHBOURS, not of arithmetic. The write asks the same question again against the run as
 * it really is at that moment, because the reader may be looking at a list drawn a moment before.
 */
export function isNoMoveInRun(order: readonly string[], bookId: string, gap: RunGap): boolean {
  const at = order.indexOf(bookId);
  if (at < 0) return false;
  if (gap.before === bookId) return true;
  if (gap.before === null) return at === order.length - 1;
  return order[at + 1] === gap.before;
}

/** The saved sequences of one scope, grouped by section. */
export type SavedOrders = ReadonlyMap<string, readonly string[]>;

/** Fold the rows of one scope into `section → ordered book ids`. They arrive already in rank order. */
export function bySection(rows: readonly { section: string; book_id: string }[]): SavedOrders {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.section);
    if (list) list.push(r.book_id);
    else out.set(r.section, [r.book_id]);
  }
  return out;
}

/**
 * WHEN EACH SECTION WAS LAST ARRANGED BY HAND.
 *
 * Every row of a run carries the same stamp, so the first one seen settles it. A section with no
 * rows has never been arranged and appears nowhere in this map; the caller falls back to the
 * library-wide epoch, which is what keeps an unarranged run from promoting a whole reading history.
 */
export function baselineBySection(
  rows: readonly { section: string; arranged_at?: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) if (!out.has(r.section)) out.set(r.section, r.arranged_at ?? 0);
  return out;
}

/**
 * READING-AWARE ORDER: what the reader arranged, with what they have since read in front of it.
 *
 * The rule, whole:
 *
 *     books read SINCE this run was arranged, newest first
 *   ++ everything else, exactly as the run already had it
 *
 * ── WHY THE BASELINE IS NOT OPTIONAL ────────────────────────────────────────────────────────
 *
 * "Promote what has been read" is not enough, and two cases the owner specified prove it. A run
 * arranged A B C D E whose C, E and B are then read must show B E C A D — every read book promoted.
 * A run whose books were read FIRST and then arranged by hand to D B A E C, with E read afterwards,
 * must show E D B A C — only E promoted, B and C left exactly where the hand put them. Same manual
 * shape, same set of read books, different answers. Nothing derivable from (order, read_at) alone
 * can produce both: the only thing separating them is whether a read happened before or after the
 * hand last touched the run. That is this argument, and it is why one timestamp per run is stored.
 *
 * ── WHY THIS WRITES NOTHING ─────────────────────────────────────────────────────────────────
 *
 * Reading must never rewrite the reader's arrangement, so promotion is computed at the moment of
 * drawing and never persisted. `view_orders` still holds only what the hand put there. The
 * arrangement re-emerges untouched the moment the promoted books age past a new baseline — and a
 * drag, which sends the drawn run back as its new baseline, is the only thing that makes a
 * promotion permanent, because that is the one gesture in which the reader has actually approved it.
 *
 * A book with no `read_at` has never been read and is never promoted; a book read twice has one
 * timestamp and one place in the run, so repeating a read refreshes recency without duplicating
 * anything. Both fall out of the shape rather than being handled.
 */
export function promoteRecent<T extends { id: string; read_at?: number | null }>(
  run: readonly T[],
  arrangedAt: number,
): T[] {
  const promoted = run.filter((b) => (b.read_at ?? 0) > arrangedAt);
  if (promoted.length === 0) return [...run];
  // Newest first. Ties keep the run's own order, which `sort` being stable gives for free.
  const byRecency = promoted.slice().sort((a, b) => (b.read_at ?? 0) - (a.read_at ?? 0));
  const lifted = new Set(byRecency.map((b) => b.id));
  return [...byRecency, ...run.filter((b) => !lifted.has(b.id))];
}
