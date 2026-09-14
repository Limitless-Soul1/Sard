// A TEXT READABILITY TOOLKIT — three treatments, four controls, one idea.
//
// THE PROBLEM. A photograph makes a beautiful ground and a hostile page. Somewhere in a busy image
// there is always a patch whose luminance is near the ink's, and the sentence dies there — usually
// mid-word, which is worse than being dark all over.
//
// WHAT THIS IS NOT. The easy answer is a dark sheet over the whole card, and it is the wrong one: it
// costs the photograph everything it was chosen for, it looks identical on every card, and it is not
// a decision anyone made. A card should not announce that it was hard to read.
//
// ── THE THREE TREATMENTS, AND WHY THEY ARE THREE ────────────────────────────────────────────────
//
//   هالة · HALO   Light around the letters, and nothing behind them. The glyphs carry a soft wide
//                 glow in a contrasting colour, so they detach from whatever is under them while the
//                 picture stays completely intact. Reach for it first: at low strength it is
//                 invisible as a device and only the legibility is noticed, which is what a good
//                 typographic fix looks like.
//
//   حِجاب · VEIL  A veil, not a panel. A wash that is deepest where the words are and dissolves to
//                 nothing well before the element's edge — no border, no corner, nothing to read as a
//                 shape. It buys real contrast across the whole passage where a halo cannot, and it
//                 leaves the picture legible through it. `softness` is how far it reaches; at its
//                 softest it is a breath, at its firmest a deliberate scrim.
//
//   لَوح · PLATE  A plate: a defined surface the words sit on, for a ground that is genuinely
//                 hostile — a face, a crowd, high-frequency detail. It has an edge, because that is
//                 the point of it, and `softness` governs how rounded and how generous that edge is.
//                 It comes in two shapes: one plate behind the block, or one per LINE, following the
//                 ragged edge of the setting the way a poster does.
//
// ── THE CONTROLS ────────────────────────────────────────────────────────────────────────────────
//
//   colour     `null` = derived (see `backingColor`), or any colour the reader picks. THE DERIVED
//              ANSWER IS A STARTING POINT, NOT A RULE. It was the only answer at first, and on a pale
//              card it always resolved to the pale paper — so every treatment came out white, and a
//              reader who wanted a warm scrim or a coloured wash had no way to ask for one.
//   strength   0..1 · how present it is. 0 is the same as «بلا» in every mode.
//   softness   0..1 · how it meets what is around it. Halo: how far the light carries. Veil: how far
//              it reaches before dissolving. Plate: its radius and the air around the words.
//   shape      Plate only · one plate for the block, or one per line.
//
// ── A TREATMENT IS PAINTED, NEVER LAID OUT ─────────────────────────────────────────────────────
//
// THE RULE: nothing here may change where a line breaks, how large the type is, or how wide the block
// is. The reader sets the type; the treatment is applied to whatever that turned out to be.
//
// It was not always so, and the failure is worth stating because it is easy to repeat. The air around
// the words was `padding`, which is part of the box — so with `box-sizing: border-box` it came out of
// the CONTENT width, and moving the SOFTNESS control narrowed the text: a word sitting near a wrapping
// boundary dropped to the next line, and because the auto-fit measures the element's own scroll size
// the fitted font size moved with it. A visual control was re-typesetting the card.
//
// So the air is a box-shadow SPREAD and the soft edge is its BLUR. A shadow paints outside the border
// box and takes no part in layout at all, which is exactly the relationship a treatment should have to
// the text it serves. `background` and `border-radius` are safe for the same reason; `text-shadow` was
// always safe, which is why the halo never had this problem.
//
// The card is exported by rasterising the very same DOM (`html-to-image`), and gradients, box-shadows
// and text-shadows all survive a foreignObject rasterisation intact. A `backdrop-filter` does not, and
// would have made the editor and the exported PNG disagree — worse than having no feature.
//
// The em unit does the rest: every measurement below is relative to the fitted font size, so a
// treatment scales with the type instead of being pinned to the card. Direction needs no special case
// — shadows and gradients are symmetric, and `fit-content` resolves against the writing direction on
// its own (and preserves wrapping: with `max-inline-size: 100%` the text still lays out at the full
// width and the box merely shrinks to the longest line it produced).

import { contrastRatio } from "../../lib/contrast";

/** The four answers a text element can give. `none` is the default and changes nothing. */
export const LEGIBILITY_MODES = ["none", "halo", "veil", "plate"] as const;
export type Legibility = (typeof LEGIBILITY_MODES)[number];

/** How a plate meets the setting: one surface behind the block, or one behind each line. */
export const LEGIBILITY_SHAPES = ["block", "lines"] as const;
export type LegibilityShape = (typeof LEGIBILITY_SHAPES)[number];

export const isLegibility = (v: unknown): v is Legibility =>
  typeof v === "string" && (LEGIBILITY_MODES as readonly string[]).includes(v);
export const isLegibilityShape = (v: unknown): v is LegibilityShape =>
  typeof v === "string" && (LEGIBILITY_SHAPES as readonly string[]).includes(v);

/**
 * Where the knobs start when a treatment is first chosen.
 *
 * Deliberately short of the middle. A treatment should arrive doing enough to be worth having and
 * little enough that the reader's first instinct is to leave it alone — arriving at full strength
 * would make every card look like it had been rescued.
 */
export const DEFAULT_LEGIBILITY_STRENGTH = 0.45;
export const DEFAULT_LEGIBILITY_SOFTNESS = 0.5;
/**
 * HOW THICK A HALO IS, in em, and why it needed a control of its own.
 *
 * A halo had two knobs — how STRONG it is and how SOFT it is — and neither of them is thickness.
 * Strength is opacity: turn it up and the same thin ring of light merely gets denser. Softness is the
 * blur radius: turn it up and the light reaches further but gets fainter as it goes, because a blur
 * spreads a fixed amount of ink over a larger area. Neither can give the halo MASS close to the
 * glyph, which is the thing a reader means by "make the halo thicker".
 *
 * The reason is in the primitive: `text-shadow` has no spread. `box-shadow` does, which is why the
 * plate can be given air and the halo could not. What produces mass for a text shadow is REPETITION —
 * copies of the glyph offset around a circle of radius w, which dilates its silhouette outward by w
 * and leaves a solid body of colour there. That is what this measures.
 *
 * 0.30em is where it stops. Past that the halos of adjacent lines meet and the setting closes up.
 */
export const HALO_WIDTH_MAX_EM = 0.3;
/** Where the thickness starts when a halo is first chosen — visible, and short of a statement. */
export const DEFAULT_HALO_WIDTH = 0.05;

/**
 * Everything one treatment resolves to, as plain CSS.
 *
 * NOTHING HERE MAY CHANGE THE TEXT'S LAYOUT. Not one of these properties takes part in deciding where
 * a line breaks, how large the type is, or how wide the block is — see the note on `boxShadow`.
 */
export interface BackingStyle {
  /** On the text block itself. */
  textShadow?: string;
  background?: string;
  borderRadius?: string;
  /**
   * THE AIR AROUND THE WORDS, PAINTED RATHER THAN RESERVED.
   *
   * This used to be `padding`, and that was a real defect: padding is part of the box, so with
   * `box-sizing: border-box` it came out of the CONTENT width — which meant moving the softness
   * control narrowed the text and words at a wrapping boundary jumped to the next line. Worse, the
   * auto-fit measures the element's own scroll size, so the fitted font size moved too: a visual
   * control was quietly re-typesetting the card.
   *
   * A box-shadow SPREAD paints exactly the same ring of colour outside the border box and takes no
   * part in layout at all, and its blur is what gives the edge its softness. The text is laid out
   * once and the treatment is painted around whatever that layout turned out to be.
   */
  boxShadow?: string;
  inlineSize?: string;
  maxInlineSize?: string;
  marginInline?: string;
  /**
   * A PER-LINE treatment cannot live on the block: a block has one box, and the whole point is to
   * follow each line's own length. So it is returned separately, for an inline span around the words,
   * where `box-decoration-break: clone` gives every line its own padded, rounded surface.
   */
  inner?: {
    display: "inline";
    background: string;
    borderRadius: string;
    /** Spread, not padding — horizontal padding on an inline box moves where its lines break. */
    boxShadow: string;
    boxDecorationBreak: "clone";
    WebkitBoxDecorationBreak: "clone";
  };
}

/** `rgba()` from a `#rgb`/`#rrggbb` or an `rgb()` colour, so a theme value works as well as a hex. */
function rgba(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const m = color.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
  let h = color.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return `rgba(0, 0, 0, ${a})`;
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
}

/**
 * The card's paper is enough to back the words with once it clears this against them.
 *
 * WHY A THRESHOLD AND NOT "WHICHEVER CONTRASTS MOST". Taking the maximum sounds right and is wrong:
 * against near-black ink, white out-scores a warm ivory paper (about 19:1 against 16:1), so the rule
 * would put a clinical white behind the words of every card whose paper is the least bit warm — the
 * exact grey-slab look this feature exists to avoid, arrived at by arithmetic. The paper does not
 * need to WIN, it needs to be enough; AA for body text is the honest place to draw that line.
 */
const PAPER_IS_ENOUGH = 4.5;

/**
 * The colour to back the words with when the reader has not named one.
 *
 * This is the DEFAULT, not the rule — `backingStyle` takes an explicit colour and prefers it. The
 * card's own paper is used wherever it reads, so the treatment is made of the card's material rather
 * than of a grey nobody chose; the fallback is whichever of black and white stands further from the
 * words, which is what makes one control work on light and dark grounds alike.
 */
export function backingColor(textColor: string, paper: string): string {
  if (contrastRatio(textColor, paper) >= PAPER_IS_ENOUGH) return paper;
  return contrastRatio(textColor, "#ffffff") >= contrastRatio(textColor, "#000000") ? "#ffffff" : "#000000";
}

/** Where a block plate sits when the words do not fill their box. `justify` fills it, so it stays full. */
function plateMargin(align: string | undefined): string | undefined {
  if (align === "center") return "auto";
  if (align === "end") return "auto 0 auto auto";
  return undefined; // start, justify, or unset — the plate begins where the words do
}

export interface BackingInput {
  mode: Legibility;
  strength?: number;
  /** 0..1. What "meets what is around it" means differs per mode — see the header. */
  softness?: number;
  /**
   * HALO ONLY · em · the thickness of the halo's own body. Absent means none, which is exactly the
   * halo every card saved before this control existed has.
   */
  haloWidth?: number;
  /** The reader's own colour, or null/undefined to derive one. */
  color?: string | null;
  shape?: LegibilityShape;
  /** The colour the words are drawn in, and the card's paper — both used to derive a colour. */
  textColor: string;
  paper: string;
  align?: string;
}

/**
 * THE HALO'S BODY — copies of the glyph offset around a circle, which is how a text shadow is given
 * mass at all.
 *
 * `text-shadow` has no spread, so the only way to push colour a fixed distance out from every edge of
 * a letterform is to draw the letterform again, displaced, in every direction. Enough copies and the
 * displaced silhouettes overlap into a continuous band of width `w` around the glyph: a halo with a
 * body, rather than a blur pretending to have one.
 *
 * HOW MANY COPIES. The gaps between neighbouring copies grow with the radius, so the count grows with
 * it too — eight is continuous at a hairline, sixteen at the maximum. Fewer would show as points of
 * light at the diagonals; more costs paint for a difference nobody can see.
 *
 * The blur on each copy is small and follows softness: it is the EDGE of the body, not its reach —
 * the two wide glows above are what carries the light outward.
 */
function haloBody(w: number, soft: number, colour: string, strength: number): string {
  if (w <= 0 || strength <= 0) return "";
  const copies = w > 0.18 ? 16 : w > 0.08 ? 12 : 8;
  const blur = (0.02 + 0.16 * soft * w).toFixed(4);
  // Denser than the glows: this is the part that has to actually hold a letterform apart from the
  // picture, and it is only ever as wide as the reader asked for.
  const ink = rgba(colour, Math.min(1, 0.55 * strength + 0.35 * strength * strength));
  const parts: string[] = [];
  for (let i = 0; i < copies; i++) {
    const a = (2 * Math.PI * i) / copies;
    parts.push(`${(Math.cos(a) * w).toFixed(4)}em ${(Math.sin(a) * w).toFixed(4)}em ${blur}em ${ink}`);
  }
  return parts.join(", ");
}

/**
 * The CSS for one treatment.
 *
 * At strength 0 every mode is nothing at all, which is what lets a reader dial a treatment away
 * without having to remember to set it back to «بلا».
 */
export function backingStyle(input: BackingInput): BackingStyle {
  const { mode, textColor, paper, align, shape } = input;
  const s = Math.max(0, Math.min(1, input.strength ?? DEFAULT_LEGIBILITY_STRENGTH));
  const soft = Math.max(0, Math.min(1, input.softness ?? DEFAULT_LEGIBILITY_SOFTNESS));
  if (mode === "none" || s <= 0) return {};
  const c = input.color || backingColor(textColor, paper);

  if (mode === "halo") {
    // TWO RINGS, NOT ONE. A single shadow at a usable opacity reads as a stroke; a tight ring plus a
    // wide, fainter one reads as light. The tight ring does the separating; the wide one carries the
    // glow far enough to cover the high-frequency detail that actually breaks a word, and `softness`
    // is how far that reach goes — from a close, almost typographic edge to a real bloom.
    const tight = `0 0 ${(0.06 + 0.12 * soft).toFixed(3)}em ${rgba(c, 0.5 * s + 0.3 * s * s)}`;
    const wide = `0 0 ${(0.18 + 0.9 * soft).toFixed(3)}em ${rgba(c, 0.5 * s)}`;
    // A third, very wide and very faint ring only once the reader asks for reach: it is what turns a
    // halo into a glow that can hold a headline over a crowd, and it costs nothing at low softness.
    const bloom = soft > 0.55 ? `, 0 0 ${(1.4 * soft).toFixed(2)}em ${rgba(c, 0.32 * s * soft)}` : "";
    // THE BODY OF THE HALO, if the reader has asked for one. Written FIRST so it is painted furthest
    // back, with the two glows over it — the mass sits under the light rather than on top of it.
    const body = haloBody(Math.max(0, Math.min(HALO_WIDTH_MAX_EM, input.haloWidth ?? 0)), soft, c, s);
    return { textShadow: body ? `${body}, ${tight}, ${wide}${bloom}` : `${tight}, ${wide}${bloom}` };
  }

  if (mode === "veil") {
    // A VEIL HAS NO EDGE. It is an ellipse of colour centred on the words, dense in the middle and
    // gone before it reaches the element's bounds — so at every strength it reads as atmosphere over
    // the picture rather than as a panel behind the text. `softness` moves where it starts to fade:
    // firm keeps its density out to the words' own extent, soft begins dissolving almost at once.
    const core = rgba(c, 0.72 * s);
    const mid = rgba(c, 0.42 * s);
    const hold = Math.round(6 + 34 * (1 - soft));   // %, how far full density carries
    const fade = Math.round(hold + 30 + 24 * soft); // %, where it has gone entirely
    return {
      background:
        `radial-gradient(115% 92% at 50% 50%, ${core} 0%, ${core} ${hold}%, ${mid} ${Math.min(fade - 8, 88)}%, ${rgba(c, 0)} ${Math.min(fade, 100)}%)`,
      // The gradient can only paint INSIDE the box, so the reach beyond the words is a blurred
      // shadow — which is what makes a veil dissolve into the picture instead of stopping at an edge.
      boxShadow: `0 0 ${(0.7 + 2.2 * soft).toFixed(2)}em ${(0.25 + 0.75 * soft).toFixed(2)}em ${rgba(c, 0.34 * s)}`,
    };
  }

  // PLATE. A surface with an edge, because that is what distinguishes it from the veil.
  const fill = rgba(c, 0.28 + 0.62 * s);
  const radius = `${(0.15 + 1.05 * soft).toFixed(2)}em`;
  // The air around the words and the softness of the edge, both painted: spread carries the plate
  // out past the text, blur decides how sharply it ends. Neither moves a single line of type.
  const spread = (0.34 + 0.62 * soft).toFixed(2);
  const blur = (0.08 + 0.75 * soft).toFixed(2);
  const shadow = `0 0 ${blur}em ${spread}em ${fill}`;
  if (shape === "lines") {
    // ONE PLATE PER LINE, following the ragged edge of the setting. The block cannot carry this — it
    // has a single box — so it is handed back for an inline span around the words, where
    // `box-decoration-break: clone` repeats the surface, its corners and its spread on every line.
    return {
      inner: {
        display: "inline",
        background: fill,
        borderRadius: radius,
        boxShadow: shadow,
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
      },
    };
  }
  return {
    background: fill,
    borderRadius: radius,
    boxShadow: shadow,
    // FITTED TO THE WORDS, not to the element. A plate that spans a wide box is a slab with the text
    // adrift in it; `fit-content` makes it hug the longest line, and `max` keeps it inside the box so
    // wrapping is unchanged.
    inlineSize: "fit-content",
    maxInlineSize: "100%",
    marginInline: plateMargin(align),
  };
}

// ── THE STROKE ──────────────────────────────────────────────────────────────────────────────────
//
// A line around the letters themselves. It is the oldest answer to type over a photograph and still
// the most economical: it costs nothing but the outline, it leaves the picture completely intact,
// and unlike a halo it holds at any size because it scales with the glyph rather than blooming.
//
// WHY IT IS NOT A FOURTH TREATMENT. A stroke composes with the three rather than competing with
// them: a halo carries the words off a busy ground and a hairline stroke stops the glyph edges
// dissolving into it. Making the reader choose between them would have been an arrangement of the
// code, not of the card.
//
// HOW IT IS DRAWN, and why this way. `-webkit-text-stroke` centres the line ON the glyph outline, so
// half of it eats into the letterform — at any usable weight Arabic counters close and the type
// thickens. `paint-order: stroke fill` puts the fill back on top afterwards, which leaves the
// letterform exactly as the typeface drew it and shows only the half of the stroke that lies
// outside. Both are paint properties: no layout, no re-wrap, no change to the fitted size — the same
// rule the treatments above are held to.
//
// It survives the export because the export rasterises this very DOM through a foreignObject, and
// both properties are ordinary computed CSS on the element.

/** As thick as a stroke should ever get on a card. Past this the counters close up. */
export const STROKE_MAX_EM = 0.24;

/**
 * The colour a stroke takes when the reader has not named one.
 *
 * The same question `backingColor` answers, and deliberately the same answer: a stroke is a backing
 * that happens to be shaped like the letters. Sharing the derivation is what makes «هالة» and a
 * stroke look like one decision rather than two colours that nearly match.
 */
export function strokeColor(textColor: string, paper: string): string {
  return backingColor(textColor, paper);
}

/** What a stroke resolves to. Empty when there is none, so the caller can spread it unconditionally. */
export interface StrokeStyle {
  WebkitTextStroke?: string;
  paintOrder?: string;
}

export function strokeStyle(input: {
  width?: number;
  color?: string | null;
  textColor: string;
  paper: string;
}): StrokeStyle {
  const w = Math.max(0, Math.min(STROKE_MAX_EM, input.width ?? 0));
  if (w <= 0) return {};
  const c = input.color || strokeColor(input.textColor, input.paper);
  return {
    // The width is doubled because half of a centred stroke is hidden under the fill — so the number
    // the reader sets is the line they actually SEE, which is the only definition that is any use.
    WebkitTextStroke: `${(w * 2).toFixed(4)}em ${c}`,
    paintOrder: "stroke fill",
  };
}
