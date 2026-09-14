// «بداية، لا قالب» — A START, NOT A TEMPLATE.
//
// Four ways of reading the same passage. They used to be four tables of coordinates, which meant a
// four-word line and a four-hundred-character paragraph were laid out identically and only the words
// differed. They are now four FLAVOURS of one content-aware pass (see `autoLayout`): each tilts the
// alignment, the margins and how much air the card is given, and the pass works out the sizes and
// the arrangement from what there actually is to say.
//
// Applying one is an act, not a mode. It rearranges the card once and then stops having an opinion —
// nothing here is consulted on render, so nothing here can undo a change the user made afterwards.

import { autoLayout, type Flavour, type RoleText } from "./autoLayout";
import { brandBand, newId, type Composition, type PresetPart, type Rect, type TextElement, type TextStyle } from "./composition";
import { MIN_SIZE } from "./elements";
import type { CardFormat } from "./photo";

export type CompositionId = Flavour;

export const COMPOSITIONS = [
  { id: "calm" as const, label: "photo.comp.calm" as const },
  { id: "manuscript" as const, label: "photo.comp.manuscript" as const },
  { id: "gilded" as const, label: "photo.comp.gilded" as const },
  { id: "night" as const, label: "photo.comp.night" as const },
  // The one that pre-designs nothing — see `FLAVOUR.blank` in autoLayout and the `blank` skin.
  { id: "blank" as const, label: "photo.comp.blank" as const },
];

/** What a card can be made of, in reading order. */
export const ROLES: PresetPart[] = ["quote", "title", "chapter", "author", "attribution"];

export type { RoleText };

/** The canvas a layout is being made for. */
export interface Canvas { format: CardFormat; w: number; h: number; }

/**
 * ARRANGE A NEW CARD.
 *
 * Only the roles that actually have words: a book with no chapter does not get an empty chapter line
 * waiting on the card to be noticed. Attribution is left out unless it is given — a card already
 * names its book and its author, and a third line saying so again is clutter.
 */
export function seedComposition(
  id: CompositionId, text: RoleText, canvas: Canvas,
  /** The foot the Sard mark has claimed — see `brandBand`. */
  reserveBottom = 0,
  /** Parts already on the card with nothing in them yet — see `autoLayout`'s `present`. */
  present: PresetPart[] = [],
): TextElement[] {
  return autoLayout({
    format: canvas.format, w: canvas.w, h: canvas.h, text, flavour: id, reserveBottom, present,
  }).elements;
}

/**
 * ONE ROLE, PLACED THE WAY THE LAYOUT WOULD HAVE PLACED IT.
 *
 * For a role added after the fact. It runs the same pass over the card's own words and takes the one
 * element out of it, so a title added by hand lands where a title belongs on THIS card rather than
 * at a coordinate that was right for some other one.
 */
export function makeRoleElement(
  id: CompositionId, part: PresetPart, text: string, canvas: Canvas, all: RoleText = {},
  /** The foot the Sard mark has claimed — see `brandBand`. Zero when there is no mark to avoid. */
  reserveBottom = 0,
): TextElement {
  const laid = autoLayout({
    format: canvas.format, w: canvas.w, h: canvas.h, flavour: id,
    text: { ...all, [part]: text },
    // This part is being ADDED, so it is on the card whether or not it has words yet.
    present: [part],
    reserveBottom,
  });
  const found = laid.elements.find((e) => e.origin === part);
  if (found) return { ...found, id: newId(), text };
  // A part the pass does not lay out (an empty attribution, say) still has to arrive somewhere.
  const last = laid.elements[laid.elements.length - 1];
  return {
    id: newId(),
    kind: part === "quote" ? "quote" : "attribution",
    placement: { rect: last ? { ...last.placement.rect, y: Math.min(0.93, last.placement.rect.y + last.placement.rect.h + 0.02) } : { x: 0.1, y: 0.86, w: 0.8, h: 0.05 } },
    style: { size: 0.026, weight: 400, lineHeight: 1.34, align: "center", color: null, opacity: 0.66, dir: "auto" },
    text,
    origin: part,
  };
}

/**
 * ADD A ROLE, AND LET THE CREDIT STACK MAKE ROOM FOR IT.
 *
 * THE FAULT THIS ANSWERS. `makeRoleElement` lays the whole card out and takes ONE element from the
 * result — which places the newcomer correctly against a stack that has made room for it, while the
 * elements already on the card stay where a layout that never knew about it had put them. Measured:
 * switching «إسناد» on dropped the attribution straight through the author line.
 *
 * The rule is OWNERSHIP BY COMPARISON, and it needs no new field to record it. An element that is
 * still EXACTLY where the layout put it has never been touched, so the layout may move it again. An
 * element that has been dragged does not match, and is left alone — the reader's arrangement wins,
 * and the newcomer takes the place the stack has for it either way.
 *
 * It reuses the same pass for both readings, so there is no second idea of where a credit line goes.
 */
/** One credit line's minimum slot, and the air between two of them — see `autoLayout`. */
const MIN_SLOT = MIN_SIZE;
const CREDIT_STEP = 0.016;

export function addRoleLaidOut(
  elements: Composition["elements"], id: CompositionId, part: PresetPart, text: string,
  canvas: Canvas, all: RoleText, reserveBottom = 0,
): Composition["elements"] {
  const lay = (t: RoleText, on: PresetPart[]) => autoLayout({
    format: canvas.format, w: canvas.w, h: canvas.h, flavour: id, text: t, present: on, reserveBottom,
  }).elements;

  /**
   * What is on the card now — and A ROLE THAT IS ON IT COUNTS EVEN WITH NO WORDS IN IT.
   *
   * Such a role has an element, a box and an editing affordance, so it needs a line of the stack. It
   * is named in `present` rather than faked into the text, because an empty part and a part nobody
   * asked for are the same empty string and must not be. Without a slot it kept whatever place it
   * last had — measured in the editor, an empty «المؤلف» and an empty «إسناد» both sat at y=758.
   */
  const on: RoleText = {};
  const here: PresetPart[] = [];
  for (const el of elements) {
    if (el.kind !== "unknown" && el.kind !== "image" && el.origin && !el.hidden) {
      on[el.origin] = el.text;
      here.push(el.origin);
    }
  }
  const before = new Map(lay(on, here).map((e) => [e.origin, e.placement.rect] as const));
  const after = new Map(
    lay({ ...on, [part]: text }, [...here, part]).map((e) => [e.origin, e.placement.rect] as const));

  /**
   * Still where the layout put it — judged on POSITION AND MEASURE ONLY.
   *
   * The height is deliberately not compared: a text box is the height of its text (see `fitToText`),
   * so by the time anyone looks, every element's `h` has settled onto its real content and matches
   * no layout estimate. Comparing it meant nothing ever matched, nothing was allowed to move, and
   * the newcomer took a seat the stack had not actually made — which put the chapter and the author
   * on the same line.
   */
  const same = (a: Rect, b: Rect) =>
    Math.abs(a.x - b.x) < 0.006 && Math.abs(a.y - b.y) < 0.006 && Math.abs(a.w - b.w) < 0.006;

  const moved = elements.map((el) => {
    if (el.kind === "unknown" || el.kind === "image" || !el.origin) return el;
    const was = before.get(el.origin);
    const now = after.get(el.origin);
    // Untouched, and the stack has a new place for it: take it. Anything else stays put.
    if (!was || !now || !same(el.placement.rect, was)) return el;
    /**
     * WHOSE HEIGHT IS IT? That depends on which way round the element works.
     *
     *   the size is the READER'S   the box follows the words, so its settled height comes with it —
     *                              taking the layout's estimate would undo the fit for a frame.
     *   the size AUTO-FITS         the box is the container and the TYPE fills it, so the height is
     *                              the layout's. Keeping the old one gave a re-composed quote a box
     *                              sized for the taller card it used to have, and it came down over
     *                              the chapter line.
     */
    // An element may keep a height that FITS the slot the stack has for it; it may never keep one
    // that exceeds it. A hugged credit line is smaller than its slot, so its settled height comes
    // through untouched. A quote's box is a CONTAINER the layout sizes, and keeping the tall one it
    // had when it owned more of the card is what brought it down over the chapter line.
    const h = Math.min(el.placement.rect.h, now.h);
    return { ...el, placement: { ...el.placement, rect: { ...now, h } } };
  });

  const born = makeRoleElement(id, part, text, canvas, all, reserveBottom);
  const seat = after.get(part) ?? born.placement.rect;
  /**
   * AND THEN SIT SOMEWHERE NOBODY IS SITTING.
   *
   * The seat above is the one the STACK has for this role, and it is right whenever the stack is
   * still arranged the way the pass would arrange it. It stops being right as soon as the words have
   * been edited: an element whose text has changed is no longer where any layout would put it, so it
   * is (correctly) left alone — and the newcomer then takes a place that was never vacated. Measured
   * in the editor: an empty «المؤلف» and an empty «إسناد» both at y=758, one over the other.
   *
   * So the seat is checked against what is actually there, and the newcomer steps down a line at a
   * time until it is clear — never past the foot, and never onto anything. It moves only ITSELF: an
   * element the reader has placed is never disturbed to make room.
   */
  const taken = moved
    .filter((e) => e.kind !== "unknown" && e.kind !== "image" && !e.hidden)
    .map((e) => (e as TextElement).placement.rect);
  const clashes = (r: Rect) => taken.some((t) =>
    r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);

  let rect = seat;
  if (clashes(rect)) {
    const step = Math.max(rect.h, MIN_SLOT) + CREDIT_STEP;
    const floor = 1 - Math.max(0, reserveBottom);
    let placed = false;
    for (let y = rect.y + step; y + rect.h <= floor + 0.0001; y += step) {
      if (!clashes({ ...rect, y })) { rect = { ...rect, y }; placed = true; break; }
    }
    // Nothing below: try above, which is where a card with a full foot still has room.
    if (!placed) {
      for (let y = rect.y - step; y >= 0; y -= step) {
        if (!clashes({ ...rect, y })) { rect = { ...rect, y }; break; }
      }
    }
  }
  return [...moved, { ...born, placement: { ...born.placement, rect } }];
}

/**
 * WHAT A COMPOSITION MAY CHANGE, AND WHAT IT MAY NOT.
 *
 * A card whose text the reader has set — the face, the size, the alignment, a readability treatment,
 * a stroke — used to lose all of it the moment a second composition was chosen. The pass writes a
 * whole new style for each role, and the merge kept only the colour and the face, so an act the
 * reader reads as decorative silently destroyed their typography. That is the defect this answers.
 *
 * The answer is OWNERSHIP, not weakness. A composition still arranges everything it is for —
 * placement, and the sizes and spacing it works out from the words. What it may not touch is a
 * property the reader set by hand, which the element records in `own` as they set it.
 *
 * FOR A CARD SAVED BEFORE THE RECORD EXISTED there is nothing to consult, so the older rule stands:
 * colour and face survive and the rest is the composition's. Such a card therefore behaves exactly
 * as it did, and starts keeping the reader's choices as soon as they make one.
 */
function keepOwned(had: TextElement, laid: TextStyle): TextStyle {
  const own = had.own;
  if (!own || own.length === 0) {
    // The old rule, kept verbatim for a document that predates the record.
    return {
      ...laid,
      ...(had.style.color ? { color: had.style.color } : {}),
      ...(had.style.family ? { family: had.style.family } : {}),
    };
  }
  const out: TextStyle = { ...laid };
  for (const k of own) {
    // `size: null` is a REAL value here — it means "let this fit itself" — so presence is what
    // decides, never truthiness. A reader who turned auto-fit on has made a choice about size.
    if (Object.prototype.hasOwnProperty.call(had.style, k)) {
      (out as Record<string, unknown>)[k] = (had.style as Record<string, unknown>)[k];
    }
  }
  return out;
}

/**
 * APPLY A DIFFERENT COMPOSITION.
 *
 * The card's WORDS are kept and everything about their arrangement is worked out again, which is
 * what makes this a re-composition rather than a nudge. Anything the user added that is not a role —
 * a picture, a line of their own text — is left exactly where they put it.
 */
export function applyComposition(comp: Composition, id: CompositionId, canvas?: Canvas): Composition {
  const text: RoleText = {};
  const here: PresetPart[] = [];
  const rest: Composition["elements"] = [];
  const roles = new Map<PresetPart, TextElement>();
  for (const el of comp.elements) {
    if (el.kind !== "unknown" && el.kind !== "image" && el.origin) {
      roles.set(el.origin, el);
      // A role the user has SWITCHED OFF is not on the card, so it does not get a share of it. It
      // keeps its words and its place and comes back exactly as it was when switched on again — but
      // re-composing around a band nobody can see would leave a hole where the author used to be.
      //
      // A role that IS on the card but has no words yet still gets a share — it is named in
      // `present` below, which is how this pass is told to lay out a part that has nothing in it.
      if (!el.hidden) { text[el.origin] = el.text; here.push(el.origin); }
    } else {
      rest.push(el);
    }
  }
  const cv = canvas ?? { format: comp.canvas.format, w: comp.canvas.w, h: comp.canvas.h };
  // THE MARK IS PART OF THE COMPOSITION, so re-composing has to lay out around it. The document
  // already carries everything needed to know what it costs, which is why this is read here rather
  // than threaded through every caller.
  const laid = seedComposition(id, text, cv, brandBand(comp.preset, comp.preset.meta, cv.w, cv.h), here);
  // Keep each role's own identity and anything the user set that is not positional, so re-composing
  // does not quietly discard a colour they chose or hide something they had switched off.
  const out = laid.map((el) => {
    const had = el.origin ? roles.get(el.origin) : undefined;
    if (!had) return el;
    return {
      ...el,
      id: had.id,
      hidden: had.hidden,
      // THE READER'S OWN WORDS, always — including none. The pass is handed a space for a role that
      // is on the card and empty, and that space must not come back as the element's text.
      text: had.text,
      // The ownership record travels with the element, or the next composition would be free to
      // undo what this one was careful to keep.
      ...(had.own && had.own.length ? { own: had.own } : {}),
      style: keepOwned(had, el.style),
      placement: {
        ...el.placement,
        // A ROTATION IS NOT A LAYOUT. The pass places rectangles and has no opinion about angle, so
        // a line the reader tilted would come back upright for no reason anyone could name. Same for
        // an element pinned to a physical side.
        ...(had.placement.rotate ? { rotate: had.placement.rotate } : {}),
        ...(had.placement.mirror === false ? { mirror: false as const } : {}),
      },
    };
  });
  // A role the pass had nothing to place — switched off, or with no words left — keeps where it was.
  for (const [part, el] of roles) if (!out.some((o) => o.origin === part)) out.push(el);
  return { ...comp, elements: [...out, ...rest] };
}
