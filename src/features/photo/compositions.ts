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
import { newId, type Composition, type PresetPart, type TextElement, type TextStyle } from "./composition";
import type { CardFormat } from "./photo";

export type CompositionId = Flavour;

export const COMPOSITIONS = [
  { id: "calm" as const, label: "photo.comp.calm" as const },
  { id: "manuscript" as const, label: "photo.comp.manuscript" as const },
  { id: "gilded" as const, label: "photo.comp.gilded" as const },
  { id: "night" as const, label: "photo.comp.night" as const },
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
export function seedComposition(id: CompositionId, text: RoleText, canvas: Canvas): TextElement[] {
  return autoLayout({ format: canvas.format, w: canvas.w, h: canvas.h, text, flavour: id }).elements;
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
): TextElement {
  const laid = autoLayout({
    format: canvas.format, w: canvas.w, h: canvas.h, flavour: id,
    text: { ...all, [part]: text || " " },
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
  const rest: Composition["elements"] = [];
  const roles = new Map<PresetPart, TextElement>();
  for (const el of comp.elements) {
    if (el.kind !== "unknown" && el.kind !== "image" && el.origin) {
      roles.set(el.origin, el);
      // A role the user has SWITCHED OFF is not on the card, so it does not get a share of it. It
      // keeps its words and its place and comes back exactly as it was when switched on again — but
      // re-composing around a band nobody can see would leave a hole where the author used to be.
      if (!el.hidden) text[el.origin] = el.text;
    } else {
      rest.push(el);
    }
  }
  const cv = canvas ?? { format: comp.canvas.format, w: comp.canvas.w, h: comp.canvas.h };
  const laid = seedComposition(id, text, cv);
  // Keep each role's own identity and anything the user set that is not positional, so re-composing
  // does not quietly discard a colour they chose or hide something they had switched off.
  const out = laid.map((el) => {
    const had = el.origin ? roles.get(el.origin) : undefined;
    if (!had) return el;
    return {
      ...el,
      id: had.id,
      hidden: had.hidden,
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
