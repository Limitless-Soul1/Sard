// THE CABINET'S ARITHMETIC — annotations in, one drawer per book out.
//
// The Library's archive is a card-catalogue cabinet: each book is one shallow drawer, and what the
// reader kept from that book lives inside it. Everything a drawer face shows is DERIVED from rows
// that already exist — there is no new column, no new table, and nothing captured at mark time that
// was not captured before. That is deliberate: the design was drawn against this data, so making it
// fit needed no model change.
//
// Kept out of the components because it is the one part of this surface with a right answer a test
// can check without a browser.

import { annoIsHighlight, annoIsNote, type AnnoItem, type BookRow } from "../../../lib/ipc";

/** One ink actually used inside a book, and how much of it there is. */
export interface Ink {
  /** The stored colour — a palette slot name, or a literal hex for a custom ink. */
  color: string;
  /** How many marks carry it. The tab's height encodes this; the design calls the tabs honest. */
  count: number;
}

/** One book's drawer, as the face needs it. */
export interface Drawer {
  bookId: string;
  title: string;
  author: string | null;
  coverPath: string | null;
  /** The BOOK's direction, which decides the face's script — not the UI language. */
  dir: string | null;
  filePath: string;
  highlights: number;
  notes: number;
  /** Distinct inks used inside, most-used first. One protruding tab each. */
  inks: Ink[];
  /** The newest thing marked in this book: what it says, and the ink it says it in. */
  latest: { text: string; color: string | null; cfi: string | null } | null;
  lastOpenedAt: number | null;
  /** Every mark in this book, newest first — what the drawer opens onto. */
  items: AnnoItem[];
}

/**
 * A drawer is only ever as tall as its content, but the TABS have to encode volume as well as
 * palette — "two tabs is a light drawer; four bristling tabs is a book someone lived in". So the
 * count of tabs carries the palette and the height of each carries how much of that ink there is,
 * scaled against the book's own busiest ink rather than against every book: a drawer is read on its
 * own terms, and one enormous book must not flatten every other silhouette to a stub.
 */
export const TAB_MIN_H = 26;
export const TAB_MAX_H = 40;

export function tabHeight(count: number, busiest: number): number {
  if (busiest <= 0) return TAB_MIN_H;
  const share = Math.max(0, Math.min(1, count / busiest));
  return Math.round(TAB_MIN_H + (TAB_MAX_H - TAB_MIN_H) * share);
}

/**
 * How many tabs a face can carry before they run off its edge.
 *
 * The face is half the cabinet's width; at the design's 44px tab on a 52px pitch, six is what fits
 * with the plate still clear. A book using more inks than this is not misreported — the SPECTRUM of
 * dots beside the tally is uncapped and shows every one; only the protruding silhouette is trimmed.
 */
export const MAX_TABS = 6;

const time = (a: AnnoItem) => a.created_at ?? 0;

/**
 * Group annotations into drawers, joining the book metadata the face needs.
 *
 * BOOKS COME FROM THE LIBRARY, NOT FROM THE ANNOTATIONS. An `AnnoItem` carries the book's title,
 * path and direction but not its author, cover or last-opened stamp, and the drawer face shows all
 * three. Joining here keeps the backend untouched: both lists are already loaded by surfaces that
 * exist, and a book with no marks simply never becomes a drawer.
 */
export function buildDrawers(items: AnnoItem[], books: BookRow[]): Drawer[] {
  const meta = new Map<string, BookRow>();
  for (const b of books) meta.set(b.id, b);

  const byBook = new Map<string, AnnoItem[]>();
  for (const it of items) {
    const list = byBook.get(it.book_id);
    if (list) list.push(it);
    else byBook.set(it.book_id, [it]);
  }

  const out: Drawer[] = [];
  for (const [bookId, list] of byBook) {
    const b = meta.get(bookId);
    const sorted = [...list].sort((x, y) => time(y) - time(x));

    // The ink spectrum, most-used first. A mark with no colour of its own (a bare note) contributes
    // no ink: the design's tabs are "one per ink actually used", and a note slip has no mark at all.
    const counts = new Map<string, number>();
    for (const it of list) {
      if (!it.color) continue;
      counts.set(it.color, (counts.get(it.color) ?? 0) + 1);
    }
    const inks: Ink[] = [...counts]
      .map(([color, count]) => ({ color, count }))
      .sort((p, q) => q.count - p.count || p.color.localeCompare(q.color));

    // The newest thing marked, quoted on the face. A highlight quotes its passage; a note quotes its
    // body — both are `text`, which is why the face needs no branch. One with neither is skipped
    // rather than quoted as an empty line.
    const newest = sorted.find((it) => (it.text ?? "").trim().length > 0) ?? null;

    out.push({
      bookId,
      title: b?.title ?? sorted[0]?.book_title ?? "",
      author: b?.author ?? null,
      coverPath: b?.cover_path ?? null,
      dir: b?.dir ?? sorted[0]?.book_dir ?? null,
      filePath: b?.file_path ?? sorted[0]?.file_path ?? "",
      highlights: list.filter(annoIsHighlight).length,
      notes: list.filter(annoIsNote).length,
      inks,
      latest: newest ? { text: (newest.text ?? "").trim(), color: newest.color, cfi: newest.cfi } : null,
      lastOpenedAt: b?.last_opened_at ?? null,
      items: sorted,
    });
  }

  return out;
}

/**
 * The cabinet's order: most recently opened drawer first.
 *
 * A book never opened has no stamp, and it sits below every book that has one rather than sorting as
 * if it were opened at the epoch — the same two-tier shape the profiles list uses for "never worn".
 * Ties fall back to the newest mark, then to the title, so the order is total and the grid never
 * reshuffles between renders.
 */
export function sortDrawers(drawers: Drawer[], lang: string): Drawer[] {
  return [...drawers].sort((a, b) => {
    const ao = a.lastOpenedAt ?? 0;
    const bo = b.lastOpenedAt ?? 0;
    if (ao !== bo) return bo - ao;
    const am = a.latest ? time(a.items[0]) : 0;
    const bm = b.latest ? time(b.items[0]) : 0;
    if (am !== bm) return bm - am;
    return a.title.localeCompare(b.title, lang, { sensitivity: "base" });
  });
}

/**
 * The letter a coverless book shows on its plate.
 *
 * The first character that actually draws something — a leading quote or bracket names no book, and
 * the design asks for a glyph, not for punctuation.
 */
export function letterOf(title: string): string {
  for (const ch of (title ?? "").trim()) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLocaleUpperCase();
  }
  return "?";
}

/**
 * HOW BIG A SLIP IS, as a multiple of the smallest one.
 *
 * 1 is the design's own compact card and the floor: the wall may be opened out, never tightened
 * past what was drawn. The ceiling is deliberate rather than generous — at 1.6 a slip is half again
 * as large in each direction, which is a real change to look at, while still leaving several columns
 * on an ordinary window. Past that the wall stops being a wall and becomes a short list of posters,
 * which is the composition this surface exists to avoid.
 */
export const SCALE_MIN = 1;
export const SCALE_MAX = 1.6;
export const SCALE_STEP = 0.05;

/** A stored value that is missing, damaged or out of range resolves to the smallest card. */
export function clampScale(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return SCALE_MIN;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, n));
}
