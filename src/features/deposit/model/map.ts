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
  /** From, to — section ordinals this bar covers, for the caption. `to < from` where the band lies
   *  past the end of a book too short to fill twenty-four of them. */
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
   *  band, and never drawn: the map is a map, and they are counted in the sheaf like every other mark. */
  sectionless: Strata;
  spineCount: number | null;
}

const zero = (): Strata => ({ highlights: 0, notes: 0, references: 0, replacements: 0 });

/** THE BOOK IS ALWAYS TWENTY-FOUR BANDS WIDE. Fixed by the design: not derived from the data, not
 *  responsive. A short book simply leaves its trailing bands with no chapters in them. */
export const BANDS = 24;

/** How many bars to draw: twenty-four, or none at all when the book has no spine to draw. */
export const bandCount = (spineCount: number | null | undefined): number => {
  if (!spineCount || spineCount < 1) return 0;
  return BANDS;
};

/** Chapters to a band — `ceil`, so the last band is the short one rather than the first. */
export const bandSpan = (spineCount: number, bands: number): number =>
  Math.max(1, Math.ceil(spineCount / Math.max(1, bands)));

/** Which bar a section ordinal falls in. */
export const bandOf = (sectionIndex: number, spineCount: number, bands: number): number =>
  Math.min(bands - 1, Math.max(0, Math.floor(sectionIndex / bandSpan(spineCount, bands))));

export interface MapInput {
  plan: DepositPlan;
  /** Bound row ids, by layer — the same selection the manifest is built from. */
  bound: { highlights: Set<string>; notes: Set<string>; references: Set<string>; replacements: Set<string> };
}

export function buildMap(input: MapInput): ReadingMap {
  const spineCount = input.plan.spine_count ?? null;
  const n = bandCount(spineCount);
  const per = spineCount ? bandSpan(spineCount, n) : 0;
  const bands: Band[] = [];
  for (let i = 0; i < n; i++) {
    // `to < from` on a band the book never reaches — twenty-four is fixed, so a short book runs out
    // of chapters before it runs out of bands. Those bands are drawn, empty, and carry no number.
    const from = i * per;
    const to = spineCount ? Math.min(spineCount, (i + 1) * per) - 1 : 0;
    bands.push({ index: i, from, to, all: zero(), bound: zero() });
  }
  const sectionless = zero();

  // EVERY KIND GOES THROUGH ONE DOOR. All four stack into the same twenty-four bands by the chapter
  // each was made in; a mark whose cfi names no position — an unanchorable highlight, a reference made
  // before Sard recorded where it was made — is counted apart and left off the map entirely. It keeps
  // its place in the layer counts, the sheaf, the manifest and the transfer; what it does not get is
  // a chapter it never had.
  const place = (m: MarkSection, key: keyof Strata, isBound: boolean) => {
    if (spineCount && n > 0 && m.section_index !== null && m.section_index !== undefined) {
      const b = bands[bandOf(m.section_index, spineCount, n)];
      b.all[key]++;
      if (isBound) b.bound[key]++;
    } else {
      sectionless[key]++;
    }
  };

  const KEY: Record<string, keyof Strata> = {
    highlight: "highlights",
    note: "notes",
    reference: "references",
    replacement: "replacements",
  };
  for (const m of input.plan.sections) {
    const key = KEY[m.kind];
    if (!key) continue;
    place(m, key, input.bound[key].has(m.id));
  }

  return { bands, sectionless, spineCount };
}

/** The tallest stack in the map, so a view can scale every bar against one number. */
export const tallestBand = (map: ReadingMap): number =>
  map.bands.reduce(
    (max, b) => Math.max(max, b.all.highlights + b.all.notes + b.all.references + b.all.replacements),
    0,
  );

export const totalIn = (s: Strata): number => s.highlights + s.notes + s.references + s.replacements;
