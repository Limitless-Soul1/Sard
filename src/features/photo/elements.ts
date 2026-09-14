// COMPOSING A CARD — the operations the editor performs on a document, kept out of the editor.
//
// Every function here is pure: a composition in, a new composition out. That is what lets the same
// operations be tested without a browser and reused by anything else that ever edits a card (a
// template applied to a new quote, an undo stack, a keyboard nudge).
//
// ## Two rules that shape all of it
//
// 1. GEOMETRY IS FRACTIONS OF THE CANVAS, and `x` is the INLINE-START edge, not the left one. Drag
//    deltas therefore arrive already converted from screen pixels by the caller, and a drag towards
//    the reader's start is POSITIVE in both directions. Nothing here knows about RTL, because the
//    coordinate system already does.
//
// 2. AN ELEMENT IS NEVER LOST. Moving one off the canvas is allowed — a sticker half off the edge is
//    a legitimate composition — but every operation keeps enough of it addressable that the user can
//    always grab it again. That is why the clamps below bound the rect rather than the position.

import {
  newId, type CardElement, type Composition, type ImageElement, type Placement, type Rect,
  type TextElement, type TextKind, type TextStyle,
} from "./composition";

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** The smallest an element may become by dragging. Below this a handle covers the whole element. */
export const MIN_SIZE = 0.04;
/** How far off-canvas an element may sit and still be reachable. */
const MIN_X = -0.9;
const MAX_X = 1.9;

export function clampRect(r: Rect): Rect {
  const w = clamp(r.w, MIN_SIZE, 3);
  const h = clamp(r.h, MIN_SIZE, 3);
  return { x: clamp(r.x, MIN_X, MAX_X), y: clamp(r.y, MIN_X, MAX_X), w, h };
}

// ---- reading the document -----------------------------------------------------------------------

export const isText = (el: CardElement): el is TextElement =>
  el.kind === "quote" || el.kind === "text" || el.kind === "attribution";
export const isImage = (el: CardElement): el is ImageElement => el.kind === "image";

export function findElement(comp: Composition, id: string | null): CardElement | null {
  if (!id) return null;
  return comp.elements.find((e) => e.id === id) ?? null;
}

/** Topmost first — the order a click should consider, since later elements paint over earlier ones. */
export function hitOrder(comp: Composition): CardElement[] {
  return [...comp.elements].reverse();
}

// ---- writing to it --------------------------------------------------------------------------------

function replace(comp: Composition, id: string, fn: (el: CardElement) => CardElement): Composition {
  return { ...comp, elements: comp.elements.map((e) => (e.id === id ? fn(e) : e)) };
}

export function addElement(comp: Composition, el: CardElement): Composition {
  return { ...comp, elements: [...comp.elements, el] };
}

export function removeElement(comp: Composition, id: string): Composition {
  return { ...comp, elements: comp.elements.filter((e) => e.id !== id) };
}

/**
 * SHOW OR HIDE, WITHOUT LOSING IT.
 *
 * A hidden element keeps its words, its type and its place; it simply is not drawn. That is the
 * difference the rail's switch needs and that deleting could not give: turning the author off and
 * on again must bring back the author the user had, not a fresh one from the book.
 */
export function setHidden(comp: Composition, id: string, hidden: boolean): Composition {
  return replace(comp, id, (el) => (hidden ? { ...el, hidden: true } : { ...el, hidden: undefined }));
}

export function setPlacement(comp: Composition, id: string, p: Partial<Placement>): Composition {
  return replace(comp, id, (el) => {
    if (el.kind === "unknown") return el;
    const next: Placement = { ...el.placement, ...p };
    if (p.rect) next.rect = clampRect(p.rect);
    return { ...el, placement: next };
  });
}

/** Move by a delta already expressed in canvas fractions. */
export function moveBy(comp: Composition, id: string, dx: number, dy: number): Composition {
  const el = findElement(comp, id);
  if (!el || el.kind === "unknown") return comp;
  const r = el.placement.rect;
  return setPlacement(comp, id, { rect: { ...r, x: r.x + dx, y: r.y + dy } });
}

/** Which corner or edge a resize is pulling. Named logically, so RTL needs no special case. */
export type ResizeGrip = "is" | "ie" | "bs" | "be" | "is-bs" | "ie-bs" | "is-be" | "ie-be";

/**
 * Resize by dragging a grip. The opposite edge stays put, which is what makes a resize feel like it
 * pivots on the side you are not holding.
 */
export function resizeBy(
  comp: Composition,
  id: string,
  grip: ResizeGrip,
  dx: number,
  dy: number,
): Composition {
  const el = findElement(comp, id);
  if (!el || el.kind === "unknown") return comp;
  let { x, y, w, h } = el.placement.rect;
  if (grip.includes("is")) {
    const w2 = Math.max(MIN_SIZE, w - dx);
    x += w - w2;
    w = w2;
  }
  if (grip.includes("ie")) w = Math.max(MIN_SIZE, w + dx);
  if (grip.includes("bs")) {
    const h2 = Math.max(MIN_SIZE, h - dy);
    y += h - h2;
    h = h2;
  }
  if (grip.includes("be")) h = Math.max(MIN_SIZE, h + dy);
  return setPlacement(comp, id, { rect: { x, y, w, h } });
}

export function updateText(comp: Composition, id: string, text: string): Composition {
  return replace(comp, id, (el) => (isText(el) ? { ...el, text } : el));
}

/**
 * A STYLE CHANGE MADE BY THE READER, and recorded as theirs.
 *
 * The patch is applied and every key in it joins the element's ownership record, which is what a
 * later composition consults before it rewrites anything — see `keepOwned`. It is set HERE, at the
 * single door every control goes through, rather than in each control: a knob added later is
 * therefore owned by default, and no one has to remember to say so.
 *
 * The layout pass writes styles too, and deliberately does not come through here. That is the whole
 * distinction: what the pass computes is the composition's, what arrives on this path is the
 * reader's.
 */
export function updateStyle(comp: Composition, id: string, patch: Partial<TextStyle>): Composition {
  const keys = Object.keys(patch) as (keyof TextStyle)[];
  return replace(comp, id, (el) =>
    isText(el)
      ? { ...el, style: { ...el.style, ...patch }, own: [...new Set([...(el.own ?? []), ...keys])] }
      : el);
}

export function updateImage(comp: Composition, id: string, patch: Partial<ImageElement>): Composition {
  return replace(comp, id, (el) => (isImage(el) ? { ...el, ...patch, id: el.id, kind: "image" } : el));
}

// ---- stacking ------------------------------------------------------------------------------------
//
// Order in the array IS the stacking order, back to front. There is no z-index field to drift out of
// step with it, and no layer panel: with a handful of elements, "bring forward" and "send back" on
// the selected thing answer the question people actually have.

function reorder(comp: Composition, id: string, to: number): Composition {
  const from = comp.elements.findIndex((e) => e.id === id);
  if (from < 0) return comp;
  const next = [...comp.elements];
  const [el] = next.splice(from, 1);
  next.splice(clamp(to, 0, next.length), 0, el);
  return { ...comp, elements: next };
}

export function bringForward(comp: Composition, id: string): Composition {
  const i = comp.elements.findIndex((e) => e.id === id);
  return i < 0 || i === comp.elements.length - 1 ? comp : reorder(comp, id, i + 1);
}
export function sendBackward(comp: Composition, id: string): Composition {
  const i = comp.elements.findIndex((e) => e.id === id);
  return i <= 0 ? comp : reorder(comp, id, i - 1);
}
export function bringToFront(comp: Composition, id: string): Composition {
  return reorder(comp, id, comp.elements.length - 1);
}
export function sendToBack(comp: Composition, id: string): Composition {
  return reorder(comp, id, 0);
}

// ---- making new elements ---------------------------------------------------------------------------

/**
 * Where a new element lands.
 *
 * Not the middle of the canvas: a new element dropped dead-centre lands on top of whatever is already
 * there, and the user's first action becomes moving it out of the way. Each new element steps down and
 * across from the last, the way a stack of cards fans, so several added in a row are all reachable.
 */
export function nextRect(comp: Composition, w: number, h: number): Rect {
  const n = comp.elements.length;
  const step = 0.045;
  return clampRect({
    x: 0.5 - w / 2 + ((n % 4) - 1.5) * step,
    y: 0.5 - h / 2 + ((n % 4) - 1.5) * step,
    w,
    h,
  });
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  size: 0.062,
  weight: 400,
  lineHeight: 1.6,
  align: "start",
  color: null,
  opacity: 1,
  dir: "auto",
};

export function makeText(comp: Composition, kind: TextKind, text: string, style?: Partial<TextStyle>): TextElement {
  const w = kind === "quote" ? 0.78 : 0.6;
  const h = kind === "quote" ? 0.34 : 0.12;
  return {
    id: newId(),
    kind,
    placement: { rect: nextRect(comp, w, h) },
    style: { ...DEFAULT_TEXT_STYLE, ...style },
    text,
  };
}

export function makeImage(comp: Composition, assetId: string): ImageElement {
  return {
    id: newId(),
    kind: "image",
    placement: { rect: nextRect(comp, 0.32, 0.32) },
    assetId,
    fit: "contain",
    opacity: 1,
  };
}

/**
 * THE QUOTE, LIFTED OUT OF THE PRESET.
 *
 * The preset draws the quote in a place the user cannot touch. The moment they want to move it, it
 * has to become an element — and it must arrive where the preset had it, or the card jumps under the
 * cursor. These fractions match the preset's own column: it insets by roughly a tenth on each side and
 * gives the credit block the bottom quarter.
 */
export function liftQuote(text: string, style?: Partial<TextStyle>): TextElement {
  return {
    id: newId(),
    kind: "quote",
    placement: { rect: { x: 0.1, y: 0.16, w: 0.8, h: 0.5 } },
    style: { ...DEFAULT_TEXT_STYLE, align: "start", size: null, ...style },
    text,
  };
}

/** Attribution lifted the same way — under the quote, where every preset already puts it. */
export function liftAttribution(text: string, style?: Partial<TextStyle>): TextElement {
  return {
    id: newId(),
    kind: "attribution",
    placement: { rect: { x: 0.1, y: 0.72, w: 0.8, h: 0.14 } },
    style: { ...DEFAULT_TEXT_STYLE, size: 0.03, align: "start", opacity: 0.82, ...style },
    text,
  };
}
