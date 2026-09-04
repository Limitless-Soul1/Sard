// THE READING MAP — the shape of someone's reading, before a word of it is read.
//
// The deposit does not open with a list of categories; it opens with the book. Bars run across the
// whole spine, each stacked by the KIND of mark made in that stretch, so you can see where a reader
// went quiet and where they stopped four times in sixty chapters.
//
// A RELEASED LAYER KEEPS ITS PLACE. Unbinding a mark does not delete its band — the band empties to a
// hollow strip, so the map goes on showing the shape of the reading rather than collapsing toward
// whatever is still bound.
//
// Pure: no React, no DOM, no colours. It answers "how many bars, and what is in each" and nothing else.
import type { DepositPlan, MarkSection } from "../../../lib/ipc";

/** The four strata, in a FIXED order, so the layers read alike from one stretch to the next. */
export interface Strata {
  highlights: number;
  notes: number;
  references: number;
  replacements: number;
}

export interface Band {
  /** 0 is the first stretch of the book. The RTL drawing order is the view's business, not this. */
  index: number;
  /** From, to — section ordinals this bar covers, for the caption. */
  from: number;
  to: number;
  /** Everything that falls here. */
  all: Strata;
  /** The part of it the sender has bound. `bound <= all` in every stratum. */
  bound: Strata;
}

export interface ReadingMap {
  bands: Band[];
  /** Marks whose cfi names no position — they have a text but nowhere to stand. Never guessed onto a
   *  band; they are reported here and shown in the map's foot. */
  sectionless: Strata;
  /** References and replacements apply to the whole book by construction: they key on a phrase, not a
   *  position, so drawing them at a chapter would be drawing a false shape. */
  wholeBook: Strata;
  spineCount: number | null;
}

const zero = (): Strata => ({ highlights: 0, notes: 0, references: 0, replacements: 0 });

/**
 * How many bars to draw.
 *
 * The design's sheet shows twenty-four across 1432 chapters — roughly sixty chapters a bar, which is
 * what makes them "substantial strips, not hairlines". Twenty-four over a nine-section book would be
 * slivers of nothing, so the count is bounded by the spine itself.
 */
export const bandCount = (spineCount: number | null | undefined): number => {
  if (!spineCount || spineCount < 1) return 0;
  return Math.max(1, Math.min(24, spineCount));
};

/** Which bar a section ordinal falls in. */
export const bandOf = (sectionIndex: number, spineCount: number, bands: number): number =>
  Math.min(bands - 1, Math.floor((sectionIndex / spineCount) * bands));

export interface MapInput {
  plan: DepositPlan;
  /** Bound row ids, by layer — the same selection the manifest is built from. */
  bound: { highlights: Set<string>; notes: Set<string>; references: Set<string>; replacements: Set<string> };
  /** All reference and replacement ids available, since neither carries a position. */
  referenceIds: string[];
  replacementIds: string[];
}

export function buildMap(input: MapInput): ReadingMap {
  const spineCount = input.plan.spine_count ?? null;
  const n = bandCount(spineCount);
  const bands: Band[] = [];
  for (let i = 0; i < n; i++) {
    const from = spineCount ? Math.floor((i * spineCount) / n) : 0;
    const to = spineCount ? Math.max(from, Math.floor(((i + 1) * spineCount) / n) - 1) : 0;
    bands.push({ index: i, from, to, all: zero(), bound: zero() });
  }
  const sectionless = zero();
  const wholeBook = zero();

  const place = (m: MarkSection, key: "highlights" | "notes", isBound: boolean) => {
    if (spineCount && n > 0 && m.section_index !== null && m.section_index !== undefined) {
      const b = bands[bandOf(m.section_index, spineCount, n)];
      b.all[key]++;
      if (isBound) b.bound[key]++;
    } else {
      sectionless[key]++;
    }
  };

  for (const m of input.plan.sections) {
    if (m.kind === "highlight") place(m, "highlights", input.bound.highlights.has(m.id));
    else if (m.kind === "note") place(m, "notes", input.bound.notes.has(m.id));
  }

  wholeBook.references = input.referenceIds.length;
  wholeBook.replacements = input.replacementIds.length;

  return { bands, sectionless, wholeBook, spineCount };
}

/** The tallest stack in the map, so a view can scale every bar against one number. */
export const tallestBand = (map: ReadingMap): number =>
  map.bands.reduce(
    (max, b) => Math.max(max, b.all.highlights + b.all.notes + b.all.references + b.all.replacements),
    0,
  );

export const totalIn = (s: Strata): number => s.highlights + s.notes + s.references + s.replacements;
