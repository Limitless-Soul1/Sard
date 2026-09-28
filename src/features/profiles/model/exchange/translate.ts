// SARD-THEME/1 -> ProfileData. The one place a stranger's design becomes a هيئة.
//
// THE RULE THIS FILE EXISTS TO KEEP. Sard renders what the recipe says. A value Sard can represent
// is carried through UNTOUCHED, however it measures; a value Sard cannot represent is DROPPED, and
// the reader's own value stands in its place.
//
//   There is no clamp. There is no nearest-legal value. There is no rescale. There is no fallback
//   derived from a rejected input. A rejected value is read, reported, and discarded, and nothing
//   downstream ever sees it.
//
// That is stated as a negative on purpose: it is a property of the code that a reviewer can check by
// searching for the absence of arithmetic on a rejected value, and `take()` below is the only place
// a supplied value can reach the output at all.
//
// WHAT "THE READER'S OWN VALUE" MEANS, AND WHY IT DIFFERS BY FIELD. A هيئة's blob has two kinds of
// field, and a drop lands differently on each:
//
//   OPTIONAL — the measure, the read-aloud marks, the reference rule, `bookmark`, `numbers`,
//   `relief`. `null` there already means "no opinion", so a dropped field is simply never written
//   and the reader's own setting shows through when the هيئة is worn. Exactly what a drop should do.
//
//   REQUIRED — the palette's colours, `texture`, `seal`, the marks. The blob must hold something, so
//   `parseProfileData` supplies SARD'S OWN DEFAULT. Not the هيئة the reader happens to be wearing:
//   that would make the same recipe produce a different هيئة for every reader and a third one on
//   re-import. An imported design is self-contained and deterministic.
//
// PURE AND TOTAL. No IPC, no filesystem, no stores, and nothing here throws — the same contract
// `package.ts` keeps, so the whole of it can be proved in a unit test.

import { isHex, suggestsDark } from "../palette";
import { parseProfileData, type ProfileData } from "../profile";
import {
  BOUNDS,
  NOT_EXPRESSIBLE,
  PALETTE_KEYS,
  PALETTE_OPTIONAL_COLOUR,
  PALETTE_SOLID,
  PALETTE_WASH,
  REFERENCE_KEYS,
  SLOT_KEYS,
  TEXTURES,
  TOP_KEYS,
  VOICE_KEYS,
  type Bound,
  type Finding,
} from "./recipe";


export interface Translation {
  /** An ordinary هيئة. Nothing marks it as having come from an AI, here or in the database. */
  data: ProfileData;
  /** The name, description, author and reasoning, for the row's own columns. */
  meta: { name: string | null; description: string | null; author: string | null; notes: string | null };
  /** Every drop and every note, in the order they were found. */
  findings: Finding[];
  /** The ratios the author claimed, untouched and unjudged. `measure.ts` compares them (Phase 3). */
  claims: Record<string, number>;
}

/** A tiny collector, so no call site has to remember the finding's shape. */
class Report {
  readonly findings: Finding[] = [];
  add(f: Finding): void {
    this.findings.push(f);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** A colour that may carry alpha — hex, or the `rgba()` the palette model already accepts. */
const isWash = (v: unknown): boolean =>
  typeof v === "string" && (isHex(v) || /^rgba?\([\d\s.,%]+\)$/.test(v));

/**
 * Note the keys the dialect has no meaning for, so a setting cannot vanish in silence.
 *
 * TWO KINDS OF MISS, AND THEY ARE NOT THE SAME NEWS. An invented name means the author was guessing
 * and the reader should weigh the whole design accordingly. A name in `NOT_EXPRESSIBLE` means the
 * author asked for a real setting this dialect does not carry yet — reasonable, and worth a reason
 * rather than a shrug. Either way the field is dropped and the reader's own value stands.
 */
/**
 * A key that is not in the vocabulary — and WHY it is not, which the reader needs to know.
 *
 * Two different absences wear the same shape in a recipe. A key Sard has never heard of is noise.
 * A key naming something a هيئة really owns — the text size, the picture's presence, the bookmark's
 * shape — is a designer asking reasonably for something this dialect deliberately does not carry.
 * `NOT_EXPRESSIBLE` knows the difference, and the report keeps the two apart so a reader can tell
 * "your model invented a field" from "that one is yours to set, not its".
 */
function flagUnknown(o: unknown, allowed: readonly string[], base: string, r: Report): void {
  if (!isObj(o)) return;
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    const path = base ? `${base}.${k}` : k;
    const why = NOT_EXPRESSIBLE[k];
    if (why !== undefined) {
      r.add({ kind: "drop", code: "rcp.drop.notExpressible", path, value: o[k], why });
      continue;
    }
    // A BLOCK OF THEM, named by the block rather than by each field inside it: `measure` and
    // `background` are whole families this version does not carry, and naming the family once is
    // more use to a reader than naming every leaf under it.
    const inner = isObj(o[k]) ? o[k] : undefined;
    if (inner) {
      const named = Object.keys(inner).filter((f) => NOT_EXPRESSIBLE[f] !== undefined);
      if (named.length > 0) {
        for (const f of named) {
          r.add({ kind: "drop", code: "rcp.drop.notExpressible", path: `${path}.${f}`, value: inner[f], why: NOT_EXPRESSIBLE[f] });
        }
        continue;
      }
      // A per-surface block — `background.library` — whose leaves are the ones named.
      const deep = Object.values(inner).filter(isObj)
        .flatMap((v) => Object.keys(v).filter((f) => NOT_EXPRESSIBLE[f] !== undefined));
      if (deep.length > 0) {
        for (const f of new Set(deep)) {
          r.add({ kind: "drop", code: "rcp.drop.notExpressible", path: `${path}.${f}`, value: undefined, why: NOT_EXPRESSIBLE[f] });
        }
        continue;
      }
    }
    r.add({ kind: "drop", code: "rcp.drop.unknown", path });
  }
}

/** A finite number inside its bound, or a drop naming the bound the reader can act on. */
function num(v: unknown, path: string, bound: Bound | undefined, r: Report): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    r.add({ kind: "drop", code: "rcp.drop.type", path, value: v, want: "number" });
    return undefined;
  }
  if (bound && (v < bound.min || v > bound.max)) {
    r.add({ kind: "drop", code: "rcp.drop.range", path, value: v, min: bound.min, max: bound.max });
    return undefined;
  }
  return v;
}

function bool(v: unknown, path: string, r: Report): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    r.add({ kind: "drop", code: "rcp.drop.type", path, value: v, want: "boolean" });
    return undefined;
  }
  return v;
}

function oneOf<T extends string | number>(
  v: unknown, path: string, allowed: readonly T[], r: Report,
): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (!(allowed as readonly unknown[]).includes(v)) {
    r.add({ kind: "drop", code: "rcp.drop.vocab", path, value: v, allowed: allowed.map(String) });
    return undefined;
  }
  return v as T;
}

function colour(v: unknown, path: string, r: Report, wash = false): string | undefined {
  if (v === undefined || v === null) return undefined;
  const ok = wash ? isWash(v) : typeof v === "string" && isHex(v);
  if (!ok) {
    r.add({ kind: "drop", code: "rcp.drop.colour", path, value: v });
    return undefined;
  }
  return v as string;
}


/**
 * WRITE A KEY ONLY WHEN THE VALUE SURVIVED — the whole optional-field rule, in one line.
 *
 * This is also the single gate every accepted value passes through, which is what makes the negative
 * rule checkable: a reviewer asking "does this file ever derive a replacement from a rejected value"
 * has one function to read. Each validator returns the supplied value or `undefined`, and
 * `undefined` means the key is never written at all. No branch anywhere computes a substitute.
 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

// ---- the palette --------------------------------------------------------------------------------

function palette(
  raw: unknown, scope: "library" | "reading", r: Report,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    r.add({ kind: "drop", code: "rcp.drop.type", path: `palette.${scope}`, value: raw, want: "object" });
    return undefined;
  }
  const base = `palette.${scope}`;
  flagUnknown(raw, PALETTE_KEYS, base, r);

  const colors: Record<string, unknown> = {};
  for (const k of PALETTE_SOLID) put(colors, k, colour(raw[k], `${base}.${k}`, r));
  for (const k of PALETTE_WASH) put(colors, k, colour(raw[k], `${base}.${k}`, r, true));

  // EACH PEN FAILS ALONE. A bad `teal` costs the reader teal, not the other seven — the block is a
  // record of eight independent choices, not one indivisible thing.
  if (raw.highlight !== undefined && raw.highlight !== null) {
    if (!isObj(raw.highlight)) {
      r.add({ kind: "drop", code: "rcp.drop.type", path: `${base}.highlight`, value: raw.highlight, want: "object" });
    } else {
      flagUnknown(raw.highlight, SLOT_KEYS, `${base}.highlight`, r);
      const pens: Record<string, unknown> = {};
      for (const slot of SLOT_KEYS) {
        put(pens, slot, colour(raw.highlight[slot], `${base}.highlight.${slot}`, r));
      }
      if (Object.keys(pens).length > 0) colors.highlight = pens;
    }
  }

  const out: Record<string, unknown> = { colors };
  for (const k of PALETTE_OPTIONAL_COLOUR) put(out, k, colour(raw[k], `${base}.${k}`, r));

  // RELIEF IS THE LIBRARY'S ALONE. `profileTheme` applies it and `profileReadingTheme` does not, so a
  // value on the reading palette could not move a book page even if it were honoured. Accepting it
  // would be telling the designer something happened that did not.
  if (raw.relief !== undefined && raw.relief !== null) {
    if (scope === "reading") {
      r.add({ kind: "drop", code: "rcp.drop.scope", path: `${base}.relief`, value: raw.relief });
    } else {
      put(out, "relief", num(raw.relief, `${base}.relief`, BOUNDS["palette.relief"], r));
    }
  }

  // `dark` IS AUTHORED, NOT DERIVED — it drives the highlight blend and the ink alpha, so a palette
  // that says nothing leaves marks undefined rather than merely unstyled. Absence is not a design
  // decision, so Sard fills it from the paper and says so.
  const claimed = bool(raw.dark, `${base}.dark`, r);
  const paper = typeof colors.paperBg === "string" ? (colors.paperBg as string) : undefined;
  if (claimed === undefined) {
    if (paper) {
      out.dark = suggestsDark(paper);
      r.add({ kind: "note", code: "rcp.note.filled", path: `${base}.dark`, from: paper });
    }
  } else {
    // RENDERED AS WRITTEN. A mismatch between what the palette claims and what its paper measures is
    // reported so the reader can see it in the preview and judge; it is NOT corrected here, because
    // correcting a value the design stated is the one thing this module may never do.
    out.dark = claimed;
    if (paper && suggestsDark(paper) !== claimed) {
      r.add({
        kind: "note", code: "rcp.note.polarity", path: `${base}.dark`,
        claimed, measured: suggestsDark(paper),
      });
    }
  }
  return out;
}

// ---- the measure, the marks, the picture, the marks a voice makes -------------------------------




function voice(raw: unknown, r: Report): Record<string, unknown> | undefined {
  if (!isObj(raw)) return undefined;
  flagUnknown(raw, VOICE_KEYS, "voice", r);
  const out: Record<string, unknown> = {};
  put(out, "ttsSpotlightColor", colour(raw.sentenceColor, "voice.sentenceColor", r));
  put(out, "ttsKaraokeColor", colour(raw.wordColor, "voice.wordColor", r));
  put(out, "ttsSpotlightOpacity", num(raw.sentenceOpacity, "voice.sentenceOpacity", BOUNDS["voice.sentenceOpacity"], r));
  put(out, "ttsKaraokeOpacity", num(raw.wordOpacity, "voice.wordOpacity", BOUNDS["voice.wordOpacity"], r));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The rule's COLOUR. Its weight and its offset are geometry, and geometry stays with the reader. */
function reference(raw: unknown, r: Report): Record<string, unknown> | undefined {
  if (!isObj(raw)) return undefined;
  flagUnknown(raw, REFERENCE_KEYS, "reference", r);
  const out: Record<string, unknown> = {};
  put(out, "refRuleColor", colour(raw.color, "reference.color", r));
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- the whole design ---------------------------------------------------------------------------

const text = (v: unknown, cap: number): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, cap) : null;

/**
 * Turn an inspected recipe into a هيئة.
 *
 * The blob is built from ACCEPTED VALUES ONLY and then handed to `parseProfileData`, which is total
 * and supplies Sard's own default for anything absent. That ordering is the point: this function
 * decides what was acceptable and reports it, and the parser decides what a هيئة looks like when a
 * field is missing. Neither is asked to do the other's job, and nothing in between invents a value.
 */
export function translateRecipe(raw: Record<string, unknown>, carry: Finding[] = []): Translation {
  const r = new Report();
  for (const f of carry) r.add(f);
  flagUnknown(raw, TOP_KEYS, "", r);

  const blob: Record<string, unknown> = {};

  // The two palettes. A recipe that states only `library` says nothing about the page, and the
  // parser's own default answers that — it is not this module's business to copy one onto the other.
  const lib = palette(isObj(raw.palette) ? raw.palette.library : undefined, "library", r);
  const read = palette(isObj(raw.palette) ? raw.palette.reading : undefined, "reading", r);
  if (isObj(raw.palette)) flagUnknown(raw.palette, ["library", "reading"], "palette", r);
  if (lib || read) {
    const theme: Record<string, unknown> = {};
    if (lib) theme.library = lib;
    if (read) theme.reading = read;
    blob.theme = theme;
  }

  const v = voice(raw.voice, r);
  if (v) blob.voice = v;
  const ref = reference(raw.reference, r);
  if (ref) blob.refs = ref;

  put(blob, "texture", oneOf(raw.texture, "texture", TEXTURES, r));
  // The author's own arithmetic, carried through untouched and unjudged. Phase 3 recomputes every
  // ratio and shows the reader both numbers; nothing here reads a claim for any decision.
  const claims: Record<string, number> = {};
  if (isObj(raw.checks)) {
    for (const [k, val] of Object.entries(raw.checks)) {
      if (typeof val === "number" && Number.isFinite(val)) claims[k] = val;
    }
  }

  return {
    data: parseProfileData(JSON.stringify(blob)),
    meta: {
      name: text(raw.name, 80),
      description: text(raw.description, 240),
      author: text(raw.author, 80),
      notes: text(raw.notes, 2000),
    },
    findings: r.findings,
    claims,
  };
}
