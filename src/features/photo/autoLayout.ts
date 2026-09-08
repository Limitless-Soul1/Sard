// SARD DOES THE DESIGN WORK.
//
// A person selects a passage and asks for a card. What they should get back is a card — arranged,
// proportioned, nothing colliding, the quote at a size that suits its length — not a starting grid
// they have to push around before it stops looking like a form.
//
// ## Why this is not a table of coordinates
//
// The obvious implementation is a per-format lookup: quote at 16%, title at 64%, author at 78%. It
// produces exactly one card. A four-word line and a four-hundred-character paragraph get the same
// box, so one is lost in it and the other overflows; a title of nine words and a title of one get
// the same strip. The arrangement has to come from the CONTENT, so this measures first and places
// second:
//
//   1. Estimate what the quote costs. Characters, at a size, in a box of a given width, take a
//      predictable number of lines — near enough for layout, and it costs no DOM.
//   2. Solve for the size that would fill the space the quote can have. That is one equation
//      (`sizeToFill`), and it is the whole reason short and long passages come out different.
//   3. Read an ARCHETYPE off that size. A passage that wants huge type is a short one and deserves
//      a dramatic, airy card; a passage that wants small type is a long one and deserves a dense
//      editorial one. The archetype then changes margins, gaps, alignment and where the quote sits
//      — not merely its size.
//   4. Lay the credit out from the bottom up, sized against the quote and CAPPED so that a long
//      author or a nine-word title reflows instead of swelling, and give the quote what is left.
//
// ## Why estimation rather than measurement
//
// Measuring the real DOM would be exact, but it would also mean laying the card out, reading it,
// re-laying it out, and doing that inside the render that is drawing it. The estimate is a ratio of
// glyph width to type size, calibrated separately for Arabic and Latin, and it only has to be good
// enough to pick a size and a shape — after which the renderer's own auto-fit and the user's own
// eye take over. Being approximately right before anyone looks beats being exactly right afterwards.
//
// ## It runs once
//
// This is a STARTING point. It runs when a card is created, and again only when the user explicitly
// asks for a different composition. Nothing here is consulted on render, so nothing here can reach
// back in and undo a change the user made.

import { newId, type PresetPart, type Rect, type TextElement, type TextStyle } from "./composition";
import type { CardFormat } from "./photo";

/** The words a card can be made of. Absent or blank means the card simply has not got that part. */
export type RoleText = Partial<Record<PresetPart, string>>;

/**
 * The shape a card takes, chosen from how much there is to say.
 *
 * These are not sizes with names — each one arranges the card differently, because a card carrying
 * eight words and a card carrying eighty are not the same design problem.
 */
export type Archetype = "display" | "spacious" | "balanced" | "editorial" | "dense";

/** How the four shipped compositions colour the result. A flavour tilts; it does not dictate. */
export type Flavour = "calm" | "manuscript" | "gilded" | "night";

export interface AutoLayout {
  elements: TextElement[];
  archetype: Archetype;
  /** The size the quote was given, as a fraction of the card's width. For reporting and tests. */
  quoteSize: number;
}

/**
 * THE GLYPH RATIO.
 *
 * Average advance width as a fraction of the type size, for the faces Sard sets cards in. Arabic
 * runs narrower per character and its words are shorter, so the same character count occupies less
 * line — which is exactly the thing a single ratio would get wrong for one script or the other.
 */
const ADVANCE = { ar: 0.42, latin: 0.5 };

/** More than half the letters being Arabic makes it an Arabic passage for measuring purposes. */
export function isArabicText(s: string): boolean {
  let ar = 0;
  let latin = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfeff)) ar++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  return ar > latin;
}

/**
 * The height of `lines` lines, as a fraction of the card's HEIGHT.
 *
 * A size is a fraction of the card's WIDTH — the renderer sets `fontSize = size * cardWidth` — so
 * converting to a share of the height MULTIPLIES by the aspect ratio. Two callers divided instead.
 * On a square that is the same arithmetic and nothing showed; on a story it reserved 1130px for
 * 630px of text, and on a landscape it let 718px of text into a 694px box.
 */
function heightOf(lines: number, size: number, lineHeight: number, aspect: number): number {
  return lines * size * lineHeight * aspect;
}

/**
 * How many lines a PASSAGE takes, with every paragraph counted separately.
 *
 * A collection of quotes gathered in the reader arrives as ONE text with blank lines between the
 * passages, and measuring that as continuous prose undercounts it badly — three passages carry at
 * least three line breaks that a character count knows nothing about. Measured on a real
 * three-passage card: the quote needed 431px in a box it had been given 340px for, and the first
 * passage was cut off at the top of the card.
 */
function linesOf(text: string, size: number, boxW: number, advance: number): number {
  const perLine = Math.max(1, boxW / (size * advance));
  let lines = 0;
  for (const para of text.split("\n")) lines += para.length ? Math.ceil(para.length / perLine) : 1;
  return Math.max(1, lines);
}

/** How many lines `chars` take at `size` in a box `boxW` wide. Sizes and widths are card fractions. */
function linesFor(chars: number, size: number, boxW: number, advance: number): number {
  const perLine = Math.max(1, boxW / (size * advance));
  return Math.max(1, Math.ceil(chars / perLine));
}

/**
 * The size at which `chars` would exactly fill a box.
 *
 * From `lines · size · lineHeight = boxH` and `lines = chars · size · advance / boxW`, which gives
 * `size = sqrt(boxH · boxW / (chars · advance · lineHeight))`. Heights are fractions of the card's
 * HEIGHT and sizes are fractions of its WIDTH, so the aspect ratio converts between them — this is
 * where a card's proportions enter the arithmetic rather than being applied to it afterwards.
 */
function sizeToFill(chars: number, boxW: number, boxH: number, aspect: number, lineHeight: number, advance: number): number {
  if (chars <= 0) return 0;
  return Math.sqrt((boxH / aspect) * boxW / (chars * advance * lineHeight));
}

/** The largest size at which `chars` still fit in `maxLines` lines of a `boxW` box. */
function sizeToFit(chars: number, boxW: number, maxLines: number, advance: number): number {
  if (chars <= 0) return Infinity;
  return (boxW * maxLines) / (chars * advance);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * WHAT EACH FORMAT WANTS.
 *
 * Not one layout scaled to fit. A story is two portraits tall and its margins have to grow with it
 * or the card reads as a strip of text; a landscape is short and wide, so its type must come down or
 * the quote runs out of vertical room after three lines.
 */
const FORMAT: Record<CardFormat, { mx: number; my: number; cap: number; floor: number; gap: number }> = {
  //          side margin   top/bottom   biggest type   smallest   quote→credit gap
  square: { mx: 0.095, my: 0.090, cap: 0.098, floor: 0.026, gap: 0.052 },
  portrait: { mx: 0.100, my: 0.082, cap: 0.104, floor: 0.026, gap: 0.055 },
  story: { mx: 0.105, my: 0.075, cap: 0.118, floor: 0.028, gap: 0.048 },
  landscape: { mx: 0.080, my: 0.100, cap: 0.078, floor: 0.022, gap: 0.060 },
};

/** How each shipped composition tilts the result. */
const FLAVOUR: Record<Flavour, { align: TextStyle["align"]; margin: number; air: number }> = {
  // Centred and generous — the default reading of a quotation.
  calm: { align: "center", margin: 1, air: 1 },
  // An editorial column, flush to the start edge, tighter side margins and more of them vertically.
  manuscript: { align: "start", margin: 0.9, air: 1.06 },
  // Formal and centred, with wider side margins so the card frames the words.
  gilded: { align: "center", margin: 1.16, air: 0.96 },
  // Large and quiet: the quote gets the room, the credit stays small and low.
  night: { align: "start", margin: 0.92, air: 1.12 },
};

/** Where a size lands tells you what kind of card this is. */
function archetypeFor(size: number, cap: number): Archetype {
  const r = size / cap;
  if (r >= 0.94) return "display";
  if (r >= 0.72) return "spacious";
  if (r >= 0.50) return "balanced";
  if (r >= 0.34) return "editorial";
  return "dense";
}

/** How the archetype spends the room: line spacing, the gap to the credit, and vertical bias. */
const SHAPE: Record<Archetype, { line: number; gap: number; bias: number; track: number }> = {
  //            line height   gap ×    where the quote sits (0 = top, .5 = centred)   tracking
  display: { line: 1.28, gap: 1.35, bias: 0.42, track: -0.005 },
  spacious: { line: 1.45, gap: 1.18, bias: 0.40, track: 0 },
  balanced: { line: 1.62, gap: 1.0, bias: 0.34, track: 0 },
  editorial: { line: 1.78, gap: 0.82, bias: 0.14, track: 0 },
  dense: { line: 1.86, gap: 0.68, bias: 0.04, track: 0 },
};

interface CreditPiece { part: PresetPart; text: string; size: number; lines: number; style: Partial<TextStyle>; }

/**
 * ARRANGE A CARD FROM WHAT IT HAS TO SAY.
 *
 * Returns elements in reading order. The caller decides whether to use them; nothing here mutates
 * anything or is consulted again afterwards.
 */
export function autoLayout(opts: {
  format: CardFormat;
  /** Export pixels — only their ratio matters here. */
  w: number;
  h: number;
  text: RoleText;
  flavour?: Flavour;
}): AutoLayout {
  const { format, w, h, text } = opts;
  const flavour = FLAVOUR[opts.flavour ?? "calm"];
  const fmt = FORMAT[format] ?? FORMAT.portrait;
  const aspect = w / h;

  const quote = (text.quote ?? "").trim();
  const advance = isArabicText(quote) ? ADVANCE.ar : ADVANCE.latin;

  const mx = fmt.mx * flavour.margin;
  const my = fmt.my;
  const boxW = 1 - 2 * mx;

  // ── what the credit costs, before the quote is given anything ────────────────────────────────
  // Built first and from the bottom, because the credit's height is knowable — it is a few short
  // lines — while the quote will take whatever is left. Sizes are capped against their own length,
  // so a nine-word title reflows onto a second line instead of pushing everything else off the card.
  const wanted: { part: PresetPart; cap: number; maxLines: number; weight?: number; opacity?: number }[] = [
    { part: "title", cap: 0.052, maxLines: 2, weight: 700 },
    { part: "chapter", cap: 0.030, maxLines: 2, opacity: 0.72 },
    { part: "author", cap: 0.034, maxLines: 1, opacity: 0.9 },
    { part: "attribution", cap: 0.026, maxLines: 2, opacity: 0.62 },
  ];
  const credit: CreditPiece[] = [];
  for (const wpiece of wanted) {
    const words = (text[wpiece.part] ?? "").trim();
    if (!words) continue;
    const adv = isArabicText(words) ? ADVANCE.ar : ADVANCE.latin;
    const size = Math.min(wpiece.cap, sizeToFit(words.length, boxW, wpiece.maxLines, adv));
    credit.push({
      part: wpiece.part,
      text: words,
      size,
      lines: linesFor(words.length, size, boxW, adv),
      style: { weight: wpiece.weight, opacity: wpiece.opacity },
    });
  }

  const CREDIT_LINE = 1.34;
  const CREDIT_GAP = 0.016; // between credit lines, as a fraction of the card's height
  const creditH = credit.reduce((sum, c) => sum + heightOf(c.lines, c.size, CREDIT_LINE, aspect), 0)
    + Math.max(0, credit.length - 1) * CREDIT_GAP;

  // ── the quote gets the rest, and its size comes out of how much that is ──────────────────────
  const gapBase = fmt.gap * flavour.air;
  // A first pass at the gap, refined once the archetype is known — the gap depends on the shape and
  // the shape depends on the size, so one round of feedback settles it.
  const quoteH = Math.max(0.18, 1 - 2 * my - creditH - gapBase);
  let ideal = sizeToFill(quote.length, boxW, quoteH, aspect, 1.6, advance);
  let size = clamp(ideal, fmt.floor, fmt.cap);
  let shape = SHAPE[archetypeFor(size, fmt.cap)];

  const gap = gapBase * shape.gap;

  // ── WHERE EVERYTHING ACTUALLY GOES ───────────────────────────────────────────────────────────
  //
  // The credit is pinned to the foot and the quote is given what remains. Both halves of that
  // matter. Pinning is what makes the card look composed rather than top-heavy — a credit that
  // merely follows the quote leaves a dangling gap under a short one — and it is also the only
  // arrangement that CANNOT collide: the quote's box is defined as the space above the credit, so
  // there is no arithmetic left that could put them in the same place.
  //
  // (It was not always. Letting the credit follow the quote and pulling it up only when it
  // overflowed meant a long passage pushed it past the foot, where the clamp that keeps elements on
  // the card stacked its lines on the same line. Measured: chapter over author, on a square.)
  const creditTop = credit.length ? 1 - my - creditH : 1 - my;
  const roomTop = my;
  const roomBottom = credit.length ? creditTop - gap : 1 - my;
  const room = Math.max(0.12, roomBottom - roomTop);

  // The quote's box is the room LESS the optical trim: text centred by arithmetic sits a touch low
  // to the eye, so the airier shapes lift their box. Short text centres in it and looks placed;
  // long text fills it.
  //
  // The size is solved against THAT BOX and not against the room, which is the distinction the
  // first version of this got wrong: it fitted the type to the whole room and then handed the text
  // a box up to a sixth shorter, so the overflow was built in before a line was ever measured.
  const boxFor = (sh: { bias: number }) => room * (1 - sh.bias * 0.34);
  ideal = sizeToFill(quote.length, boxW, boxFor(shape), aspect, shape.line, advance);
  size = clamp(ideal, fmt.floor, fmt.cap);

  // ── AND THEN THE LINES ARE WHOLE ─────────────────────────────────────────────────────────────
  //
  // `sizeToFill` packs text continuously: it answers "what size makes this many characters occupy
  // exactly this much area". Real text does not work that way — it breaks into WHOLE lines, and the
  // last one is as tall as the rest however little it carries. A passage that wants 4.2 lines takes
  // five, and five lines at the solved size is taller than the box it was solved for.
  //
  // Photographed: the first line of an English quote clipped against the top edge of the card. So
  // the size steps down until the whole lines genuinely fit. The shape is re-read on every step,
  // because a smaller size can belong to a different archetype, with its own leading and its own
  // trim — fitting against the shape the size no longer has is its own way of overflowing.
  const fits = (sz: number, sh: { bias: number; line: number }) =>
    heightOf(linesOf(quote, sz, boxW, advance), sz, sh.line, aspect) <= boxFor(sh);
  // The floor is where a quote stops being comfortable to read, and the step-down is allowed a
  // little way past it. A passage that will not fit even at the floor is already past comfortable
  // by its own length, and running off the edge of the card is strictly worse than being set a
  // fraction smaller: a reader can hold the card closer, but cannot read what was cropped off.
  // (Measured: a 959-character passage on a square needs about 0.93 of the floor to fit.)
  const hardFloor = fmt.floor * 0.8;
  // The bound is a safety rail, not a budget: 6% steps from the cap to the hard floor take about
  // forty of them, and a loop that stopped short of the floor would report a fit it had not found.
  for (let i = 0; i < 80 && quote.length > 0 && size > hardFloor; i++) {
    shape = SHAPE[archetypeFor(size, fmt.cap)];
    if (fits(size, shape)) break;
    size = Math.max(hardFloor, size * 0.96);
  }

  const archetype = archetypeFor(size, fmt.cap);
  shape = SHAPE[archetype];
  const quoteBoxH = boxFor(shape);

  // The lines the quote will actually take, and therefore the height it actually needs. A short
  // quote needs far less than it was offered — that surplus is the air that makes a display card
  // look composed rather than merely large.
  const elements: TextElement[] = [];
  const base: TextStyle = {
    size, weight: 400, lineHeight: shape.line, align: flavour.align, color: null, opacity: 1, dir: "auto",
  };

  const quoteTop = roomTop;
  if (quote) {
    elements.push({
      id: newId(),
      kind: "quote",
      placement: { rect: r(mx, quoteTop, boxW, quoteBoxH) },
      style: { ...base, ...(shape.track ? { letterSpacing: shape.track } : {}) },
      text: quote,
      origin: "quote",
    });
  }

  // ── the credit, on the card's own baseline ───────────────────────────────────────────────────
  let y = creditTop;
  for (const c of credit) {
    const lineH = heightOf(c.lines, c.size, CREDIT_LINE, aspect);
    elements.push({
      id: newId(),
      kind: "attribution",
      placement: { rect: r(mx, y, boxW, lineH) },
      style: { ...base, size: c.size, lineHeight: CREDIT_LINE, ...c.style },
      text: c.text,
      origin: c.part,
    });
    y += lineH + CREDIT_GAP;
  }

  return { elements, archetype, quoteSize: size };
}

/** Clamp a rect into the card, so nothing this produces can start outside it. */
function r(x: number, y: number, wd: number, ht: number): Rect {
  const cy = clamp(y, 0, 0.98);
  return { x: clamp(x, 0, 0.98), y: cy, w: clamp(wd, 0.02, 1 - clamp(x, 0, 0.98)), h: clamp(ht, 0.02, 1 - cy) };
}

/**
 * WHERE A NEWLY ADDED ELEMENT GOES ON A BLANK CARD.
 *
 * A custom card starts empty and stays empty until the user adds something — but what they add
 * should arrive somewhere sensible rather than at the origin. These are the same regions the
 * automatic layout uses, so a hand-built card and a generated one have the same bones.
 */
export function defaultRectFor(part: PresetPart | "text" | "image", format: CardFormat): Rect {
  const fmt = FORMAT[format] ?? FORMAT.portrait;
  const mx = fmt.mx;
  const boxW = 1 - 2 * mx;
  switch (part) {
    case "quote": return r(mx, 0.20, boxW, 0.38);
    case "title": return r(mx, 0.655, boxW, 0.075);
    case "chapter": return r(mx, 0.742, boxW, 0.045);
    case "author": return r(mx, 0.792, boxW, 0.05);
    case "attribution": return r(mx, 0.858, boxW, 0.042);
    case "image": return r(0.28, 0.30, 0.44, 0.30);
    default: return r(mx, 0.44, boxW, 0.1);
  }
}

/** And the type it arrives in — a real size from the start, never zero and never "work it out". */
export function defaultStyleFor(part: PresetPart | "text", format: CardFormat): TextStyle {
  const fmt = FORMAT[format] ?? FORMAT.portrait;
  const size = {
    quote: fmt.cap * 0.62,
    title: 0.046,
    chapter: 0.027,
    author: 0.031,
    attribution: 0.024,
    subtitle: 0.028,
    text: 0.040,
  }[part] ?? 0.04;
  return {
    size,
    weight: part === "title" ? 700 : 400,
    lineHeight: part === "quote" ? 1.6 : 1.34,
    align: "center",
    color: null,
    opacity: part === "chapter" ? 0.72 : part === "attribution" ? 0.62 : 1,
    dir: "auto",
  };
}
